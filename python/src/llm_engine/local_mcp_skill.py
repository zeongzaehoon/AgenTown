"""Skill calls through the installed MCP process and existing Rust contracts."""
from .application.apply_selected_skill import SelectedSkillResult, canonical_id
from .connection_diagnostic import inspection_payload
from .local_mcp_execution import LocalMcpExecution, DECLARED_SOURCE


class LocalMcpSkill(LocalMcpExecution):
    result_type = SelectedSkillResult

    async def execute_work(self, request):
        if request.operation == 'execute' and not self.provider_configured:
            return self.result_type('rejected', 'configuration_unavailable')
        if request.operation == 'execute':
            confirmed = self._confirmed_previews.get(request.preview_id)
            if confirmed != (request.task_id, request.skill_id, request.input, request.expected_runs):
                return self.result_type('rejected', 'admission_rejected')
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
            return {'name': 'list_skills_v1', 'arguments': {}}
        if selected.operation == 'preview':
            return {'name': 'preview_skill_work_v1', 'arguments': {
                'task_id': selected.task_id, 'skill_id': selected.skill_id}}
        return {'name': 'execute_skill_work_v1', 'arguments': {
            'task_id': selected.task_id, 'preview_id': selected.preview_id,
            'expected_runs': selected.expected_runs, 'provider': self.provider,
            'model': self.model, 'declared_source': DECLARED_SOURCE}}

    async def _verified_receipt(self, result, selected, send, receive):
        if result.get('isError') is True:
            # Reuse the ordinary execution adapter's conservative admission errors.
            return super()._receipt(result, selected)
        data = inspection_payload(result)
        if selected.operation == 'list':
            if set(data) != {'schema_version', 'skills'} or type(data['schema_version']) is not int or data['schema_version'] != 1 or type(data['skills']) is not list:
                raise ValueError('Invalid discovery')
            seen = set()
            for skill in data['skills']:
                if set(skill) != {'id', 'name', 'enabled'} or type(skill['name']) is not str or type(skill['enabled']) is not bool:
                    raise ValueError('Invalid Skill')
                canonical_id(skill['id'])
                if skill['id'] in seen:
                    raise ValueError('Duplicate Skill')
                seen.add(skill['id'])
            return self.result_type('confirmed', 'skills_discovered', data)
        if selected.operation == 'preview':
            if (set(data) != {'schema_version', 'preview_id', 'task_id', 'skill_id', 'input', 'expected_runs'}
                    or type(data['schema_version']) is not int or data['schema_version'] != 1
                    or data['task_id'] != selected.task_id or data['skill_id'] != selected.skill_id
                    or type(data['preview_id']) is not str or not data['preview_id']
                    or type(data['input']) is not str or not data['input']
                    or type(data['expected_runs']) is not int or data['expected_runs'] < 0):
                raise ValueError('Invalid preview identity')
            if len(self._confirmed_previews) >= 128:
                del self._confirmed_previews[next(iter(self._confirmed_previews))]
            self._confirmed_previews[data['preview_id']] = (
                data['task_id'], data['skill_id'], data['input'], data['expected_runs'])
            return self.result_type('confirmed', 'skill_previewed', data)
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
        if history['task']['id'] != selected.task_id:
            raise ValueError('Wrong Task')
        runs = [run for run in history['attempts'] if run['id'] == execution['run_id']]
        if len(runs) != 1:
            raise ValueError('Missing admitted Run')
        run = runs[0]
        skill = run['skill']
        if (run['task_id'] != selected.task_id or run['declared_source'] != DECLARED_SOURCE
                or run['execution'] != execution or skill['run_id'] != execution['run_id']
                or skill['preview_id'] != selected.preview_id or skill['skill_id'] != selected.skill_id
                or skill['input'] != selected.input):
            raise ValueError('Wrong Skill provenance')
        return self.result_type('completed', 'execution_recorded', {'execution': execution, 'skill': skill})
