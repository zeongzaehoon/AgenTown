# MCP employee and text workflow

The Python 3.13 FastMCP stdio adapter exposes Rust-backed employee, text work
and execution operations, retaining the original read tools. Install the package as described in
[Python installation](python-cli.md). `uv.lock` locks FastMCP and its MCP SDK;
there is no dependency on `.agents` or `.harness` at runtime.

Initialize a product database through the creation CLI first (even
`agentown --database PATH agent list` initializes an empty store).
The MCP server requires an existing valid database at startup. The four original
read tools open SQLite read-only; mutations and execution history use the normal
Rust product store, including migration and expired-lease recovery. Each call
uses the fixed startup path, observing intervening committed writes.
The path is fixed, not the file's identity: replacing that file replaces the
store inspected on the next call. Use a dedicated product path.

macOS, after `uv sync --directory python --locked` in the checkout:

```sh
uv run --directory python --locked agentown --database /absolute/path/company.sqlite agent list
uv run --directory python --locked agentown-mcp --database /absolute/path/company.sqlite
```

Windows PowerShell:

```powershell
uv run --directory python --locked agentown --database 'C:\Company\company.sqlite' agent list
uv run --directory python --locked agentown-mcp --database 'C:\Company\company.sqlite'
```

The parent directory must exist. The server waits for MCP input on stdin;
a terminal alone is not a client. A client launches and owns each server process.
Closing stdin ends the session. Normal stdout contains only JSON-RPC messages;
startup failures go to stderr with a nonzero exit. `--help` is a separate CLI
invocation, not a protocol session. There is no HTTP listener. Execution uses the existing provider environment
configuration inherited by the server process; never put credentials in tool arguments.

## Server 0.2.0: compatible reads and workflow contract v1

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
also become tool errors. No argument selects a database. These four tool names and result envelopes remain compatible. Their read-only
annotations describe Rust storage behavior, rather than serving as enforcement.


## Explicit text workflow v1

The new tools publish typed input and output schemas. Every new result carries
`schema_version: 1`. Use an MCP client to send these calls in order:

1. `create_employee_v1({"name":"Writer"})` returns `employee.id`.
2. `save_text_work_v1({"employee_id":"EMPLOYEE_UUID","text":"Draft a greeting"})`
   returns `task.id`. Saving assigns the employee atomically and makes no LLM call.
3. `get_work_history_v1({"task_id":"TASK_UUID"})` returns `task` and `attempts`.
4. After an explicit user execution request, call
   `execute_text_work_v1({"task_id":"TASK_UUID","provider":"anthropic","model":"YOUR_MODEL","expected_runs":0,"resubmission_consent":false,"declared_source":"codex"})`.
5. Inspect history again. A Run includes its stable `id`, `task_id`, participant
   snapshot, timestamps in UTC milliseconds, state, reported outcome, untrusted
   `declared_source` (null for legacy/non-MCP Runs) and optional
   `execution`. Execution contains `run_id`, saved `input`, `provider`, `model`,
   `deadline_unix_ms`, `output`, `error` and `quality: "unverified"`.

Select the provider/model intentionally; configured providers are `anthropic`,
`openai`, `bedrock`, and `xai`. Use the existing environment configuration in
[text execution](text-execution.md). Missing configuration is an error before
admission. The tools accept no credential fields and never configure an account.

Execution is **costly, non-idempotent and open-world**: it can charge a provider.
Employee creation and work saving are also non-idempotent mutations. Retrying an
MCP request blindly is unsafe. Rust compares `expected_runs` atomically against
all persisted attempts and rejects stale requests and active execution. After a
failure or successful result, first inspect history, obtain explicit user consent
to resend the saved text, then pass the new count and
`resubmission_consent: true`. This creates a distinct Run under the same Task.
No tool marks work independently quality-verified.

`declared_source` is a caller's untrusted integration label, stored separately
from provider metadata by native admission (at most 80 UTF-8 bytes); it is never proof of identity or
authorization. The stdio process inherits the operator's database/provider access.
Only connect trusted local clients. Native failures return sanitized categories;
provider failures use existing bounded error codes, not exception text.

History inspection is annotated **non-read-only**, idempotent and closed-world:
its atomic native snapshot can finalize expired execution leases, without making
provider requests. Generic Runs with no text execution have `execution: null`.
The original four inspection tools retain their read-only behavior.

## Deterministic protocol reproduction

After the supervisor builds native bindings and installs locked dependencies:

```sh
cd python
python -m pytest tests/test_mcp.py -q
```

`mcp_fixture_server.py` is a test-only process, using real FastMCP stdio and native
SQLite with an injected deterministic provider. It is not an installed command or
a production provider option. Tests cover initial execution, completed duplicate
and stale rejection, consent, concurrent duplicate admission, provider failure,
explicit recovery retry and reopened history. Their output text begins
`Fixture result:` and does not establish live LLM behavior. The installed
`agentown-mcp --database PATH` tests retain compatibility/read preservation checks.
Observable artifacts are the product SQLite Task/Run/execution records and typed
history responses; see [this implementation handoff](evidence/c20-t1/implementation.md).
Live provider calls are skipped under user policy. Client application sessions,
Windows execution and supervisor/browser checks remain pending until recorded.

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

### Copyable configuration files

Choose one artifact, replace **both** executable and database paths, and merge
only the `agentown` entry into the destination. Back up an existing destination
first; do not overwrite other servers. These files contain no credentials.

| Client | macOS artifact | Windows artifact | Destination |
| --- | --- | --- | --- |
| Codex | [TOML](mcp-config/codex-macos.toml) | [TOML](mcp-config/codex-windows.toml) | `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows) |
| Claude Code | [JSON](mcp-config/claude-code-macos.json) | [JSON](mcp-config/claude-code-windows.json) | `.mcp.json` in the chosen project root |

For a wheel installed into a virtual environment, use its `bin/agentown-mcp`
(macOS) or `Scripts\agentown-mcp.exe` (Windows). Run the matching `agentown`
executable with `--database ABSOLUTE_DATABASE agent list` to initialize the store
before connecting. Keep each path as a separate argument; do not embed shell
quotes inside a JSON string. TOML Windows literal strings preserve backslashes.
Use the earlier `mcp add` commands as an alternative to copying, not an additional
registration. Copying is an operator action; the tests never change client settings.

Start Codex in the intended workspace, inspect `codex mcp list`, and use `/mcp`
to inspect the connection. For Claude Code run `claude mcp get agentown`, then
start `claude` in that project and review workspace/server trust prompts and
`/mcp`. Registration alone is not a successful connection.

Ask either client: “Using AgenTown, list employees and saved work. Inspect the
selected Task and its attempt history. Do not execute work.” Then follow the
explicit workflow above to create an employee and save assigned text. Set
`declared_source` to `codex` in Codex or `claude-code` in Claude Code for each
execution call. This is a tool argument, not a server startup flag, client setting
or authenticated identity.

Connection approval does not grant consent to spend money. Before execution,
confirm the saved text, employee, provider/model and current attempt count with
the user. Pass that count as `expected_runs`. Initial execution uses
`resubmission_consent: false`; any resend requires fresh explicit user consent
and `resubmission_consent: true`. After a timeout or disconnect inspect history
before retrying; a lost response can still have committed a Run. Keep client tool
approval enabled. History inspection may finalize expired leases; execution
results remain quality-unverified. No live provider call is needed for discovery.

### Recovery and compatibility

If startup fails, run the exact configured executable with `--help`, check that
the existing database is the intended valid product store, and inspect the
client's stderr diagnostics. Missing directories, relative paths, stale virtual
environments and an incompatible database are configuration failures. Do not
replace or delete the database to repair a connection. Missing provider settings
matter only when executing; use [provider setup](text-execution.md) in the server's
launch environment. Codex can explicitly forward needed environment variables
with `env_vars`; do not assume every client forwards all shell variables or paste
secrets into a shared artifact.

To undo a copied configuration, stop the client session, remove only its
`agentown` table/object or restore the backup, and restart the client. For CLI
registration use `codex mcp remove agentown` or `claude mcp remove agentown` in
the same scope used to add it. Claude Code project approval can be reconsidered
with `claude mcp reset-project-choices`. Keep the product database and environment.

The server is stdio-only, version 0.2.0 with workflow `schema_version: 1` and eight
tools. Older four-tool read clients keep their envelopes. This is configuration
syntax compatibility, not certification of client versions. Record client version,
OS, initialization, discovery, inspection and disconnect results when validating
an actual client. Windows artifacts parse on macOS but that does not test Windows
process launch or permissions.

### Bounded next packaging steps (bundles not delivered or validated)

- Claude Desktop: package the installed server plus its supported Python/native
  runtime as a Desktop Extension (historically DXT, now MCPB), with a manifest and
  user-selected existing database path. Build separate platform bundles, check
  licensing/signing, install/uninstall and child cleanup on each OS. Do not ship
  this checkout, credentials or a company database in a bundle.
- Codex/Claude plugins can package the same stdio command with platform runtime
  and explicit user database selection. A plugin manifest alone is not an
  installation or authorization boundary. Remote MCP/ChatGPT integration needs
  a separately designed authenticated HTTPS transport, per-user database isolation,
  execution authorization and deployment lifecycle. This server has no URL and
  cannot be connected remotely by copying its local file paths. Remote/plugin
  delivery is deferred; preserve the same eight-tool consent contract.

### Artifact-driven checks and validation record

After installing product dependencies and native bindings, from the checkout:

```sh
uv run --directory python --locked python -m pytest tests/test_mcp_config.py -q
```

The four artifact variants are parsed, their two machine-specific paths replaced
with installed executable/temporary database paths, and their resulting command
launched through the real MCP SDK. Tests bound the session to 30 seconds, check
initialization, eight-tool discovery, employee/Task/history inspection, v1 schema,
unchanged database bytes, JSON-RPC-only stdout and process exit. They perform no
provider calls and never read or modify installed client configuration. The
Windows artifact is launched with host paths during this test, not on Windows.

This invocation exercised only Python 3.13 static parsing on macOS; SDK subprocess
checks await supervisor dependencies. **No Codex, Claude Code, Claude Desktop or
Cursor client session, Windows execution, remote service or plugin installation
was exercised.** Live provider validation is skipped, not passed. See the
[scoped handoff](evidence/c20-t2/implementation.md) for exact local results and
pending checks. Protocol test success must never be reported as client validation.

## Connection syntax recheck (2026-11-12)

- [Official OpenAI MCP documentation](https://developers.openai.com/codex/mcp)
  (redirects to ChatGPT Learn): confirms the TOML `mcp_servers` command/args
  structure and CLI registration. Artifacts use absolute executable/database paths.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp): confirms
  stdio CLI separator, project `.mcp.json` with `mcpServers`, and approval/recovery.
- [Desktop Extensions](https://github.com/modelcontextprotocol/mcpb) and
  [Cursor MCP documentation](https://cursor.com/docs/mcp) inform the bounded
  future packaging path. Manual JSON setup is delivered below; client sessions and bundled extensions remain unexercised.

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

## Earlier read-tool verification and limits

The original read-tool evidence below predates C20-T1 and does not verify the new workflow.
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

## Claude Desktop and Cursor manual JSON setup (C26-T1)

Generate a standalone artifact using explicitly selected **absolute** installed
executable and database paths. Generation prints JSON and does not open the
selected database, probe the executable, or change client settings. Initialize
with the matching `agentown` executable first; the database parent must exist.
Examples deliberately include spaces. Replace the paths with your own.

macOS:

```sh
'/Company Space/venv/bin/agentown' --database '/Company Space/company.sqlite' agent list
'/Company Space/venv/bin/agentown' --database '/Company Space/company.sqlite' connection setup --client claude-desktop --platform macos --executable '/Company Space/venv/bin/agentown-mcp' > claude-desktop.json
'/Company Space/venv/bin/agentown' --database '/Company Space/company.sqlite' connection setup --client cursor --platform macos --executable '/Company Space/venv/bin/agentown-mcp' > cursor.json
python3 -m json.tool claude-desktop.json
python3 -m json.tool cursor.json
'/Company Space/venv/bin/agentown-mcp' --help
'/Company Space/venv/bin/agentown' connection detect
```

Windows PowerShell (UTF-8 output works with Windows PowerShell 5.1 as well):

```powershell
& 'C:\Company Space\venv\Scripts\agentown.exe' --database 'C:\Company Space\company.sqlite' agent list
& 'C:\Company Space\venv\Scripts\agentown.exe' --database 'C:\Company Space\company.sqlite' connection setup --client claude-desktop --platform windows --executable 'C:\Company Space\venv\Scripts\agentown-mcp.exe' | Set-Content -Encoding utf8 claude-desktop.json
& 'C:\Company Space\venv\Scripts\agentown.exe' --database 'C:\Company Space\company.sqlite' connection setup --client cursor --platform windows --executable 'C:\Company Space\venv\Scripts\agentown-mcp.exe' | Set-Content -Encoding utf8 cursor.json
Get-Content -Raw claude-desktop.json | ConvertFrom-Json
Get-Content -Raw cursor.json | ConvertFrom-Json
& 'C:\Company Space\venv\Scripts\agentown-mcp.exe' --help
& 'C:\Company Space\venv\Scripts\agentown.exe' connection detect
```

| Client | macOS destination | Windows destination | Templates |
| --- | --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | [macOS](mcp-config/claude-desktop-macos.json), [Windows](mcp-config/claude-desktop-windows.json) |
| Cursor global | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` | [macOS](mcp-config/cursor-macos.json), [Windows](mcp-config/cursor-windows.json) |
| Cursor project | `.cursor/mcp.json` inside the chosen project | `.cursor\mcp.json` inside the chosen project | Same Cursor templates |

Back up the destination, then explicitly merge only `mcpServers.agentown` from
the generated artifact, preserving other keys and servers. Do not register the
same server in both Cursor scopes. JSON paths contain no extra shell quotes.
No Node runtime or bundled extension is required for this installed Python server.

For Claude Desktop use Settings → Developer → Edit Config, then fully quit and
restart the application. For Cursor open the intended project and inspect its
MCP server controls under Customize/settings; approve and enable the server.
Request: “Use AgenTown to list employees and saved work, inspect a Task and its
history; do not execute work.” Confirm eight tools and the expected database
contents. Use `declared_source: "claude-desktop"` or `"cursor"` for explicitly
consented execution, retaining all workflow v1 retry and approval requirements.

For removal, fully quit the client and back up the destination. The following
command removes only `agentown`; replace `DESTINATION` with the expanded exact
path from the table. On macOS run with Python from the installed environment:

```sh
python3 -c 'import json, pathlib, sys; p=pathlib.Path(sys.argv[1]); d=json.loads(p.read_text(encoding="utf-8-sig")); d.get("mcpServers", {}).pop("agentown", None); p.write_text(json.dumps(d, indent=2)+"\n", encoding="utf-8")' 'DESTINATION'
```

On Windows PowerShell use the exact expanded destination (example for Desktop;
for Cursor use the corresponding path from the table):

```powershell
$destination = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
$config = Get-Content -Raw -LiteralPath $destination | ConvertFrom-Json
if ($null -ne $config.mcpServers) { $config.mcpServers.PSObject.Properties.Remove('agentown') }
$config | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $destination -Encoding utf8
```

Alternatively restore the backup or manually remove only that entry. Restart the
client and confirm AgenTown is absent. Retain the database and environment.
The command above is an explicit operator action, never performed by detection.

Detection checks PATH for Cursor and known application locations only:
`/Applications/Claude.app`, `/Applications/Cursor.app`, and on Windows
`%LOCALAPPDATA%\AnthropicClaude\claude.exe` and
`%LOCALAPPDATA%\Programs\cursor\Cursor.exe`. It reads no settings contents or
credential stores and launches no application. Custom installations can be missed.
Detected means an installation hint; configured means the operator merged an
entry; connected means a successful MCP initialization/discovery session;
actually exercised means a recorded client application inspection. None implies
the next. Detection always reports configuration unknown and connection/client
exercise unverified. Copying or parsing JSON establishes neither connection nor
client exercise.

Scoped deterministic coverage: `tests/test_connections.py`,
`tests/test_cli.py -k connection`, and `tests/test_mcp_config.py`. The last parses
all eight artifacts and exercises host-generated Desktop/Cursor commands with
executable/database paths containing spaces through MCP initialization, eight-tool
discovery, inspection, clean protocol stdout and process cleanup. Windows syntax
on macOS is not Windows execution. No actual Claude Desktop or Cursor session
was exercised by this implementation. Live provider calls are skipped, not passed.
Supervisor protocol and browser checks are pending; see
[evidence](evidence/c26-t1/implementation.md).

Primary guidance used for this addition (2026-11-12):
[official local-server guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
confirms Desktop's manual JSON destinations and restart;
[official Cursor MCP guide](https://cursor.com/docs/mcp) confirms project/global
locations and stdio fields. Cursor's current field table requires `type: "stdio"`;
its generated artifacts include it. Existing Codex/Claude Code guidance above is
reused without repeating research. Bundled extensions remain future work.
