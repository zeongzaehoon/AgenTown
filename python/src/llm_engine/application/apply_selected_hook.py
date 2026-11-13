"""Explicit discovery, preview and consented execution of saved work Hooks."""
from dataclasses import asdict, dataclass
from uuid import UUID

from ..ports.selected_hook import SelectedHookPort


def canonical_id(value):
    if type(value) is not str or str(UUID(value)) != value:
        raise ValueError('Canonical UUID required')


@dataclass(frozen=True)
class SelectedHookRequest:
    operation: str
    task_id: str | None = None
    hook_id: str | None = None
    agent_id: str | None = None
    skill_id: str | None = None
    source_run_id: str | None = None
    event: str | None = None
    source_outcome: str | None = None
    preview_id: str | None = None
    expected_runs: int | None = None
    input: str | None = None
    execution_consent: bool | None = None

    def __post_init__(self):
        if self.operation not in ('list', 'preview', 'execute'):
            raise ValueError('Unknown operation')
        if self.operation != 'list':
            canonical_id(self.task_id)
            canonical_id(self.hook_id)
        if self.operation == 'execute':
            for value in (self.agent_id, self.skill_id, self.source_run_id):
                canonical_id(value)
            if (self.event, self.source_outcome) not in (('run_completed', 'reported_success'), ('run_failed', 'failure')):
                raise ValueError('Invalid source event/outcome')
            if (type(self.preview_id) is not str or not 1 <= len(self.preview_id) <= 1000
                    or type(self.expected_runs) is not int or self.expected_runs < 0
                    or type(self.input) is not str or not self.input
                    or self.execution_consent is not True):
                raise ValueError('Explicit consent to the complete preview required')


@dataclass(frozen=True)
class SelectedHookResult:
    status: str
    code: str
    data: dict | None = None
    recovery: str = 'Inspect work and obtain a fresh preview before any fresh explicit execution. Never automatically replay.'


class ApplySelectedHook:
    def __init__(self, port: SelectedHookPort):
        self.port = port

    async def execute(self, request):
        result = await self.port.execute_work(request)
        return dict(schema_version=1, requested_task_id=request.task_id, **asdict(result))
