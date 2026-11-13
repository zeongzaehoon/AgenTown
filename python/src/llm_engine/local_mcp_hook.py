"""Hook calls through the installed MCP process and existing Rust contracts."""
from .application.apply_selected_hook import SelectedHookResult, canonical_id
from .connection_diagnostic import inspection_payload
from .local_mcp_execution import LocalMcpExecution, DECLARED_SOURCE


CONSENT_FIELDS = ('task_id', 'hook_id', 'agent_id', 'skill_id', 'source_run_id',
                  'event', 'source_outcome', 'input', 'expected_runs')
PREVIEW_FIELDS = set(CONSENT_FIELDS) | {'schema_version', 'preview_id', 'hook_name',
    'hook_enabled', 'target_kind', 'skill_name', 'skill_enabled', 'instructions'}


class LocalMcpHook(LocalMcpExecution):
    result_type = SelectedHookResult

    async def execute_work(self, request):
        if request.operation == 'execute' and not self.provider_configured:
            return self.result_type('rejected', 'configuration_unavailable')
        if request.operation == 'execute':
            confirmed = self._confirmed_previews.get(request.preview_id)
            if confirmed != tuple(getattr(request, key) for key in CONSENT_FIELDS):
                return self.result_type('rejected', 'admission_rejected')
        if request.operation == 'execute':
            # Consume local authorization even when delivery cannot be verified.
            self._confirmed_previews.pop(request.preview_id, None)
        return await super().execute_work(request)

    def __init__(self, database, provider, model, *, configured=True, timeout=75):
        super().__init__(database, provider, model, configured=configured, timeout=timeout)
        self.provider_configured = self.configured
        # Discovery and preview deliberately work without provider configuration.
        self.configured = True
        # Bind caller consent to a preview actually observed by this adapter.
        # Rust remains responsible for atomic freshness and single-use admission.
        self._confirmed_previews = {}

    def _tool_call(self, selected):
        if selected.operation == 'list':
            return {'name': 'list_hooks_v1', 'arguments': {}}
        if selected.operation == 'preview':
            return {'name': 'preview_hook_work_v1', 'arguments': {
                'task_id': selected.task_id, 'hook_id': selected.hook_id}}
        return {'name': 'execute_hook_work_v1', 'arguments': {
            'task_id': selected.task_id, 'preview_id': selected.preview_id,
            'expected_runs': selected.expected_runs, 'provider': self.provider,
            'model': self.model, 'declared_source': DECLARED_SOURCE}}

    async def _verified_receipt(self, result, selected, send, receive):
        if result.get('isError') is True:
            # Reuse the ordinary execution adapter's conservative admission errors.
            return super()._receipt(result, selected)
        data = inspection_payload(result)
        if selected.operation == 'list':
            if set(data) != {'schema_version', 'hooks'} or type(data['schema_version']) is not int or data['schema_version'] != 1 or type(data['hooks']) is not list:
                raise ValueError('Invalid discovery')
            seen = set()
            for hook in data['hooks']:
                if (set(hook) != {'id', 'name', 'enabled', 'skill_id', 'target_kind', 'target_id', 'event'}
                        or type(hook['name']) is not str or type(hook['enabled']) is not bool
                        or hook['target_kind'] not in ('agent', 'team')
                        or hook['event'] not in ('task_created', 'run_completed', 'run_failed')):
                    raise ValueError('Invalid Hook')
                for key in ('id', 'skill_id', 'target_id'):
                    canonical_id(hook[key])
                if hook['id'] in seen:
                    raise ValueError('Duplicate Hook')
                seen.add(hook['id'])
            return self.result_type('confirmed', 'hooks_discovered', data)
        if selected.operation == 'preview':
            if (set(data) != PREVIEW_FIELDS
                    or type(data['schema_version']) is not int or data['schema_version'] != 1
                    or data['task_id'] != selected.task_id or data['hook_id'] != selected.hook_id
                    or type(data['preview_id']) is not str or not data['preview_id']
                    or type(data['input']) is not str or not data['input']
                    or type(data['expected_runs']) is not int or data['expected_runs'] < 0):
                raise ValueError('Invalid preview identity')
            for key in ('task_id', 'hook_id', 'agent_id', 'skill_id', 'source_run_id'):
                canonical_id(data[key])
            if (data['hook_enabled'] is not True or data['skill_enabled'] is not True
                    or data['target_kind'] != 'agent'
                    or (data['event'], data['source_outcome']) not in
                       (('run_completed', 'reported_success'), ('run_failed', 'failure'))
                    or any(type(data[key]) is not str for key in ('hook_name', 'skill_name', 'instructions'))):
                raise ValueError('Invalid Hook context')
            if len(self._confirmed_previews) >= 128:
                del self._confirmed_previews[next(iter(self._confirmed_previews))]
            self._confirmed_previews[data['preview_id']] = tuple(data[key] for key in CONSENT_FIELDS)
            return self.result_type('confirmed', 'hook_previewed', data)
        # Validate the ordinary execution receipt before checking persisted identity.
        from dataclasses import asdict
        receipt = super()._receipt(result, selected)
        execution = asdict(receipt.data)
        if execution['input'] != selected.input:
            raise ValueError('Execution differs from consented preview')
        await send(dict(jsonrpc='2.0', id=3, method='tools/call', params={
            'name': 'get_work_history_v1', 'arguments': {'task_id': selected.task_id, 'read_only': True}}))
        history_result = await receive(3)
        if history_result.get('isError') is True:
            raise ValueError('History unavailable after dispatch')
        history = inspection_payload(history_result)
        if (history['task']['id'] != selected.task_id
                or len(history['attempts']) != selected.expected_runs + 1):
            raise ValueError('Wrong Task')
        runs = [run for run in history['attempts'] if run['id'] == execution['run_id']]
        if len(runs) != 1:
            raise ValueError('Missing admitted Run')
        run = runs[0]
        hook = run['hook']
        if (hook['hook_enabled'] is not True or hook['skill_enabled'] is not True
                or hook['target_kind'] != 'agent'
                or run['task_id'] != selected.task_id or run['declared_source'] != DECLARED_SOURCE
                or run['execution'] != execution or hook['run_id'] != execution['run_id']
                or hook['preview_id'] != selected.preview_id or hook['hook_id'] != selected.hook_id
                or any(hook[key] != getattr(selected, key) for key in CONSENT_FIELDS if key != 'expected_runs')):
            raise ValueError('Wrong Hook provenance')
        return self.result_type('completed', 'execution_recorded', {'execution': execution, 'hook': hook})
