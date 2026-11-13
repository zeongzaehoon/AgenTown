"""Explicit selected-work bounded Loop actions; scheduling remains in Rust."""
from dataclasses import asdict, dataclass
from .apply_selected_hook import canonical_id
from ..ports.selected_loop import SelectedLoopPort


@dataclass(frozen=True)
class SelectedLoopRequest:
    operation: str
    task_id: str
    policy_id: str | None = None
    consent: dict | None = None
    execution_consent: bool | None = None
    session_id: str | None = None

    def __post_init__(self):
        canonical_id(self.task_id)
        if self.operation not in ('list', 'preview', 'start', 'inspect', 'stop'):
            raise ValueError('Unknown Loop operation')
        if self.operation == 'preview':
            canonical_id(self.policy_id)
        if self.operation == 'start' and (type(self.consent) is not dict or self.execution_consent is not True):
            raise ValueError('Explicit consent to complete observed preview required')
        if self.operation == 'stop':
            canonical_id(self.session_id)


@dataclass(frozen=True)
class SelectedLoopResult:
    status: str
    code: str
    data: dict | None = None
    recovery: str = 'Inspect through the owning server. Obtain fresh preview and explicit consent before a new activation; never automatically replay.'


class ApplySelectedLoop:
    def __init__(self, port: SelectedLoopPort):
        self.port = port

    async def execute(self, request):
        return dict(schema_version=1, requested_task_id=request.task_id,
                    **asdict(await self.port.execute_work(request)))


class InspectCompanyLoops:
    """Read all recorded sessions through the retained execution owner."""
    def __init__(self, port: SelectedLoopPort):
        self.port = port

    async def execute(self):
        return dict(schema_version=1, scope='company',
                    **asdict(await self.port.inspect_company()))
