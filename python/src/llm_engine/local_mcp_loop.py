"""Serialized, retained installed MCP owner. No transport retries or scheduler."""
import asyncio
import copy
import json
import subprocess

from .application.apply_selected_loop import SelectedLoopResult as Result
from .connection_diagnostic import inspection_payload
from .connections import installed_server_command
from .local_mcp_execution import DECLARED_SOURCE


class ToolUnconfirmed(ValueError):
    pass


class LocalMcpLoop:
    def __init__(self, database, provider, model, *, configured=True, timeout=75):
        self.command = installed_server_command(database)
        self.provider, self.model = provider, model
        self.configured = configured and bool(model)
        self.timeout = timeout
        self.process = None
        self.lock = asyncio.Lock()
        self.closed = False
        self.broken = False
        self.sequence = 0
        self.previews = {}

    async def _send(self, value):
        self.process.stdin.write(json.dumps(value).encode() + b'\n')
        await self.process.stdin.drain()

    async def _rpc(self, method, params):
        self.sequence += 1
        identifier = self.sequence
        await self._send(dict(jsonrpc='2.0', id=identifier, method=method, params=params))
        received = 0
        while True:
            line = await self.process.stdout.readline()
            received += len(line)
            if not line or received > 4 * 1024 * 1024:
                raise ValueError('Invalid transport')
            reply = json.loads(line)
            if not isinstance(reply, dict) or reply.get('jsonrpc') != '2.0':
                raise ValueError('Invalid envelope')
            if type(reply.get('id')) is int and reply['id'] == identifier:
                if 'error' in reply or not isinstance(reply.get('result'), dict):
                    raise ValueError('Invalid result')
                return reply['result']
            if 'id' in reply or not isinstance(reply.get('method'), str):
                raise ValueError('Unexpected response')

    async def _connect(self):
        if self.process is not None:
            if self.process.returncode is not None:
                raise ValueError('Owner exited; restart web explicitly')
            return
        self.process = await asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=subprocess.DEVNULL, limit=2 * 1024 * 1024)
        initialized = await self._rpc('initialize', {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': DECLARED_SOURCE, 'version': '1'}})
        if (initialized.get('protocolVersion') != '2025-03-26'
                or not isinstance(initialized.get('capabilities', {}).get('tools'), dict)):
            raise ValueError('Unsupported server')
        await self._send(dict(jsonrpc='2.0', method='notifications/initialized'))

    async def _tool(self, name, arguments):
        reply = await self._rpc('tools/call', dict(name=name, arguments=arguments))
        if reply.get('isError') is True:
            raise ToolUnconfirmed('Tool did not confirm delivery')
        return inspection_payload(reply)

    async def execute_work(self, request):
        # Queueing is serialized so validation, consumption and dispatch are atomic locally.
        async with self.lock:
            if self.closed or self.broken:
                return Result('unavailable', 'owner_unavailable')
            dispatched = False
            try:
                async with asyncio.timeout(self.timeout):
                    if request.operation == 'start':
                        if not self.configured:
                            return Result('rejected', 'configuration_unavailable')
                        consent = request.consent
                        observed = self.previews.get(consent.get('preview_id'))
                        # JSON canonicalization distinguishes bool from int and binds every field.
                        if (observed is None or observed['task_id'] != request.task_id
                                or json.dumps(consent, sort_keys=True) != json.dumps(observed, sort_keys=True)
                                or consent['provider'] != self.provider or consent['model'] != self.model):
                            return Result('rejected', 'admission_rejected')
                    await self._connect()
                    if request.operation == 'list':
                        from .mcp_server import Loops
                        data = Loops.model_validate(await self._tool('list_loops_v1', {})).model_dump(mode='json')
                        data['loops'] = [p for p in data['loops'] if p['task_id'] == request.task_id]
                        return Result('confirmed', 'loops_discovered', data)
                    if request.operation == 'preview':
                        from .mcp_server import LoopPreview
                        data = LoopPreview.model_validate(await self._tool('preview_loop_v1', {
                            'policy_id': request.policy_id})).model_dump(mode='json')
                        if data['task_id'] != request.task_id or data['policy_id'] != request.policy_id:
                            return Result('rejected', 'selection_mismatch')
                        data.update(provider=self.provider, model=self.model)
                        if len(self.previews) >= 128:
                            del self.previews[next(iter(self.previews))]
                        self.previews[data['preview_id']] = copy.deepcopy(data)
                        return Result('confirmed', 'loop_previewed', data)
                    if request.operation == 'start':
                        # Consume before potentially delivering any activation bytes.
                        self.previews.pop(consent['preview_id'])
                        dispatched = True
                        data = await self._tool('start_loop_v1', {
                            'preview_id': consent['preview_id'], 'expected_runs': consent['expected_runs'],
                            'provider': self.provider, 'model': self.model, 'declared_source': DECLARED_SOURCE})
                        from .mcp_server import LoopSession
                        data = LoopSession.model_validate(data).model_dump(mode='json')
                        expected = {k: v for k, v in consent.items() if k not in ('provider', 'model')}
                        if (data['preview'] != expected or data['provider'] != self.provider
                                or data['model'] != self.model or data['declared_source'] != DECLARED_SOURCE):
                            raise ValueError('Wrong activation provenance')
                        return Result('confirmed', 'loop_started', data)
                    from .mcp_server import LoopInspection, LoopSession
                    inspection = LoopInspection.model_validate(await self._tool('inspect_loop_sessions_v1', {})).model_dump(mode='json')
                    sessions = [s for s in inspection['sessions'] if s['preview']['task_id'] == request.task_id]
                    if request.operation == 'inspect':
                        ids = {s['session_id'] for s in sessions}
                        inspection['sessions'] = sessions
                        inspection['attempts'] = [a for a in inspection['attempts'] if a['session_id'] in ids]
                        return Result('confirmed', 'loops_inspected', inspection)
                    if not any(s['session_id'] == request.session_id for s in sessions):
                        return Result('rejected', 'selection_mismatch')
                    if inspection['control']['state'] == 'competing_owner':
                        return Result('rejected', 'competing_owner', inspection)
                    dispatched = True
                    data = LoopSession.model_validate(await self._tool('stop_loop_v1', {
                        'session_id': request.session_id})).model_dump(mode='json')
                    if data['session_id'] != request.session_id or data['preview']['task_id'] != request.task_id or data['state'] == 'active':
                        raise ValueError('Wrong Stop receipt')
                    return Result('confirmed', 'loop_stopped', data)
            except asyncio.CancelledError:
                self.broken = True
                self.previews.clear()
                raise
            except Exception as exc:
                # Never reconnect/replay after an ambiguous mutation. Inspection is still
                # possible on a healthy channel after an MCP tool error.
                if not isinstance(exc, ToolUnconfirmed):
                    self.broken = True
                return Result('uncertain' if dispatched else 'unavailable',
                              'delivery_uncertain' if dispatched else 'transport_unavailable')

    async def close(self):
        async with self.lock:
            self.closed = True
            self.previews.clear()
            if self.process is None:
                return
            # EOF lets FastMCP run its lifespan cleanup and stop owned sessions.
            if self.process.returncode is None:
                self.process.stdin.close()
                try:
                    await asyncio.wait_for(self.process.wait(), 15)
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
