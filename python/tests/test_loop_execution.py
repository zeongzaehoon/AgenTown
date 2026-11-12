"""Deterministic Loop service/API fixtures. No real provider calls."""
import asyncio

import httpx
import pytest

from llm_engine import _native
from llm_engine.execution import ProviderFailure
from llm_engine.loop_execution import LoopService
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}


class FixtureProvider:
    name = 'deterministic-test'

    def __init__(self, *, blocked=False, failure=False):
        self.calls = 0
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.blocked, self.failure = blocked, failure

    async def generate(self, text, model):
        self.calls += 1
        self.entered.set()
        try:
            if self.blocked:
                await self.release.wait()
            if self.failure:
                raise ProviderFailure('rate_limit')
            return 'Fixture output; not a real LLM result.'
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


@pytest.fixture
def saved(tmp_path):
    db = str(tmp_path / 'loops.db')
    agent = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, 'Summarize saved text', agent)[0]
    def policy(maximum=1):
        value = _native.create_loop(db, 'Bounded fixture', task, maximum, 60)
        _native.set_loop_enabled(db, value['id'], True)
        return value['id']
    return db, policy


def test_api_preview_activation_duplicates_and_linked_outputs(saved):
    async def scenario():
        db, policy = saved
        provider = FixtureProvider(blocked=True)
        app = create_app(db, 'fixture-model', provider=provider)
        async with app.app.router.lifespan_context(app.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers=HEADERS) as client:
                preview = (await client.post('/api/loops/v1/preview', json={'policy_id': policy()})).json()
                assert preview['schema_version'] == 1 and provider.calls == 0
                payload = {'preview_id': preview['preview_id'], 'expected_runs': preview['expected_runs']}
                started = await client.post('/api/loops/v1/start', json=payload)
                assert started.status_code == 201
                sid = started.json()['session_id']
                await asyncio.wait_for(provider.entered.wait(), 2)
                assert (await client.post('/api/loops/v1/start', json=payload)).status_code == 409
                provider.release.set()
                for _ in range(100):
                    state = (await client.get('/api/loops/v1')).json()
                    if state['sessions'][0]['state'] == 'complete':
                        break
                    await asyncio.sleep(0.001)
                assert state['sessions'][0]['state'] == 'complete'
                assert state['sessions'][0]['admitted'] == provider.calls == 1
                attempt = state['attempts'][0]
                assert attempt['session_id'] == sid
                assert attempt['execution']['output'].startswith('Fixture output')
                assert attempt['execution']['quality'] == 'unverified'
                assert (await client.post('/api/loops/v1/start', json={**payload, 'expected_runs': True})).status_code == 409
                assert (await client.post('/api/loops/v1/stop', json={'session_id': sid}, headers={'Origin': 'http://evil.example'})).status_code == 403
    asyncio.run(scenario())


def test_missing_configuration_never_activates(saved, monkeypatch):
    from starlette.testclient import TestClient
    db, policy = saved
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    with TestClient(create_app(db), base_url=ORIGIN, headers=HEADERS) as client:
        preview = client.post('/api/loops/v1/preview', json={'policy_id': policy()}).json()
        result = client.post('/api/loops/v1/start', json={'preview_id': preview['preview_id'], 'expected_runs': 0})
        assert result.status_code == 409
        assert client.get('/api/loops/v1').json()['sessions'] == []


@pytest.mark.parametrize('when', ['before_dispatch', 'during_dispatch', 'interval', 'failure', 'restart'])
def test_stop_interval_failure_and_restart(saved, when):
    async def scenario():
        db, policy = saved
        provider = FixtureProvider(blocked=when in ('during_dispatch', 'restart'), failure=when == 'failure')
        service = LoopService(db, provider, 'fixture-model')
        preview = _native.preview_loop(db, policy(2))
        session = service.start(preview['preview_id'], 0)
        sid = session['session_id']
        worker = service.workers[sid]
        if when == 'before_dispatch':
            service.stop(sid)
            await asyncio.gather(worker, return_exceptions=True)
            assert provider.calls == 0
        else:
            await asyncio.wait_for(provider.entered.wait(), 2)
            if when == 'restart':
                replacement = LoopService(db, provider, 'fixture-model')
                replacement.initialize()
                assert replacement.inspect()['sessions'][0]['state'] == 'restarted'
                # A real crash loses local tasks; emulate local cancellation only.
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
                await replacement.close()
            elif when == 'during_dispatch':
                result = service.stop(sid)
                assert result['state'] == 'stopped'
                await asyncio.gather(worker, return_exceptions=True)
                assert provider.cancelled.is_set()
                assert service.inspect()['attempts'][0]['execution']['error'] == 'interrupted'
                assert service.stop(sid)['state'] == 'stopped'
            elif when == 'failure':
                await asyncio.wait_for(worker, 2)
                assert service.inspect()['sessions'][0]['state'] == 'failed'
            else:
                # Worker has finalized the first call and Rust refuses admission
                # during the interval, even for duplicate immediate requests.
                for _ in range(3):
                    assert _native.admit_loop_attempt(db, sid, service.runtime_id) is None
                assert service.inspect()['sessions'][0]['admitted'] == 1
                service.stop(sid)
                await asyncio.gather(worker, return_exceptions=True)
            assert provider.calls == 1
        terminal = service.inspect()['sessions'][0]['state']
        assert terminal != 'active'
        with pytest.raises(ValueError):
            _native.admit_loop_attempt(db, sid, service.runtime_id)
        await service.close()
        reopened = LoopService(db, provider, 'fixture-model')
        reopened.initialize()
        assert reopened.inspect()['sessions'][0]['state'] == terminal
        assert provider.calls == (0 if when == 'before_dispatch' else 1)
        await reopened.close()
    asyncio.run(scenario())


def test_api_stop_during_call_and_restart_inspection(saved):
    async def scenario():
        db, policy = saved
        provider = FixtureProvider(blocked=True)
        app = create_app(db, 'fixture-model', provider=provider)
        async with app.app.router.lifespan_context(app.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers=HEADERS) as client:
                preview = (await client.post('/api/loops/v1/preview', json={'policy_id': policy(2)})).json()
                start = await client.post('/api/loops/v1/start', json={'preview_id': preview['preview_id'], 'expected_runs': 0})
                assert start.status_code == 201
                sid = start.json()['session_id']
                await asyncio.wait_for(provider.entered.wait(), 2)
                for _ in range(2):
                    stop = await client.post('/api/loops/v1/stop', json={'session_id': sid})
                    assert stop.status_code == 200
                    assert stop.json()['state'] == 'stopped'
                    assert 'unknown' in stop.json()['cancellation']
                await asyncio.wait_for(provider.cancelled.wait(), 2)
        reopened = create_app(db, 'fixture-model', provider=provider)
        async with reopened.app.router.lifespan_context(reopened.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=reopened), base_url=ORIGIN, headers=HEADERS) as client:
                state = (await client.get('/api/loops/v1')).json()
                assert state['sessions'][0]['state'] == 'stopped'
                assert state['attempts'][0]['execution']['error'] == 'interrupted'
                assert provider.calls == 1
    asyncio.run(scenario())
