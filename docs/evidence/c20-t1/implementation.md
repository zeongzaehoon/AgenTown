# C20-T1 AI Developer implementation handoff

This invocation changed only the assigned Python MCP adapter, protocol tests,
test-only fixture server and MCP documentation. No other agent was invoked.

The adapter consumes the agreed native signature:
`start_mcp_execution(database, task_id, provider, model, expected_runs, resubmission_consent, declared_source)`.
It expects the existing seven-field execution tuple accepted by `finish_text`.
The native implementation and provenance migration are outside this worker scope;
the owner must integrate them before protocol validation.

New typed version-1 tools create employees, save assigned text work, explicitly
execute/retry and inspect atomic persisted history. Existing four read tools and
their output envelopes remain intact. Provider I/O reuses `finish_text`; existing
provider SDK selection and behavior were not changed. History uses the existing
snapshot, including expired-lease recovery, and is annotated as capable of writes.

Local checks: Python 3.13 AST parsing passed for mcp_server.py, test_mcp.py and
mcp_fixture_server.py. Import probes showed FastMCP, pytest and llm_engine are
unavailable in this isolated environment. No dependencies were installed and no
native rebuild, full suite, browser test or harness command was run.

Pending: integration of native admission/provenance; supervisor-selected consolidated
verification, including real MCP subprocess tests, native regression coverage and
any required browser checks. Protocol tests have been written, not executed here.
No verification artifact was supplied. Live provider calls remain skipped, not
passed. No authenticated Codex/Claude session or Windows execution is claimed.
