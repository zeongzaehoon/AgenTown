"""Selected local MCP inspection never admits execution or provider calls."""
import asyncio
import copy
import json
import sys
from uuid import uuid4

import pytest

from llm_engine.application.inspect_selected_work import InspectSelectedWork
from llm_engine.connection_diagnostic import ConnectionDiagnostic, validated_inspection

TASK = '11111111-1111-4111-8111-111111111111'
RUN = '22222222-2222-4222-8222-222222222222'


def records():
    task = dict(id=TASK, title='Saved work', status='pending', assignees=[])
    run = dict(id=RUN, task_id=TASK, stage='implement', reporting_source='mcp',
               declared_source=None, started_at=1, ended_at=2, state='finished',
               outcome='reported_success', participants=[], execution=dict(
                   schema_version=1, run_id=RUN, input='Work', provider='fixture',
                   model='fixture', deadline_unix_ms=10, output='Available result',
                   error=None, quality='unverified'), skill=None, hook=None)
    return task, dict(schema_version=1, task=copy.deepcopy(task), attempts=[run])


def envelope(data):
    return dict(structuredContent=data, content=[dict(type='text', text=json.dumps(data))], isError=False)


@pytest.mark.parametrize('change', [
    lambda t, h: t.update(id=str(uuid4())),
    lambda t, h: h['task'].update(id=str(uuid4())),
    lambda t, h: h['task'].update(title='Different selection'),
    lambda t, h: h['attempts'][0].update(task_id=str(uuid4())),
    lambda t, h: h['attempts'][0]['execution'].update(run_id=str(uuid4())),
    lambda t, h: h['attempts'].append(copy.deepcopy(h['attempts'][0])),
    lambda t, h: h['attempts'][0].update(ended_at=None),
    lambda t, h: h['attempts'][0].update(started_at='1'),
    lambda t, h: h.update(extra='unexpected'),
    lambda t, h: h['attempts'][0]['execution'].update(error='Conflicting failure'),
    lambda t, h: h['attempts'][0].update(state='active', ended_at=None, outcome=None),
])
def test_rejects_inconsistent_or_malformed_records(change):
    task, history = records()
    change(task, history)
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK)


def test_empty_and_nullable_execution():
    task, history = records()
    history['attempts'][0]['execution'] = None
    assert validated_inspection(envelope(task), envelope(history), TASK).attempts[0].execution is None
    history['attempts'] = []
    assert validated_inspection(envelope(task), envelope(history), TASK).attempts == []


def command(tmp_path, mode):
    task, history = records()
    trace = tmp_path / 'inspection.jsonl'
    script = '''
import json, sys, time
mode, trace, task, history = sys.argv[1:]
for line in sys.stdin:
    msg = json.loads(line)
    with open(trace, 'a') as log: log.write(json.dumps(msg) + '\\n')
    if mode == 'timeout': time.sleep(60)
    if msg['method'] == 'initialize':
        result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}}
    elif msg['method'] == 'tools/call':
        data = json.loads(task if msg['params']['name'] == 'get_task' else history)
        if mode == 'mismatch': data['id' if 'id' in data else 'schema_version'] = 'invalid'
        result = {'structuredContent': data, 'content': [{'type': 'text', 'text': json.dumps(data)}], 'isError': mode == 'error'}
    else: continue
    print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}), flush=True)
'''
    return [sys.executable, '-u', '-c', script, mode, str(trace), json.dumps(task), json.dumps(history)], trace


@pytest.mark.parametrize('mode,status', [('success', 'passed'), ('error', 'failed'),
                                         ('mismatch', 'failed'), ('timeout', 'timeout')])
def test_installed_transport_only_reads_and_reaps(tmp_path, monkeypatch, mode, status):
    async def exercise():
        database = tmp_path / 'selected.db'
        database.write_bytes(b'unchanged')
        service = ConnectionDiagnostic(database, timeout=.5)
        service.command, trace = command(tmp_path, mode)
        processes = []
        spawn = asyncio.create_subprocess_exec
        async def capture(*args, **kwargs):
            process = await spawn(*args, **kwargs)
            processes.append(process)
            return process
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', capture)
        # No provider factory is part of this application/adapter path.
        import llm_engine.mcp_server as mcp
        monkeypatch.setattr(mcp, 'configured_provider', lambda *a, **k: pytest.fail('provider called'))
        result = await InspectSelectedWork(service).execute(TASK)
        assert result['status'] == ('success' if status == 'passed' else 'failure')
        assert result['requested_task_id'] == TASK
        if status == 'passed':
            assert result['inspection']['task']['id'] == TASK
            assert result['inspection']['attempts'][0]['execution']['output'] == 'Available result'
            assert result['inspection']['evidence'] == dict(
                source='installed_local_mcp', tools=['get_task', 'get_work_history_v1'],
                read_only=True, external_client_verified=False)
        else:
            assert result['inspection'] is None
        calls = [json.loads(line)['params'] for line in trace.read_text().splitlines()
                 if json.loads(line)['method'] == 'tools/call']
        if mode != 'timeout':
            assert calls == [dict(name='get_task', arguments=dict(task_id=TASK)),
                             dict(name='get_work_history_v1', arguments=dict(task_id=TASK, read_only=True))]
        assert database.read_bytes() == b'unchanged'
        assert service.active is None and processes[0].returncode is not None
        await service.close()
    asyncio.run(exercise())


def test_inspection_shares_admission_and_cancellation_cleanup(tmp_path):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'selected.db')
        service.command, trace = command(tmp_path, 'timeout')
        task = asyncio.create_task(InspectSelectedWork(service).execute(TASK))
        while not trace.exists():
            await asyncio.sleep(.01)
        assert (await service.run())['status'] == 'busy'
        assert (await service.run_shared_data())['status'] == 'busy'
        busy = await InspectSelectedWork(service).execute(TASK)
        assert busy['status'] == 'failure' and busy['code'] == 'inspection_busy' and busy['inspection'] is None
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.active is None
        await service.close()
    asyncio.run(exercise())


def test_api_fixed_identity_input_and_failure_envelope(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from llm_engine.application.inspect_selected_work import InspectionResult
    from llm_engine.web import create_app
    calls = []
    async def inspect(self, task_id):
        calls.append(task_id)
        return InspectionResult('failed', 'inspection_failed', 'Unavailable', 'Inspect explicitly again.')
    monkeypatch.setattr(ConnectionDiagnostic, 'inspect_work', inspect)
    class NoProvider:
        async def complete(self, *args, **kwargs):
            pytest.fail('provider called')
    origin = 'http://127.0.0.1:8765'
    with TestClient(create_app(str(tmp_path / 'api.db'), provider=NoProvider()), base_url=origin) as client:
        route = '/api/connections/v1/inspect-work'
        headers = {'Origin': origin}
        for data in ({}, {'task_id': 'invalid'}, {'task_id': None},
                     {'task_id': TASK, 'command': 'anything'}, {'task_id': TASK, 'read_only': False}):
            assert client.post(route, json=data, headers=headers).status_code == 400
        assert calls == []
        assert client.post(route, json={'task_id': TASK}).status_code == 403
        result = client.post(route, json={'task_id': TASK}, headers=headers)
        assert result.status_code == 200
        assert result.json() == dict(schema_version=1, requested_task_id=TASK, status='failure',
                                     code='inspection_failed', message='Unavailable',
                                     recovery='Inspect explicitly again.', inspection=None)
        assert calls == [TASK]


@pytest.mark.parametrize('change', [
    lambda result: result.update(isError=True),
    lambda result: result.update(content=[]),
    lambda result: result['content'][0].update(text='{}'),
    lambda result: result.update(structuredContent=[]),
])
def test_error_and_malformed_envelopes_never_succeed(change):
    task, history = records()
    result = envelope(task)
    change(result)
    with pytest.raises(Exception):
        validated_inspection(result, envelope(history), TASK)


@pytest.mark.parametrize('status', ['failed', 'busy', 'timeout', 'passed'])
def test_unconfirmed_port_result_never_exposes_inspection(status):
    from llm_engine.application.inspect_selected_work import (
        InspectionResult, LocalInspection, InspectedTask)
    class Port:
        async def inspect_work(self, task_id):
            # Even a contradictory failed result cannot leak successful evidence.
            inspection = (LocalInspection(InspectedTask(TASK, 'Saved', 'pending', []), [])
                          if status != 'passed' else None)
            return InspectionResult(status, 'inspection_unavailable', 'Unavailable',
                                    'Inspect explicitly again.', inspection)
    result = asyncio.run(InspectSelectedWork(Port()).execute(TASK))
    assert result['status'] == 'failure'
    assert result['inspection'] is None
