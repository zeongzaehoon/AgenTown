"""Single-dispatch installed local MCP execution adapter; never replays a call."""
import asyncio
import json
import subprocess
from uuid import UUID

from .application.execute_selected_work import SelectedWorkExecutionResult
from .application.inspect_selected_work import InspectedExecution
from .connection_diagnostic import inspection_payload
from .connections import installed_server_command

DECLARED_SOURCE = 'agentown-local-product'


class LocalMcpExecution:
    def __init__(self, database, provider, model, *, configured=True, timeout=75):
        self.command = installed_server_command(database)
        self.provider, self.model = provider, model
        self.configured = configured and bool(model)
        self.timeout = timeout
        self.active = None
        self.closed = False

    async def execute_work(self, request):
        if not self.configured:
            return SelectedWorkExecutionResult('rejected', 'configuration_unavailable')
        if self.closed or self.active is not None:
            return SelectedWorkExecutionResult('rejected', 'execution_busy')
        task = asyncio.create_task(self._execute(request))
        self.active = task
        def release(completed):
            if self.active is completed:
                self.active = None
        task.add_done_callback(release)
        try:
            return await asyncio.shield(task)
        finally:
            if not task.done():
                task.cancel()
            # Admission remains occupied until process cleanup has completed.
            try:
                await asyncio.shield(task)
            finally:
                if task.done() and self.active is task:
                    self.active = None

    async def close(self):
        self.closed = True
        if self.active is not None:
            self.active.cancel()
            try:
                await self.active
            except asyncio.CancelledError:
                pass

    async def _execute(self, selected):
        process, dispatched = None, False
        try:
            async with asyncio.timeout(self.timeout):
                process = await asyncio.create_subprocess_exec(
                    *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=subprocess.DEVNULL, limit=2 * 1024 * 1024)
                async def send(value):
                    process.stdin.write(json.dumps(value).encode() + b'\n')
                    await process.stdin.drain()
                received = 0
                async def receive(identifier):
                    nonlocal received
                    while True:
                        line = await process.stdout.readline()
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
                await send(dict(jsonrpc='2.0', id=1, method='initialize', params={
                    'protocolVersion': '2025-03-26', 'capabilities': {},
                    'clientInfo': {'name': DECLARED_SOURCE, 'version': '1'}}))
                initialized = await receive(1)
                if (initialized.get('protocolVersion') != '2025-03-26'
                        or not isinstance(initialized.get('capabilities', {}).get('tools'), dict)):
                    raise ValueError('Unsupported server')
                await send(dict(jsonrpc='2.0', method='notifications/initialized'))
                # Mark uncertainty before writing: even a failed drain may deliver.
                dispatched = True
                await send(dict(jsonrpc='2.0', id=2, method='tools/call', params={
                    'name': 'execute_text_work_v1', 'arguments': {
                        'task_id': selected.task_id, 'expected_runs': selected.expected_runs,
                        'resubmission_consent': selected.resubmission_consent,
                        'provider': self.provider, 'model': self.model,
                        'declared_source': DECLARED_SOURCE}}))
                result = await receive(2)
                if result.get('isError') is True:
                    # Only known pre-admission errors are safe to classify as rejected.
                    content = result.get('content', [])
                    message = ' '.join(item.get('text', '') for item in content if isinstance(item, dict))
                    if 'Provider configuration unavailable;' in message:
                        return SelectedWorkExecutionResult('rejected', 'configuration_unavailable')
                    for category in ('schema', 'invalid', 'unknown', 'stale', 'consent', 'owner', 'active', 'duplicate', 'assigned', 'storage'):
                        if f'Operation rejected ({category});' in message:
                            return SelectedWorkExecutionResult('rejected', 'admission_rejected')
                    raise ValueError('Uncertain tool failure')
                data = inspection_payload(result)
                expected = {'schema_version', 'run_id', 'input', 'provider', 'model', 'deadline_unix_ms', 'output', 'error', 'quality'}
                if (set(data) != expected or type(data['schema_version']) is not int or data['schema_version'] != 1
                        or str(UUID(data['run_id'])) != data['run_id']
                        or data['provider'] != self.provider or data['model'] != self.model
                        or not isinstance(data['input'], str) or type(data['deadline_unix_ms']) is not int
                        or data['quality'] != 'unverified'
                        or not ((isinstance(data['output'], str) and data['error'] is None)
                                or (data['output'] is None and isinstance(data['error'], str)))):
                    raise ValueError('Invalid execution')
                return SelectedWorkExecutionResult('completed', 'execution_recorded', InspectedExecution(**data))
        except Exception:
            return SelectedWorkExecutionResult('uncertain' if dispatched else 'unavailable',
                                               'delivery_uncertain' if dispatched else 'transport_unavailable')
        finally:
            if process is not None:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                reaped = asyncio.create_task(process.wait())
                interrupted = False
                while not reaped.done():
                    try:
                        await asyncio.shield(reaped)
                    except asyncio.CancelledError:
                        interrupted = True
                reaped.result()
                if interrupted:
                    raise asyncio.CancelledError()
