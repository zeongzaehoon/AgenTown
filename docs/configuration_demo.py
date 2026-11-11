"""Exercise installed configuration APIs and a real agentown-web restart.

Run with the installed product's Python: python configuration_demo.py --evidence DIR
Uses a new temporary database, no credentials and no execution endpoints.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


def exercise(evidence):
    evidence.mkdir(parents=True, exist_ok=True)
    executable = Path(sys.executable).parent / (
        'agentown-web.exe' if os.name == 'nt' else 'agentown-web')
    if not executable.is_file():
        raise RuntimeError('Run with the Python interpreter of an installed AgenTown environment.')
    with tempfile.TemporaryDirectory(prefix='agentown-configuration-') as directory:
        db = Path(directory) / 'configuration.sqlite3'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        command = [str(executable), '--database', str(db), '--port', str(port)]
        env = os.environ.copy()
        for key in ('PYTHONPATH', 'PYTHONHOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
                    'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'):
            env.pop(key, None)
        env['AWS_EC2_METADATA_DISABLED'] = 'true'
        server = None
        commands = []

        def request(path, fields=None, method=None):
            data = None if fields is None else json.dumps(fields).encode()
            req = Request(origin + path, data=data, method=method,
                          headers={'Origin': origin, 'Content-Type': 'application/json'})
            with urlopen(req, timeout=5) as response:
                return json.load(response)

        def python(code, *args):
            return json.loads(subprocess.check_output(
                [sys.executable, '-I', '-c', code, str(db), *args],
                cwd=directory, env=env, text=True, timeout=20))

        with (evidence / 'configuration-server.log').open('w') as log:
            def start():
                nonlocal server
                commands.append(command)
                server = subprocess.Popen(command, cwd=directory, env=env,
                                          stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise AssertionError('Server exited; inspect configuration-server.log')
                    try:
                        request('/api/config/v1/skills')
                        return
                    except (URLError, TimeoutError):
                        time.sleep(.1)
                raise AssertionError('Server startup timed out')

            def stop():
                server.terminate()
                server.wait(timeout=15)

            try:
                start()
                # The documented HTTP Skill example, followed by all three kinds.
                skill = request('/api/config/v1/skills',
                                {'name': 'Draft', 'instructions': 'Write a clear draft.'})
                refs = python('''import json, sys
from llm_engine import _native
print(json.dumps([_native.create_agent(sys.argv[1], 'Writer')[0],
                  _native.create_task(sys.argv[1], 'Draft announcement')[0]]))''')
                cases = [
                    ('skills', skill, {'name': 'Edited draft', 'instructions': 'Use short sentences.'}),
                    ('hooks', None, {'name': 'Draft hook', 'skill_id': skill['id'],
                                     'target_kind': 'agent', 'target_id': refs[0], 'event': 'task_created'}),
                    ('loops', None, {'name': 'Draft policy', 'task_id': refs[1],
                                     'max_iterations': 3, 'interval_seconds': 60}),
                ]
                saved = {}
                for plural, row, fields in cases:
                    base = '/api/config/v1/' + plural
                    if row is None:
                        row = request(base, fields)
                    assert row['enabled'] is False
                    path = base + '/' + row['id']
                    edited = {**fields, 'name': 'Edited ' + plural}
                    request(path, edited, 'PUT')
                    assert request(path + '/enabled', {'enabled': False}, 'PUT')['enabled'] is False
                    enabled = request(path + '/enabled', {'enabled': True}, 'PUT')
                    assert enabled['id'] == row['id'] and enabled['enabled'] is True
                    assert all(enabled[key] == value for key, value in edited.items())
                    assert request(path) == enabled
                    assert enabled in request(base)[plural]
                    saved[path] = enabled
                first_pid = server.pid
                stop()
                start()
                reopened = {path: request(path) for path in saved}
                assert reopened == saved
                # A new interpreter inspects the same IDs through the public Python API.
                inspected = python('''import json, sys
from llm_engine import configuration as c, _native
saved = json.loads(sys.argv[2])
rows = {path: getattr(c, 'show_' + {'skills':'skill','hooks':'hook','loops':'loop'}[path.split('/')[4]])(sys.argv[1], row['id']) for path, row in saved.items()}
assert _native.list_runs(sys.argv[1], sys.argv[3]) == []
print(json.dumps(rows))''', json.dumps(saved), refs[1])
                assert inspected == saved
                (evidence / 'configuration-restart.json').write_text(json.dumps({
                    'commands': commands, 'first_pid': first_pid, 'restarted_pid': server.pid,
                    'before_restart': saved, 'after_restart': reopened,
                    'new_python_process': inspected, 'runs': [],
                }, indent=2) + '\n')
                stop()
                shutil.copy2(db, evidence / 'configuration.sqlite3')
            finally:
                if server is not None and server.poll() is None:
                    server.kill()
                    server.wait(timeout=15)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    exercise(parser.parse_args().evidence.resolve())
