# C20-T2 implementation handoff

This invocation operated as the assigned CLI Developer only. No other agents
were invoked. Changes are limited to docs/mcp.md, docs/mcp-config/,
python/tests/test_mcp_config.py and this evidence directory. Existing C20-T1
server/domain/test changes were preserved; no client settings, PLAN, runtime,
harness configuration or state were edited. No dependencies were installed.

Delivered four copyable Codex TOML / Claude Code JSON artifacts, each with
explicit executable and database paths for macOS or Windows. Documentation
covers initialization, installation locations, registration, inspection, declared
calling integration, execution/resubmission consent, configuration rollback,
compatibility and deferred Desktop/MCPB, Cursor, plugin and remote paths.

Artifact-driven tests load the actual files, validate their path syntax, substitute
only executable/database values and launch their command through the MCP SDK.
They reuse existing installed CLI and protocol helpers for a temporary database,
eight-tool discovery and schema checks. They inspect employees, assigned Tasks
and workflow-v1 history without provider calls. The existing transport observer
asserts exited processes and JSON-RPC-only stdout; sessions have a 30-second
bound. No production execution is attempted.

## Local commands and observed results

Host: Darwin (macOS), Python 3.13.12. No Windows process was exercised.

- `python3 docs/evidence/c20-t2/static-check.py`: exit 0. All four TOML/JSON
  artifacts parsed and passed the actual test loader's stdio shape, executable
  name and absolute-path assertions. Python test AST parsed successfully.
- `python3 -m pytest python/tests/test_mcp_config.py -q`: exit 1 before collection,
  `No module named pytest`. Import probes also showed `mcp` and `llm_engine`
  unavailable in this isolated workspace. This is not a protocol test pass.

Supervisor should install its normal locked product dependencies/bindings and
run `uv run --directory python --locked python -m pytest tests/test_mcp_config.py -q`
plus the selected consolidated gate. MCP subprocess tests and any required browser
checks remain pending. No supplied verification artifact exists for this stage.
No native rebuild, full suite, browser test or harness command was run here.

Clients exercised: none (Codex, Claude Code, Claude Desktop and Cursor all
unverified). Only macOS stdlib artifact checks ran; parsing Windows syntax does
not establish Windows compatibility. Live provider calls were skipped per user
policy, not passed. Remote/plugin packaging is a bounded future path, not shipped.

## Official source recheck

On 2026-11-12 fetched the official OpenAI MCP page
https://developers.openai.com/codex/mcp (redirected to
https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and
https://code.claude.com/docs/en/mcp. Verified command/args TOML, stdio CLI separator,
Claude project mcpServers JSON and recovery commands. Reused C20-T1 protocol
research/contract; did not repeat provider research.

For the bounded packaging path fetched https://github.com/anthropics/mcpb
(redirected to https://github.com/modelcontextprotocol/mcpb), which documents
DXT's rename and bundle manifest/runtime contents, and https://cursor.com/docs/mcp.
The old desktop-extensions repository URL returned 404; the old Cursor URL
redirected to its docs index, whose MCP link led to the current page. No client
binaries or settings were inspected or changed by these documentation checks.
