"""Run the packaged adapter outside the checkout, using the installed wheel fixture."""
import json
import re
import socket
import subprocess
import time

import httpx

TOKEN = 'ab' * 32
IDENTITY = 'cd' * 32


def test_installed_desktop_owner_lifecycle(tmp_path, installed_package):
    python, runtime, env = installed_package
    database = tmp_path / 'desktop.sqlite3'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    url = f'http://127.0.0.1:{port}'

    def start():
        child = subprocess.Popen(
            [str(python), '-I', '-m', 'llm_engine.desktop', '--database', str(database), '--port', str(port)],
            cwd=runtime, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        child.stdin.write(json.dumps({'token': TOKEN, 'identity': IDENTITY}) + '\n')
        child.stdin.flush()
        return child

    def stop(child):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()

    saved = None
    for attempt in range(2):
        child = start()
        try:
            deadline = time.monotonic() + 15
            while True:
                assert child.poll() is None, 'Desktop service exited before readiness'
                try:
                    ready = httpx.get(url + '/_desktop/ready', headers={'X-AgenTown-Desktop': TOKEN}, timeout=.5)
                    if ready.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                assert time.monotonic() < deadline, 'Desktop readiness timed out'
                time.sleep(.05)
            assert ready.json() == {'ready': True, 'identity': IDENTITY}
            workspace = httpx.get(url)
            assert workspace.status_code == 200
            references = re.findall(r'(?:src|href)="(/static/[^\"]+)"', workspace.text)
            assert any(reference.endswith('.js') for reference in references), 'React bundle missing'
            for reference in references:
                asset = httpx.get(url + reference)
                assert asset.status_code == 200
                assert asset.content, f'Empty desktop asset: {reference}'
            headers = {'Origin': url}
            if attempt == 0:
                response = httpx.post(url + '/api/employees', headers=headers, json={'name': 'Persistent desktop employee'})
                assert response.status_code == 201
                saved = response.json()['id']
            else:
                state = httpx.post(url + '/api/state', headers=headers, json={}).json()
                assert any(employee['id'] == saved for employee in state['employees'])
            duplicate = start()
            try:
                out, err = duplicate.communicate(timeout=10)
                assert duplicate.returncode == 3
                assert 'endpoint is unavailable' in err
                assert TOKEN not in out + err and IDENTITY not in out + err
            finally:
                stop(duplicate)
            if attempt == 0:
                child.stdin.write('\n')
                child.stdin.flush()
            else:
                child.stdin.close()
            assert child.wait(timeout=10) == 0
            output = child.stdout.read() + child.stderr.read()
            assert TOKEN not in output and IDENTITY not in output
        finally:
            stop(child)


def test_installed_desktop_invalid_identity_is_safe(tmp_path, installed_package):
    python, runtime, env = installed_package
    result = subprocess.run(
        [str(python), '-I', '-m', 'llm_engine.desktop', '--database', str(tmp_path / 'invalid.db'), '--port', '18765'],
        input='private-invalid-token\n', capture_output=True, text=True, cwd=runtime, env=env, timeout=10,
    )
    assert result.returncode == 2
    assert 'Cannot initialize desktop service' in result.stderr
    assert 'private-invalid-token' not in result.stdout + result.stderr
