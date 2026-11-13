"""Explicit expired-attempt recovery; Rust owns lease decisions."""
from dataclasses import asdict, dataclass
from uuid import UUID

from ..ports.selected_work_recovery import SelectedWorkRecoveryPort
from .inspect_selected_work import LocalInspection


@dataclass(frozen=True)
class SelectedWorkRecoveryRequest:
    task_id: str
    recovery_consent: bool

    def __post_init__(self):
        if not isinstance(self.task_id, str) or str(UUID(self.task_id)) != self.task_id:
            raise ValueError('Canonical Task UUID required')
        if self.recovery_consent is not True:
            raise ValueError('Explicit recovery consent required')


@dataclass(frozen=True)
class SelectedWorkRecoveryResult:
    status: str
    code: str
    inspection: LocalInspection | None = None
    recovery: str = 'Inspect selected work read-only before another explicit request. Never automatically replay.'


class ReconcileSelectedWork:
    def __init__(self, port: SelectedWorkRecoveryPort):
        self.port = port

    async def execute(self, request: SelectedWorkRecoveryRequest):
        result = await self.port.reconcile_work(request)
        payload = asdict(result)
        # A receipt confirms the operation, not that every attempt was expired.
        if result.status != 'confirmed':
            payload['inspection'] = None
        return dict(schema_version=1, requested_task_id=request.task_id,
                    evidence={'source': 'installed_local_mcp', 'tool': 'get_work_history_v1',
                              'read_only': False, 'mutation_scope': 'snapshot_expired_leases',
                              'external_client_verified': False}, **payload)
