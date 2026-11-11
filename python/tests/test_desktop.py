"""Desktop owner protocol and unchanged API security; no real provider calls."""
import json
import io
import socket
import sys
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from llm_engine.desktop import (
    create_desktop_app, read_token, watch_owner,
)
from llm_engine import desktop

TOKEN = 'ab' * 32
IDENTITY = 'cd' * 32
ORIGIN = 'http://127.0.0.1:18765'


def test_identity_requires_private_token_and_exact_host(tmp_path):
    app = create_desktop_app(str(tmp_path / 'desktop.db'), TOKEN, IDENTITY, port=18765)
    with TestClient(app, base_url=ORIGIN) as client:
        assert client.get('/_desktop/ready').status_code == 403
        assert client.get('/_desktop/ready', headers={'X-AgenTown-Desktop': 'wrong'}).status_code == 403
        headers = {'X-AgenTown-Desktop': TOKEN}
        assert client.get('/_desktop/ready', headers={**headers, 'Host': 'evil.test'}).status_code == 403
        response = client.get('/_desktop/ready', headers=headers)
        assert response.json() == {'ready': True, 'identity': IDENTITY}
        assert response.headers['cache-control'] == 'no-store'
        assert TOKEN not in response.text
        assert client.post('/api/employees', json={'name': 'Blocked'}).status_code == 403
        assert client.post('/api/employees', json={'name': 'Blocked'}, headers={'Origin': 'http://evil.test'}).status_code == 403


def test_desktop_records_survive_adapter_restart(tmp_path):
    db = str(tmp_path / 'desktop.db')
    def launch(token):
        return TestClient(create_desktop_app(db, token, IDENTITY, port=18765), base_url=ORIGIN)
    with launch(TOKEN) as client:
        response = client.post('/api/employees', json={'name': 'Desktop writer'}, headers={'Origin': ORIGIN})
        assert response.status_code == 201
        saved_id = response.json()['id']
    with launch('cd' * 32) as client:
        state = client.post('/api/state', json={}, headers={'Origin': ORIGIN}).json()
        assert any(employee['id'] == saved_id for employee in state['employees'])
        assert client.get('/_desktop/ready', headers={'X-AgenTown-Desktop': TOKEN}).status_code == 403


@pytest.mark.parametrize('line', ['', TOKEN, 'x' * 64 + '\n', TOKEN + 'extra\n', TOKEN.upper() + '\n', json.dumps({'token': TOKEN, 'identity': TOKEN}) + '\n'])
def test_invalid_private_handshake(line):
    with pytest.raises(ValueError):
        read_token(io.StringIO(line))


def test_owner_eof_or_shutdown_byte_requests_exit():
    assert read_token(io.StringIO(json.dumps({'token': TOKEN, 'identity': IDENTITY}) + '\n')) == (TOKEN, IDENTITY)
    for value in ('', '\n'):
        class Server:
            should_exit = False
        server = Server()
        watch_owner(io.StringIO(value), server)
        assert server.should_exit


def test_startup_database_failure_is_actionable_and_redacted(tmp_path, monkeypatch, capsys):
    (tmp_path / 'index.html').write_text('desktop assets')
    monkeypatch.setattr(desktop, 'ASSETS', tmp_path)
    monkeypatch.setattr(desktop.sys, 'stdin', io.StringIO(
        json.dumps({'token': TOKEN, 'identity': IDENTITY}) + '\n'))

    def inaccessible_database(database):
        raise OSError(f'private database path {database}; {TOKEN}; {IDENTITY}')

    monkeypatch.setattr(desktop._native, 'history_snapshot', inaccessible_database)
    database = str(tmp_path / 'private.sqlite3')
    assert desktop.main(['--database', database, '--port', '18765']) == 2
    output = capsys.readouterr()
    assert 'Check application data access' in output.err
    assert not output.out
    assert all(secret not in output.err for secret in (database, TOKEN, IDENTITY))


def test_missing_packaged_workspace_fails_before_database_access(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(desktop, 'ASSETS', tmp_path)
    monkeypatch.setattr(desktop.sys, 'stdin', io.StringIO(
        json.dumps({'token': TOKEN, 'identity': IDENTITY}) + '\n'))

    def unexpected_database_access(database):
        pytest.fail('Missing resources must be rejected before database initialization')

    monkeypatch.setattr(desktop._native, 'history_snapshot', unexpected_database_access)
    assert desktop.main(['--database', str(tmp_path / 'desktop.db'), '--port', '18765']) == 2
    output = capsys.readouterr()
    assert 'Rebuild or reinstall AgenTown' in output.err
    assert not output.out
    assert TOKEN not in output.err and IDENTITY not in output.err


def test_startup_occupied_endpoint_preserves_existing_listener(tmp_path, monkeypatch, capsys):
    (tmp_path / 'index.html').write_text('desktop assets')
    monkeypatch.setattr(desktop, 'ASSETS', tmp_path)
    monkeypatch.setattr(desktop.sys, 'stdin', io.StringIO(
        json.dumps({'token': TOKEN, 'identity': IDENTITY}) + '\n'))
    monkeypatch.setattr(desktop._native, 'history_snapshot', lambda database: None)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        assert desktop.main(['--database', str(tmp_path / 'desktop.db'),
                             '--port', str(port)]) == 3
        # Startup failure must leave the unrelated endpoint open and untouched.
        assert listener.getsockname() == ('127.0.0.1', port)
        assert listener.fileno() >= 0
    output = capsys.readouterr()
    assert 'Close the conflicting application and retry' in output.err
    assert not output.out
    assert TOKEN not in output.err and IDENTITY not in output.err


@pytest.mark.parametrize('failure', ['not_started', 'exception', None])
def test_server_outcome_closes_listener_and_redacts_errors(tmp_path, monkeypatch, capsys, failure):
    (tmp_path / 'index.html').write_text('desktop assets')
    monkeypatch.setattr(desktop, 'ASSETS', tmp_path)
    monkeypatch.setattr(desktop.sys, 'stdin', io.StringIO(
        json.dumps({'token': TOKEN, 'identity': IDENTITY}) + '\n'))
    monkeypatch.setattr(desktop._native, 'history_snapshot', lambda database: None)
    monkeypatch.setattr(desktop, 'create_desktop_app', lambda *args, **kwargs: object())
    listeners = []

    class Server:
        started = failure is None

        def __init__(self, config):
            pass

        def run(self, *, sockets):
            listeners.extend(sockets)
            if failure == 'exception':
                raise RuntimeError(f'private failure {TOKEN} {IDENTITY}')

    monkeypatch.setitem(sys.modules, 'uvicorn', SimpleNamespace(
        Config=lambda *args, **kwargs: object(), Server=Server))
    # The owner watcher is covered separately; keep this outcome test synchronous.
    monkeypatch.setattr(desktop.threading, 'Thread', lambda **kwargs: SimpleNamespace(start=lambda: None))
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    assert desktop.main(['--database', str(tmp_path / 'desktop.db'), '--port', str(port)]) == (
        0 if failure is None else 4)
    assert len(listeners) == 1 and listeners[0].fileno() == -1
    output = capsys.readouterr()
    assert not output.out
    assert TOKEN not in output.err and IDENTITY not in output.err
    if failure:
        assert 'Restart AgenTown or reinstall its resources' in output.err
    else:
        assert not output.err
