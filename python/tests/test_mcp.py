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
    assert set(tools) == {"list_agents", "get_agent", "list_tasks", "get_task"}
    for name, tool in tools.items():
        assert tool.annotations.readOnlyHint
        assert tool.outputSchema
        jsonschema.Draft202012Validator.check_schema(tool.outputSchema)
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
