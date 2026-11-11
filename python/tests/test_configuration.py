"""Configuration persistence and transport boundaries; no real provider calls."""
import uuid
import pytest
from starlette.testclient import TestClient
from llm_engine import _native, configuration as api
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}


class NoExecution:
    name = 'anthropic'

    async def generate(self, *args, **kwargs):
        pytest.fail('configuration invoked provider')


def test_python_configuration_persists_and_is_atomic(tmp_path):
    db = str(tmp_path / 'configuration.db')
    agent = _native.create_agent(db, 'Employee')[0]
    team = _native.create_team(db, 'Team')[0]
    task = _native.create_task(db, 'Work')[0]
    skill = api.create_skill(db, name='Skill', instructions='Instructions')
    hook_fields = dict(name='Hook', skill_id=skill['id'], target_kind='agent', target_id=agent, event='task_created')
    loop_fields = dict(name='Loop', task_id=task, max_iterations=2, interval_seconds=60)
    hook = api.create_hook(db, **hook_fields)
    loop = api.create_loop(db, **loop_fields)
    for kind, row, fields in [('skill', skill, dict(name='Skill', instructions='Instructions')),
                              ('hook', hook, hook_fields), ('loop', loop, loop_fields)]:
        assert row['enabled'] is False
        show = getattr(api, f'show_{kind}')
        update = getattr(api, f'update_{kind}')
        toggle = getattr(api, f'set_{kind}_enabled')
        changed = update(db, row['id'], **{**fields, 'name': 'Edited'})
        assert changed['id'] == row['id'] and changed['enabled'] is False
        assert toggle(db, row['id'], True)['enabled'] is True
        assert toggle(db, row['id'], True) == show(db, row['id'])
        before = show(db, row['id'])
        for invalid in ({**fields, 'name': ''}, {**fields, 'name': 'x' * 121}, {**fields, 'extra': True}):
            with pytest.raises(ValueError):
                update(db, row['id'], **invalid)
            assert show(db, row['id']) == before
        with pytest.raises(ValueError):
            toggle(db, row['id'], 1)
        with pytest.raises(ValueError):
            show(db, None)
        assert toggle(db, row['id'], False)['enabled'] is False
    api.update_hook(db, hook['id'], **{**hook_fields, 'target_kind': 'team', 'target_id': team})
    with pytest.raises(ValueError):
        api.create_skill(db, id='unexpected', name='Skill', instructions='Text')
    for fields in ({**hook_fields, 'skill_id': str(uuid.uuid4())}, {**hook_fields, 'target_id': str(uuid.uuid4())}):
        with pytest.raises(KeyError):
            api.update_hook(db, hook['id'], **fields)
    for fields in ({**loop_fields, 'max_iterations': True}, {**loop_fields, 'max_iterations': -1},
                   {**loop_fields, 'max_iterations': 2**64}, {**loop_fields, 'max_iterations': 101},
                   {**loop_fields, 'interval_seconds': -1}, {**loop_fields, 'interval_seconds': 59}):
        with pytest.raises(ValueError):
            api.update_loop(db, loop['id'], **fields)
    assert _native.list_runs(db, task) == []
    assert _native.list_agents(db) == [(agent, 'Employee')]
    assert api.show_hook(db, hook['id'])['target_id'] == team


def test_http_configuration_restart_and_errors(tmp_path, monkeypatch):
    db = str(tmp_path / 'http.db')
    for name in ('start_web_execution', 'start_execution', 'recover_executions'):
        monkeypatch.setattr(_native, name, lambda *a: pytest.fail('execution side effect'))
    saved = []
    with TestClient(create_app(db, provider=NoExecution()), base_url=ORIGIN) as client:
        agent = _native.create_agent(db, 'Employee')[0]
        task = _native.create_task(db, 'Work')[0]
        skill = client.post('/api/config/v1/skills', json={'name': 'Skill', 'instructions': 'Text'}, headers=HEADERS).json()
        cases = [('skills', {'name': 'Skill', 'instructions': 'Text'}),
                 ('hooks', {'name': 'Hook', 'skill_id': skill['id'], 'target_kind': 'agent', 'target_id': agent, 'event': 'run_completed'}),
                 ('loops', {'name': 'Loop', 'task_id': task, 'max_iterations': 100, 'interval_seconds': 86400})]
        for plural, fields in cases:
            base = '/api/config/v1/' + plural
            created = client.post(base, json=fields, headers=HEADERS)
            assert created.status_code == 201
            row = created.json()
            assert row['enabled'] is False
            path = base + '/' + row['id']
            assert client.put(path, json={**fields, 'name': 'Edited'}, headers=HEADERS).status_code == 200
            enabled = client.put(path + '/enabled', json={'enabled': True}, headers=HEADERS)
            assert enabled.status_code == 200
            saved.append((path, enabled.json()))
            for payload in ({'enabled': 1}, {'enabled': True, 'extra': 1}, {}):
                assert client.put(path + '/enabled', json=payload, headers=HEADERS).status_code == 400
            assert client.get(path).json() == enabled.json()
            assert enabled.json() in client.get(base).json()[plural]
            assert client.get(base + '/' + str(uuid.uuid4())).status_code == 404
            assert client.get(base + '/invalid').status_code == 400
            assert client.post(base, json=fields).status_code == 403
        assert _native.list_runs(db, task) == []
    with TestClient(create_app(db, provider=NoExecution()), base_url=ORIGIN) as client:
        for path, expected in saved:
            assert client.get(path).json() == expected
    with TestClient(create_app(tmp_path / 'missing' / 'store.db', provider=NoExecution()), base_url=ORIGIN) as client:
        result = client.get('/api/config/v1/skills')
        assert result.status_code == 503
        assert str(tmp_path) not in result.text
