"""Reusable real-process Loop scenario, also run outside the installed checkout."""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys

from llm_engine import _native
from llm_engine.application.apply_selected_loop import SelectedLoopRequest as Request
from llm_engine.local_mcp_loop import LocalMcpLoop


async def exercise(db, fixture):
    employee = _native.create_agent(db, 'Loop writer')[0]
    task = _native.create_assigned_work(db, 'Bounded saved input', employee)[0]
    policy = _native.create_loop(db, 'Bounded', task, 2, 60)['id']
    _native.set_loop_enabled(db, policy, True)

    def adapter(model='fixture', configured=True):
        port = LocalMcpLoop(db, 'anthropic', model, configured=configured, timeout=20)
        port.command = [sys.executable, fixture, db]
        return port

    # The actual installed command must support credential-free discovery/preview.
    installed = LocalMcpLoop(db, 'anthropic', None, configured=False, timeout=20)
    try:
        assert (await installed.execute_work(Request('list', task))).status == 'confirmed'
        assert (await installed.execute_work(Request('preview', task, policy))).status == 'confirmed'
    finally:
        await installed.close()
    port, competitor = adapter(), adapter()
    try:
        assert (await port.execute_work(Request('list', task))).data['loops'][0]['id'] == policy
        preview = (await port.execute_work(Request('preview', task, policy))).data
        pid = port.process.pid
        assert preview['expected_runs'] == 0
        assert not Path(db + '.dispatches').exists()
        start = Request('start', task, consent=preview, execution_consent=True)
        # Every observed field, including employee, bounds, provider/model and timestamp,
        # must match before dispatch. Wrong JSON primitive types also fail closed.
        for key, value in preview.items():
            changed = dict(preview)
            changed[key] = value + 1 if type(value) is int else str(value) + '-changed'
            result = await port.execute_work(replace(start, consent=changed))
            assert result.code == 'admission_rejected', (key, result)
        assert (await port.execute_work(replace(start, consent={**preview, 'expected_runs': False}))).code == 'admission_rejected'
        result = await port.execute_work(start)
        assert result.code == 'loop_started', result
        sid = result.data['session_id']
        # Activation returns a snapshot before the retained worker runs. By the
        # next database read it may already have admitted the first attempt.
        persisted = next(s for s in _native.loop_sessions(db) if s['session_id'] == sid)
        progress = {'state', 'admitted', 'next_at'}
        assert {k: v for k, v in result.data.items() if k not in progress} == {
            k: v for k, v in persisted.items() if k not in progress}
        assert result.data['state'] == persisted['state'] == 'active'
        assert result.data['admitted'] == 0
        assert 0 <= persisted['admitted'] <= 1
        assert persisted['next_at'] >= result.data['next_at']
        assert (await port.execute_work(start)).code == 'admission_rejected'
        for _ in range(100):
            inspected = await port.execute_work(Request('inspect', task))
            if inspected.data['attempts'] and inspected.data['attempts'][0]['execution']['output']:
                break
            await asyncio.sleep(.02)
        assert port.process.pid == pid
        assert inspected.data['control']['state'] == 'local_authority'
        assert len(inspected.data['attempts']) == 1
        attempt = inspected.data['attempts'][0]
        assert attempt['session_id'] == sid
        assert attempt['execution']['input'] == preview['input']
        assert attempt['execution']['provider'] == preview['provider']
        assert attempt['execution']['model'] == preview['model']
        assert attempt['run_id'] == _native.loop_attempts(db)[0]['run_id']
        assert (await competitor.execute_work(Request('inspect', task))).data['control']['state'] == 'competing_owner'
        assert (await competitor.execute_work(Request('stop', task, session_id=sid))).code == 'competing_owner'
        other_preview = (await competitor.execute_work(Request('preview', task, policy))).data
        competing_start = Request('start', task, consent=other_preview, execution_consent=True)
        assert (await competitor.execute_work(competing_start)).status == 'uncertain'
        assert (await competitor.execute_work(competing_start)).code == 'admission_rejected'
        assert len(_native.loop_sessions(db)) == 1
        stopped = await port.execute_work(Request('stop', task, session_id=sid))
        assert stopped.code == 'loop_stopped'
        assert stopped.data['state'] == 'stopped'
        assert port.process.pid == pid
        # A second explicitly authorized session is shut down with its web-owned port.
        preview2 = (await port.execute_work(Request('preview', task, policy))).data
        assert (await port.execute_work(Request('start', task, consent=preview2, execution_consent=True))).code == 'loop_started'
        await port.close()
        assert port.process.returncode is not None
        assert all(s['state'] != 'active' for s in _native.loop_sessions(db))
        count = len(_native.loop_attempts(db))
        reopened = adapter()
        try:
            assert (await reopened.execute_work(Request('inspect', task))).status == 'confirmed'
            assert (await reopened.execute_work(start)).code == 'admission_rejected'
            await asyncio.sleep(.1)
            assert len(_native.loop_attempts(db)) == count
            # A changed saved policy invalidates a previously observed consent.
            stale = (await reopened.execute_work(Request('preview', task, policy))).data
            _native.set_loop_enabled(db, policy, False)
            stale_request = Request('start', task, consent=stale, execution_consent=True)
            assert (await reopened.execute_work(stale_request)).status == 'uncertain'
            assert (await reopened.execute_work(stale_request)).code == 'admission_rejected'
            assert len(_native.loop_attempts(db)) == count
            bounded = _native.create_loop(db, 'One admission', task, 1, 60)['id']
            _native.set_loop_enabled(db, bounded, True)
            one = (await reopened.execute_work(Request('preview', task, bounded))).data
            started = await reopened.execute_work(Request('start', task, consent=one, execution_consent=True))
            assert started.code == 'loop_started', started
            for _ in range(100):
                observed = (await reopened.execute_work(Request('inspect', task))).data
                session = next(s for s in observed['sessions'] if s['session_id'] == started.data['session_id'])
                if session['state'] == 'complete':
                    break
                await asyncio.sleep(.02)
            assert session['state'] == 'complete'
            assert session['admitted'] == one['max_iterations'] == 1
            assert len(_native.loop_attempts(db)) == count + 1
        finally:
            await reopened.close()
    finally:
        await port.close()
        await competitor.close()


if __name__ == '__main__':
    asyncio.run(exercise(*sys.argv[1:]))
