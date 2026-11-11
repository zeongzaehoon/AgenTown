# C14-T1 implementation handoff

Historical handoff: the outcomes below predate the isolated team implementation
invocation. They are retained for context, not fresh verification of this snapshot.
See [the AI Developer worker handoff](c14-t1-ai-worker.md) for that invocation's
scoped changes, local checks, and pending supervisor checks.

Only the implement stage and current Task were performed. No subagents ran; role
perspectives were advisory. Existing partial/user files and layout were preserved.
PLAN.md, harness source/state/config, service settings and installed service runtime
were not edited. C8-T2 live configuration/acceptance remains outstanding.

Anthropic max_tokens now maps to stable sanitized output_limit before content is
read. Empty and nonempty limited content is discarded; no successful output is
persisted or displayed. The current 2048-token cap, 45/60/65-second timeout bounds
and zero automatic retries are unchanged. Frontend attempt guidance explains the
unretained partial response, Use as new draft, shorter answers/split requests and
unchanged-input retry risk. Existing draft, selection and history components are
reused without layout changes.

Persistence design: existing Agent/Task identities, per-attempt Run IDs, immutable
execution input and Task/Run relationship remain unchanged. Rust finalization and
stored-record validation both admit output_limit as Failure with no output. The
existing transaction writes the error and terminal Run/timestamp together. No DDL,
version bump, schema expansion or migration of old malformed_response records.
Reopen/recovery preserves terminal records; explicit retry retains Task identity
and creates a new Run. Provider failure cannot approve or complete the Task.

Research before implementation:
- https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons :
  max_tokens means generation hit the request cap; end_turn is natural completion;
  refusal is distinct. Decision: classify truncation before examining content.
- https://github.com/anthropics/anthropic-sdk-python : configurable timeout and
  max_retries options; SDK defaults can retry. Decision: retain max_retries=0 and
  existing bounded timeouts, without continuing a partial response automatically.

Deterministic SDK tests cover empty/nonempty max_tokens, end_turn success,
refusal, malformed/empty responses and sanitized errors. API tests use the SDK
fixture through real Rust persistence, reject replay, compare exact terminal
snapshots after reopen and prove each explicit retry sends unchanged input once.
Rust tests inject a terminal-write failure to prove rollback, reject partial text
paired with an error, and retain both earlier success and output-limit failure
through read/write and read-only reopen. Frontend behavior covers guidance, no
result actions, recorded times, keyboard draft reuse/cancellation, disconnect,
assignee preservation and correction without implicit execution.

Supervisor browser test extension is pending execution after handoff. Its separate
output-limit journal expects two submissions (limited original and shorter separate
work); the original journal still requires exactly three submissions. It retains
screenshots, trace/interactions, Task/Run IDs, native error/output/timestamp records,
exact restart history and SQLite alongside all existing paste, search, export,
timestamp, retry and process-kill coverage. No old browser artifact is claimed as
this snapshot's evidence. Browser fixture/test syntax was checked successfully.

Required ordinary commands and retained logs:
- npm --prefix frontend test: c14-t1-frontend-final.txt (51 passed).
- npm --prefix frontend run build: c14-t1-build-final.txt (TypeScript/Vite passed).
- cargo test --manifest-path rust/Cargo.toml --workspace --locked:
  c14-t1-cargo.txt (43 tests passed).
- uv run --directory python --locked maturin develop --locked:
  c14-t1-native.txt (passed before Python tests).
- LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c14-t1-installed
  uv run --directory python --locked python -m pytest: c14-t1-pytest.txt.
  Includes fresh installed wheel/asset/configuration/redaction/recovery checks.
- python3 .harness/cli.py check: c14-t1-harness.txt.

Initial frontend/build logs retain a test-only TypeScript locator error (unsupported
exact option). It was corrected to an anchored accessible-name regex and both
commands then passed. No assertions were weakened.

Actual platform: macOS arm64, Python 3.13. Windows, other browsers, screen readers
and live-provider execution were not performed. Section 8 and C8-T2 remain incomplete.
