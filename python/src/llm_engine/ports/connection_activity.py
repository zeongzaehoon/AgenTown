"""Narrow historical activity read boundary."""
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RecordedConnectionAttempt:
    task_id: str
    run_id: str
    started_at: int
    ended_at: int | None
    state: str
    outcome: str | None
    declared_source: str | None


class ConnectionActivityUnavailable(Exception):
    """Persisted history could not be read."""


class ConnectionActivityPort(Protocol):
    def recent_attempts(self, limit: int) -> list[RecordedConnectionAttempt]: ...
