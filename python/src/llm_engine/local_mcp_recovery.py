"""Reuse the bounded single-dispatch stdio lifecycle without executing providers."""
import json

from .application.reconcile_selected_work import SelectedWorkRecoveryResult
from .connection_diagnostic import inspection_payload, validated_inspection
from .local_mcp_execution import LocalMcpExecution


class LocalMcpRecovery(LocalMcpExecution):
    result_type = SelectedWorkRecoveryResult
    busy_code = 'recovery_busy'

    def __init__(self, database, *, timeout=20):
        # Recovery deliberately has no provider/model configuration prerequisite.
        super().__init__(database, None, None, timeout=timeout)
        self.configured = True

    async def reconcile_work(self, request):
        return await self.execute_work(request)

    def _tool_call(self, selected):
        return {'name': 'get_work_history_v1',
                'arguments': {'task_id': selected.task_id, 'read_only': False}}

    def _receipt(self, result, selected):
        if result.get('isError') is True:
            # The MCP error category does not identify whether failure happened
            # before or after its mutating snapshot. Never infer non-delivery.
            raise ValueError('Uncertain recovery failure')
        data = inspection_payload(result)
        inspection = validated_inspection({'structuredContent': data['task'], 'content': [{'type': 'text', 'text': json.dumps(data['task'])}]}, result, selected.task_id)
        return self.result_type('confirmed', 'reconciliation_confirmed', inspection)
