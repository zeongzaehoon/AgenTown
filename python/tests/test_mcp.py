"""Real SDK client + installed server processes; all waits and cleanup are bounded."""
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid

import anyio
import jsonschema
from mcp import ClientSession, StdioServerParameters
import mcp.client.stdio as stdio
import pytest

from test_cli import cli


def executable():
    return os.environ.get("LLM_ENGINE_TEST_MCP") or str(
        Path(sys.executable).parent / ("agentown-mcp.exe" if os.name == "nt" else "agentown-mcp"))


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def server_processes(monkeypatch):
    processes = []
    original = stdio._create_platform_compatible_process

    class Capture:
        def __init__(self, stream):
            self.stream, self.data = stream, bytearray()

        async def receive(self, *args):
            data = await self.stream.receive(*args)
            self.data.extend(data)
            return data

        async def aclose(self):
            await self.stream.aclose()

    async def spawn(*args, **kwargs):
        process = await original(*args, **kwargs)
        capture = Capture(process.stdout)
        # Observe transport bytes without replacing the SDK client/protocol.
        process._stdout = capture
        processes.append((process, capture))
        return process

    monkeypatch.setattr(stdio, "_create_platform_compatible_process", spawn)
    yield processes
    for process, capture in processes:
        assert process.returncode is not None, f"server {process.pid} leaked"
        for line in capture.data.splitlines():
            message = json.loads(line)  # stdout must contain only JSON-RPC
            assert message["jsonrpc"] == "2.0"


@asynccontextmanager
async def session(database):
    with anyio.fail_after(30):
        async with stdio.stdio_client(StdioServerParameters(
            command=executable(), args=["--database", str(database)],
            cwd=str(database.parent),
        )) as streams:
            async with ClientSession(*streams) as client:
                initialized = await client.initialize()
                assert initialized.serverInfo.name == "AgenTown"
                yield client


async def discover(client):
    tools = {tool.name: tool for tool in (await client.list_tools()).tools}
    assert set(tools) == {"list_agents", "get_agent", "list_tasks", "get_task",
                          "create_employee_v1", "save_text_work_v1",
                          "execute_text_work_v1", "get_work_history_v1", "list_skills_v1"}
    for name, tool in tools.items():
        assert tool.annotations.readOnlyHint == (name in {
            "list_agents", "get_agent", "list_tasks", "get_task", "list_skills_v1"})
        assert tool.outputSchema
        jsonschema.Draft202012Validator.check_schema(tool.outputSchema)
        if name.endswith("_v1"):
            continue
        expected = {} if name.startswith("list_") else {
            "agent_id" if name == "get_agent" else "task_id": "string"}
        assert {k: v["type"] for k, v in tool.inputSchema["properties"].items()} == expected
    return tools


async def call(client, tools, name, args=None):
    result = await client.call_tool(name, args or {})
    assert not result.isError, result
    jsonschema.validate(result.structuredContent, tools[name].outputSchema,
                        format_checker=jsonschema.FormatChecker())
    return result.structuredContent


@pytest.mark.anyio
async def test_protocol_commits_restart_and_preservation(cli, tmp_path, server_processes):
    cli("agent", "list")
    database = tmp_path / "product.sqlite"
    before = database.read_bytes()
    async with session(database) as client:
        tools = await discover(client)
        assert await call(client, tools, "list_agents") == {"agents": []}
        assert await call(client, tools, "list_tasks") == {"tasks": []}
        assert database.read_bytes() == before
        first = cli("agent", "create", "Designer 한글")
        second = cli("agent", "create", "Developer")
        task = cli("task", "create", "Shared Task")
        assigned = cli("task", "assign", task["id"], first["id"], second["id"])
        before = database.read_bytes()
        assert await call(client, tools, "get_agent", {"agent_id": first["id"]}) == first
        assert await call(client, tools, "get_task", {"task_id": task["id"]}) == assigned
        assert await call(client, tools, "list_tasks") == {"tasks": [assigned]}
        agents = (await call(client, tools, "list_agents"))["agents"]
        assert agents == sorted([first, second], key=lambda row: row["id"])
        for name, key in [("get_agent", "agent_id"), ("get_task", "task_id")]:
            for value, expected in [("bad", "invalid"), (str(uuid.uuid4()), "unknown")]:
                result = await client.call_tool(name, {key: value})
                assert result.isError and expected in result.content[0].text
            assert (await client.call_tool(name, {key: 123})).isError
        # A tool call cannot switch stores, even if an extra field is supplied.
        alternate = tmp_path / "alternate.sqlite"
        result = await client.call_tool("list_agents", {"database": str(alternate)})
        assert result.isError or result.structuredContent == {"agents": agents}
        assert not alternate.exists()
        assert (await client.call_tool("create_agent", {"name": "Forbidden"})).isError
        assert database.read_bytes() == before
    async with session(database) as client:
        tools = await discover(client)
        assert await call(client, tools, "get_task", {"task_id": task["id"]}) == assigned
        assert database.read_bytes() == before
    assert len(server_processes) == 2


@pytest.mark.anyio
async def test_storage_failure_is_tool_error(cli, tmp_path, server_processes):
    cli("agent", "list")
    database = tmp_path / "product.sqlite"
    async with session(database) as client:
        with sqlite3.connect(database) as connection:
            connection.execute("PRAGMA user_version=999")
        before = database.read_bytes()
        result = await client.call_tool("list_agents", {})
        assert result.isError and "schema" in result.content[0].text.lower()
        assert database.read_bytes() == before


@pytest.mark.parametrize("kind", ["missing", "foreign", "garbage", "directory", "no_argument"])
def test_invalid_startup(kind, tmp_path):
    database = tmp_path / "invalid.sqlite"
    if kind == "foreign":
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE foreign_data(value)")
    elif kind == "garbage":
        database.write_bytes(b"not sqlite")
    elif kind == "directory":
        database.mkdir()
    before = database.read_bytes() if database.is_file() else None
    args = [] if kind == "no_argument" else ["--database", str(database)]
    result = subprocess.run([executable(), *args], input="", text=True,
                            capture_output=True, cwd=tmp_path, timeout=20)
    assert result.returncode != 0 and result.stderr
    assert not result.stdout and "Traceback" not in result.stderr
    if before is not None:
        assert database.read_bytes() == before
    elif kind in {"missing", "no_argument"}:
        assert not database.exists()


@pytest.mark.anyio
async def test_team_assignment_inspection(cli, tmp_path, server_processes):
    first = cli('agent', 'create', 'A')
    second = cli('agent', 'create', 'B')
    team = cli('team', 'create', 'Delivery')['id']
    cli('team', 'add-members', team, first['id'], second['id'])
    task = cli('task', 'create', 'Deliver')['id']
    assigned = cli('team', 'assign', team, task)
    failed = cli('run', 'start', task, '--stage', 'implement',
                 '--reporting-source', 'operator', '--participants', first['id'])
    cli('run', 'finish', failed['id'], '--outcome', 'failure')
    active = cli('run', 'start', task, '--stage', 'implement',
                 '--reporting-source', 'operator', '--participants', second['id'])
    history = cli('run', 'list', task)
    database = tmp_path / 'product.sqlite'
    before = database.read_bytes()
    for _ in range(2):
        async with session(database) as client:
            tools = await discover(client)
            assert (await call(client, tools, 'list_agents'))['agents'] == sorted(
                [first, second], key=lambda row: row['id'])
            for agent in (first, second):
                assert await call(client, tools, 'get_agent', {'agent_id': agent['id']}) == agent
            assert await call(client, tools, 'list_tasks') == {'tasks': [assigned]}
            assert await call(client, tools, 'get_task', {'task_id': task}) == assigned
        assert database.read_bytes() == before
    assert cli('team', 'show', team)['members'] == sorted([first['id'], second['id']])

    assert cli('run', 'list', task) == history
    assert cli('run', 'show', active['id']) == active


@asynccontextmanager
async def fixture_session(database, *, forbid_provider=False):
    with anyio.fail_after(30):
        async with stdio.stdio_client(StdioServerParameters(
            command=sys.executable,
            args=[str(Path(__file__).with_name("mcp_fixture_server.py")), str(database),
                  *(["--forbid-provider"] if forbid_provider else [])],
            cwd=str(database.parent),
        )) as streams:
            async with ClientSession(*streams) as client:
                await client.initialize()
                yield client


@pytest.mark.anyio
async def test_explicit_workflow_retry_failure_and_reopen(cli, tmp_path, server_processes):
    cli("agent", "list")
    database = tmp_path / "product.sqlite"
    async with fixture_session(database) as client:
        tools = await discover(client)
        execute = tools["execute_text_work_v1"]
        assert not execute.annotations.idempotentHint
        assert execute.annotations.openWorldHint
        assert "COSTLY" in execute.description
        schema = execute.inputSchema
        assert set(schema["required"]) == {
            "task_id", "provider", "model", "declared_source", "expected_runs"}
        assert schema["properties"]["declared_source"]["minLength"] == 1
        assert schema["properties"]["declared_source"]["maxLength"] == 80
        assert schema["properties"]["expected_runs"]["minimum"] == 0
        assert schema["properties"]["resubmission_consent"]["default"] is False
        assert not any("key" in key or "credential" in key
                       for key in execute.inputSchema["properties"])
        employee = (await call(client, tools, "create_employee_v1", {"name": "Writer"}))["employee"]
        work = (await call(client, tools, "save_text_work_v1", {
            "employee_id": employee["id"], "text": "Draft a greeting"}))["task"]
        args = {"task_id": work["id"], "provider": "anthropic", "model": "fixture",
                "expected_runs": 0, "declared_source": "test-client"}
        for invalid in (
            {key: value for key, value in args.items() if key != "declared_source"},
            {key: value for key, value in args.items() if key != "expected_runs"},
            {**args, "declared_source": ""},
            {**args, "expected_runs": -1},
        ):
            assert (await client.call_tool("execute_text_work_v1", invalid)).isError
        # Pydantic counts characters; native provenance is bounded in UTF-8 bytes.
        oversized_source = await client.call_tool("execute_text_work_v1", {
            **args, "declared_source": "한" * 27})
        assert oversized_source.isError
        assert (await call(client, tools, "get_work_history_v1", {
            "task_id": work["id"]}))["attempts"] == []
        initial = await call(client, tools, "execute_text_work_v1", args)
        assert initial["output"] == "Fixture result: Draft a greeting"
        assert initial["quality"] == "unverified" and initial["error"] is None
        # Replay of the original admission cannot create another Run.
        assert (await client.call_tool("execute_text_work_v1", args)).isError
        stale = {**args, "expected_runs": 99, "resubmission_consent": True}
        assert (await client.call_tool("execute_text_work_v1", stale)).isError
        args["expected_runs"] = 1
        assert (await client.call_tool("execute_text_work_v1", args)).isError
        rejected_history = await call(client, tools, "get_work_history_v1", {
            "task_id": work["id"]})
        assert [run["id"] for run in rejected_history["attempts"]] == [initial["run_id"]]
        args.update(resubmission_consent=True, model="failure")
        failure = await call(client, tools, "execute_text_work_v1", args)
        assert failure["error"] == "provider_error" and failure["output"] is None
        assert failure["run_id"] != initial["run_id"]
        args.update(expected_runs=2, model="fixture")
        recovered = await call(client, tools, "execute_text_work_v1", args)
        assert recovered["output"] and recovered["run_id"] != failure["run_id"]
        history = await call(client, tools, "get_work_history_v1", {"task_id": work["id"]})
        assert all(run["skill"] is None for run in history["attempts"])
        assert len(history["attempts"]) == 3
        assert {r["declared_source"] for r in history["attempts"]} == {"test-client"}
        assert {r["reporting_source"] for r in history["attempts"]} == {"anthropic"}
        assert {r["task_id"] for r in history["attempts"]} == {work["id"]}
        assert {r["execution"]["run_id"] for r in history["attempts"]} == {
            initial["run_id"], failure["run_id"], recovered["run_id"]}
    async with fixture_session(database) as client:
        tools = await discover(client)
        assert await call(client, tools, "get_work_history_v1", {"task_id": work["id"]}) == history


@pytest.mark.anyio
async def test_concurrent_admission_rejected(cli, tmp_path, server_processes):
    cli("agent", "list")
    database = tmp_path / "product.sqlite"
    async with fixture_session(database) as first, fixture_session(database) as second:
        tools = await discover(first)
        employee = (await call(first, tools, "create_employee_v1", {"name": "Writer"}))["employee"]
        work = (await call(first, tools, "save_text_work_v1", {
            "employee_id": employee["id"], "text": "Draft"}))["task"]
        args = {"task_id": work["id"], "provider": "anthropic", "model": "slow",
                "expected_runs": 0, "declared_source": "test-client"}
        results = []

        async def execute(client):
            results.append(await client.call_tool("execute_text_work_v1", args))

        async with anyio.create_task_group() as group:
            group.start_soon(execute, first)
            group.start_soon(execute, second)
        assert sorted(result.isError for result in results) == [False, True]
        history = await call(first, tools, "get_work_history_v1", {"task_id": work["id"]})
        assert len(history["attempts"]) == 1


@pytest.mark.anyio
async def test_workflow_errors_do_not_echo_input(cli, tmp_path, server_processes):
    cli("agent", "list")
    async with fixture_session(tmp_path / "product.sqlite") as client:
        tools = await discover(client)
        result = await client.call_tool("save_text_work_v1", {
            "employee_id": "private-invalid-value", "text": "Draft"})
        assert result.isError
        assert "private-invalid-value" not in str(result)
        assert "Traceback" not in str(result)


@pytest.mark.anyio
async def test_skill_discovery_and_immutable_history(cli, tmp_path, server_processes):
    from llm_engine import _native

    cli("agent", "list")
    database = tmp_path / "product.sqlite"
    db = str(database)
    # This process fails if discovery/history ever constructs a provider.
    async with fixture_session(database, forbid_provider=True) as client:
        tools = await discover(client)
        assert await call(client, tools, "list_skills_v1") == {
            "schema_version": 1, "skills": []}
        first = _native.create_skill(db, "Concise", "Use short sentences.")
        second = _native.create_skill(db, "Disabled", "Other instructions.")
        _native.set_skill_enabled(db, first["id"], True)
        expected = {"schema_version": 1, "skills": sorted([
            {"id": first["id"], "name": "Concise", "enabled": True},
            {"id": second["id"], "name": "Disabled", "enabled": False},
        ], key=lambda row: row["id"])}
        assert await call(client, tools, "list_skills_v1") == expected
        employee = cli("agent", "create", "Writer")
        work = cli("task", "create", "Saved work")
        cli("task", "assign", work["id"], employee["id"])
        legacy = cli("run", "start", work["id"], "--stage", "implement",
                     "--reporting-source", "operator", "--participants", employee["id"])
        cli("run", "finish", legacy["id"], "--outcome", "failure")
        preview = _native.preview_skill(db, work["id"], first["id"])
        execution = _native.start_skill_execution(
            db, work["id"], preview["preview_id"], "anthropic", "fixture", 1)
        admitted = next(row for row in _native.skill_provenance(db)
                        if row["run_id"] == execution[0])
        _native.update_skill(db, first["id"], "Edited", "Different instructions.")
        _native.set_skill_enabled(db, first["id"], False)
        history = await call(client, tools, "get_work_history_v1", {"task_id": work["id"]})
        attempts = {row["id"]: row for row in history["attempts"]}
        assert attempts[legacy["id"]]["skill"] is None
        assert attempts[legacy["id"]]["execution"] is None
        assert attempts[execution[0]]["skill"] == admitted
        assert admitted["instructions"] == "Use short sentences."
        assert admitted["input"] == preview["input"]
        assert admitted["skill_name"] == "Concise"
        assert admitted["skill_id"] == first["id"]
        assert admitted["preview_id"] == preview["preview_id"]
        assert attempts[execution[0]]["execution"]["input"] == preview["input"]
    async with fixture_session(database, forbid_provider=True) as client:
        tools = await discover(client)
        assert await call(client, tools, "list_skills_v1") == {
            "schema_version": 1, "skills": sorted([
                {"id": first["id"], "name": "Edited", "enabled": False},
                {"id": second["id"], "name": "Disabled", "enabled": False},
            ], key=lambda row: row["id"])}
        assert await call(client, tools, "get_work_history_v1", {"task_id": work["id"]}) == history
