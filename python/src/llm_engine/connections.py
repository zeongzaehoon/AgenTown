"""Static presentation of the published stdio workflow v1; no client probing."""
import json
import os
import shutil
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath


def installed_server_command(database):
    """The fixed installed command shared by setup artifacts and diagnostics."""
    return [str(Path(sys.executable).absolute()), "-I", "-m", "llm_engine.mcp_server",
            "--database", str(Path(database).absolute())]


def connection_setup(database=None):
    selected_database = database
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
    result = {
        "schema_version": 1, "workflow_version": 1, "transport": "stdio",
        "evidence": "No client settings or connection sessions are inspected. Setup availability and copying do not establish configuration or verification.",
        "preparation": "Install AgenTown into a virtual environment. Replace both absolute paths below. The database parent must exist. Initialize the store with the matching agentown executable: agentown --database ABSOLUTE_DATABASE agent list. Back up the destination and merge only the agentown entry; preserve other servers. The client launches the stdio server; there is no remote URL.",
        "actions": ["List and inspect employees and saved work (list_agents, get_agent, list_tasks, get_task).", "Create an employee and save assigned text without a provider call (create_employee_v1, save_text_work_v1).", "Inspect attempts and results (get_work_history_v1); inspection can finalize expired leases.", "Explicitly execute or retry saved text (execute_text_work_v1); results remain quality-unverified."],
        "consent": "Connection approval is not execution consent. Keep client tool approval enabled. Before a costly, non-idempotent execution, confirm saved text, employee, provider/model and current attempt count. Pass expected_runs and declared_source (codex, claude-code, claude-desktop or cursor, an untrusted label). Initial execution uses resubmission_consent: false. Any resend requires fresh explicit consent and resubmission_consent: true. Never pass credentials as tool arguments; provider configuration is inherited from the server environment.",
        "recovery": "After a timeout or disconnect inspect history before retrying: a lost response may have committed a Run. For startup failure check the configured executable with --help, database path/permissions and client stderr. Do not delete the database. To disconnect, stop the client, remove only its agentown entry (or restore the backup), then restart. Keep the database.",
        "clients": clients,
    }
    if selected_database is not None:
        _runtime_setup(result, selected_database)
    return result


def _runtime_setup(result, database):
    """Render the running installation; never write settings or start a server."""
    platform = "windows" if sys.platform == "win32" else "macos"
    executable, *args = installed_server_command(database)
    database = args[-1]
    hints = {c["id"]: c for c in detect_capabilities()["clients"]}
    home = Path.home()
    for client in result["clients"]:
        item = next(p for p in client["platforms"] if p["id"] == platform)
        entry = {"command": executable, "args": args}
        if client["id"] in ("cursor", "claude-code"):
            entry["type"] = "stdio"
        if client["id"] == "codex":
            # TOML requires Unicode scalar values, not JSON surrogate escapes.
            item["configuration"] = ('[mcp_servers.agentown]\ncommand = ' + json.dumps(executable, ensure_ascii=False) +
                                     '\nargs = ' + json.dumps(args, ensure_ascii=False) + '\n')
            destination = home / ".codex" / "config.toml"
        else:
            item["configuration"] = json.dumps({"mcpServers": {"agentown": entry}}, indent=2) + "\n"
            if client["id"] == "claude-desktop":
                destination = (Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))) / "Claude" / "claude_desktop_config.json"
                               if platform == "windows" else home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json")
            elif client["id"] == "cursor":
                destination = home / ".cursor" / "mcp.json"
            else:
                destination = home / ".claude.json"
                item["inspection"] = "Use Claude Code /mcp Add server (user scope) with the command and args shown, then run claude mcp get agentown and inspect /mcp. Merge the mcpServers entry only; preserve other settings."
        item["destination"] = str(destination)
        item["filename"] = client["id"] + (".toml" if client["id"] == "codex" else ".json")
        client["platforms"] = [item]
        client["status"] = {"detected": hints.get(client["id"], {}).get("detected"),
                            "configured": "unknown", "connected": "unverified", "exercised": "unverified"}
    remote = """ChatGPT remote connection prerequisites — not configured or verified.
ChatGPT cannot use a local executable or loopback URL.
Provide a public HTTPS endpoint with a valid certificate and trusted TLS proxy forwarding /mcp and discovery routes, including Authorization headers (never log them).
Provide an OAuth issuer with discovery, authorization/token endpoints, supported client registration, redirect validation, PKCE and scoped/audienced access tokens. AgenTown is a resource server, not an OAuth login service.
Choose an eligible ChatGPT workspace and configure its remote MCP connector with the public HTTPS /mcp URL. Keep tool approvals enabled.
The operator must explicitly start the packaged Python with -I -m llm_engine.mcp_remote --database DATABASE --public-key PUBLIC_KEY --issuer ISSUER --base-url HTTPS_URL --allow-public --host 127.0.0.1 behind that proxy.
Replace DATABASE with the selected database below; all other values require operator configuration. No endpoint, issuer or key is detected by this screen.
Validate protected-resource discovery at /.well-known/oauth-protected-resource/mcp, unauthenticated rejection, OAuth login and approved read-only list_agents/list_tasks before considering connected or exercised.
Recovery: stop the foreground adapter and revoke/stop the proxy separately. Inspect work history before retrying. Keep the database. Remove only the connector to disconnect.
"""
    remote += "\nPackaged Python: " + executable + "\nSelected database: " + database + "\n"
    result["clients"].append({"id": "chatgpt", "name": "ChatGPT", "readiness": "unknown",
        "status": {"detected": None, "configured": "unknown", "connected": "unverified", "exercised": "unverified"},
        "platforms": [{"id": platform, "name": "Windows" if platform == "windows" else "macOS",
        "configuration": remote, "filename": "chatgpt-prerequisites.txt", "destination": "ChatGPT workspace connector settings — HTTPS/OAuth prerequisites unmet",
        "inspection": "Complete the prerequisites in this checklist. Local stdio configuration is not usable by ChatGPT."}]})
    result["preparation"] = ("Artifacts use this running packaged Python and selected database. No checkout or Node is required. "
        "Back up the destination and merge only the agentown entry; do not replace other settings. "
        "Download saves a merge fragment, not a settings installation. For ChatGPT use the prerequisite checklist instead. "
        "Moving the installation or selecting another database requires fresh artifacts.")



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
