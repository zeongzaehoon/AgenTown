"""Launch checked-in client artifacts via MCP SDK, never installed client settings.

Both path syntaxes are parsed on any host. Substitution exercises the installed
server on the test host; it does not validate the named client or another OS.
"""
import json
import os
import shutil
from pathlib import Path, PurePosixPath, PureWindowsPath
import tomllib

import anyio
from mcp import ClientSession, StdioServerParameters
import mcp.client.stdio as stdio
import pytest

from test_cli import cli
from test_mcp import call, discover, executable, server_processes


ARTIFACTS = Path(__file__).resolve().parents[2] / "docs" / "mcp-config"
CONFIGS = [f"{client}-{platform}.{extension}"
           for client, extension in [("codex", "toml"), ("claude-code", "json"), ("claude-desktop", "json"), ("cursor", "json")]
           for platform in ["macos", "windows"]]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def load_config(filename):
    path = ARTIFACTS / filename
    if path.suffix == ".toml":
        root = tomllib.loads(path.read_text(encoding="utf-8"))
        servers = root["mcp_servers"]
    else:
        root = json.loads(path.read_text(encoding="utf-8"))
        servers = root["mcpServers"]
    assert set(servers) == {"agentown"}
    entry = servers["agentown"]
    assert set(entry) == ({"command", "args"} if path.suffix == ".toml"
                          else ({"type", "command", "args"} if filename.startswith(("claude-code", "cursor")) else {"command", "args"}))
    assert entry.get("type", "stdio") == "stdio"
    assert len(entry["args"]) == 2 and entry["args"][0] == "--database"
    path_type = PureWindowsPath if "windows" in filename else PurePosixPath
    assert path_type(entry["command"]).is_absolute()
    assert path_type(entry["args"][1]).is_absolute()
    assert path_type(entry["command"]).name == (
        "agentown-mcp.exe" if "windows" in filename else "agentown-mcp")
    return entry


@pytest.mark.parametrize("filename", CONFIGS)
def test_configuration_shape(filename):
    load_config(filename)


@pytest.mark.anyio
@pytest.mark.parametrize("filename", CONFIGS)
async def test_artifact_launch_discovery_and_inspection(
        filename, cli, tmp_path, server_processes):
    entry = load_config(filename)
    employee = cli("agent", "create", "Connection check")
    task = cli("task", "create", "Inspect without execution")
    assigned = cli("task", "assign", task["id"], employee["id"])
    database = tmp_path / "product.sqlite"
    before = database.read_bytes()
    # Only machine-specific path values change; command/argument structure comes
    # from the artifact. cwd deliberately differs from the checkout.
    # Launch an executable path with spaces, without a shell. Symlink preserves
    # the installed entry point interpreter and package environment.
    spaced = tmp_path / "Installed Product Space"
    spaced.mkdir()
    command = spaced / Path(executable()).name
    if os.name == "nt":
        shutil.copy2(executable(), command)
    else:
        command.symlink_to(executable())
    database_with_spaces = spaced / "Company Data.sqlite"
    database_with_spaces.write_bytes(database.read_bytes())
    if filename.startswith(("claude-desktop", "cursor")):
        from llm_engine.connections import generate_configuration
        generated = generate_configuration(filename.split("-macos")[0].split("-windows")[0],
            "windows" if os.name == "nt" else "macos", str(command), str(database_with_spaces))
        entry = json.loads(generated)["mcpServers"]["agentown"]
    else:
        entry["command"] = str(command)
        entry["args"][1] = str(database_with_spaces)
    with anyio.fail_after(30):
        async with stdio.stdio_client(StdioServerParameters(
                command=entry["command"], args=entry["args"],
                cwd=str(tmp_path))) as streams:
            async with ClientSession(*streams) as client:
                initialized = await client.initialize()
                assert initialized.serverInfo.name == "AgenTown"
                tools = await discover(client)
                assert await call(client, tools, "list_agents") == {"agents": [employee]}
                assert await call(client, tools, "get_agent", {
                    "agent_id": employee["id"]}) == employee
                assert await call(client, tools, "get_task", {
                    "task_id": task["id"]}) == assigned
                history = await call(client, tools, "get_work_history_v1", {
                    "task_id": task["id"]})
                assert history["schema_version"] == 1
                assert history["task"]["id"] == task["id"]
                assert history["attempts"] == []
                schema = tools["execute_text_work_v1"].inputSchema
                assert {"declared_source", "expected_runs"} <= set(schema["required"])
                assert schema["properties"]["resubmission_consent"]["default"] is False
    assert database.read_bytes() == before
    assert database_with_spaces.read_bytes() == before
    assert len(server_processes) == 1  # fixture also checks exit and JSON-RPC stdout
