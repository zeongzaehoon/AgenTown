"""Adapter lifecycle checks; native concurrency/SQLite checks run at integration."""
import asyncio

import pytest

from llm_engine import _native
from llm_engine.loop_execution import LoopService


def test_conflict_never_recovers_or_consumes_consent(monkeypatch):
    calls = []

    def acquire(database):
        calls.append('acquire')
        raise ValueError('live owner')

    monkeypatch.setattr(_native, 'acquire_loop_execution_owner', acquire, raising=False)
    monkeypatch.setattr(_native, 'recover_loop_sessions', lambda *a: calls.append('recover'))
    monkeypatch.setattr(_native, 'start_loop_session', lambda *a: calls.append('start'))

    async def scenario():
        service = LoopService('fixture', type('Provider', (), {'name': 'fixture'})(), 'model')
        with pytest.raises(ValueError):
            service.start('preview', 0)
        await service.close()
        assert service.owner is None

    asyncio.run(scenario())
    assert calls == ['acquire']


def test_failed_recovery_releases_handle_and_can_retry(monkeypatch):
    events = []

    class Handle:
        def close(self):
            events.append('release')

    def recover(owner):
        events.append('recover')
        raise OSError('fixture storage unavailable')

    monkeypatch.setattr(_native, 'acquire_loop_execution_owner', lambda database: Handle(), raising=False)
    monkeypatch.setattr(_native, 'recover_loop_sessions', recover)
    service = LoopService('fixture', None, None)
    with pytest.raises(ValueError, match='storage unavailable'):
        service.initialize()
    assert events == ['recover', 'release']
    assert not service.initialized and service.owner is None


def test_inspection_never_initializes_or_recovers(monkeypatch):
    def forbidden(*args):
        raise AssertionError('inspection attempted mutation')

    for name in ('acquire_loop_execution_owner', 'history_snapshot', 'recover_loop_sessions'):
        monkeypatch.setattr(_native, name, forbidden, raising=False)
    monkeypatch.setattr(_native, 'loop_control_available', lambda database: False, raising=False)
    monkeypatch.setattr(_native, 'loop_sessions', lambda *a: [])
    monkeypatch.setattr(_native, 'loop_attempts', lambda *a: [])
    service = LoopService('fixture', None, None)
    result = service.inspect()
    assert result['sessions'] == []
    assert result['control']['state'] == 'competing_owner'
    assert result['control']['can_control'] is False
    assert not service.initialized


def test_shutdown_retains_ownership_through_cancellation_persistence(monkeypatch):
    events = []

    class Handle:
        def close(self):
            events.append('release')

    monkeypatch.setattr(_native, 'acquire_loop_execution_owner', lambda database: Handle(), raising=False)
    monkeypatch.setattr(_native, 'recover_loop_sessions', lambda owner: events.append('recover'))
    monkeypatch.setattr(_native, 'stop_loop_session', lambda owner, sid: events.append(('stop', sid)))

    async def scenario():
        service = LoopService('fixture', None, None)
        service.initialize()
        entered = asyncio.Event()

        async def worker():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                events.append('persist-interrupted')

        service.workers['session'] = asyncio.create_task(worker())
        await entered.wait()
        await service.close()
        assert events == ['recover', ('stop', 'session'), 'persist-interrupted', 'release']
        with pytest.raises(ValueError):
            service.initialize()
        await service.close()
        assert events.count('release') == 1

    asyncio.run(scenario())


def test_native_handle_is_used_for_activation_admission_and_stop(monkeypatch):
    events = []

    class Handle:
        def close(self):
            events.append('release')

    owner = Handle()

    def acquire(database):
        assert database == 'fixture'
        return owner

    def recover(handle):
        assert handle is owner

    def start(handle, preview, count, provider, model, secrets, source):
        assert handle is owner
        assert (preview, count, provider, model, source) == (
            'preview', 0, 'fixture-provider', 'model', 'mcp-fixture')
        events.append('start')
        return {'session_id': 'session'}

    def admit(handle, sid, secrets):
        assert handle is owner and sid == 'session'
        events.append('admit')
        return None

    def stop(handle, sid):
        assert handle is owner and sid == 'session'
        events.append('stop')
        return {'session_id': sid, 'state': 'stopped'}

    for name, method in [('acquire_loop_execution_owner', acquire),
                         ('recover_loop_sessions', recover),
                         ('start_loop_session', start), ('admit_loop_attempt', admit),
                         ('stop_loop_session', stop)]:
        monkeypatch.setattr(_native, name, method, raising=False)
    monkeypatch.setattr(_native, 'loop_sessions', lambda database: [
        {'session_id': 'session', 'state': 'complete'}])

    async def scenario():
        service = LoopService('fixture', type('Provider', (), {'name': 'fixture-provider'})(), 'model')
        service.start('preview', 0, 'mcp-fixture')
        await service.workers['session']
        service.stop('session')
        await service.close()

    asyncio.run(scenario())
    assert events == ['start', 'admit', 'stop', 'release']


def test_availability_storage_failure_is_distinct(monkeypatch):
    def unavailable(database):
        raise OSError('private path must not escape')
    monkeypatch.setattr(_native, 'loop_control_available', unavailable, raising=False)
    service = LoopService('fixture', None, None)
    control = service.control_availability()
    assert control['state'] == 'storage_failure'
    assert not control['can_control']
    assert 'private path' not in str(control)


def test_two_services_inspect_conflict_release_and_explicit_recovery(tmp_path):
    """Real native ownership/consent boundary; deterministic and no dispatch."""
    db = str(tmp_path / 'shared.db')
    agent = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, 'Saved input', agent)[0]
    policy = _native.create_loop(db, 'Bounded', task, 1, 60)['id']
    _native.set_loop_enabled(db, policy, True)
    preview = _native.preview_loop(db, policy, [])
    provider = type('Provider', (), {'name': 'fixture'})()

    async def scenario():
        first = LoopService(db, provider, 'model')
        second = LoopService(db, provider, 'model')
        assert second.control_availability()['state'] == 'available'
        first.initialize()
        # Persist an abandoned session without creating any Python driver.
        session = _native.start_loop_session(first.owner, preview['preview_id'],
                                             0, 'fixture', 'model', [], 'mcp')
        fresh = _native.preview_loop(db, policy, [])
        before = second.inspect()
        assert before['control']['state'] == 'competing_owner'
        assert first.control_availability()['state'] == 'local_authority'
        assert before['sessions'][0]['state'] == 'active'
        for command in (lambda: second.start(fresh['preview_id'], 0),
                        lambda: second.stop(session['session_id'])):
            with pytest.raises(ValueError, match='owning MCP server'):
                command()
        assert second.inspect() == before
        assert not second.workers and not second.initialized
        await first.close()
        assert second.inspect()['sessions'][0]['state'] == 'active'
        assert second.control_availability()['state'] == 'available'
        # Explicit control triggers recovery, never replay of the old session.
        second.initialize()
        assert second.inspect()['sessions'][0]['state'] == 'restarted'
        assert second.inspect()['attempts'] == []
        # Rejected competing commands did not consume this preview's consent.
        created = _native.start_loop_session(second.owner, fresh['preview_id'],
                                             0, 'fixture', 'model', [], 'web')
        second.stop(created['session_id'])
        assert second.inspect()['attempts'] == []
        await second.close()

    asyncio.run(scenario())
