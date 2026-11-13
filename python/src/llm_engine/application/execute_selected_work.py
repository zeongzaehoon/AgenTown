"""Explicit selected ordinary-text execution; Rust remains admission authority."""
from dataclasses import asdict, dataclass
from uuid import UUID

from ..ports.selected_work_execution import SelectedWorkExecutionPort
from .inspect_selected_work import InspectedExecution


@dataclass(frozen=True)
class SelectedWorkExecutionRequest:
    task_id: str
    expected_runs: int
    resubmission_consent: bool

    def __post_init__(self):
        if not isinstance(self.task_id, str) or str(UUID(self.task_id)) != self.task_id:
            raise ValueError('Canonical Task UUID required')
        if type(self.expected_runs) is not int or self.expected_runs < 0:
            raise ValueError('Observed nonnegative attempt count required')
        if type(self.resubmission_consent) is not bool:
            raise ValueError('Explicit boolean consent required')


@dataclass(frozen=True)
class SelectedWorkExecutionResult:
    status: str
    code: str
    execution: InspectedExecution | None = None
    recovery: str = 'Inspect selected work before any fresh explicit execution request. Never automatically replay.'


class ExecuteSelectedWork:
    def __init__(self, port: SelectedWorkExecutionPort):
        self.port = port

    async def execute(self, request: SelectedWorkExecutionRequest):
        result = await self.port.execute_work(request)
        return dict(schema_version=1, requested_task_id=request.task_id, **asdict(result))
