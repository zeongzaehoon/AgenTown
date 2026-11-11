# C14-T1 AI Developer isolated implementation

This invocation inspected the required instructions and existing implementation,
then modified only Python tests and documentation. No subagents were invoked.
Existing provider classification, Rust persistence, frontend guidance, layout and
partial/user changes were preserved. Prior handoff results are historical evidence.
Existing recorded Anthropic stop-reason and SDK research was reused; no new SDK
usage or material research uncertainty was introduced.

Changes:

- `python/tests/test_execution.py`: added missing/null limited-content cases,
  refusal with nonempty content, malformed natural completion and unexpected stops.
- `python/tests/test_web.py`: parameterized the output-limit API/reopen test for
  empty and nonempty content. Both explicit attempts must retain terminal failure
  timestamps, no output, sanitized history and pending Task status. A second reopen
  must preserve the complete history without a third submission.
- `python/tests/web_browser_server.py` and `python/tests/test_web_browser.py`:
  the separately counted limit journal now retains exact input/model JSON records;
  the test requires the original request followed by the shorter corrected request.
  The original exactly-three-submission journal and coverage remain unchanged.
- `docs/local-screen.md` clarifies current versus historical platform evidence and
  exact-input browser evidence. The earlier handoff is marked historical.

Fresh local checks on macOS arm64, Python 3.13.12:

- Python AST parsing passed for the provider and four touched test files.
- Eight dependency-free adapter checks passed using a stub SDK module: empty,
  nonempty, missing and null limited content; refusal; malformed content;
  unexpected stop; natural completion with credential redaction. Each performed
  exactly one create call and asserted the 2048-token cap, 45-second SDK timeout,
  zero SDK retries, exact original input and sanitized failure code.
- Outcomes and source SHA-256 hashes are retained in
  `c14-t1-ai-worker-checks.json`. These stub checks do not validate the real SDK,
  native binding, API persistence or installed runtime.

There is no `python/.venv` in this isolated snapshot, and the available Python lacks
pytest and Anthropic. No dependencies were installed, full suites run, bindings
rebuilt, browser launched, or harness CLI invoked, per the current worker contract.
The owner must integrate team outputs; the supervisor must run the consolidated
frontend tests/build, locked Rust tests, sequential native rebuild then Python
tests, installed-package checks, harness check and installed browser verification.
Screenshots, interactions, Task/Run IDs, exact history and final installed/source
hashes for this snapshot remain pending that supervisor gate.

Windows, screen readers and actual live-provider execution were not tested.
C8-T2 intentional credentials/model configuration and live acceptance remain
outstanding; this independent task does not complete PLAN section 8.
