"""Inspect recorded labels without asserting a connected or authenticated client."""
from dataclasses import asdict, dataclass

from ..ports.connection_activity import ConnectionActivityPort

SUPPORTED_INTEGRATIONS = frozenset({'codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt'})


@dataclass(frozen=True)
class ConnectionActivityRequest:
    limit: int

    def __post_init__(self):
        if type(self.limit) is not int or not 1 <= self.limit <= 100:
            raise ValueError('limit must be an integer from 1 through 100')


class InspectConnectionActivity:
    def __init__(self, port: ConnectionActivityPort):
        self.port = port

    def execute(self, request: ConnectionActivityRequest):
        attempts = self.port.recent_attempts(request.limit)
        return {
            'schema_version': 1,
            'limit': request.limit,
            'attempts': [dict(asdict(attempt), integration=(
                attempt.declared_source if attempt.declared_source in SUPPORTED_INTEGRATIONS else None
            )) for attempt in attempts],
            'evidence': {
                'read_only': True,
                'source': 'persisted_run_records',
                'source_labels': 'untrusted_historical_metadata',
                'current_connection_verified': False,
                'authenticated_client_identity_verified': False,
                'quality_approved': False,
                'local_product_attempts_excluded': True,
            },
        }
