"""Explicit recovery through real MCP/Rust, with deterministic historical leases."""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
from uuid import uuid4

import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.application.reconcile_selected_work import SelectedWorkRecoveryRequest as Request
from llm_engine.local_mcp_recovery import LocalMcpRecovery
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}
ENDPOINT = '/api/connections/v1/reconcile-work'
TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


def seed(db):
    agent = _native.create_agent(str(db), 'Writer')[0]
    task = _native.create_assigned_work(str(db), 'Draft', agent)[0]
    other = _native.create_assigned_work(str(db), 'Other expired work', agent)[0]
    live = _native.create_assigned_work(str(db), 'Live work', agent)[0]
    _native.start_execution(str(db), live, agent, 'Live input', 'test-fixture', 'fixture')
    with sqlite3.connect(db) as conn:
        for work in (task, other):
            run = str(uuid4())
            conn.execute('INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL, NULL)',
                         (run, work, 'text_execution', 'test-fixture', 1000))
            conn.execute('INSERT INTO run_participants VALUES (?, ?)', (run, agent))
            conn.execute('INSERT INTO executions VALUES (?, ?, ?, ?, ?, NULL, NULL)',
                         (run, 'Expired input', 'test-fixture', 'fixture', 121000))
    return task, other, live


def adapter(db):
    port = LocalMcpRecovery(db)
    port.command = [sys.executable, str(Path(__file__).with_name('mcp_fixture_server.py')), str(db), '--forbid-provider']
    return port


def test_explicit_recovery_preserves_live_and_never_executes(tmp_path):
    db = tmp_path / 'recovery.sqlite'
    task, other, live = seed(db)
    before = _native.history_snapshot_read_only(str(db))
    assert all(run[6] == 'active' for _, runs in before[1] for run in runs)
    port = adapter(db)
    with TestClient(create_app(db, recovery_port=port), base_url=ORIGIN) as client:
        # Ordinary inspection remains read-only even with expired historical rows.
        from llm_engine.connection_diagnostic import ConnectionDiagnostic
        diagnostic = ConnectionDiagnostic(db)
        diagnostic.command = port.command
        inspected = asyncio.run(diagnostic.inspect_work(task))
        assert inspected.status == 'passed'
        assert inspected.inspection.attempts[0].state == 'active'
        assert _native.history_snapshot_read_only(str(db)) == before
        result = client.post(ENDPOINT, headers=HEADERS, json=dict(task_id=task, recovery_consent=True)).json()
        assert result['status'] == 'confirmed'
        assert result['code'] == 'reconciliation_confirmed'
        assert result['evidence']['mutation_scope'] == 'snapshot_expired_leases'
        assert result['inspection']['task']['id'] == task
        assert result['inspection']['attempts'][0]['execution']['error'] == 'interrupted'
        assert result['inspection']['attempts'][0]['state'] == 'finished'
    after = _native.history_snapshot_read_only(str(db))
    assert len(before[2]) == len(after[2]) == 3
    assert {r[0] for _, runs in before[1] for r in runs} == {r[0] for _, runs in after[1] for r in runs}
    rows = {work[0]: runs for work, runs in after[1]}
    assert rows[task][0][6] == rows[other][0][6] == 'finished'
    assert rows[live][0][6] == 'active'
    assert sum(row[6] == 'interrupted' for row in after[2]) == 2
    assert not db.with_suffix('.sqlite.dispatches').exists()


def test_input_and_origin_never_dispatch(tmp_path):
    class Forbidden:
        async def reconcile_work(self, request):
            raise AssertionError('Invalid input dispatched')
    data = dict(task_id=TASK, recovery_consent=True)
    with TestClient(create_app(tmp_path / 'invalid.sqlite', recovery_port=Forbidden()), base_url=ORIGIN) as client:
        for invalid in ({}, {'task_id': TASK}, {**data, 'recovery_consent': False},
                        {**data, 'recovery_consent': 1}, {**data, 'recovery_consent': 'true'},
                        {**data, 'task_id': TASK.upper()}, {**data, 'task_id': 'bad'},
                        {**data, 'read_only': False}, {**data, 'model': 'forbidden'}):
            assert client.post(ENDPOINT, headers=HEADERS, json=invalid).status_code == 400
        for raw, status in [(b'{', 400), (b'null', 400), (b'[]', 400), (b'\xff', 400), (b'x' * 120001, 413)]:
            assert client.post(ENDPOINT, headers={**HEADERS, 'Content-Type': 'application/json'}, content=raw).status_code == status
        for headers in ({}, {'Origin': 'https://other.example'}, {**HEADERS, 'Sec-Fetch-Site': 'cross-site'}):
            assert client.post(ENDPOINT, headers=headers, json=data).status_code == 403


def test_missing_task_error_is_conservative_without_mutation(tmp_path):
    db = tmp_path / 'unknown.sqlite'
    seed(db)
    before = _native.history_snapshot_read_only(str(db))
    result = asyncio.run(adapter(db).reconcile_work(Request(TASK, True)))
    assert result.status == 'uncertain' and result.code == 'delivery_uncertain'
    assert _native.history_snapshot_read_only(str(db)) == before


def test_pre_dispatch_unavailable(tmp_path):
    port = LocalMcpRecovery(tmp_path / 'unused.sqlite')
    port.command = [str(tmp_path / 'missing-command')]
    result = asyncio.run(port.reconcile_work(Request(TASK, True)))
    assert result.status == 'unavailable' and result.code == 'transport_unavailable'


@pytest.mark.parametrize('receipt', ['lost', 'malformed', 'wrong_task', 'tool_error', 'timeout'])
def test_post_dispatch_uncertainty_never_replays(tmp_path, receipt):
    db = tmp_path / 'uncertain.sqlite'
    task, _, _ = seed(db)
    script = tmp_path / 'transport.py'
    marker = tmp_path / 'dispatches'
    script.write_text('''import json, sys, time
from pathlib import Path
from llm_engine import _native
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1:
        print(json.dumps(dict(jsonrpc='2.0', id=1, result=dict(protocolVersion='2025-03-26', capabilities=dict(tools={})))), flush=True)
    if message.get('id') == 2:
        assert message['params']['name'] == 'get_work_history_v1'
        assert message['params']['arguments']['read_only'] is False
        with Path(sys.argv[2]).open('a') as log: log.write('dispatch\\n')
        _native.history_snapshot(sys.argv[1])
        if sys.argv[3] == 'lost': break
        if sys.argv[3] == 'timeout': time.sleep(10)
        result = {'content': [], 'structuredContent': {}}
        if sys.argv[3] == 'tool_error': result = {'isError': True, 'content': [{'type': 'text', 'text': 'Operation rejected (storage); inspect work history.'}]}
        if sys.argv[3] == 'wrong_task':
            data = {'schema_version': 1, 'task': {'id': sys.argv[4], 'title': 'Other', 'status': 'pending', 'assignees': []}, 'attempts': []}
            result = {'structuredContent': data, 'content': [{'type': 'text', 'text': json.dumps(data)}]}
        print(json.dumps(dict(jsonrpc='2.0', id=2, result=result)), flush=True)
''')
    port = LocalMcpRecovery(db, timeout=2)
    port.command = [sys.executable, str(script), str(db), str(marker), receipt, TASK]
    with TestClient(create_app(db, recovery_port=port), base_url=ORIGIN) as client:
        result = client.post(ENDPOINT, headers=HEADERS, json=dict(task_id=task, recovery_consent=True)).json()
    assert result['status'] == 'uncertain' and result['code'] == 'delivery_uncertain'
    assert result['inspection'] is None
    assert marker.read_text() == 'dispatch\n'
    assert port.active is None
    assert sum(row[6] == 'interrupted' for row in _native.history_snapshot_read_only(str(db))[2]) == 2


def test_installed_web_recovery_without_credentials(tmp_path, installed_package):
    """Real agentown-web -> installed MCP -> persisted attempts, outside checkout."""
    import inspect
    import os
    import socket
    import subprocess
    import time
    import httpx

    python, runtime, env = installed_package
    db = tmp_path / 'installed-recovery.sqlite'
    child_env = dict(env)
    for key in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'):
        child_env.pop(key, None)
    seed_code = 'import sqlite3\nfrom uuid import uuid4\nfrom llm_engine import _native\n' + inspect.getsource(seed)
    seeded = subprocess.run([str(python), '-I', '-c', seed_code + '\nimport sys, json\nprint(json.dumps(seed(sys.argv[1])))', str(db)],
                            cwd=runtime, env=child_env, text=True, capture_output=True, check=True)
    task, other, live = json.loads(seeded.stdout)
    def snapshot():
        result = subprocess.run([str(python), '-I', '-c',
            'import json, sys; from llm_engine import _native; print(json.dumps(_native.history_snapshot_read_only(sys.argv[1])))', str(db)],
            cwd=runtime, env=child_env, text=True, capture_output=True, check=True)
        return json.loads(result.stdout)
    before = snapshot()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    command = python.parent / ('agentown-web.exe' if os.name == 'nt' else 'agentown-web')
    with (tmp_path / 'installed-recovery-server.log').open('w') as log:
        server = subprocess.Popen([str(command), '--database', str(db), '--port', str(port)],
                                  cwd=runtime, env=child_env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                try:
                    if httpx.post(url + '/api/connections/v1', headers={'Origin': url}, json={}).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                assert server.poll() is None, 'Installed server exited'
                time.sleep(.1)
            else:
                raise AssertionError('Installed server startup timeout')
            inspected = httpx.post(url + '/api/connections/v1/inspect-work', headers={'Origin': url},
                                   json={'task_id': task}, timeout=30)
            assert inspected.status_code == 200 and inspected.json()['status'] == 'success'
            assert inspected.json()['inspection']['attempts'][0]['state'] == 'active'
            assert snapshot() == before
            response = httpx.post(url + ENDPOINT, headers={'Origin': url},
                                  json=dict(task_id=task, recovery_consent=True), timeout=30)
            assert response.status_code == 200
            receipt = response.json()
            assert receipt['status'] == 'confirmed'
            assert receipt['inspection']['attempts'][0]['execution']['error'] == 'interrupted'
            after = snapshot()
            assert {row[0] for row in before[2]} == {row[0] for row in after[2]}
            assert len(before[2]) == len(after[2]) == 3
            rows = {work[0]: runs for work, runs in after[1]}
            assert rows[task][0][6] == rows[other][0][6] == 'finished'
            assert rows[live][0][6] == 'active'
            assert sum(row[6] == 'interrupted' for row in after[2]) == 2
            artifact = {'before': before, 'response': receipt, 'after': after,
                        'new_runs': 0, 'provider_calls': 0,
                        'provider_evidence': 'No credentials or model; history tool never constructs a provider. Deterministic adapter test forbids provider construction.'}
            evidence = Path(os.environ.get('LLM_ENGINE_PACKAGE_EVIDENCE', str(tmp_path)))
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / 'selected-work-recovery.json').write_text(json.dumps(artifact, indent=2))
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait(timeout=15)
