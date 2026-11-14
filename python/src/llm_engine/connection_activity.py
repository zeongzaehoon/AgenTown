"""Native adapter for historical Connections activity; never reconcile leases."""
from . import _native
from .ports.connection_activity import (
    ConnectionActivityUnavailable, RecordedConnectionAttempt,
)


class NativeConnectionActivity:
    def __init__(self, database: str):
        self.database = database

    def recent_attempts(self, limit: int) -> list[RecordedConnectionAttempt]:
        try:
            _, tasks, _ = _native.history_snapshot_read_only(self.database)
            # Sources are immutable. Later attempts cannot enter this snapshot.
            sources = dict(_native.execution_sources(self.database))
            attempts = [
                RecordedConnectionAttempt(
                    task_id=run[1], run_id=run[0], started_at=run[4],
                    ended_at=run[5], state=run[6], outcome=run[7],
                    declared_source=sources.get(run[0]),
                )
                for _, runs in tasks for run in runs
                if sources.get(run[0]) != 'agentown-local-product'
            ]
            # Existing snapshot queries load history; only the response is bounded.
            return sorted(attempts, key=lambda attempt: (
                attempt.started_at, attempt.run_id), reverse=True)[:limit]
        except Exception:
            raise ConnectionActivityUnavailable('Recorded activity is unavailable.') from None
