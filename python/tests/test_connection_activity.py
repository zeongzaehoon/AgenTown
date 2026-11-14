"""Historical Connections reads against Rust-backed deterministic fixtures."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
from uuid import uuid4

import httpx
import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.connection_activity import NativeConnectionActivity
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
ENDPOINT = '/api/connections/v1/activity'
HEADERS = {'Origin': ORIGIN}


def fixture_database(db):
    employee = _native.create_agent(str(db), 'Fixture writer')[0]
    expected = []
    labels = ['codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt',
              'Codex', 'future-client', None, 'agentown-local-product']
    for index, label in enumerate(labels):
        task = _native.create_assigned_work(str(db), 'Fixture work', employee)[0]
        if label is None:
            run = _native.start_run(str(db), task, 'implement', 'codex', [employee])
            _native.finish_run(str(db), run[0], 'interruption')
        else:
            run = _native.start_mcp_execution(str(db), task, 'anthropic', 'fixture', 0, False, label)
            if index % 2:
                _native.finish_execution(str(db), run[0], None, 'provider_error')
            elif index != 0:
                _native.finish_execution(str(db), run[0], 'Fixture output', None)
        expected.append((run[0], task, label))
    # Add expired unfinished history directly, as a deterministic fixture only.
    task = _native.create_assigned_work(str(db), 'Expired fixture', employee)[0]
    run = str(uuid4())
    with sqlite3.connect(db) as connection:
        connection.execute('INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL, NULL)',
                           (run, task, 'text_execution', 'anthropic', 1000))
        connection.execute('INSERT INTO run_participants VALUES (?, ?)', (run, employee))
        connection.execute('INSERT INTO executions VALUES (?, ?, ?, ?, ?, NULL, NULL)',
                           (run, 'Fixture', 'anthropic', 'fixture', 121000))
        connection.execute('INSERT INTO execution_sources VALUES (?, ?)', (run, 'codex'))
    expected.append((run, task, 'codex'))
    return expected


def snapshot(db):
    with sqlite3.connect(db) as connection:
        return '\n'.join(connection.iterdump())


def test_persisted_activity_is_bounded_honest_and_nonmutating(tmp_path):
    db = tmp_path / 'activity.sqlite'
    expected = fixture_database(db)
    before = snapshot(db)
    with TestClient(create_app(db), base_url=ORIGIN) as client:
        result = client.post(ENDPOINT, headers=HEADERS, json={'limit': 100})
        assert result.status_code == 200
        assert result.headers['cache-control'] == 'no-store'
        payload = result.json()
        attempts = payload['attempts']
        assert len(attempts) == 9
        assert [(a['started_at'], a['run_id']) for a in attempts] == sorted(
            ((a['started_at'], a['run_id']) for a in attempts), reverse=True)
        by_run = {a['run_id']: a for a in attempts}
        for run, task, label in expected:
            if label == 'agentown-local-product':
                assert run not in by_run
                continue
            assert by_run[run]['task_id'] == task
            assert by_run[run]['declared_source'] == label
            assert by_run[run]['integration'] == (label if label in {
                'codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt'} else None)
        assert by_run[expected[0][0]]['state'] == 'active'
        assert by_run[expected[0][0]]['outcome'] is None
        assert any(a['outcome'] == 'failure' for a in attempts)
        assert any(a['outcome'] == 'interruption' for a in attempts)
        assert any(a['outcome'] == 'reported_success' for a in attempts)
        assert payload['evidence'] == {
            'read_only': True, 'source': 'persisted_run_records',
            'source_labels': 'untrusted_historical_metadata',
            'current_connection_verified': False,
            'authenticated_client_identity_verified': False,
            'quality_approved': False, 'local_product_attempts_excluded': True,
        }
        assert client.post(ENDPOINT, headers=HEADERS, json={'limit': 1}).json()['attempts'] == attempts[:1]
        assert client.post(ENDPOINT, headers=HEADERS, json={'limit': 100}).json() == payload
    assert snapshot(db) == before


def test_empty_and_native_failures(tmp_path, monkeypatch):
    db = tmp_path / 'empty.sqlite'
    _native.create_agent(str(db), 'Fixture')
    with TestClient(create_app(db), base_url=ORIGIN) as client:
        assert client.post(ENDPOINT, headers=HEADERS, json={'limit': 10}).json()['attempts'] == []
        def fail(*args):
            raise RuntimeError('private database path and secret')
        for name in ('history_snapshot_read_only', 'execution_sources'):
            with monkeypatch.context() as patch:
                patch.setattr(_native, name, fail)
                response = client.post(ENDPOINT, headers=HEADERS, json={'limit': 10})
                assert response.status_code == 503
                assert response.json() == {'error': 'Recorded activity is unavailable. Try inspection again.'}
                assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('body', [{}, {'limit': True}, {'limit': 0}, {'limit': 101},
    {'limit': 1.0}, {'limit': '1'}, {'limit': None}, {'limit': 1, 'source': 'codex'}, [], None])
def test_invalid_requests_do_not_read(tmp_path, body):
    class Forbidden:
        def recent_attempts(self, limit):
            pytest.fail('invalid requests must not query history')
    with TestClient(create_app(tmp_path / 'unused', activity_port=Forbidden()), base_url=ORIGIN) as client:
        assert client.post(ENDPOINT, headers={**HEADERS, 'Content-Type': 'application/json'}, content=json.dumps(body)).status_code == 400


def test_transport_boundary(tmp_path):
    class Empty:
        def recent_attempts(self, limit):
            return []
    with TestClient(create_app(tmp_path / 'unused', activity_port=Empty()), base_url=ORIGIN) as client:
        assert client.post(ENDPOINT, json={'limit': 1}).status_code == 403
        assert client.post(ENDPOINT, headers={'Origin': 'https://foreign.example'}, json={'limit': 1}).status_code == 403
        assert client.get(ENDPOINT).status_code == 405
        assert client.post(ENDPOINT, headers={**HEADERS, 'Content-Type': 'application/json'}, content='{').status_code == 400
        assert client.post(ENDPOINT, headers={**HEADERS, 'Content-Type': 'application/json'}, content=' ' * 120001).status_code == 413


def test_missing_database_is_not_created(tmp_path):
    from llm_engine.ports.connection_activity import ConnectionActivityUnavailable
    db = tmp_path / 'missing.sqlite'
    with pytest.raises(ConnectionActivityUnavailable):
        NativeConnectionActivity(str(db)).recent_attempts(10)
    assert not db.exists()


def test_activity_remains_readable_while_writer_holds_reserved_lock(tmp_path):
    db = tmp_path / 'reserved-writer.sqlite'
    fixture_database(db)
    before = snapshot(db)
    with sqlite3.connect(db) as writer:
        writer.execute('BEGIN IMMEDIATE')
        with TestClient(create_app(db), base_url=ORIGIN) as client:
            response = client.post(ENDPOINT, headers=HEADERS, json={'limit': 100})
            assert response.status_code == 200
            assert response.json()['attempts']
        writer.rollback()
    assert snapshot(db) == before


@pytest.mark.parametrize('contents', [b'not a SQLite database', b''])
def test_unusable_existing_database_is_not_initialized_or_modified(tmp_path, contents):
    from llm_engine.ports.connection_activity import ConnectionActivityUnavailable
    db = tmp_path / 'unusable.sqlite'
    db.write_bytes(contents)
    with pytest.raises(ConnectionActivityUnavailable, match='Recorded activity is unavailable'):
        NativeConnectionActivity(str(db)).recent_attempts(10)
    assert db.read_bytes() == contents
    assert sorted(path.name for path in tmp_path.iterdir()) == ['unusable.sqlite']


def test_activity_endpoint_runs_in_real_agentown_web_process(tmp_path):
    db = tmp_path / 'process-activity.sqlite'
    fixture_database(db)
    before = snapshot(db)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    executable = Path(sys.executable).parent / ('agentown-web.exe' if os.name == 'nt' else 'agentown-web')
    log_path = tmp_path / 'agentown-web.log'
    with log_path.open('w') as log:
        server = subprocess.Popen(
            [str(executable), '--database', str(db), '--port', str(port)],
            stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                try:
                    response = httpx.post(
                        origin + ENDPOINT,
                        headers={'Origin': origin},
                        json={'limit': 2}, timeout=1,
                    )
                    if response.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                assert server.poll() is None, log_path.read_text()
                time.sleep(.05)
            else:
                pytest.fail('agentown-web activity endpoint did not become ready')
            payload = response.json()
            assert len(payload['attempts']) == 2
            assert payload['evidence']['read_only'] is True
        finally:
            server.terminate()
            server.wait(timeout=15)
    assert snapshot(db) == before


def test_equal_timestamps_and_interrupted_records(monkeypatch):
    # Deliberately shuffled equal-time records prove the stable Run-ID tiebreak.
    runs = [
        ('a', 'task', 'text_execution', 'fixture', 10, 11, 'finished', 'interruption', []),
        ('c', 'task', 'text_execution', 'fixture', 10, None, 'active', None, []),
        ('b', 'task', 'text_execution', 'fixture', 10, 11, 'finished', 'failure', []),
    ]
    monkeypatch.setattr(_native, 'history_snapshot_read_only', lambda db: ([], [(None, runs)], []))
    monkeypatch.setattr(_native, 'execution_sources', lambda db: [('a', 'codex'), ('b', 'cursor')])
    attempts = NativeConnectionActivity('unused').recent_attempts(100)
    assert [a.run_id for a in attempts] == ['c', 'b', 'a']
    assert attempts[-1].outcome == 'interruption'
    assert NativeConnectionActivity('unused').recent_attempts(1) == attempts[:1]
