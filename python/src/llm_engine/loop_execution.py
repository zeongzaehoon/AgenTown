"""Async Loop I/O driver. Rust alone decides admission, timing and termination."""
import asyncio
from uuid import uuid4

from . import _native
from .execution import finish_text, record
from .providers import runtime_secrets


class LoopService:
    def __init__(self, database, provider, model):
        self.database, self.provider, self.model = database, provider, model
        self.runtime_id = str(uuid4())
        self.workers = {}
        self.initialized = False
        self.closed = False

    def initialize(self):
        if not self.initialized:
            _native.recover_loop_sessions(self.database, self.runtime_id)
            self.initialized = True

    def start(self, preview_id, expected_runs):
        self.initialize()
        if self.closed or self.provider is None or not self.model or not self.model.strip():
            raise ValueError('Configure a provider and explicit model before activation.')
        session = _native.start_loop_session(
            self.database, preview_id, expected_runs, self.provider.name,
            self.model, self.runtime_id, runtime_secrets())
        sid = session['session_id']
        self.workers[sid] = asyncio.create_task(self.drive(sid))
        return session

    async def drive(self, sid):
        try:
            while not self.closed:
                # No await separates admission and dispatch: stop either wins
                # admission or cancels the already admitted local operation.
                row = _native.admit_loop_attempt(
                    self.database, sid, self.runtime_id, runtime_secrets())
                if row is not None:
                    await finish_text(self.database, row, self.provider)
                    continue
                session = next(s for s in _native.loop_sessions(self.database)
                               if s['session_id'] == sid)
                if session['state'] != 'active':
                    return
                # Transport polling only; Rust evaluates next_at and all limits.
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            raise
        except (ValueError, OSError):
            # Fail closed. Never repeat a dispatch after uncertain persistence.
            try:
                _native.stop_loop_session(self.database, sid)
            except (ValueError, OSError):
                pass
        finally:
            self.workers.pop(sid, None)

    def stop(self, sid):
        self.initialize()
        session = _native.stop_loop_session(self.database, sid)
        worker = self.workers.get(sid)
        if worker is not None:
            worker.cancel()
        return session

    def inspect(self):
        self.initialize()
        _, _, rows = _native.history_snapshot(self.database)
        executions = {row[0]: record(row) for row in rows}
        attempts = [{**a, 'execution': executions.get(a['run_id'])}
                    for a in _native.loop_attempts(self.database)]
        return {'schema_version': 1, 'sessions': _native.loop_sessions(self.database),
                'attempts': attempts,
                'cancellation': 'Stop prevents new admissions and attempts local cancellation. '
                                'Remote completion may remain unknown.'}

    async def close(self):
        self.closed = True
        workers = list(self.workers.items())
        for sid, worker in workers:
            try:
                _native.stop_loop_session(self.database, sid)
            except (ValueError, OSError):
                pass
            worker.cancel()
        await asyncio.gather(*(worker for _, worker in workers), return_exceptions=True)
