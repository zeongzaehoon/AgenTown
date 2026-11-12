# C26-T1 implementation handoff

This invocation implemented only the assigned Python Developer scope. No agents
were spawned. Existing unrelated files, including C25-T3 evidence, were preserved.

Changes:
- `python/src/llm_engine/connections.py`: explicit absolute-path JSON generation
  for Claude Desktop and Cursor on macOS/Windows; four-client static setup
  presentation; bounded installation hints that read no client settings or
  credential stores, write nothing and launch nothing. Unknown configuration,
  unverified protocol and unverified actual client exercise remain separate.
- `python/src/llm_engine/cli.py`: `connection setup` emits only artifact JSON;
  `connection detect` needs no database. Other commands still require a database.
- Four new `docs/mcp-config/{claude-desktop,cursor}-{macos,windows}.json` templates.
- `docs/mcp.md`: generation, exact destinations, initialization, JSON validation,
  application inspection and removal commands, approval/retry guidance and limits.
- `python/tests/test_connections.py`, `test_cli.py`, `test_mcp_config.py`:
  generation/path rejection, no-file-opening detection, CLI generation/detection,
  all eight artifact shapes, and MCP subprocess launch using generated host
  commands with executable/database paths containing spaces. Retains eight-tool
  discovery, employee/Task/history inspection, v1 schema, unchanged database,
  JSON-RPC stdout and child exit assertions; never executes providers.

Actual local checks (Python 3.13):
- AST parsing of all five changed Python source/test files passed.
- Dependency-free artifact check passed: eight checked-in templates parse and
  exactly match setup presentation; all four new generated client/platform
  combinations preserve spaced paths and reject relative executable paths.
- Dependency-free detection check passed with builtins.open and Path.open
  forbidden; configuration remained unknown and client exercise unverified.
- `python3.13 -m pytest --version` failed with `No module named pytest`.
  No product venv is present. No dependency installs, native rebuilds, full suites,
  harness commands or browser tests were attempted, per worker stage contract.

Supervisor checks pending: focused pytest cases including real MCP subprocesses,
consolidated mandatory checks and any browser validation. This report does not
claim that newly added tests ran. Windows process launch, Claude Desktop and
Cursor application exercise are unverified. Codex/Claude Code application
sessions also were not exercised. Live provider calls are skipped under user
policy, not passed. No external app settings were modified.

Research reused: docs/mcp.md and docs/evidence/c20-t2/implementation.md for the
existing workflow, Codex and Claude Code. New material gap: manual Desktop JSON
destinations rather than extension packaging. Checked official guidance:
- https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers
  confirms Desktop JSON structure, macOS/Windows destinations and restart.
- https://cursor.com/docs/mcp confirms global/project paths and command/args;
  its current field table requires `type: "stdio"`, included in Cursor artifacts.
No official client application was launched or configured by this invocation.
