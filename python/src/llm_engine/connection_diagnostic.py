"""Bounded, discovery-only MCP stdio diagnostic of the installed server.

No tool invocation, provider configuration, client settings, or durable admission.
The subprocess is always killed/reaped before the admission slot is released.
"""
import asyncio
import json
import subprocess

from .connections import installed_server_command

REQUIRED_TOOLS = frozenset({
    "list_agents", "get_agent", "list_tasks", "get_task", "create_employee_v1",
    "save_text_work_v1", "execute_text_work_v1", "get_work_history_v1",
})


def outcome(status, code, message, recovery):
    return dict(schema_version=1, status=status, code=code, message=message, recovery=recovery)


class DiagnosticFailure(Exception):
    pass


class ConnectionDiagnostic:
    def __init__(self, database, *, timeout=8):
        self.command = installed_server_command(database)
        self.timeout = timeout
        self.active = None
        self.closed = False

    async def run(self):
        # No await between admission and assigning the task: one event-loop owner.
        if self.closed or self.active is not None:
            return outcome("busy", "diagnostic_busy", "A local server diagnostic is already running or stopping.",
                           "Wait for it to finish, then explicitly check again.")
        task = asyncio.create_task(self._check())
        self.active = task
        # Repeated request cancellation can interrupt the caller's cleanup wait.
        # Release admission only when _check has actually finished reaping.
        def release(completed):
            if self.active is completed:
                self.active = None
        task.add_done_callback(release)
        try:
            return await asyncio.shield(task)
        finally:
            if not task.done():
                task.cancel()
            # Shield cleanup from request cancellation; the slot stays occupied.
            try:
                await asyncio.shield(task)
            finally:
                if task.done() and self.active is task:
                    self.active = None

    async def close(self):
        self.closed = True
        if self.active is not None:
            if not self.active.cancelling():
                self.active.cancel()
            try:
                await self.active
            except asyncio.CancelledError:
                pass
            self.active = None

    async def _check(self):
        process = None
        try:
            async with asyncio.timeout(self.timeout):
                process = await asyncio.create_subprocess_exec(
                    *self.command, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=subprocess.DEVNULL,
                    limit=1024 * 1024)
                async def send(value):
                    process.stdin.write(json.dumps(value).encode() + b"\n")
                    await process.stdin.drain()

                async def request(identifier, method, params):
                    await send(dict(jsonrpc="2.0", id=identifier, method=method, params=params))
                    while True:
                        line = await process.stdout.readline()
                        if not line:
                            raise DiagnosticFailure()
                        reply = json.loads(line)
                        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0":
                            raise DiagnosticFailure()
                        if reply.get("id") == identifier:
                            if "error" in reply or not isinstance(reply.get("result"), dict):
                                raise DiagnosticFailure()
                            return reply["result"]
                        # Only notifications may be ignored; never answer server requests.
                        if "id" in reply or "method" not in reply:
                            raise DiagnosticFailure()

                initialized = await request(1, "initialize", {
                    "protocolVersion": "2025-03-26", "capabilities": {},
                    "clientInfo": {"name": "agentown-local-diagnostic", "version": "1"}})
                if (initialized.get("protocolVersion") != "2025-03-26"
                        or not isinstance(initialized.get("capabilities", {}).get("tools"), dict)):
                    raise DiagnosticFailure()
                await send(dict(jsonrpc="2.0", method="notifications/initialized"))
                names, cursors, cursor = set(), set(), None
                for identifier in range(2, 102):
                    result = await request(identifier, "tools/list", {} if cursor is None else {"cursor": cursor})
                    tools = result.get("tools")
                    if not isinstance(tools, list) or any(not isinstance(t, dict) or not isinstance(t.get("name"), str) for t in tools):
                        raise DiagnosticFailure()
                    names.update(t["name"] for t in tools)
                    cursor = result.get("nextCursor")
                    if cursor is None:
                        break
                    if not isinstance(cursor, str) or not cursor or cursor in cursors:
                        raise DiagnosticFailure()
                    cursors.add(cursor)
                else:
                    raise DiagnosticFailure()
                if not REQUIRED_TOOLS <= names:
                    return outcome("failed", "missing_tools", "Required local workflow tools were not discovered.",
                                   "Repair or reinstall this AgenTown installation, restart it and check again. Keep the database.")
                return outcome("passed", "diagnostic_passed", "Local server diagnostic passed",
                               "External client configuration remains unknown; connection and exercise remain unverified. Follow the client setup steps.")
        except TimeoutError:
            return outcome("timeout", "diagnostic_timeout", "Local server diagnostic timed out.",
                           "Check database access and installation health, then explicitly check again. Keep the database.")
        except Exception:
            # Never expose stderr, paths, environment, protocol payloads or exceptions.
            return outcome("failed", "diagnostic_failed", "The installed local server could not complete its diagnostic.",
                           "Check the installed Python and database permissions. Repair the installation if needed, restart and check again. Keep the database.")
        finally:
            if process is not None:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                # Reaping continues even if shutdown races request cancellation.
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
