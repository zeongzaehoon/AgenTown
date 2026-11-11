"""Installed entry point, assets and real killed-process recovery without a browser."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import shutil
import subprocess
import time

import httpx


def test_installed_web_assets_and_process_recovery(tmp_path, installed_package):
    python, runtime, env = installed_package
    evidence = Path(os.environ.get('LLM_ENGINE_PACKAGE_EVIDENCE', str(tmp_path / 'evidence')))
    evidence.mkdir(parents=True, exist_ok=True)
    db = tmp_path / 'installed-work.sqlite3'
    gate = tmp_path / 'gate'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    log = (evidence / 'installed-server.txt').open('w')
    server = None
    def start(fixture=False, secret=None):
        command = [str(python), '-I', str(runtime / 'server.py'), str(db), str(port), str(gate)] if fixture else [str(python.parent / ('agentown-web.exe' if os.name == 'nt' else 'agentown-web')), '--database', str(db), '--model', 'test-model', '--port', str(port)]
        child_env = dict(env)
        if secret:
            child_env['ANTHROPIC_API_KEY'] = secret
        child = subprocess.Popen(command, cwd=runtime, env=child_env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if httpx.get(url).status_code == 200:
                    return child
            except httpx.HTTPError:
                pass
            if child.poll() is not None:
                raise AssertionError('Installed server exited; inspect installed-server.txt')
            time.sleep(.1)
        child.kill(); child.wait()
        raise AssertionError('Installed server startup timeout')
    def post(path, data):
        return httpx.post(url + path, json=data, headers={'Origin': url}, timeout=140)
    def state():
        response = post('/api/state', {}); response.raise_for_status(); return response.json()
    try:
        server = start()
        assert 'ANTHROPIC_API_KEY' in state()['configuration']
        html = httpx.get(url).text
        references = re.findall(r'(?:src|href)="(/static/[^"]+)"', html)
        assert references and any(p.endswith('.js') for p in references) and any(p.endswith('.css') for p in references)
        assets = {}
        for reference in references:
            response = httpx.get(url + reference); assert response.status_code == 200
            assets[reference] = hashlib.sha256(response.content).hexdigest()
        (evidence / 'served-assets.json').write_text(json.dumps(assets, indent=2))
        employee = post('/api/employees', {'name': 'Installed writer'}).json()['id']
        task = post('/api/work', {'employee': employee, 'input': 'Summarize the Friday draft agreement.'}).json()['id']
        execute = f'/api/work/{task}/execute'
        assert post(execute, {'expected_runs': 0}).status_code == 409
        assert state()['work'][0]['attempts'] == []
        server.terminate(); server.wait(timeout=15)
        # A synthetic credential is used only to test redaction. No provider call.
        secret = 'synthetic-redaction-canary'
        server = start(secret=secret)
        assert post('/api/employees', {'name': secret}).status_code == 400
        assert secret not in json.dumps(state())
        server.terminate(); server.wait(timeout=15)
        server = start(fixture=True)
        gate.write_text('fail')
        assert post(execute, {'expected_runs': 0}).json()['error'] == 'rate_limit'
        assert post(execute, {'expected_runs': 0}).status_code == 409
        gate.write_text('success')
        output = post(execute, {'expected_runs': 1}).json()['output']
        assert output.endswith('END OF FULL RESULT')
        original = state()
        server.terminate(); server.wait(timeout=15)
        server = start(fixture=True)
        assert state() == original
        gate.unlink()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            pending = pool.submit(post, execute, {'expected_runs': 2})
            for _ in range(100):
                if gate.with_suffix('.calls').exists() and len(gate.with_suffix('.calls').read_text().splitlines()) == 3:
                    break
                time.sleep(.1)
            else:
                raise AssertionError('Provider request did not start')
            before = state()
            assert len(before['work'][0]['attempts']) == 3
            server.kill(); server.wait(timeout=15)
            killed = {'pid': server.pid, 'returncode': server.returncode, 'before': before}
            assert server.returncode != 0
            try:
                pending.result(timeout=10)
            except httpx.HTTPError:
                pass
        server = start(fixture=True)
        deadline = time.monotonic() + 130
        while True:
            recovered = state()
            if recovered['work'][0]['attempts'][-1]['error'] == 'interrupted':
                break
            assert time.monotonic() < deadline, 'Lease did not recover'
            time.sleep(1)
        assert recovered['work'][0]['attempts'][:2] == original['work'][0]['attempts']
        assert len(recovered['work'][0]['attempts']) == 3
        assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
        assert state() == recovered
        server.terminate(); server.wait(timeout=15)
        server = start(fixture=True)
        assert state() == recovered
        assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
        (evidence / 'process-recovery.json').write_text(json.dumps({'killed': killed, 'restarted': recovered, 'submissions': 3}, indent=2))
    finally:
        if server is not None and server.poll() is None:
            server.kill(); server.wait(timeout=15)
        log.close()
        if db.exists():
            shutil.copy2(db, evidence / 'installed-work.sqlite3')
    assert secret not in db.read_bytes().decode('utf-8', errors='ignore')
    assert secret not in (evidence / 'installed-server.txt').read_text()
