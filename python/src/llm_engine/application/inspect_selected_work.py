"""Explicit selected-work inspection; no execution or retry policy."""
from dataclasses import dataclass, asdict
from typing import Literal
from uuid import UUID

from ..ports.selected_work_inspection import SelectedWorkInspectionPort


@dataclass(frozen=True)
class InspectedTask:
    id: str
    title: str
    status: str
    assignees: list[str]


@dataclass(frozen=True)
class InspectedExecution:
    schema_version: int
    run_id: str
    input: str
    provider: str
    model: str
    deadline_unix_ms: int
    output: str | None
    error: str | None
    quality: Literal['unverified']


@dataclass(frozen=True)
class InspectedRun:
    id: str
    task_id: str
    stage: str
    reporting_source: str
    declared_source: str | None
    started_at: int
    ended_at: int | None
    state: str
    outcome: str | None
    participants: list[str]
    execution: InspectedExecution | None


@dataclass(frozen=True)
class LocalInspection:
    task: InspectedTask
    attempts: list[InspectedRun]


@dataclass(frozen=True)
class InspectionResult:
    status: str
    code: str
    message: str
    recovery: str
    inspection: LocalInspection | None = None


class InspectSelectedWork:
    def __init__(self, port: 'SelectedWorkInspectionPort'):
        self.port = port

    async def execute(self, task_id: str):
        # The inbound boundary only accepts a canonical stable identity.
        if not isinstance(task_id, str) or str(UUID(task_id)) != task_id:
            raise ValueError('A canonical Task UUID is required.')
        result = await self.port.inspect_work(task_id)
        payload = asdict(result)
        confirmed = result.status == 'passed' and result.inspection is not None
        payload['status'] = 'success' if confirmed else 'failure'
        if not confirmed:
            payload['inspection'] = None
        if confirmed:
            payload['inspection']['evidence'] = {
                'source': 'installed_local_mcp',
                'tools': ['get_task', 'get_work_history_v1'],
                'read_only': True,
                'external_client_verified': False,
            }
        return dict(schema_version=1, requested_task_id=task_id, **payload)

