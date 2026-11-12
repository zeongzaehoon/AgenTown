"""Real subprocess fixtures exercise explicit discovery and shared-data reads."""
import asyncio
import json
import sys

import pytest

from llm_engine.connection_diagnostic import ConnectionDiagnostic, REQUIRED_TOOLS
from llm_engine.connections import installed_server_command, connection_setup


def fixture_command(tmp_path, mode):
    trace = tmp_path / 'messages.jsonl'
    script = '''
import sys, json, time
mode, trace, names = sys.argv[1:]
if mode == 'startup':
    sys.stderr.write('private secret startup failure')
    sys.exit(1)
for line in sys.stdin:
    msg = json.loads(line)
    with open(trace, 'a') as log: log.write(json.dumps(msg) + '\\n')
    if mode == 'timeout': time.sleep(60)
    method = msg['method']
    if method == 'initialize':
        result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}}
    elif method == 'tools/list':
        tools = json.loads(names) if mode != 'missing' else []
        if 'cursor' not in msg['params']:
            result = {'tools': [], 'nextCursor': 'page2'}
        else: result = {'tools': [{'name': name} for name in tools]}
    else: continue
    print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}), flush=True)
'''
    return [sys.executable, '-u', '-c', script, mode, str(trace), json.dumps(sorted(REQUIRED_TOOLS))], trace


@pytest.mark.parametrize('mode,status', [('success', 'passed'), ('missing', 'failed'), ('startup', 'failed'), ('timeout', 'timeout')])
def test_subprocess_outcomes_cleanup_repeat(tmp_path, monkeypatch, mode, status):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'company.db', timeout=0.5)
        service.command, trace = fixture_command(tmp_path, mode)
        original = asyncio.create_subprocess_exec
        processes = []
        async def spawn(*args, **kwargs):
            process = await original(*args, **kwargs)
            processes.append(process)
            return process
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
        for _ in range(2):
            result = await service.run()
            assert result['status'] == status
            assert result['schema_version'] == 1
            assert 'secret' not in json.dumps(result)
            assert service.active is None
            assert processes[-1].returncode is not None
        if trace.exists():
            messages = [json.loads(line) for line in trace.read_text().splitlines()]
            assert {m['method'] for m in messages} <= {'initialize', 'notifications/initialized', 'tools/list'}
        await service.close()
    asyncio.run(exercise())


def test_busy_cancel_and_shutdown_reap(tmp_path, monkeypatch):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'company.db')
        service.command, trace = fixture_command(tmp_path, 'timeout')
        original = asyncio.create_subprocess_exec
        processes = []
        async def spawn(*args, **kwargs):
            process = await original(*args, **kwargs)
            processes.append(process)
            return process
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
        for shutdown in (False, True):
            task = asyncio.create_task(service.run())
            while not trace.exists():
                await asyncio.sleep(0.01)
            assert (await service.run())['status'] == 'busy'
            if shutdown:
                await service.close()
            else:
                task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert processes[-1].returncode is not None
            assert service.active is None
            trace.unlink()
    asyncio.run(exercise())


def test_fixed_command_matches_artifacts(tmp_path):
    db = tmp_path / 'company.db'
    command = installed_server_command(db)
    assert command == [sys.executable, '-I', '-m', 'llm_engine.mcp_server', '--database', str(db)]
    setup = connection_setup(db)
    for client in setup['clients']:
        if client['id'] not in ('codex', 'chatgpt'):
            entry = json.loads(client['platforms'][0]['configuration'])['mcpServers']['agentown']
            assert [entry['command'], *entry['args']] == command


def test_repeated_request_cancellation_releases_slot_after_cleanup(tmp_path):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'company.db')
        started, cleaning, finish_cleanup = (asyncio.Event() for _ in range(3))

        async def check():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await finish_cleanup.wait()

        service._check = check
        request = asyncio.create_task(service.run())
        await started.wait()
        request.cancel()
        await cleaning.wait()
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert (await service.run())['status'] == 'busy'
        active = service.active
        finish_cleanup.set()
        with pytest.raises(asyncio.CancelledError):
            await active
        await asyncio.sleep(0)
        assert service.active is None
        await service.close()

    asyncio.run(exercise())


def shared_command(tmp_path, mode):
    trace = tmp_path / 'shared.jsonl'
    script = '''
import sys, json, time
mode, trace = sys.argv[1:]
for line in sys.stdin:
    msg = json.loads(line)
    with open(trace, 'a') as log: log.write(json.dumps(msg) + '\\n')
    if mode == 'timeout': time.sleep(60)
    if msg['method'] == 'initialize':
        result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}}
    elif msg['method'] == 'tools/call':
        key = 'agents' if msg['params']['name'] == 'list_agents' else 'tasks'
        row = {'id': '11111111-1111-4111-8111-111111111111'}
        row.update({'name': 'private employee'} if key == 'agents' else
                   {'title': 'private work', 'status': 'pending', 'assignees': []})
        data = {key: [] if mode == 'empty' else [row]}
        if mode == 'malformed': data[key][0]['id'] = 'invalid'
        result = {'content': [{'type': 'text', 'text': json.dumps(data)}],
                  'structuredContent': data, 'isError': mode == 'error'}
    else: continue
    print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}), flush=True)
'''
    return [sys.executable, '-u', '-c', script, mode, str(trace)], trace


@pytest.mark.parametrize('mode,status', [('success', 'passed'), ('empty', 'passed'),
    ('malformed', 'failed'), ('error', 'failed'), ('timeout', 'timeout')])
def test_shared_data_exact_reads_validation_cleanup(tmp_path, monkeypatch, mode, status):
    async def exercise():
        database = tmp_path / 'company.db'
        database.write_bytes(b'unchanged sentinel')
        service = ConnectionDiagnostic(database, timeout=0.5)
        service.command, trace = shared_command(tmp_path, mode)
        original = asyncio.create_subprocess_exec
        processes = []
        async def spawn(*args, **kwargs):
            process = await original(*args, **kwargs)
            processes.append(process)
            return process
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
        assert not trace.exists()  # construction never admits a check
        result = await service.run_shared_data()
        assert result['status'] == status
        assert 'private' not in json.dumps(result)
        if status == 'passed':
            assert result['employee_count'] == result['work_count'] == (0 if mode == 'empty' else 1)
        else:
            assert 'employee_count' not in result and 'work_count' not in result
        messages = [json.loads(line) for line in trace.read_text().splitlines()]
        calls = [m for m in messages if m['method'] == 'tools/call']
        assert all(m['params']['arguments'] == {} for m in calls)
        assert [m['params']['name'] for m in calls] == (
            ['list_agents', 'list_tasks'] if status == 'passed' else
            [] if mode == 'timeout' else ['list_agents'])
        assert {m['method'] for m in messages} <= {'initialize', 'notifications/initialized', 'tools/call'}
        assert processes[0].returncode is not None and service.active is None
        assert database.read_bytes() == b'unchanged sentinel'
        await service.close()
    asyncio.run(exercise())


def test_shared_data_and_discovery_share_admission_and_cancel_cleanup(tmp_path):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'company.db')
        service.command, trace = shared_command(tmp_path, 'timeout')
        task = asyncio.create_task(service.run_shared_data())
        while not trace.exists():
            await asyncio.sleep(0.01)
        assert (await service.run())['status'] == 'busy'
        assert (await service.run_shared_data())['status'] == 'busy'
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.active is None
        await service.close()
    asyncio.run(exercise())


@pytest.mark.parametrize('change', [
    lambda r: r.update(isError=True),
    lambda r: r.update(content=[]),
    lambda r: r.update(structuredContent={'agents': [], 'extra': 1}),
    lambda r: r['content'][0].update(text='{}'),
    lambda r: r.update(structuredContent={'agents': 'bad'}),
])
def test_shared_data_rejects_invalid_envelope(change):
    from llm_engine.connection_diagnostic import validated_count, DiagnosticFailure
    result = {'content': [{'type': 'text', 'text': '{"agents": []}'}],
              'structuredContent': {'agents': []}, 'isError': False}
    change(result)
    with pytest.raises(DiagnosticFailure):
        validated_count(result, 'agents')


@pytest.mark.parametrize('change', [
    lambda rows: rows.append(dict(rows[0])),
    lambda rows: rows[0].update(status='completed'),
    lambda rows: rows[0].update(assignees=['invalid']),
    lambda rows: rows[0].update(assignees=['11111111-1111-4111-8111-111111111111'] * 2),
    lambda rows: rows[0].update(title=None),
    lambda rows: rows[0].update(output='private result'),
])
def test_shared_data_rejects_invalid_work_rows(change):
    from llm_engine.connection_diagnostic import validated_count, DiagnosticFailure
    data = {'tasks': [{'id': '11111111-1111-4111-8111-111111111111',
                       'title': 'private work', 'status': 'pending', 'assignees': []}]}
    change(data['tasks'])
    result = {'content': [{'type': 'text', 'text': json.dumps(data)}],
              'structuredContent': data, 'isError': False}
    with pytest.raises((DiagnosticFailure, ValueError)):
        validated_count(result, 'tasks')
