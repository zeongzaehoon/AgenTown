"""Async Loop I/O driver. Rust alone decides admission, timing and termination."""
import asyncio

from . import _native
from .execution import finish_text, record
from .providers import runtime_secrets


class LoopService:
    def __init__(self, database, provider, model):
        self.database, self.provider, self.model = database, provider, model
        self.workers = {}
        self.initialized = False
        self.owner = None
        self.closed = False

    def initialize(self):
        if self.closed:
            raise ValueError('Loop execution service is closed.')
        if not self.initialized:
            # Native handle excludes all other processes/services before recovery.
            # Never fall back to unguarded recovery if acquisition fails.
            owner = _native.acquire_loop_execution_owner(self.database)
            try:
                _native.recover_loop_sessions(owner)
            except BaseException:
                owner.close()
                raise
            self.owner = owner
            self.initialized = True

    def start(self, preview_id, expected_runs, declared_source='web-product', *,
              provider=None, model=None):
        adapter = self.provider if provider is None else provider
        selected_model = self.model if model is None else model
        if self.closed or adapter is None or not selected_model or not selected_model.strip():
            raise ValueError('Configure a provider and explicit model before activation.')
        # Require an event loop before consuming single-use consent.
        loop = asyncio.get_running_loop()
        self.initialize()
        session = _native.start_loop_session(
            self.owner, preview_id, expected_runs, adapter.name,
            selected_model, runtime_secrets(), declared_source)
        sid = session['session_id']
        self.workers[sid] = loop.create_task(self.drive(sid, adapter))
        return session

    async def drive(self, sid, provider):
        try:
            while not self.closed:
                # No await separates admission and dispatch: stop either wins
                # admission or cancels the already admitted local operation.
                row = _native.admit_loop_attempt(
                    self.owner, sid, runtime_secrets())
                if row is not None:
                    await finish_text(self.database, row, provider)
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
                _native.stop_loop_session(self.owner, sid)
            except (ValueError, OSError):
                pass
        finally:
            self.workers.pop(sid, None)

    def stop(self, sid):
        self.initialize()
        session = _native.stop_loop_session(self.owner, sid)
        worker = self.workers.get(sid)
        if worker is not None:
            worker.cancel()
        return session

    def inspect(self):
        # Polling must not acquire ownership or recover expired execution leases.
        sessions = _native.loop_sessions(self.database)
        session_ids = {s['session_id'] for s in sessions}
        attempts = [{**a, 'execution': record(_native.show_execution_read_only(
            self.database, a['run_id']))}
                    for a in _native.loop_attempts(self.database)
                    if a['session_id'] in session_ids]
        return {'schema_version': 1, 'sessions': sessions,
                'attempts': attempts,
                'cancellation': 'Stop prevents new admissions and attempts local cancellation. '
                                'Remote completion may remain unknown.'}

    async def close(self):
        self.closed = True
        workers = list(self.workers.items())
        for sid, worker in workers:
            try:
                _native.stop_loop_session(self.owner, sid)
            except (ValueError, OSError):
                pass
            worker.cancel()
        await asyncio.gather(*(worker for _, worker in workers), return_exceptions=True)
        self.workers.clear()
        # Keep authority until cancellation has persisted interrupted attempts.
        if self.owner is not None:
            self.owner.close()
            self.owner = None
            self.initialized = False
