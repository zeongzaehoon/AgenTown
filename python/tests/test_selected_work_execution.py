"""Deterministic API -> stdio MCP -> Rust persistence; never live provider I/O."""
import asyncio
from pathlib import Path
import sys

import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.application.execute_selected_work import SelectedWorkExecutionRequest as Request
from llm_engine.local_mcp_execution import LocalMcpExecution, DECLARED_SOURCE
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}
TASK = '11111111-1111-4111-8111-111111111111'


def adapter(db, model='fixture'):
    port = LocalMcpExecution(db, 'anthropic', model, timeout=20)
    port.command = [sys.executable, str(Path(__file__).with_name('mcp_fixture_server.py')), str(db)]
    return port


def saved(db):
    agent = _native.create_agent(str(db), 'Writer')[0]
    return _native.create_assigned_work(str(db), 'Draft a greeting', agent)[0]


@pytest.mark.parametrize('field,value', [('task_id', TASK.upper()), ('task_id', 'bad'),
    ('expected_runs', True), ('expected_runs', -1), ('expected_runs', 0.0),
    ('resubmission_consent', 1), ('resubmission_consent', 'true')])
def test_request_strict_types(field, value):
    data = dict(task_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expected_runs=0, resubmission_consent=False)
    if field == 'task_id' and value == TASK:
        value = data['task_id'].upper()
    data[field] = value
    with pytest.raises(ValueError):
        Request(**data)


def test_api_persists_initial_and_explicit_resubmission(tmp_path):
    db = tmp_path / 'product.sqlite'
    task = saved(db)
    port = adapter(db)
    with TestClient(create_app(db, model='fixture', execution_port=port), base_url=ORIGIN) as client:
        def execute(count, consent):
            reply = client.post('/api/connections/v1/execute-work', headers=HEADERS,
                json=dict(task_id=task, expected_runs=count, resubmission_consent=consent))
            assert reply.status_code == 200
            return reply.json()
        initial = execute(0, False)
        assert initial['status'] == 'completed'
        assert initial['execution']['output'] == 'Fixture result: Draft a greeting'
        assert initial['execution']['quality'] == 'unverified'
        assert execute(1, False)['code'] == 'admission_rejected'
        assert execute(0, True)['code'] == 'admission_rejected'
        retry = execute(1, True)
        assert retry['status'] == 'completed'
        assert retry['execution']['run_id'] != initial['execution']['run_id']
    _, tasks, executions = _native.history_snapshot_read_only(str(db))
    runs = next(runs for work, runs in tasks if work[0] == task)
    assert len(runs) == len(executions) == 2
    assert all(row[6] == 'finished' for row in runs)
    assert dict(_native.execution_sources(str(db))) == {
        initial['execution']['run_id']: DECLARED_SOURCE, retry['execution']['run_id']: DECLARED_SOURCE}
    assert db.with_suffix('.sqlite.dispatches').read_text().splitlines() == ['dispatch', 'dispatch']


def test_concurrent_processes_rust_admission(tmp_path):
    db = tmp_path / 'concurrent.sqlite'
    task = saved(db)
    async def scenario():
        first, second = adapter(db, 'slow'), adapter(db, 'slow')
        # Separate adapters/processes cannot rely on an in-memory admission guard.
        results = await asyncio.gather(*(port.execute_work(Request(task, 0, False)) for port in (first, second)))
        assert sum(r.status == 'completed' for r in results) == 1
        assert next(r.code for r in results if r.status != 'completed') == 'admission_rejected'
    asyncio.run(scenario())
    assert len(_native.history_snapshot_read_only(str(db))[2]) == 1
    assert db.with_suffix('.sqlite.dispatches').read_text() == 'dispatch\n'


def test_api_rejects_override_and_missing_configuration(tmp_path):
    db = tmp_path / 'missing.sqlite'
    task = saved(db)
    port = LocalMcpExecution(db, 'anthropic', None, configured=False)
    with TestClient(create_app(db, execution_port=port), base_url=ORIGIN) as client:
        data = dict(task_id=task, expected_runs=0, resubmission_consent=False)
        for extra in ('provider', 'model', 'credentials', 'declared_source'):
            assert client.post('/api/connections/v1/execute-work', headers=HEADERS,
                               json={**data, extra: 'forbidden'}).status_code == 400
        assert client.post('/api/connections/v1/execute-work', headers=HEADERS, json=data).json()['code'] == 'configuration_unavailable'
        assert client.post('/api/connections/v1/execute-work', json=data).status_code == 403
    assert not _native.history_snapshot_read_only(str(db))[2]


def test_delivery_lost_after_persisting_never_replays(tmp_path):
    db = tmp_path / 'uncertain.sqlite'
    task = saved(db)
    script = tmp_path / 'lost.py'
    script.write_text('''import json, sys
from llm_engine import _native
from llm_engine.execution import record
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1:
        print(json.dumps(dict(jsonrpc='2.0', id=1, result=dict(protocolVersion='2025-03-26', capabilities=dict(tools={})))), flush=True)
    if message.get('id') == 2:
        args = message['params']['arguments']
        row = _native.start_mcp_execution(sys.argv[1], args['task_id'], args['provider'], args['model'], args['expected_runs'], args['resubmission_consent'], args['declared_source'])
        _native.finish_execution(sys.argv[1], row[0], 'Persisted before delivery loss', None)
        break
''')
    port = adapter(db)
    port.command = [sys.executable, str(script), str(db)]
    with TestClient(create_app(db, model='fixture', execution_port=port), base_url=ORIGIN) as client:
        result = client.post('/api/connections/v1/execute-work', headers=HEADERS,
            json=dict(task_id=task, expected_runs=0, resubmission_consent=False)).json()
    assert result['status'] == 'uncertain'
    assert result['code'] == 'delivery_uncertain'
    _, tasks, executions = _native.history_snapshot_read_only(str(db))
    assert len(executions) == 1
    assert executions[0][5] == 'Persisted before delivery loss'
    assert dict(_native.execution_sources(str(db)))[executions[0][0]] == DECLARED_SOURCE
    assert len(next(runs for work, runs in tasks if work[0] == task)) == 1


def test_unavailable_before_dispatch_and_timeout(tmp_path):
    port = adapter(tmp_path / 'unused.sqlite')
    port.command = [str(tmp_path / 'nonexistent')]
    assert asyncio.run(port.execute_work(Request(TASK, 0, False))).code == 'transport_unavailable'
    script = tmp_path / 'silent.py'
    script.write_text('import time; time.sleep(10)')
    port.command = [sys.executable, str(script)]
    port.timeout = 0.1
    assert asyncio.run(port.execute_work(Request(TASK, 0, False))).code == 'transport_unavailable'
    assert port.active is None


def test_api_strict_input_never_dispatches(tmp_path):
    class NoDispatch:
        async def execute_work(self, request):
            raise AssertionError('Invalid input must not reach the execution port')
    with TestClient(create_app(tmp_path / 'strict.sqlite', execution_port=NoDispatch()), base_url=ORIGIN) as client:
        data = dict(task_id=TASK, expected_runs=0, resubmission_consent=False)
        invalid = [{}, {k: v for k, v in data.items() if k != 'resubmission_consent'},
                   {**data, 'expected_runs': True}, {**data, 'expected_runs': -1},
                   {**data, 'expected_runs': 0.0}, {**data, 'resubmission_consent': 'true'},
                   {**data, 'task_id': 'bad'}]
        for value in invalid:
            assert client.post('/api/connections/v1/execute-work', headers=HEADERS, json=value).status_code == 400
        for raw, status in [(b'{', 400), (b'[]', 400), (b'null', 400), (b'\xff', 400), (b'x' * 120001, 413)]:
            assert client.post('/api/connections/v1/execute-work', headers={**HEADERS, 'Content-Type': 'application/json'}, content=raw).status_code == status


def test_dispatched_timeout_busy_and_cleanup(tmp_path):
    script = tmp_path / 'no-reply.py'
    marker = tmp_path / 'sent'
    script.write_text('''import json, sys, time
from pathlib import Path
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1:
        print(json.dumps(dict(jsonrpc='2.0', id=1, result=dict(protocolVersion='2025-03-26', capabilities=dict(tools={})))), flush=True)
    if message.get('id') == 2:
        Path(sys.argv[1]).write_text('one dispatch')
        time.sleep(10)
''')
    async def scenario():
        port = adapter(tmp_path / 'unused.sqlite')
        port.command = [sys.executable, str(script), str(marker)]
        port.timeout = 1
        task = asyncio.create_task(port.execute_work(Request(TASK, 0, False)))
        for _ in range(100):
            if marker.exists():
                break
            await asyncio.sleep(0.005)
        assert marker.exists()
        assert (await port.execute_work(Request(TASK, 0, False))).code == 'execution_busy'
        result = await task
        assert result.status == 'uncertain' and result.code == 'delivery_uncertain'
        assert port.active is None
        assert marker.read_text() == 'one dispatch'
        await port.close()
        assert (await port.execute_work(Request(TASK, 0, False))).code == 'execution_busy'
    asyncio.run(scenario())


def test_mcp_configuration_rejection_creates_no_attempt(tmp_path):
    db = tmp_path / 'server-config.sqlite'
    task = saved(db)
    port = adapter(db)
    port.command.append('--forbid-provider')
    result = asyncio.run(port.execute_work(Request(task, 0, False)))
    assert result.status == 'rejected' and result.code == 'configuration_unavailable'
    assert not _native.history_snapshot_read_only(str(db))[2]
    assert not db.with_suffix('.sqlite.dispatches').exists()
