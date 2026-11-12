"""Deterministic HTTP acceptance for the integrated C28 native Hook contract."""
import asyncio

import httpx
import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.web import create_app
from test_skill_execution import FixtureProvider, HEADERS, ORIGIN, setup


def configured_hook(client, event='run_completed'):
    task, skill, skill_path = setup(client)
    employee = client.post('/api/state', json={}, headers=HEADERS).json()['employees'][0]['id']
    fields = dict(name='Follow up', skill_id=skill, target_kind='agent', target_id=employee, event=event)
    created = client.post('/api/config/v1/hooks', json=fields, headers=HEADERS)
    assert created.status_code == 201, created.text
    hook = created.json()['id']
    path = '/api/config/v1/hooks/' + hook
    assert client.put(path + '/enabled', json={'enabled': True}, headers=HEADERS).status_code == 200
    return task, hook, path, fields, skill_path


def source_attempt(client, task):
    result = client.post(f'/api/work/{task}/execute', json={'expected_runs': 0}, headers=HEADERS)
    assert result.status_code == 200, result.text
    return result.json()


def preview(client, task, hook):
    result = client.post(f'/api/work/{task}/hook-preview', json={'hook_id': hook}, headers=HEADERS)
    assert result.status_code == 200, result.text
    value = result.json()
    assert value['schema_version'] == 1 and value['task_id'] == task
    assert value['expected_runs'] == 1
    assert 'Use short sentences.' in value['input'] and 'Saved work' in value['input']
    return value


def consent(value):
    return {'hook_preview_id': value['preview_id'], 'expected_runs': value['expected_runs']}


@pytest.mark.parametrize('failure,event', [(False, 'run_completed'), (True, 'run_failed')])
def test_matching_event_explicit_admission_failure_and_restart(tmp_path, failure, event):
    db = tmp_path / 'hooks.db'
    provider = FixtureProvider(failure)
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        task, hook, path, fields, skill_path = configured_hook(client, event)
        route = f'/api/work/{task}/execute'
        # Configuration and missing terminal events cannot dispatch work.
        assert provider.inputs == []
        assert client.post(f'/api/work/{task}/hook-preview', json={'hook_id': hook}, headers=HEADERS).status_code == 409
        source = source_attempt(client, task)
        assert len(provider.inputs) == 1
        value = preview(client, task, hook)
        assert len(provider.inputs) == 1
        result = client.post(route, json=consent(value), headers=HEADERS)
        assert result.status_code == 200, result.text
        result = result.json()
        assert result['error'] == ('rate_limit' if failure else None)
        assert result['hook']['hook_id'] == hook
        assert result['hook']['source_run_id'] == source['run_id']
        assert result['hook']['instructions'] == 'Use short sentences.'
        assert provider.inputs[-1] == (value['input'], 'fixture')
        for count in (1, 2):
            assert client.post(route, json={**consent(value), 'expected_runs': count}, headers=HEADERS).status_code == 409
        assert client.put(path, json={**fields, 'name': 'Edited'}, headers=HEADERS).status_code == 200
        assert client.put(skill_path, json={'name': 'Changed', 'instructions': 'Different'}, headers=HEADERS).status_code == 200
        saved = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]
        assert len(saved['attempts']) == 2
        attempt = next(a for a in saved['attempts'] if a['id'] == result['run_id'])
        assert attempt['hook'] == result['hook'] and attempt['input'] == value['input']
        assert attempt['quality'] == 'unverified'
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'][0] == saved
    assert len(provider.inputs) == 2  # No automatic chain after the second terminal event.


@pytest.mark.parametrize('change', ['hook', 'skill', 'source', 'assignment'])
def test_stale_preview_rejected_without_provider_io(tmp_path, change):
    provider = FixtureProvider()
    db = tmp_path / 'stale.db'
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        task, hook, path, fields, skill_path = configured_hook(client)
        source_attempt(client, task)
        value = preview(client, task, hook)
        if change == 'hook':
            assert client.put(path, json={**fields, 'name': 'Changed'}, headers=HEADERS).status_code == 200
        elif change == 'skill':
            assert client.put(skill_path + '/enabled', json={'enabled': False}, headers=HEADERS).status_code == 200
        elif change == 'source':
            assert client.post(f'/api/work/{task}/execute', json={'expected_runs': 1}, headers=HEADERS).status_code == 200
        else:
            other = _native.create_agent(str(db), 'Other')[0]
            _native.assign_task(str(db), task, [other])
        calls = len(provider.inputs)
        assert client.post(f'/api/work/{task}/execute', json=consent(value), headers=HEADERS).status_code == 409
        assert len(provider.inputs) == calls


@pytest.mark.parametrize('change', ['event', 'employee', 'team', 'disabled', 'task_created'])
def test_unmatched_configuration_rejected(tmp_path, change):
    provider = FixtureProvider()
    with TestClient(create_app(tmp_path / 'mismatch.db', 'fixture', provider=provider), base_url=ORIGIN) as client:
        task, hook, path, fields, _ = configured_hook(client)
        source_attempt(client, task)
        if change == 'disabled':
            assert client.put(path + '/enabled', json={'enabled': False}, headers=HEADERS).status_code == 200
        else:
            if change in ('event', 'task_created'):
                fields['event'] = 'run_failed' if change == 'event' else 'task_created'
            elif change == 'employee':
                fields['target_id'] = client.post('/api/employees', json={'name': 'Other'}, headers=HEADERS).json()['id']
            else:
                fields['target_kind'] = 'team'
                fields['target_id'] = client.post('/api/teams', json={'name': 'Team'}, headers=HEADERS).json()['id']
            assert client.put(path, json=fields, headers=HEADERS).status_code == 200
        assert client.post(f'/api/work/{task}/hook-preview', json={'hook_id': hook}, headers=HEADERS).status_code == 409
        assert len(provider.inputs) == 1


def test_concurrent_duplicate_admits_one_call(tmp_path):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        class Slow(FixtureProvider):
            async def generate(self, text, model):
                self.inputs.append((text, model))
                entered.set()
                await release.wait()
                return 'Fixture result'
        db = tmp_path / 'duplicate.db'
        with TestClient(create_app(db, 'fixture', provider=FixtureProvider()), base_url=ORIGIN) as client:
            task, hook, *_ = configured_hook(client)
            source_attempt(client, task)
            value = preview(client, task, hook)
        provider = Slow()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(db, 'fixture', provider=provider)), base_url=ORIGIN, headers=HEADERS) as client:
            route = f'/api/work/{task}/execute'
            pending = asyncio.create_task(client.post(route, json=consent(value)))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                assert (await client.post(route, json=consent(value))).status_code == 409
            finally:
                release.set()
            assert (await pending).status_code == 200
            assert len(provider.inputs) == 1
    asyncio.run(scenario())


@pytest.mark.parametrize('payload', [{}, {'hook_id': True}, {'hook_id': None}, {'hook_id': 'x', 'extra': 1}])
def test_invalid_preview_rejected_before_native(tmp_path, monkeypatch, payload):
    monkeypatch.setattr(_native, 'preview_hook', lambda *a: pytest.fail('invalid preview reached native'))
    with TestClient(create_app(tmp_path / 'invalid.db', provider=FixtureProvider()), base_url=ORIGIN) as client:
        assert client.post('/api/work/task/hook-preview', json=payload, headers=HEADERS).status_code == 409


@pytest.mark.parametrize('payload', [
    {'hook_preview_id': 'x', 'preview_id': 'y', 'expected_runs': 1},
    {'hook_preview_id': True, 'expected_runs': 1},
    {'hook_preview_id': 'x', 'expected_runs': True},
    {'hook_preview_id': 'x', 'expected_runs': 1, 'input': 'override'},
])
def test_ambiguous_or_invalid_consent_rejected_before_native(tmp_path, monkeypatch, payload):
    for name in ('start_hook_execution', 'start_skill_execution', 'start_web_execution'):
        monkeypatch.setattr(_native, name, lambda *a: pytest.fail('invalid consent reached admission'))
    provider = FixtureProvider()
    with TestClient(create_app(tmp_path / 'invalid.db', 'fixture', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/work/task/execute', json=payload, headers=HEADERS).status_code == 409
    assert provider.inputs == []


def test_wrong_task_consent_cannot_consume_preview(tmp_path):
    provider = FixtureProvider()
    with TestClient(create_app(tmp_path / 'wrong-task.db', 'fixture', provider=provider), base_url=ORIGIN) as client:
        task, hook, *_ = configured_hook(client)
        source_attempt(client, task)
        value = preview(client, task, hook)
        employee = client.post('/api/state', json={}, headers=HEADERS).json()['employees'][0]['id']
        other = client.post('/api/work', json={'employee': employee, 'input': 'Other work'}, headers=HEADERS).json()['id']
        assert client.post(f'/api/work/{other}/execute', json=consent(value), headers=HEADERS).status_code == 409
        assert len(provider.inputs) == 1
        assert client.post(f'/api/work/{task}/execute', json=consent(value), headers=HEADERS).status_code == 200
        assert len(provider.inputs) == 2


def test_saved_preview_admits_once_after_restart(tmp_path):
    db = tmp_path / 'preview-restart.db'
    provider = FixtureProvider()
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        task, hook, *_ = configured_hook(client)
        source = source_attempt(client, task)
        value = preview(client, task, hook)
    assert len(provider.inputs) == 1

    # Reopening the application must preserve consent without dispatching it.
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        assert len(provider.inputs) == 1
        route = f'/api/work/{task}/execute'
        result = client.post(route, json=consent(value), headers=HEADERS)
        assert result.status_code == 200, result.text
        provenance = result.json()['hook']
        assert provenance['source_run_id'] == source['run_id']
        assert provenance['hook_id'] == hook
        assert provider.inputs[-1] == (value['input'], 'fixture')

    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        assert client.post(route, json=consent(value), headers=HEADERS).status_code == 409
        attempts = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts']
        assert len(attempts) == 2
        assert next(a for a in attempts if a['id'] == result.json()['run_id'])['hook'] == provenance
    assert len(provider.inputs) == 2


@pytest.mark.parametrize('location', ['work', 'instructions'])
def test_secret_rejected_without_preview_or_provider(tmp_path, monkeypatch, location):
    secret = 'configured-secret-c28'
    monkeypatch.setenv('ANTHROPIC_API_KEY', secret)
    db = str(tmp_path / 'secret.db')
    employee = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, secret if location == 'work' else 'Safe work', employee)[0]
    skill = _native.create_skill(db, 'Skill', secret if location == 'instructions' else 'Safe instructions')
    _native.set_skill_enabled(db, skill['id'], True)
    hook = _native.create_hook(db, 'Hook', skill['id'], 'agent', employee, 'run_completed')
    _native.set_hook_enabled(db, hook['id'], True)
    # Legacy safe execution establishes a terminal source without sending secrets.
    row = _native.start_web_execution(db, task, 'deterministic-test', 'fixture', 0)
    _native.finish_execution(db, row[0], 'Safe result', None)
    provider = FixtureProvider()
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        result = client.post(f'/api/work/{task}/hook-preview', json={'hook_id': hook['id']}, headers=HEADERS)
        assert result.status_code == 409 and secret not in result.text
        state = client.post('/api/state', json={}, headers=HEADERS)
        assert secret not in state.text
        assert len(state.json()['work'][0]['attempts']) == 1
    assert provider.inputs == []
