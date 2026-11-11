# C20-T1 MCP signature repair

This implement invocation inspected the existing adapter, protocol tests and
prior evidence against the supplied FastMCP/Pydantic startup traceback. No agents
were invoked and no new research was needed.

Changed `python/src/llm_engine/mcp_server.py` to express required declared-source
and attempt-count constraints with `Annotated[..., Field(...)]`, rather than
using `Field` objects as Python defaults before another required argument.
The retry-consent argument retains its explicit false default. This addresses
the reported generated-signature error without changing native admission or
provider execution behavior.

Changed `python/tests/test_mcp.py` to inspect the discovered execution input
schema for required fields, source-length limits, nonnegative attempt count
and default retry consent. The real protocol workflow now submits missing
required fields, an empty source and a negative count and requires tool errors;
the existing history assertion checks that rejected requests created no Run.

Local check: Python 3.13 AST parsing passed for mcp_server.py, execution.py,
test_mcp.py and mcp_fixture_server.py (exit 0). Import availability probes found
fastmcp, pytest, mcp and llm_engine unavailable in this isolated workspace.
Protocol tests were not executed here. No dependencies were installed and no
native bindings were rebuilt. No full suite, browser tests, harness commands,
runtime changes or settings edits were performed.

Supervisor-selected consolidated checks, real MCP subprocess coverage and
applicable browser validation remain pending. No verification artifact was
supplied. Live provider calls were skipped, not passed.
