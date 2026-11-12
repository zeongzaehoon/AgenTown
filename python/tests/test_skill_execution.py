"""Deterministic HTTP acceptance; requires the integrated C27 Rust bindings."""
import asyncio

import httpx
import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.execution import ProviderFailure
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}


class FixtureProvider:
    name = 'deterministic-test'

    def __init__(self, failure=False):
        self.inputs = []
        self.failure = failure

    async def generate(self, text, model):
        self.inputs.append((text, model))
        if self.failure:
            raise ProviderFailure('rate_limit')
        return 'Fixture result'


def setup(client):
    employee = client.post('/api/employees', json={'name': 'Writer'}, headers=HEADERS).json()['id']
    task = client.post('/api/work', json={'employee': employee, 'input': 'Saved work'}, headers=HEADERS).json()['id']
    skill = client.post('/api/config/v1/skills', json={'name': 'Concise', 'instructions': 'Use short sentences.'}, headers=HEADERS).json()['id']
    path = f'/api/config/v1/skills/{skill}'
    assert client.put(path + '/enabled', json={'enabled': True}, headers=HEADERS).status_code == 200
    return task, skill, path


def preview(client, task, skill):
    result = client.post(f'/api/work/{task}/skill-preview', json={'skill_id': skill}, headers=HEADERS)
    assert result.status_code == 200, result.text
    value = result.json()
    assert value['schema_version'] == 1
    assert value['task_id'] == task and value['skill_id'] == skill
    assert 'Use short sentences.' in value['input'] and 'Saved work' in value['input']
    return value


@pytest.mark.parametrize('failure', [False, True])
def test_success_failure_explicit_retry_and_restart(tmp_path, failure):
    db = tmp_path / 'skills.db'
    provider = FixtureProvider(failure)
    with TestClient(create_app(db, 'fixture-model', provider=provider), base_url=ORIGIN) as client:
        task, skill, path = setup(client)
        value = preview(client, task, skill)
        assert value['expected_runs'] == 0 and provider.inputs == []
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts'] == []
        payload = {'preview_id': value['preview_id'], 'expected_runs': 0}
        route = f'/api/work/{task}/execute'
        result = client.post(route, json=payload, headers=HEADERS)
        assert result.status_code == 200, result.text
        result = result.json()
        assert provider.inputs == [(value['input'], 'fixture-model')]
        assert result['error'] == ('rate_limit' if failure else None)
        assert result['skill']['skill_id'] == skill
        assert result['skill']['instructions'] == 'Use short sentences.'
        # Replaying consumed consent cannot silently become a retry.
        for count in (0, 1):
            assert client.post(route, json={**payload, 'expected_runs': count}, headers=HEADERS).status_code == 409
        fresh = preview(client, task, skill)
        assert fresh['expected_runs'] == 1
        retry = client.post(route, json={'preview_id': fresh['preview_id'], 'expected_runs': 1}, headers=HEADERS)
        assert retry.status_code == 200 and retry.json()['run_id'] != result['run_id']
        # Later edits must not change already admitted instructions.
        assert client.put(path, json={'name': 'Edited', 'instructions': 'Different'}, headers=HEADERS).status_code == 200
        saved = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]
        assert len(saved['attempts']) == 2
        for attempt in saved['attempts']:
            assert attempt['skill']['instructions'] == 'Use short sentences.'
            assert attempt['input'] == value['input']
            assert attempt['outcome'] == ('failure' if failure else 'reported_success')
            assert attempt['ended'] is not None
    with TestClient(create_app(db, 'fixture-model', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'][0] == saved
    assert len(provider.inputs) == 2


def test_stale_preview_and_configuration_without_provider(tmp_path):
    with TestClient(create_app(tmp_path / 'skills.db'), base_url=ORIGIN) as client:
        task, skill, path = setup(client)
        value = preview(client, task, skill)
        assert client.put(path + '/enabled', json={'enabled': False}, headers=HEADERS).status_code == 200
        # Reopen with deterministic configuration to exercise Rust stale validation.
    provider = FixtureProvider()
    with TestClient(create_app(tmp_path / 'skills.db', 'fixture', provider=provider), base_url=ORIGIN) as client:
        assert client.post(f'/api/work/{task}/execute', json={'preview_id': value['preview_id'], 'expected_runs': 0}, headers=HEADERS).status_code == 409
        assert provider.inputs == []
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts'] == []


def test_concurrent_duplicate_only_one_provider_call(tmp_path):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        class Slow(FixtureProvider):
            async def generate(self, text, model):
                self.inputs.append((text, model))
                entered.set()
                await release.wait()
                return 'Fixture result'
        db = tmp_path / 'skills.db'
        provider = Slow()
        with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
            task, skill, _ = setup(client)
            value = preview(client, task, skill)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(db, 'fixture', provider=provider)), base_url=ORIGIN, headers=HEADERS) as client:
            route = f'/api/work/{task}/execute'
            payload = {'preview_id': value['preview_id'], 'expected_runs': 0}
            pending = asyncio.create_task(client.post(route, json=payload))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                assert (await client.post(route, json=payload)).status_code == 409
            finally:
                release.set()
            assert (await pending).status_code == 200
            assert len(provider.inputs) == 1
            saved = (await client.post('/api/state', json={})).json()['work'][0]
            assert len(saved['attempts']) == 1 and saved['attempts'][0]['skill']['skill_id'] == skill
    asyncio.run(scenario())


@pytest.mark.parametrize('location', ['work', 'instructions'])
def test_legacy_secret_rejected_before_preview_persistence(tmp_path, monkeypatch, location):
    secret = 'configured-secret-c27'
    monkeypatch.setenv('ANTHROPIC_API_KEY', secret)
    db = str(tmp_path / 'secret.db')
    employee = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, secret if location == 'work' else 'Safe work', employee)[0]
    skill = _native.create_skill(db, 'Skill', secret if location == 'instructions' else 'Safe instructions')
    _native.set_skill_enabled(db, skill['id'], True)
    provider = FixtureProvider()
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        result = client.post(f'/api/work/{task}/skill-preview', json={'skill_id': skill['id']}, headers=HEADERS)
        assert result.status_code == 409 and secret not in result.text
        state = client.post('/api/state', json={}, headers=HEADERS)
        assert secret not in state.text and state.json()['work'][0]['attempts'] == []
    assert provider.inputs == []


def test_configured_secret_output_redacted_and_retained(tmp_path, monkeypatch):
    secret = 'configured-output-secret-c27'
    monkeypatch.setenv('ANTHROPIC_API_KEY', secret)
    class Echo(FixtureProvider):
        async def generate(self, text, model):
            self.inputs.append((text, model))
            return 'Result ' + secret
    provider = Echo()
    db = tmp_path / 'redacted.db'
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        task, skill, _ = setup(client)
        value = preview(client, task, skill)
        result = client.post(f'/api/work/{task}/execute', json={'preview_id': value['preview_id'], 'expected_runs': 0}, headers=HEADERS)
        assert result.status_code == 200 and result.json()['output'] == 'Result [redacted]'
        assert secret not in result.text
    with TestClient(create_app(db, 'fixture', provider=provider), base_url=ORIGIN) as client:
        state = client.post('/api/state', json={}, headers=HEADERS)
        assert secret not in state.text
        assert state.json()['work'][0]['attempts'][0]['output'] == 'Result [redacted]'
    assert len(provider.inputs) == 1


@pytest.mark.parametrize('payload', [{}, {'skill_id': None}, {'skill_id': True},
                                     {'skill_id': 'x', 'extra': 1}])
def test_invalid_preview_never_calls_native_or_provider(tmp_path, monkeypatch, payload):
    def forbidden(*args):
        pytest.fail('invalid preview reached native admission')
    monkeypatch.setattr(_native, 'preview_skill', forbidden)
    provider = FixtureProvider()
    with TestClient(create_app(tmp_path / 'invalid.db', 'fixture', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/work/task/skill-preview', json=payload, headers=HEADERS).status_code == 409
    assert provider.inputs == []
