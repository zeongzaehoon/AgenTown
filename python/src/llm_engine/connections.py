"""Static presentation of the published stdio workflow v1; no client probing."""
import json
import os
import shutil
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath


def connection_setup():
    clients = []
    for client_id, name in (("codex", "Codex"), ("claude-code", "Claude Code"), ("claude-desktop", "Claude Desktop"), ("cursor", "Cursor")):
        platforms = []
        for platform in ("macos", "windows"):
            windows = platform == "windows"
            executable = r"C:\Company\venv\Scripts\agentown-mcp.exe" if windows else "/absolute/venv/bin/agentown-mcp"
            database = r"C:\Company\company.sqlite" if windows else "/absolute/company.sqlite"
            if client_id == "codex":
                quote = "'" if windows else '"'
                config = f'[mcp_servers.agentown]\ncommand = {quote}{executable}{quote}\nargs = ["--database", {quote}{database}{quote}]\n'
                destination = r"%USERPROFILE%\.codex\config.toml" if windows else "~/.codex/config.toml"
                inspect = "Run codex mcp list, then open Codex and inspect /mcp."
            elif client_id in JSON_CLIENTS:
                config = generate_configuration(client_id, platform, executable, database)
                if client_id == "claude-desktop":
                    destination = r"%APPDATA%\Claude\claude_desktop_config.json" if windows else "~/Library/Application Support/Claude/claude_desktop_config.json"
                    inspect = "Restart Claude Desktop, inspect MCP server status in Developer settings, then request employee and Task inspection. Client exercise is unverified."
                else:
                    destination = r"%USERPROFILE%\.cursor\mcp.json or project .cursor\mcp.json" if windows else "~/.cursor/mcp.json or project .cursor/mcp.json"
                    inspect = "Open Cursor MCP settings, enable the server with approval, then request employee and Task inspection. Client exercise is unverified."
            else:
                config = json.dumps({"mcpServers": {"agentown": {"type": "stdio", "command": executable, "args": ["--database", database]}}}, indent=2) + "\n"
                destination = ".mcp.json in the chosen project root"
                inspect = "Run claude mcp get agentown, then open Claude Code in that project, review trust prompts and inspect /mcp."
            platforms.append({"id": platform, "name": "Windows" if windows else "macOS", "configuration": config,
                              "destination": destination, "inspection": inspect})
        clients.append({"id": client_id, "name": name, "readiness": "unknown", "platforms": platforms})
    return {
        "schema_version": 1, "workflow_version": 1, "transport": "stdio",
        "evidence": "No client settings or connection sessions are inspected. Setup availability and copying do not establish configuration or verification.",
        "preparation": "Install AgenTown into a virtual environment. Replace both absolute paths below. The database parent must exist. Initialize the store with the matching agentown executable: agentown --database ABSOLUTE_DATABASE agent list. Back up the destination and merge only the agentown entry; preserve other servers. The client launches the stdio server; there is no remote URL.",
        "actions": ["List and inspect employees and saved work (list_agents, get_agent, list_tasks, get_task).", "Create an employee and save assigned text without a provider call (create_employee_v1, save_text_work_v1).", "Inspect attempts and results (get_work_history_v1); inspection can finalize expired leases.", "Explicitly execute or retry saved text (execute_text_work_v1); results remain quality-unverified."],
        "consent": "Connection approval is not execution consent. Keep client tool approval enabled. Before a costly, non-idempotent execution, confirm saved text, employee, provider/model and current attempt count. Pass expected_runs and declared_source (codex, claude-code, claude-desktop or cursor, an untrusted label). Initial execution uses resubmission_consent: false. Any resend requires fresh explicit consent and resubmission_consent: true. Never pass credentials as tool arguments; provider configuration is inherited from the server environment.",
        "recovery": "After a timeout or disconnect inspect history before retrying: a lost response may have committed a Run. For startup failure check the configured executable with --help, database path/permissions and client stderr. Do not delete the database. To disconnect, stop the client, remove only its agentown entry (or restore the backup), then restart. Keep the database.",
        "clients": clients,
    }


JSON_CLIENTS = ("claude-desktop", "cursor")


def generate_configuration(client, platform, executable, database):
    """Render only; never inspect paths or write a client's settings."""
    if client not in JSON_CLIENTS or platform not in ("macos", "windows"):
        raise ValueError("Choose claude-desktop or cursor and macos or windows.")
    path_type = PureWindowsPath if platform == "windows" else PurePosixPath
    for name, value in (("executable", executable), ("database", database)):
        if not value or not path_type(value).is_absolute() or any(ord(c) < 32 for c in value):
            raise ValueError(f"{name} must be an absolute {platform} path without control characters.")
    entry = {"command": executable, "args": ["--database", database]}
    if client == "cursor":
        entry["type"] = "stdio"
    return json.dumps({"mcpServers": {"agentown": entry}}, indent=2) + "\n"


def detect_capabilities():
    """Bounded installation hints only: no settings, credentials or subprocesses."""
    clients = []
    for client, command, app in (("claude-desktop", None, "Claude.app"),
                                  ("cursor", "cursor", "Cursor.app")):
        located = shutil.which(command) if command else None
        app_present = sys.platform == "darwin" and (Path("/Applications") / app).is_dir()
        local = os.environ.get("LOCALAPPDATA") if sys.platform == "win32" else None
        relative = ("AnthropicClaude/claude.exe" if client == "claude-desktop"
                    else "Programs/cursor/Cursor.exe")
        windows_present = bool(local and (Path(local) / relative).is_file())
        clients.append({"id": client, "detected": bool(located or app_present or windows_present),
                        "configuration": "unknown", "protocol_connection": "unverified",
                        "client_exercise": "unverified"})
    return {"clients": clients, "evidence": "Installation hints only; no settings or credential stores read. Absence is inconclusive."}
