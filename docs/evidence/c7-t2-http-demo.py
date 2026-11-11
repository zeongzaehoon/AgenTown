"""Supplemental real HTTP evidence, explicitly NOT browser or live-provider validation."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import httpx

root = Path(__file__).resolve().parents[2]


def serve(command, url, log):
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            if httpx.get(url + '/').status_code == 200:
                return process
        except httpx.HTTPError:
            pass
        if process.poll() is not None:
            raise RuntimeError('server stopped')
        time.sleep(.1)
    process.kill()
    process.wait()
    raise RuntimeError('server did not start')


with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    db = directory / 'work.db'
    gate = directory / 'gate'
    command = [sys.executable, str(root / 'tests/web_browser_server.py'), str(db), str(port), str(gate)]
    with (root / 'docs/evidence/c7-t2-http-server.txt').open('w') as log:
        server = serve(command, url, log)
        try:
            with httpx.Client(base_url=url, headers={'Origin': url}) as client:
                for asset in ('/', '/static/app.js', '/static/style.css'):
                    response = client.get(asset)
                    assert response.status_code == 200
                    print('GET', asset, response.status_code, response.headers['content-type'])
                employee = client.post('/api/employees', json={'name': 'Writer'}).json()['id']
                task = client.post('/api/work', json={'employee': employee, 'input': 'Summarize: We agreed to ship the draft on Friday.'}).json()['id']
                gate.write_text('fail')
                first = client.post(f'/api/work/{task}/execute', json={'expected_runs': 0}).json()
                assert first['error'] == 'rate_limit'
                gate.write_text('success')
                second = client.post(f'/api/work/{task}/execute', json={'expected_runs': 1}).json()
                assert second['output'].endswith('END OF FULL RESULT')
                assert client.post(f'/api/work/{task}/execute', json={'expected_runs': 1}).status_code == 409
                before = client.post('/api/state', json={}).json()
                server.terminate()
                server.wait(timeout=15)
                server = serve(command, url, log)
                after = client.post('/api/state', json={}).json()
                assert after == before
                print(json.dumps({'validation': 'real HTTP; deterministic provider; no browser', 'restarted_history_matches': True, 'history': after}, indent=2))
        finally:
            server.terminate()
            server.wait(timeout=15)
        # Exercise the actual product web module, with missing model configuration.
        product = serve([sys.executable, '-m', 'llm_engine.web', '--database', str(db), '--port', str(port)], url, log)
        try:
            config = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            assert '--model' in config['configuration']
            assert len(config['work'][0]['attempts']) == 2
            print('Product web command: HTTP 200, packaged assets and retained history available; missing model guidance present.')
        finally:
            product.terminate()
            product.wait(timeout=15)
