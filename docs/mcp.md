# Read-only MCP inspection

C3-T2 implements PLAN.md 2.4 and 3 with Python 3.13 FastMCP stdio and the
Rust read-only query bindings. Install the package as described in
[Python installation](python-cli.md). `uv.lock` locks FastMCP and its MCP SDK;
there is no dependency on `.agents` or `.harness` at runtime.

Initialize a product database through the creation CLI first (even
`agentown --database PATH agent list` initializes an empty store).
The MCP server requires an existing valid database and never initializes or
migrates one. Rust validates stored data and opens SQLite read-only. Each call
reopens the fixed startup path, observing intervening committed writes.
The path is fixed, not the file's identity: replacing that file replaces the
store inspected on the next call. Use a dedicated product path.

macOS, after `uv sync --directory python --locked` in the checkout:

```sh
.venv/bin/agentown --database /absolute/path/company.sqlite agent list
.venv/bin/agentown-mcp --database /absolute/path/company.sqlite
```

Windows PowerShell:

```powershell
.\.venv\Scripts\agentown.exe --database 'C:\Company\company.sqlite' agent list
.\.venv\Scripts\agentown-mcp.exe --database 'C:\Company\company.sqlite'
```

The parent directory must exist. The server waits for MCP input on stdin;
a terminal alone is not a client. A client launches and owns each server process.
Closing stdin ends the session. Normal stdout contains only JSON-RPC messages;
startup failures go to stderr with a nonzero exit. `--help` is a separate CLI
invocation, not a protocol session. There is no HTTP listener or provider setup.

## Contract version 0.1.0

| Tool | Arguments | Structured result |
| --- | --- | --- |
| `list_agents` | none | `{"agents": [{"id": "UUID", "name": "Designer"}]}` |
| `get_agent` | `agent_id: string` | `{"id": "UUID", "name": "Designer"}` |
| `list_tasks` | none | `{"tasks": [{"id": "UUID", "title": "Shared", "status": "pending", "assignees": ["UUID"]}]}` |
| `get_task` | `task_id: string` | Task object as above |

Empty lists use the same envelopes with empty arrays. Pydantic return models
produce discoverable JSON output schemas, including UUID format and Task status
enum. IDs and assignees are the Rust identities; ordering follows Rust ID order.
Input IDs remain strings so malformed and unknown IDs both reach Rust validation
and become MCP tool errors (`isError: true`). Storage errors during a session
also become tool errors. No argument selects a database. Only these four tools
are registered; no agent execution, assignment, creation, provider, or Task
completion operations are exposed. Read-only annotations describe actual Rust
storage behavior, rather than serving as the enforcement mechanism.

## Client connection examples

These are instructions for an operator; no installed client settings were changed.
Substitute absolute paths to the installed executable and an existing database.
A wheel environment uses the same executable names, without needing the checkout.

macOS:

```sh
codex mcp add agentown -- /absolute/venv/bin/agentown-mcp --database /absolute/company.sqlite
claude mcp add --transport stdio agentown -- /absolute/venv/bin/agentown-mcp --database /absolute/company.sqlite
```

Windows PowerShell (native Python executable, not an npm wrapper):

```powershell
codex mcp add agentown -- 'C:\Company\venv\Scripts\agentown-mcp.exe' --database 'C:\Company\company.sqlite'
claude mcp add --transport stdio agentown -- 'C:\Company\venv\Scripts\agentown-mcp.exe' --database 'C:\Company\company.sqlite'
```

Codex also supports a TOML entry (example only):

```toml
[mcp_servers.agentown]
command = "/absolute/venv/bin/agentown-mcp"
args = ["--database", "/absolute/company.sqlite"]
```

For Windows TOML, use literal strings such as
`command = 'C:\Company\venv\Scripts\agentown-mcp.exe'` and
`args = ['--database', 'C:\Company\company.sqlite']`.
After adding, inspect `codex mcp list` or `claude mcp get agentown` and ask the
client to list registered agents and inspect a Task. Configuration registration
alone does not establish a successful protocol connection.

## Research and decisions (2026-09-13)

- https://gofastmcp.com/servers/tools — function annotations generate input and
  output schemas; typed models support structured results, and explicit
  `ToolError` communicates expected failures. Use four functions and typed
  object envelopes, avoiding collection wrapping ambiguity.
- https://gofastmcp.com/deployment/running-server — direct `run` supports stdio
  and disabling the banner. Select stdio explicitly in the packaged entry point.
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports —
  stdio uses newline-delimited JSON-RPC; stdout must not carry non-protocol
  messages and stderr may carry diagnostics. Capture and parse actual stdout
  bytes in subprocess integration tests.
- https://developers.openai.com/codex/mcp (redirects to
  https://learn.chatgpt.com/docs/extend/mcp?surface=cli) — Codex supports stdio
  command/args and `codex mcp add NAME -- COMMAND`. Use an absolute installed
  executable and pass the fixed database argument after the separator.
- https://code.claude.com/docs/en/mcp — Claude Code supports local stdio servers;
  `--` separates client options from the server command and arguments. Document
  explicit stdio registration; do not execute settings-changing examples.

## Verification and limits

`python/tests/test_mcp.py` uses the real MCP SDK client and separately launched installed
entry points. Requests and process waits are bounded. Tests inspect initialization,
exact tool discovery, input/output schemas, clean stdout, empty/populated results,
CLI writes during a session, malformed/unknown IDs, storage failure, invalid
startup, restart, unchanged database bytes, and terminated process handles.
The test transport observer touches a private SDK process factory solely to retain
stdout and assert cleanup; its compatibility is checked against the locked SDK.

[Implementation evidence](evidence/c3-t2-implementation.txt) records source hashes,
commands, exit codes, native rebuild, mandatory checks, and a standalone product
wheel build/installation. The installed tests run outside the checkout after the
copied build source is deleted, using a clean environment with locked dependencies.
This validates protocol and packaging on the recorded macOS host. Windows and
live Codex/Claude Code sessions have not been executed; examples are researched
connection instructions, not claims of those validations.
