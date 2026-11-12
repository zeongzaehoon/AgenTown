"""Run the installed entry point in independent processes (also used for wheel checks)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

import pytest


@pytest.fixture
def cli(tmp_path):
    executable = os.environ.get("LLM_ENGINE_TEST_CLI") or str(
        Path(sys.executable).parent / ("agentown.exe" if os.name == "nt" else "agentown"))

    def run(*args, success=True, machine=True):
        command = [executable, "--database", str(tmp_path / "product.sqlite")]
        if machine:
            command.append("--json")
        result = subprocess.run(command + list(args), cwd=tmp_path, text=True,
                                capture_output=True, timeout=20)
        if os.environ.get("LLM_ENGINE_TEST_TRANSCRIPT"):
            print(json.dumps({"command": command + list(args), "exit": result.returncode,
                              "stdout": result.stdout, "stderr": result.stderr}))
        assert (result.returncode == 0) == success, result.stderr
        assert "Traceback" not in result.stderr
        if success:
            assert not result.stderr
            return json.loads(result.stdout) if machine else result.stdout
        assert result.stderr
        return result.stderr
    return run


def test_persisted_complete_flow(cli):
    assert cli("agent", "list") == []
    assert cli("task", "list") == []
    assert cli("agent", "list", machine=False).strip() == "No agents yet."
    assert cli("task", "list", machine=False).strip() == "No tasks yet."
    first = cli("agent", "create", "  Designer 한글  ")
    second = cli("agent", "create", "Developer")
    assert first["name"] == "Designer 한글"
    task = cli("task", "create", "Build workspace")
    assert task["status"] == "pending" and task["assignees"] == []
    assigned = cli("task", "assign", task["id"], first["id"], second["id"])
    assert set(assigned["assignees"]) == {first["id"], second["id"]}
    assert cli("task", "show", task["id"]) == assigned
    assert cli("task", "list") == [assigned]
    assert {a["id"] for a in cli("agent", "list")} == {first["id"], second["id"]}
    text = cli("task", "show", task["id"], machine=False)
    assert first["id"] in text and second["id"] in text and "pending" in text


def test_unknown_ids_and_batch_rollback(cli):
    agent = cli("agent", "create", "A")["id"]
    task = cli("task", "create", "T")["id"]
    unknown = str(uuid.uuid4())
    assert "unknown task" in cli("task", "show", unknown, success=False)
    assert "unknown task" in cli("task", "assign", unknown, agent, success=False)
    assert "unknown agent" in cli("task", "assign", task, agent, unknown, success=False)
    assert cli("task", "show", task)["assignees"] == []
    assert "invalid task ID" in cli("task", "show", "bad", success=False)
    assert "invalid agent ID" in cli("task", "assign", task, "bad", success=False)


def test_duplicate_policy_is_atomic(cli):
    first = cli("agent", "create", "A")["id"]
    second = cli("agent", "create", "B")["id"]
    task = cli("task", "create", "T")["id"]
    assert "already assigned" in cli("task", "assign", task, first, first, success=False)
    assert cli("task", "show", task)["assignees"] == []
    cli("task", "assign", task, first)
    assert "already assigned" in cli("task", "assign", task, second, first, success=False)
    assert cli("task", "show", task)["assignees"] == [first]


def test_validation_help_and_errors(cli):
    assert "must not be empty" in cli("agent", "create", "   ", success=False)
    assert "must not be empty" in cli("task", "create", "", success=False)
    assert cli("agent", "list") == []
    assert cli("task", "list") == []
    assert "--database" in cli("--help", machine=False)
    assert "atomically" in cli("task", "assign", "--help", machine=False)
    assert "required" in cli("task", "assign", "bad", success=False)


def test_database_error(cli, tmp_path):
    (tmp_path / "product.sqlite").mkdir()
    assert "database error" in cli("agent", "list", success=False)


@pytest.mark.parametrize("client", ["claude-desktop", "cursor"])
def test_connection_setup_cli(cli, client):
    platform = "windows" if os.name == "nt" else "macos"
    executable = r"C:\Installed Space\agentown-mcp.exe" if os.name == "nt" else "/Installed Space/bin/agentown-mcp"
    config = cli("connection", "setup", "--client", client, "--platform", platform,
                 "--executable", executable)
    assert config["mcpServers"]["agentown"]["command"] == executable
    assert "absolute" in cli("connection", "setup", "--client", client,
        "--platform", "macos", "--executable", "relative", success=False)


def test_connection_detection_cli():
    executable = os.environ.get("LLM_ENGINE_TEST_CLI") or str(
        Path(sys.executable).parent / ("agentown.exe" if os.name == "nt" else "agentown"))
    result = subprocess.run([executable, "connection", "detect"],
                            text=True, capture_output=True, timeout=20)
    assert result.returncode == 0 and not result.stderr
    clients = json.loads(result.stdout)["clients"]
    assert {client["id"] for client in clients} == {"claude-desktop", "cursor"}
    assert all(client["client_exercise"] == "unverified" for client in clients)
