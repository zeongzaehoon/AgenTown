"""Selected Loop API and retained-process failure boundaries; no live providers."""
import asyncio
from pathlib import Path
import sys
from uuid import uuid4

from starlette.testclient import TestClient
from llm_engine import _native
from llm_engine.application.apply_selected_loop import SelectedLoopRequest as Request
from llm_engine.local_mcp_loop import LocalMcpLoop, ToolUnconfirmed
from llm_engine.web import create_app
from selected_loop_scenario import exercise

ORIGIN = 'http://127.0.0.1:8765'
FIXTURE = str(Path(__file__).with_name('mcp_fixture_server.py'))


def test_retained_owner_provenance_stop_shutdown_restart(tmp_path, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'selected-loop-fixture-only')
    asyncio.run(exercise(str(tmp_path / 'loop.sqlite'), FIXTURE))


def test_api_no_credentials_preview_origin_and_shutdown(tmp_path):
    db = str(tmp_path / 'preview.sqlite')
    employee = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, 'Saved work', employee)[0]
    policy = _native.create_loop(db, 'Bounded', task, 2, 60)['id']
    _native.set_loop_enabled(db, policy, True)
    port = LocalMcpLoop(db, 'anthropic', None, configured=False)
    port.command = [sys.executable, FIXTURE, db, '--forbid-provider']
    with TestClient(create_app(db, loop_port=port), base_url=ORIGIN) as client:
        def call(operation, payload, status=200):
            reply = client.post('/api/connections/v1/loops/' + operation,
                                headers={'Origin': ORIGIN}, json=payload)
            assert reply.status_code == status, reply.text
            return reply.json()
        assert call('list', {'task_id': task})['data']['loops'][0]['id'] == policy
        preview = call('preview', {'task_id': task, 'policy_id': policy})['data']
        payload = dict(task_id=task, consent=preview, execution_consent=True)
        assert call('start', payload)['code'] == 'configuration_unavailable'
        call('start', {**payload, 'execution_consent': False}, 400)
        call('start', {**payload, 'provider': 'openai'}, 400)
        assert client.post('/api/connections/v1/loops/start', json=payload).status_code == 403
        assert call('inspect', {'task_id': task})['data']['sessions'] == []
        assert call('preview', {'task_id': str(uuid4()), 'policy_id': policy})['code'] == 'selection_mismatch'
        assert not Path(db + '.dispatches').exists()
        process = port.process
    assert process.returncode is not None
    assert port.closed


def test_ambiguous_activation_is_consumed_without_replay(tmp_path):
    async def scenario():
        port = LocalMcpLoop(tmp_path / 'unused', 'anthropic', 'fixture')
        task = str(uuid4())
        consent = dict(preview_id='opaque', task_id=task, expected_runs=0,
                       provider='anthropic', model='fixture')
        port.previews['opaque'] = consent.copy()
        calls = []
        async def connect():
            pass
        async def ambiguous(name, arguments):
            calls.append(name)
            raise ToolUnconfirmed('receipt lost after admission')
        port._connect, port._tool = connect, ambiguous
        request = Request('start', task, consent=consent, execution_consent=True)
        assert (await port.execute_work(request)).status == 'uncertain'
        assert (await port.execute_work(request)).code == 'admission_rejected'
        assert calls == ['start_loop_v1']
        await port.close()
    asyncio.run(scenario())


def test_api_activation_poll_and_owner_directed_stop(tmp_path, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'selected-loop-fixture-only')
    db = str(tmp_path / 'api.sqlite')
    employee = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, 'Saved work', employee)[0]
    policy = _native.create_loop(db, 'Bounded', task, 2, 60)['id']
    _native.set_loop_enabled(db, policy, True)
    port = LocalMcpLoop(db, 'anthropic', 'fixture')
    port.command = [sys.executable, FIXTURE, db]
    with TestClient(create_app(db, loop_port=port), base_url=ORIGIN) as client:
        def call(operation, payload):
            reply = client.post('/api/connections/v1/loops/' + operation,
                                headers={'Origin': ORIGIN}, json=payload)
            assert reply.status_code == 200, reply.text
            return reply.json()
        preview = call('preview', dict(task_id=task, policy_id=policy))['data']
        payload = dict(task_id=task, consent=preview, execution_consent=True)
        started = call('start', payload)
        assert started['code'] == 'loop_started', started
        sid = started['data']['session_id']
        pid = port.process.pid
        observed = call('inspect', dict(task_id=task))
        assert observed['data']['control']['state'] == 'local_authority'
        assert observed['data']['sessions'][0]['session_id'] == sid
        assert call('start', payload)['code'] == 'admission_rejected'
        assert call('stop', dict(task_id=task, session_id=sid))['data']['state'] == 'stopped'
        assert port.process.pid == pid
    assert all(s['state'] != 'active' for s in _native.loop_sessions(db))


def test_company_inspection_reuses_owner_and_preserves_multiple_task_identity(tmp_path, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'selected-loop-fixture-only')
    db = str(tmp_path / 'company.sqlite')
    employee = _native.create_agent(db, 'Writer')[0]
    port = LocalMcpLoop(db, 'anthropic', 'fixture')
    port.command = [sys.executable, FIXTURE, db]
    with TestClient(create_app(db, loop_port=port), base_url=ORIGIN) as client:
        def call(operation, payload):
            return client.post('/api/connections/v1/loops/' + operation,
                               headers={'Origin': ORIGIN}, json=payload)
        empty = call('inspect-company', {}).json()
        assert empty['scope'] == 'company'
        assert 'requested_task_id' not in empty
        assert empty['data']['sessions'] == []
        pid = port.process.pid
        expected = {}
        for number in range(2):
            task = _native.create_assigned_work(db, f'Work {number}', employee)[0]
            policy = _native.create_loop(db, f'Loop {number}', task, 2, 60)['id']
            _native.set_loop_enabled(db, policy, True)
            preview = call('preview', dict(task_id=task, policy_id=policy)).json()['data']
            started = call('start', dict(task_id=task, consent=preview, execution_consent=True)).json()
            sid = started['data']['session_id']
            expected[sid] = task
            call('stop', dict(task_id=task, session_id=sid))
        before = _native.loop_sessions(db)
        previews = port.previews.copy()
        result = call('inspect-company', {}).json()
        assert result['code'] == 'company_loops_inspected'
        assert {s['session_id']: s['preview']['task_id'] for s in result['data']['sessions']} == expected
        assert all(s['state'] == 'stopped' for s in result['data']['sessions'])
        assert result['data']['control']['state'] == 'local_authority'
        assert port.process.pid == pid
        assert port.previews == previews
        assert _native.loop_sessions(db) == before
        for task in expected.values():
            selected = call('inspect', dict(task_id=task)).json()['data']['sessions']
            assert all(s['preview']['task_id'] == task for s in selected)
        for payload in ({'task_id': employee}, {'execution_consent': True}, {'declared_source': 'owner'}):
            assert call('inspect-company', payload).status_code == 400
        assert client.post('/api/connections/v1/loops/inspect-company', json={}).status_code == 403
