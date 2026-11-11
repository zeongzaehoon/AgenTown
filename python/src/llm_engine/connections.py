"""Static presentation of the published stdio workflow v1; no client probing."""
import json


def connection_setup():
    clients = []
    for client_id, name in (("codex", "Codex"), ("claude-code", "Claude Code")):
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
        "consent": "Connection approval is not execution consent. Keep client tool approval enabled. Before a costly, non-idempotent execution, confirm saved text, employee, provider/model and current attempt count. Pass expected_runs and declared_source (codex or claude-code, an untrusted label). Initial execution uses resubmission_consent: false. Any resend requires fresh explicit consent and resubmission_consent: true. Never pass credentials as tool arguments; provider configuration is inherited from the server environment.",
        "recovery": "After a timeout or disconnect inspect history before retrying: a lost response may have committed a Run. For startup failure check the configured executable with --help, database path/permissions and client stderr. Do not delete the database. To disconnect, stop the client, remove only its agentown entry (or restore the backup), then restart. Keep the database.",
        "clients": clients,
    }
