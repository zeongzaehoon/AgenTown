"""Bounded explicit MCP discovery and shared-data checks of the installed server.

No provider configuration, client settings, or durable admission.
The subprocess is always killed/reaped before the admission slot is released.
"""
import asyncio
import json
import subprocess
from uuid import UUID

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

    async def run_shared_data(self):
        return await self.run(shared_data=True)

    async def inspect_work(self, task_id):
        from .application.inspect_selected_work import InspectionResult
        value = await self.run(task_id=task_id)
        return InspectionResult(**value)

    async def run(self, *, shared_data=False, task_id=None):
        # No await between admission and assigning the task: one event-loop owner.
        if self.closed or self.active is not None:
            return (dict(status="busy", code="inspection_busy", message="A local check is already running or stopping.",
                             recovery="Wait, then explicitly inspect again.", inspection=None) if task_id is not None else outcome("busy", "diagnostic_busy", "A local server diagnostic is already running or stopping.",
                           "Wait for it to finish, then explicitly check again."))
        task = asyncio.create_task(self._check(task_id=task_id) if task_id is not None else
                                   self._check(shared_data=True) if shared_data else self._check())
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

    async def _check(self, *, shared_data=False, task_id=None):
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

                received = 0
                async def request(identifier, method, params):
                    nonlocal received
                    await send(dict(jsonrpc="2.0", id=identifier, method=method, params=params))
                    while True:
                        line = await process.stdout.readline()
                        received += len(line)
                        if received > 4 * 1024 * 1024 or not line:
                            raise DiagnosticFailure()
                        reply = json.loads(line)
                        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0":
                            raise DiagnosticFailure()
                        if type(reply.get("id")) is int and reply["id"] == identifier:
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
                        or not isinstance(initialized.get("capabilities"), dict)
                        or not isinstance(initialized["capabilities"].get("tools"), dict)):
                    raise DiagnosticFailure()
                await send(dict(jsonrpc="2.0", method="notifications/initialized"))
                if task_id is not None:
                    first = await request(2, "tools/call", {"name": "get_task", "arguments": {"task_id": task_id}})
                    second = await request(3, "tools/call", {"name": "get_work_history_v1",
                        "arguments": {"task_id": task_id, "read_only": True}})
                    third = await request(4, "tools/call", {"name": "inspect_loop_sessions_v1", "arguments": {}})
                    inspection = validated_inspection(first, second, task_id, third)
                    return dict(status="passed", code="inspection_passed",
                        message="Selected work inspected through the installed local MCP server.",
                        recovery="External-client connection remains unverified. Inspect again explicitly to refresh.",
                        inspection=inspection)
                if shared_data:
                    counts = []
                    for identifier, name, key in ((2, "list_agents", "agents"), (3, "list_tasks", "tasks")):
                        result = await request(identifier, "tools/call", {"name": name, "arguments": {}})
                        counts.append(validated_count(result, key))
                    return dict(outcome("passed", "shared_data_passed", "Shared employee and work access passed.",
                        "External client configuration remains unknown; connection and exercise remain unverified."),
                        employee_count=counts[0], work_count=counts[1])
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
            if task_id is not None:
                return dict(status="timeout", code="inspection_timeout", message="Local inspection timed out.",
                    recovery="Check installation and database access, then explicitly inspect again.", inspection=None)
            return outcome("timeout", "shared_data_timeout" if shared_data else "diagnostic_timeout",
                           "Local shared-data check timed out." if shared_data else "Local server diagnostic timed out.",
                           "Check database access and installation health, then explicitly check again. Keep the database.")
        except Exception:
            if task_id is not None:
                return dict(status="failed", code="inspection_failed", message="Work is missing, unavailable, or the local response was invalid.",
                    recovery="Refresh saved work and select it again. Check installation and database access before explicitly inspecting again.", inspection=None)
            # Never expose stderr, paths, environment, protocol payloads or exceptions.
            return outcome("failed", "shared_data_failed" if shared_data else "diagnostic_failed",
                           "The installed local server returned an error or malformed shared data." if shared_data else "The installed local server could not complete its diagnostic.",
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


def validated_count(result, key):
    """Validate the installed server's entire typed read result before counting.

    The server emits structured data and one equivalent JSON text block. Neither
    payload nor employee/work text crosses the HTTP boundary.
    """
    if result.get("isError", False) is not False:
        raise DiagnosticFailure()
    content = result.get("content")
    data = result.get("structuredContent")
    if (not isinstance(content, list) or len(content) != 1
            or not isinstance(content[0], dict) or content[0].get("type") != "text"
            or not isinstance(content[0].get("text"), str)
            or json.loads(content[0]["text"]) != data
            or not isinstance(data, dict) or set(data) != {key}
            or not isinstance(data[key], list)):
        raise DiagnosticFailure()
    ids = set()
    for row in data[key]:
        expected = {"id", "name"} if key == "agents" else {"id", "title", "status", "assignees"}
        if not isinstance(row, dict) or set(row) != expected:
            raise DiagnosticFailure()
        if not isinstance(row["id"], str):
            raise DiagnosticFailure()
        identifier = UUID(row["id"])
        if identifier in ids:
            raise DiagnosticFailure()
        ids.add(identifier)
        if not isinstance(row["name" if key == "agents" else "title"], str):
            raise DiagnosticFailure()
        if key == "tasks":
            if (row["status"] not in ("pending", "in_progress", "blocked", "cancelled")
                    or not isinstance(row["assignees"], list)
                    or any(not isinstance(value, str) for value in row["assignees"])):
                raise DiagnosticFailure()
            assignees = [UUID(value) for value in row["assignees"]]
            if len(set(assignees)) != len(assignees):
                raise DiagnosticFailure()
    return len(data[key])


def inspection_payload(result):
    if result.get("isError", False) is not False:
        raise DiagnosticFailure()
    content, data = result.get("content"), result.get("structuredContent")
    if (not isinstance(content, list) or len(content) != 1
            or not isinstance(content[0], dict) or content[0].get("type") != "text"
            or not isinstance(content[0].get("text"), str)
            or json.loads(content[0]["text"]) != data or not isinstance(data, dict)):
        raise DiagnosticFailure()
    return data


def validated_inspection(first, second, task_id, third=None):
    # Existing MCP models reject extra fields and malformed nested records. Strict
    # JSON validation prevents scalar coercion while accepting JSON UUID strings.
    from .mcp_server import Task, WorkHistory
    from .application.inspect_selected_work import (
        LocalInspection, InspectedTask, InspectedRun, InspectedExecution,
        InspectedSkill, InspectedHook, InspectedLoop)
    task_data, history_data = inspection_payload(first), inspection_payload(second)
    work = Task.model_validate_json(json.dumps(task_data), strict=True)
    history = WorkHistory.model_validate_json(json.dumps(history_data), strict=True)
    if work.model_dump(mode="json") != task_data or history.model_dump(mode="json") != history_data:
        raise DiagnosticFailure()
    if str(work.id) != task_id or str(history.task.id) != task_id or work != history.task:
        raise DiagnosticFailure()
    def unique(values):
        if len(values) != len(set(values)):
            raise DiagnosticFailure()
    unique(work.assignees)
    unique([run.id for run in history.attempts])
    runs = {run.id: run for run in history.attempts}
    loop_links = validated_loop_links(third, history) if third is not None else {}
    attempts = []
    for run in history.attempts:
        if run.task_id != work.id or (run.execution is not None and run.execution.run_id != run.id):
            raise DiagnosticFailure()
        unique(run.participants)
        if ((run.state == "active" and (run.ended_at is not None or run.outcome is not None))
                or (run.state == "finished" and (run.ended_at is None or run.outcome is None))
                or (run.ended_at is not None and run.ended_at < run.started_at)
                or (run.skill is not None and run.skill.run_id != run.id)
                or (run.hook is not None and (run.hook.run_id != run.id or run.hook.task_id != work.id))):
            raise DiagnosticFailure()
        if run.execution is not None:
            execution = run.execution
            if ((execution.output is not None and execution.error is not None)
                    or (run.state == 'active' and
                        (execution.output is not None or execution.error is not None))):
                raise DiagnosticFailure()
        # Validate immutable saved snapshots, never today's Skill/Hook settings.
        for provenance in (run.skill, run.hook):
            if provenance is not None and (
                    run.execution is None or provenance.input != run.execution.input
                    or provenance.admitted_at != run.started_at
                    or not provenance.preview_id.strip()
                    or not provenance.skill_name.strip()
                    or not provenance.instructions.strip()):
                raise DiagnosticFailure()
        if run.skill is not None and run.hook is not None:
            # These are distinct admission paths in the existing Rust store.
            raise DiagnosticFailure()
        if run.hook is not None:
            hook = run.hook
            source = runs.get(hook.source_run_id)
            if (source is None or source.id == run.id or source.task_id != work.id
                    or source.state != 'finished' or source.outcome != hook.source_outcome
                    or source.ended_at is None or source.ended_at > hook.admitted_at
                    or hook.event != ('run_completed' if hook.source_outcome == 'reported_success' else 'run_failed')
                    or run.participants != [hook.agent_id]
                    or not hook.hook_name.strip()):
                raise DiagnosticFailure()
        row = run.model_dump(mode="json")
        if row['execution'] is not None:
            row['execution'] = InspectedExecution(**row['execution'])
        if row['skill'] is not None:
            row['skill'] = InspectedSkill(**row['skill'])
        if row['hook'] is not None:
            row['hook'] = InspectedHook(**row['hook'])
        # Ordinary execution has no negative Loop marker. A later read may omit
        # a concurrently created session, so a missing link is not proof of absence.
        row['loop'] = loop_links.get(str(run.id), InspectedLoop(
            'absent' if run.execution is None or run.skill is not None or run.hook is not None
            else 'uncertain')) if third is not None else None
        attempts.append(InspectedRun(**row))
    return LocalInspection(InspectedTask(**work.model_dump(mode="json")), attempts)


def validated_loop_links(result, history):
    """Correlate immutable admission facts; progress reads are not a transaction."""
    from .mcp_server import LoopInspection
    from .application.inspect_selected_work import InspectedLoop
    data = inspection_payload(result)
    loops = LoopInspection.model_validate_json(json.dumps(data), strict=True)
    if loops.model_dump(mode='json') != data or loops.control.state == 'storage_failure':
        raise DiagnosticFailure()
    sessions, run_links, ordinals = {}, {}, set()
    for session in loops.sessions:
        preview = session.preview
        if (session.session_id in sessions or not preview.preview_id.strip()
                or not preview.policy_name.strip() or not preview.input.strip()
                or not 1 <= preview.max_iterations <= 100 or not 60 <= preview.interval_seconds <= 86400
                or preview.expected_runs < 0 or session.admitted < 0
                or session.admitted > preview.max_iterations
                or session.expires_at <= session.started_at
                or preview.created_at > session.started_at):
            raise DiagnosticFailure()
        sessions[session.session_id] = session
    runs = {run.id: run for run in history.attempts}
    for link in loops.attempts:
        session = sessions.get(link.session_id)
        if (session is None or link.run_id in run_links
                or (link.session_id, link.ordinal) in ordinals
                or link.ordinal < 1 or link.ordinal > session.preview.max_iterations
                or link.execution.run_id != link.run_id
                or link.admitted_at < session.started_at
                or link.admitted_at >= session.expires_at):
            raise DiagnosticFailure()
        ordinals.add((link.session_id, link.ordinal))
        run_links[link.run_id] = link
        run = runs.get(link.run_id)
        if run is None:
            # A later Loop read can include attempts absent from earlier history.
            continue
        execution, preview = run.execution, session.preview
        if (run.task_id != preview.task_id or execution is None
                or run.participants != [preview.agent_id]
                or run.skill is not None or run.hook is not None
                or run.started_at != link.admitted_at
                or execution.input != preview.input
                or execution.provider != session.provider or execution.model != session.model
                or any(getattr(execution, field) != getattr(link.execution, field)
                       for field in ('schema_version', 'run_id', 'input', 'provider', 'model', 'deadline_unix_ms'))):
            raise DiagnosticFailure()
    return {str(run_id): InspectedLoop(
        'confirmed', sessions[link.session_id].model_dump(mode='json'),
        link.ordinal, link.admitted_at)
        for run_id, link in run_links.items() if run_id in runs}
