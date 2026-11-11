# C20-T1 integration handoff

This integrate invocation read both supplied member reports:

- `/Users/hoon/Portfolio/llm-engine/.harness/runs/1794412893-977850000/worker-1/report.json`
- `/Users/hoon/Portfolio/llm-engine/.harness/runs/1794412893-977850000/worker-2/report.json`

Inspected the actual merged MCP adapter, deterministic subprocess tests, provider
selection, shared execution adapter, native signatures, SQLite admission,
source migration and targeted Rust tests. No agents were invoked here.

The Python admission call matches the native seven-argument interface and consumes
the unchanged seven-field execution tuple. Rust resolves saved input, assignment,
attempt count and retry consent in an immediate transaction. Provider selection
remains before admission; provider I/O remains after admission through finish_text.

Integration edits expose immutable declared-source metadata in typed Run history,
with null for legacy/non-MCP Runs, independently of provider reporting_source.
The history snapshot still determines which attempts appear; the subsequent
source query only decorates those attempts. Aligned the source argument with
Rust's 80-byte limit, including a UTF-8 byte check before provider selection.
Extended deterministic protocol assertions to distinguish declared source from
provider, and updated the workflow documentation.

Checks executed here: Python 3.13 AST parsing passed for mcp_server.py,
test_mcp.py and mcp_fixture_server.py. Import availability probes reported
FastMCP, pytest and llm_engine unavailable. No dependencies installed, native
rebuild or full test suite executed. Written protocol assertions are unexecuted.

Supervisor-selected consolidated checks, real MCP protocol tests, native tests
and applicable browser validation remain pending. No verification artifact was
supplied for this invocation. Live provider calls were skipped, not passed.
