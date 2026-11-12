import asyncio
import json
import re

import httpx
import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.execution import ProviderFailure
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}


def test_team_api_persistence_and_atomic_membership(tmp_path):
    import uuid
    db = str(tmp_path / 'teams.db')
    provider = TestProvider()
    with TestClient(create_app(db, provider=provider), base_url=ORIGIN) as client:
        assert client.get('/api/teams').json() == {'teams': []}
        result = client.post('/api/teams', json={'name': '  Delivery 한글  '}, headers=HEADERS)
        assert result.status_code == 201
        team = result.json()
        assert team == {'id': team['id'], 'name': 'Delivery 한글', 'members': []}
        a, b, c = [_native.create_agent(db, name)[0] for name in ('A', 'B', 'C')]
        path = f'/api/teams/{team["id"]}/members'

        def unchanged(members, expected, route=path):
            assert client.post(route, json={'members': members}, headers=HEADERS).status_code == 400
            assert client.get('/api/teams').json() == {'teams': [{**team, 'members': expected}]}

        for invalid in ('invalid', str(uuid.uuid4())):
            unchanged([a, invalid], [])
            unchanged([a], [], f'/api/teams/{invalid}/members')
        unchanged([a, a], [])
        added = client.post(path, json={'members': [a, b]}, headers=HEADERS)
        assert added.status_code == 200
        saved = {**team, 'members': sorted([a, b])}
        assert added.json() == saved
        unchanged([c, a], saved['members'])
        unchanged([c, str(uuid.uuid4())], saved['members'])
        assert provider.calls == 0
    with TestClient(create_app(db, provider=provider), base_url=ORIGIN) as client:
        assert client.get('/api/teams').json() == {'teams': [saved]}
        assert provider.calls == 0


def test_team_api_input_bounds_and_origin(tmp_path):
    db = str(tmp_path / 'teams.db')
    with TestClient(create_app(db, provider=TestProvider()), base_url=ORIGIN) as client:
        team = client.post('/api/teams', json={'name': 'T' * 200}, headers=HEADERS).json()
        path = f'/api/teams/{team["id"]}/members'
        for name in ('', ' \t', 'x' * 201, None, [], 123, '\ud800'):
            assert client.post('/api/teams', content=json.dumps({'name': name}), headers={**HEADERS, 'Content-Type': 'application/json'}).status_code == 400
        for members in ([], ['x'] * 101, 'x', None, [123], ['x' * 101], [''], ['\ud800']):
            assert client.post(path, content=json.dumps({'members': members}), headers={**HEADERS, 'Content-Type': 'application/json'}).status_code == 400
        for route in ('/api/teams', path):
            for payload in ({}, [], None):
                assert client.post(route, content=json.dumps(payload), headers={**HEADERS, 'Content-Type': 'application/json'}).status_code == 400
            for payload, status in ((b'{', 400), (b'\xff', 400), (b'x' * 120001, 413)):
                assert client.post(route, content=payload, headers={**HEADERS, 'Content-Type': 'application/json'}).status_code == status
            for headers in ({}, {'Origin': 'http://evil.example'}, {**HEADERS, 'Sec-Fetch-Site': 'cross-site'}):
                assert client.post(route, json={'name': 'Blocked', 'members': ['x']}, headers=headers).status_code == 403
            assert client.post(route, data={'name': 'Blocked'}, headers=HEADERS).status_code == 403
        assert client.get('/api/teams', headers={'Host': 'evil.example'}).status_code == 403
        listing = client.get('/api/teams')
        assert listing.json() == {'teams': [team]}
        assert listing.headers['cache-control'] == 'no-store'


def test_team_api_safe_errors_and_redaction(tmp_path, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'team-secret-never-return')
    db = str(tmp_path / 'teams.db')
    _native.create_team(db, 'legacy team-secret-never-return')
    with TestClient(create_app(db, provider=TestProvider()), base_url=ORIGIN) as client:
        assert 'team-secret-never-return' not in client.get('/api/teams').text
        assert client.post('/api/teams', json={'name': 'team-secret-never-return'}, headers=HEADERS).status_code == 400
        def fail(*args):
            raise ValueError('private database path team-secret-never-return')
        for binding in ('list_teams', 'create_team', 'add_team_members'):
            monkeypatch.setattr(_native, binding, fail)
        for result, status in (
            (client.get('/api/teams'), 503),
            (client.post('/api/teams', json={'name': 'Valid'}, headers=HEADERS), 400),
            (client.post('/api/teams/invalid/members', json={'members': ['valid']}, headers=HEADERS), 400),
        ):
            assert result.status_code == status
            assert 'private database path' not in result.text
            assert 'team-secret-never-return' not in result.text


class TestProvider:
    __test__ = False
    name = 'deterministic-test'

    def __init__(self):
        self.calls = 0

    async def generate(self, text, model):
        self.calls += 1
        if self.calls == 1:
            raise ProviderFailure('rate_limit')
        return '<script>not executable</script> Full test result\n' + text


def setup_work(client):
    employee = client.post('/api/employees', json={'name': '<img src=x onerror=alert(1)>'}, headers=HEADERS)
    assert employee.status_code == 201
    work = client.post('/api/work', json={'input': 'Summarize the plan.', 'employee': employee.json()['id']}, headers=HEADERS)
    assert work.status_code == 201
    return work.json()['id']


def test_flow_retry_replay_restart_and_atomic_assignment(tmp_path):
    db = str(tmp_path / 'work.db')
    provider = TestProvider()
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'] == []
        task = setup_work(client)
        state = client.post('/api/state', json={}, headers=HEADERS).json()
        assert state['work'][0]['status'] == 'pending'
        assert state['work'][0]['attempts'] == []
        path = f'/api/work/{task}/execute'
        first = client.post(path, json={'expected_runs': 0}, headers=HEADERS)
        assert first.json()['error'] == 'rate_limit'
        assert client.post(path, json={'expected_runs': 0}, headers=HEADERS).status_code == 409
        second = client.post(path, json={'expected_runs': 1}, headers=HEADERS)
        assert second.json()['quality'] == 'unverified'
        assert second.json()['output'].startswith('<script>')
        assert second.json()['run_id'] != first.json()['run_id']
        assert client.post(path, json={'expected_runs': 1}, headers=HEADERS).status_code == 409
        assert provider.calls == 2
        before = _native.list_tasks(db)
        assert client.post('/api/work', json={'input': 'No orphan', 'employee': 'invalid'}, headers=HEADERS).status_code == 400
        assert _native.list_tasks(db) == before
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        work = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]
        assert work['id'] == task
        assert len(work['attempts']) == 2
        assert work['attempts'][1]['output'] == second.json()['output']
        assert work['status'] != 'completed'
        assert provider.calls == 2


def test_same_origin_boundary_configuration_and_redaction(tmp_path, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test-secret-never-return')
    db = str(tmp_path / 'work.db')
    _native.create_agent(db, 'legacy test-secret-never-return')
    with TestClient(create_app(db), base_url=ORIGIN) as client:
        state = client.post('/api/state', json={}, headers=HEADERS)
        assert 'test-secret-never-return' not in state.text
        assert '--model' in state.json()['configuration']
        for headers in ({}, {'Origin': 'http://evil.example'}, {'Origin': 'null'}, {'Origin': 'http://127.0.0.1:9999'}, {'Origin': ORIGIN, 'Sec-Fetch-Site': 'cross-site'}):
            assert client.post('/api/employees', json={'name': 'blocked'}, headers=headers).status_code == 403
        assert client.post('/api/state', json={}, headers={**HEADERS, 'Host': 'evil.example:8765'}).status_code == 403
        assert client.post('/api/employees', data={'name': 'blocked'}, headers=HEADERS).status_code == 403
        assert client.post('/api/employees', json={'name': 'test-secret-never-return'}, headers=HEADERS).status_code == 400
        assert client.get('/api/state').status_code == 405
        assert client.post('/api/state', json={}).status_code == 403
        assert len(_native.list_agents(db)) == 1
        assert client.post('/api/employees', content='x' * 120001, headers={**HEADERS, 'Content-Type': 'application/json'}).status_code == 400
        assert client.post('/api/work/invalid/execute', json={'expected_runs': 0}, headers=HEADERS).status_code == 409
        assert 'frame-ancestors' in client.get('/').headers['content-security-policy']
        home = client.get('/')
        assets = re.findall(r'(?:src|href)="(/static/[^"]+)"', home.text)
        assert len(assets) >= 2
        assert 'type="module"' in home.text
        for path in assets:
            asset = client.get(path)
            assert asset.status_code == 200
            assert "script-src 'self'" in asset.headers['content-security-policy']
        assert any(path.endswith('.js') for path in assets)
        assert any(path.endswith('.css') for path in assets)


def test_responsive_during_provider_io_and_concurrent_duplicate(tmp_path):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        class Slow:
            name = 'deterministic-test'
            async def generate(self, text, model):
                entered.set()
                await release.wait()
                return 'test result'
        app = create_app(tmp_path / 'work.db', 'test-model', provider=Slow())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers=HEADERS) as client:
            a = (await client.post('/api/employees', json={'name': 'Writer'})).json()['id']
            task = (await client.post('/api/work', json={'employee': a, 'input': 'Draft text'})).json()['id']
            path = f'/api/work/{task}/execute'
            pending = asyncio.create_task(client.post(path, json={'expected_runs': 0}))
            await asyncio.wait_for(entered.wait(), 2)
            state = await asyncio.wait_for(client.post('/api/state', json={}, headers=HEADERS), 2)
            assert state.json()['work'][0]['attempts'][0]['state'] == 'active'
            duplicate = await client.post(path, json={'expected_runs': 0})
            assert duplicate.status_code == 409
            release.set()
            assert (await pending).json()['output'] == 'test result'
    asyncio.run(scenario())


def test_interrupted_history_recovers_without_resend(tmp_path):
    import sqlite3
    import uuid
    db = str(tmp_path / 'work.db')
    provider = TestProvider()
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        task = setup_work(client)
        agent = _native.list_agents(db)[0][0]
        run = str(uuid.uuid4())
        with sqlite3.connect(db) as connection:
            connection.execute('INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL, NULL)', (run, task, 'text_execution', provider.name, 1000))
            connection.execute('INSERT INTO run_participants VALUES (?, ?)', (run, agent))
            connection.execute('INSERT INTO executions VALUES (?, ?, ?, ?, ?, NULL, NULL)', (run, 'Summarize the plan.', provider.name, 'test-model', 121000))
        for _ in range(2):
            attempt = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts'][0]
            assert attempt['state'] == 'finished'
            assert attempt['error'] == 'interrupted'
            assert attempt['outcome'] == 'interruption'
        assert provider.calls == 0
        assert len(_native.list_runs(db, task)) == 1
        # Ordinary CLI stage labels must not break the screen or imply execution.
        recorded = _native.start_run(db, task, 'text_execution', 'human', [agent])
        _native.finish_run(db, recorded[0], 'reported_success')
        history = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts']
        assert len(history) == 2 and 'output' not in history[1]


def test_missing_frontend_build_has_actionable_guidance(tmp_path, monkeypatch):
    import llm_engine.web as web
    monkeypatch.setattr(web, 'ASSETS', tmp_path / 'missing-assets')
    with TestClient(create_app(tmp_path / 'work.db'), base_url=ORIGIN) as client:
        result = client.get('/')
        assert result.status_code == 503
        assert 'npm ci and npm run build' in result.json()['error']


def test_revised_work_preserves_exact_input_and_original_history_on_restart(tmp_path):
    db = str(tmp_path / 'draft.db')
    provider = TestProvider()
    original_text = '\n  Original 한글 😀 <b>literal</b>\n\t  '
    revised_text = original_text + '\n  Revised request\nKeep separate.  '
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        employee = client.post('/api/employees', json={'name': 'Writer'}, headers=HEADERS).json()['id']
        original_id = client.post('/api/work', json={'input': original_text, 'employee': employee}, headers=HEADERS).json()['id']
        path = f'/api/work/{original_id}/execute'
        client.post(path, json={'expected_runs': 0}, headers=HEADERS)
        client.post(path, json={'expected_runs': 1}, headers=HEADERS)
        original = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]
        assert original['input'] == original_text
        assert original['attempts'][1]['output'].endswith(original_text)
        saved = client.post('/api/work', json={'input': revised_text, 'employee': employee}, headers=HEADERS)
        assert saved.status_code == 201 and saved.json()['id'] != original_id
        before = client.post('/api/state', json={}, headers=HEADERS).json()['work']
        assert len(before) == 2
        revised = next(w for w in before if w['id'] == saved.json()['id'])
        assert revised['input'] == revised_text and revised['attempts'] == []
        assert next(w for w in before if w['id'] == original_id) == original
        assert client.post('/api/work', json={'input': '\n \t\u2003', 'employee': employee}, headers=HEADERS).status_code == 400
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'] == before
        assert provider.calls == 2


@pytest.mark.parametrize('output,failure,outcome', [
    ('Full saved response', None, 'reported_success'),
    (None, 'network', 'failure'),
    (None, 'output_limit', 'failure'),
    (None, 'interrupted', 'interruption'),
])
def test_history_response_keeps_one_snapshot_when_execution_finishes(tmp_path, monkeypatch, output, failure, outcome):
    db = str(tmp_path / 'snapshot.db')
    provider = TestProvider()
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        task = setup_work(client)
        run = _native.start_web_execution(db, task, provider.name, 'test-model', 0)
        native_start = _native.show_run(db, run[0])
        snapshot = _native.history_snapshot
        calls = []

        def finish_after_read(database):
            result = snapshot(database)
            if not calls:
                _native.finish_execution(database, run[0], output, failure)
            calls.append(database)
            return result

        monkeypatch.setattr(_native, 'history_snapshot', finish_after_read)
        first = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]
        assert calls == [db]
        assert first['attempts'][0]['started'] == native_start[4]
        assert first['attempts'][0]['ended'] is None
        assert first['attempts'][0]['state'] == 'active'
        assert first['attempts'][0]['outcome'] is None
        assert first['attempts'][0]['output'] is None
        assert first['attempts'][0]['error'] is None
        second = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]
        assert second['id'] == first['id'] == task
        assert len(second['attempts']) == 1
        assert second['attempts'][0]['id'] == run[0]
        native_end = _native.show_run(db, run[0])
        assert second['attempts'][0]['started'] == native_start[4] == native_end[4]
        assert second['attempts'][0]['ended'] == native_end[5]
        assert native_end[5] is not None
        assert second['attempts'][0]['state'] == 'finished'
        assert second['attempts'][0]['outcome'] == outcome
        assert second['attempts'][0]['output'] == output
        assert second['attempts'][0]['error'] == failure
        assert provider.calls == 0


@pytest.mark.parametrize('outcome', ['reported_success', 'failure', 'interruption'])
def test_reported_attempt_times_match_native_after_restart(tmp_path, outcome):
    db = str(tmp_path / 'reported.db')
    provider = TestProvider()
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        task = setup_work(client)
        employee = _native.show_task(db, task)[3][0]
        run = _native.start_run(db, task, 'execute', 'caller', [employee])
        active = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts'][0]
        assert active['started'] == run[4] and active['ended'] is None
        assert 'provider' not in active
        terminal = _native.finish_run(db, run[0], outcome)
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        attempt = client.post('/api/state', json={}, headers=HEADERS).json()['work'][0]['attempts'][0]
        assert attempt['started'] == terminal[4] == run[4]
        assert attempt['ended'] == terminal[5] and terminal[5] is not None
        assert attempt['outcome'] == outcome and attempt['state'] == 'finished'
        assert 'provider' not in attempt and provider.calls == 0


@pytest.mark.parametrize('text,valid', [
    ('a' * 100000, True), ('a' * 100001, False),
    ('한' * 33333 + 'a', True), ('한' * 33334, False),
    ('😀' * 25000, True), ('😀' * 25001, False),
    ('e\u0301' * 33333 + 'a', True), ('e\u0301' * 33334, False),
    ('\n\t\u0085\u2003', False), ('\ufeff', True),
    ('\n  한글 😀 <b>literal</b> \\" e\u0301\r\n\t ', True),
])
def test_text_byte_boundaries_keep_native_authority_and_exact_restart(tmp_path, text, valid):
    db = str(tmp_path / 'limits.db')
    provider = TestProvider()
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        employee = client.post('/api/employees', json={'name': 'Writer'}, headers=HEADERS).json()['id']
        result = client.post('/api/work', json={'input': text, 'employee': employee}, headers=HEADERS)
        assert result.status_code == (201 if valid else 400)
        if not valid:
            assert result.json()['code'] == 'invalid_work_text'
        work = client.post('/api/state', json={}, headers=HEADERS).json()['work']
        assert len(work) == int(valid)
        if valid:
            assert work[0]['input'] == text and work[0]['attempts'] == []
            assert _native.show_task(db, work[0]['id'])[1] == text
        assert provider.calls == 0
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json()['work'] == work


@pytest.mark.parametrize('escaped', ['"', '\\', '\n', '\x01'])
def test_serialized_exact_and_over_limit(tmp_path, escaped):
    db = str(tmp_path / 'serialized.db')
    provider = TestProvider()
    with TestClient(create_app(db, 'test-model', provider=provider), base_url=ORIGIN) as client:
        employee = client.post('/api/employees', json={'name': 'Writer'}, headers=HEADERS).json()['id']
        def encode(text):
            return json.dumps({'input': text, 'employee': employee}, ensure_ascii=False, separators=(',', ':')).encode()
        available = 120000 - len(encode('')) - 1
        unit = len(json.dumps(escaped)) - 2
        text = 'x' + escaped * (available // unit) + 'a' * (available % unit)
        assert len(encode(text)) == 120000 and len(text.encode()) <= 100000
        headers = {**HEADERS, 'Content-Type': 'application/json'}
        result = client.post('/api/work', content=encode(text), headers=headers)
        assert result.status_code == 201
        before = client.post('/api/state', json={}, headers=HEADERS).json()
        rejected = client.post('/api/work', content=encode(text + 'a'), headers=headers)
        assert rejected.status_code == 413 and rejected.json()['code'] == 'request_too_large'
        assert client.post('/api/state', json={}, headers=HEADERS).json() == before
        assert before['work'][0]['input'] == text and before['work'][0]['attempts'] == []
        assert provider.calls == 0


def test_work_database_error_is_not_size_error_or_secret(tmp_path, monkeypatch):
    def fail(*args):
        raise ValueError('sensitive database detail')
    monkeypatch.setattr(_native, 'create_assigned_work', fail)
    with TestClient(create_app(tmp_path / 'db', 'test-model', provider=TestProvider()), base_url=ORIGIN) as client:
        result = client.post('/api/work', json={'input': 'valid', 'employee': 'id'}, headers=HEADERS)
        assert result.status_code == 400
        assert 'database' in result.json()['error']
        assert 'code' not in result.json() and 'sensitive' not in result.text


@pytest.mark.parametrize('partial_text', [None, 'SECRET PARTIAL'])
def test_output_limit_sdk_api_restart(monkeypatch, tmp_path, partial_text):
    from types import SimpleNamespace as Obj
    from test_execution import mock_sdk
    from llm_engine.execution import AnthropicProvider
    content = [] if partial_text is None else [Obj(type='text', text=partial_text)]
    calls = mock_sdk(monkeypatch, Obj(stop_reason='max_tokens', content=content))
    db = str(tmp_path / 'limit.db')
    provider = AnthropicProvider('SECRET')
    with TestClient(create_app(db, 'model', provider=provider), base_url=ORIGIN) as client:
        task = setup_work(client)
        path = f'/api/work/{task}/execute'
        result = client.post(path, json={'expected_runs': 0}, headers=HEADERS).json()
        assert result['error'] == 'output_limit' and result['output'] is None
        assert client.post(path, json={'expected_runs': 0}, headers=HEADERS).status_code == 409
        saved = client.post('/api/state', json={}, headers=HEADERS).json()
        attempt = saved['work'][0]['attempts'][0]
        assert attempt['outcome'] == 'failure' and attempt['ended'] >= attempt['started']
        assert 'SECRET' not in json.dumps(saved) and 'PARTIAL' not in json.dumps(saved)
    with TestClient(create_app(db, 'model', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json() == saved
        assert len(calls) == 1
        retry = client.post(path, json={'expected_runs': 1}, headers=HEADERS).json()
        assert retry['error'] == 'output_limit' and retry['run_id'] != result['run_id']
        assert retry['output'] is None
        assert len(calls) == 2 and calls[0] == calls[1]
        retried = client.post('/api/state', json={}, headers=HEADERS).json()
        assert retried['work'][0]['attempts'][0] == attempt
        assert len(retried['work'][0]['attempts']) == 2
        assert retried['work'][0]['status'] == 'pending'
        assert 'SECRET' not in json.dumps(retried) and 'PARTIAL' not in json.dumps(retried)
        for recorded in retried['work'][0]['attempts']:
            assert recorded['error'] == 'output_limit' and recorded['output'] is None
            assert recorded['outcome'] == 'failure'
            assert recorded['ended'] >= recorded['started']
    with TestClient(create_app(db, 'model', provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json() == retried
        assert len(calls) == 2


def test_connections_presentation_boundary_and_no_storage_access(tmp_path, monkeypatch):
    from llm_engine.connections import connection_setup
    with TestClient(create_app(str(tmp_path / 'company.db')), base_url=ORIGIN) as client:
        def forbidden(*args, **kwargs):
            raise AssertionError('Setup must not inspect storage')
        monkeypatch.setattr(_native, 'history_snapshot', forbidden)
        path = '/api/connections/v1'
        assert client.get(path).status_code == 405
        assert client.post(path, json={}).status_code == 403
        assert client.post(path, json={}, headers={'Origin': 'http://evil.example'}).status_code == 403
        response = client.post(path, json={}, headers=HEADERS)
        assert response.status_code == 200
        assert response.json() == connection_setup(str(tmp_path / 'company.db'))
        assert 'no-store' in response.headers['cache-control']


def test_workspace_declared_sources_persist_by_run(tmp_path, monkeypatch):
    db = str(tmp_path / 'sources.db')
    provider = TestProvider()
    expected = {}
    with TestClient(create_app(db, provider=provider), base_url=ORIGIN) as client:
        task = setup_work(client)
        employee = _native.show_task(db, task)[3][0]
        legacy = _native.start_run(db, task, 'implement', 'not-a-declared-source', [employee])
        _native.finish_run(db, legacy[0], 'failure')
        expected[legacy[0]] = None
        web = _native.start_web_execution(db, task, 'anthropic', 'fixture', 1)
        _native.finish_execution(db, web[0], 'Web fixture', None)
        expected[web[0]] = None
        ordinary = _native.start_mcp_execution(db, task, 'anthropic', 'fixture', 2, True, 'codex')
        _native.finish_execution(db, ordinary[0], 'MCP fixture', None)
        expected[ordinary[0]] = 'codex'
        skill = _native.create_skill(db, 'Concise', 'Use short sentences.')
        _native.set_skill_enabled(db, skill['id'], True)
        preview = _native.preview_skill(db, task, skill['id'])
        run = _native.start_skill_execution(db, task, preview['preview_id'], 'anthropic', 'fixture', 3,
                                            declared_source='cursor')
        _native.finish_execution(db, run[0], 'Skill fixture', None)
        expected[run[0]] = 'cursor'
        hook = _native.create_hook(db, 'Follow up', skill['id'], 'agent', employee, 'run_completed')
        _native.set_hook_enabled(db, hook['id'], True)
        preview = _native.preview_hook(db, task, hook['id'])
        run = _native.start_hook_execution(db, task, preview['preview_id'], 'anthropic', 'fixture', 4,
                                           declared_source='claude-code')
        _native.finish_execution(db, run[0], 'Hook fixture', None)
        expected[run[0]] = 'claude-code'
        other = setup_work(client)
        run = _native.start_mcp_execution(db, other, 'anthropic', 'fixture', 0, False, 'other-client')
        _native.finish_execution(db, run[0], 'Other fixture', None)
        expected[run[0]] = 'other-client'
        snapshot = _native.history_snapshot
        sources = _native.execution_sources
        reads = []

        def read_history(database):
            reads.append('history')
            return snapshot(database)

        def read_sources(database):
            assert reads[-1] == 'history'
            reads.append('sources')
            return sources(database)

        monkeypatch.setattr(_native, 'history_snapshot', read_history)
        monkeypatch.setattr(_native, 'execution_sources', read_sources)
        saved = client.post('/api/state', json={}, headers=HEADERS).json()
        work = {item['id']: item for item in saved['work']}
        attempts = [a for item in work.values() for a in item['attempts']]
        assert {a['id']: a['declared_source'] for a in attempts} == expected
        assert {a['id'] for a in work[task]['attempts']} == set(expected) - {run[0]}
        assert [a['id'] for a in work[other]['attempts']] == [run[0]]
        assert any('skill' in a for a in attempts)
        assert any('hook' in a for a in attempts)
        for item in work.values():
            assert item['attempts'] == sorted(item['attempts'], key=lambda a: (a['started'], a['id']))
    with TestClient(create_app(db, provider=provider), base_url=ORIGIN) as client:
        assert client.post('/api/state', json={}, headers=HEADERS).json() == saved
        assert provider.calls == 0


@pytest.mark.parametrize('failure', [ValueError, OSError])
def test_workspace_source_read_failure_is_sanitized(tmp_path, monkeypatch, failure):
    def unavailable(database):
        raise failure('/private/database caller-secret')

    with TestClient(create_app(str(tmp_path / 'sources.db'), provider=TestProvider()), base_url=ORIGIN) as client:
        monkeypatch.setattr(_native, 'execution_sources', unavailable)
        result = client.post('/api/state', json={}, headers=HEADERS)
        assert result.status_code == 503
        assert result.json() == {'error': 'Cannot read work history. Check the database path, permissions and compatibility, then restart.'}
        assert 'caller-secret' not in result.text


def test_connection_diagnostic_api_fixed_input_and_no_provider(tmp_path, monkeypatch):
    from llm_engine.connection_diagnostic import ConnectionDiagnostic, outcome
    calls = []
    async def check(self):
        calls.append(self.command)
        return outcome('passed', 'diagnostic_passed', 'Local server diagnostic passed',
                       'External connection and exercise remain unverified.')
    monkeypatch.setattr(ConnectionDiagnostic, 'run', check)
    provider = TestProvider()
    db = tmp_path / 'diagnostic.db'
    with TestClient(create_app(db, provider=provider), base_url=ORIGIN) as client:
        route = '/api/connections/v1/diagnostic'
        for body in ({'command': 'evil'}, {'database': '/other'}, []):
            assert client.post(route, json=body, headers=HEADERS).status_code == 400
        # HTTPX treats json=None as no body, rather than a JSON null value.
        assert client.post(route, content='null', headers={
            **HEADERS, 'Content-Type': 'application/json',
        }).status_code == 400
        assert client.post(route, headers=HEADERS).status_code == 403
        assert not calls
        assert client.post(route, json={}).status_code == 403
        for _ in range(2):
            reply = client.post(route, json={}, headers=HEADERS)
            assert reply.status_code == 200
            assert reply.json()['status'] == 'passed'
        assert len(calls) == 2
        assert calls[0][-1] == str(db)
        assert provider.calls == 0


def test_shared_data_api_fixed_input_and_no_provider(tmp_path, monkeypatch):
    from llm_engine.connection_diagnostic import ConnectionDiagnostic, outcome
    calls = []
    async def check(self):
        calls.append(self.command)
        return dict(outcome('passed', 'shared_data_passed', 'Shared employee and work access passed.',
                       'External connection and exercise remain unverified.'), employee_count=0, work_count=0)
    monkeypatch.setattr(ConnectionDiagnostic, 'run_shared_data', check)
    provider = TestProvider()
    db = tmp_path / 'diagnostic.db'
    # The check requires a valid selected store; app construction is lazy.
    assert _native.list_agents(str(db)) == []
    with TestClient(create_app(db, provider=provider), base_url=ORIGIN) as client:
        route = '/api/connections/v1/shared-data'
        before = db.read_bytes()
        assert client.get(route).status_code == 405
        assert not calls
        for body in ({'command': 'evil'}, {'database': '/other'}, []):
            assert client.post(route, json=body, headers=HEADERS).status_code == 400
        # HTTPX treats json=None as no body, rather than a JSON null value.
        assert client.post(route, content='null', headers={
            **HEADERS, 'Content-Type': 'application/json',
        }).status_code == 400
        assert client.post(route, headers=HEADERS).status_code == 403
        assert not calls
        assert client.post(route, json={}).status_code == 403
        for _ in range(2):
            reply = client.post(route, json={}, headers=HEADERS)
            assert reply.status_code == 200
            assert reply.json()['status'] == 'passed'
            assert reply.json()['employee_count'] == reply.json()['work_count'] == 0
        assert len(calls) == 2
        assert calls[0][-1] == str(db)
        assert provider.calls == 0
        assert db.read_bytes() == before
