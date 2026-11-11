# C13-T1 implementation handoff

Only C13-T1 implemented. No subagents ran; role perspectives were advisory.
Existing partial/user changes and the frontend/rust/python layout were preserved.
No edits to PLAN.md, harness source/state/config, service settings or the installed
service runtime. Temporary package test environments are separate from that runtime.
C8-T2 intentional live configuration and real-provider acceptance remain outstanding;
PLAN.md section 8 is not complete.

The textarea no longer truncates pastes at 25,000 UTF-16 units. Advisory validation
checks Unicode White_Space, malformed surrogate input, native 100,000 UTF-8-byte
text size and the exact 120,000-byte JSON.stringify payload including assignee.
Accessible guidance is associated with the field via aria-describedby/aria-invalid;
invalid submission focuses the editor, preserves text/assignee and sends no mutation.
Server size/native text validation errors have distinct sanitized codes and field
feedback. Other database/employee errors remain separate. Server body limits and
Rust text validation are unchanged. No token estimate, implicit execution, trimming
or Unicode normalization was introduced. Browser newline normalization is documented.
Server rejection focus waits until the editor is enabled after refresh.

Frontend tests cover ASCII, Korean, emoji, combining text, escaped-body exact/over
limits, Unicode blank differences, malformed surrogate input, paste preservation,
keyboard correction, disconnect/reconnect, polling, server errors and mutation counts.
API tests compare native exact text and restart state for byte-boundary inputs,
plus exact/over HTTP limits for quotes, backslashes, newlines and control escaping;
rejections preserve history and make no provider submissions. Database errors remain
sanitized and distinguishable. Existing frontend/API tests remain intact.

The installed supervisor browser flow now pastes CRLF long text through the real
clipboard, checks normalized LF content exceeding the old cap, rejects a 60,000-quote
serialized oversized draft, corrects it with keyboard/clipboard interaction, saves
separate work and compares exact API and native text after restart. It retains
screenshots, interactions, IDs, trace, and all previous export/search/draft reuse/
timestamp/failure/retry/process-kill/exactly-three-submission assertions.
Browser syntax compilation passed. Supervisor browser validation is PENDING for
this snapshot, to be produced after handoff. No prior run is used as browser evidence.

Primary research, findings and usage are recorded in ../local-screen.md under
“Pasting and request limits (C13-T1)”: WHATWG HTML textarea and Encoding standards,
Rust str::trim documentation, W3C WCAG quick reference and ARIA21. Decisions were
made after consulting these authoritative sources.

Commands (outputs retained beside this document):
- npm --prefix frontend test → c13-t1-frontend.txt
- npm --prefix frontend run build → c13-t1-build.txt
- cargo test --manifest-path rust/Cargo.toml --workspace --locked → c13-t1-cargo.txt
- uv run --directory python --locked maturin develop --locked → c13-t1-native.txt
- After native rebuild, LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c13-t1-installed uv run --directory python --locked python -m pytest → c13-t1-pytest.txt
- python3 .harness/cli.py check → c13-t1-harness.txt

One frontend rerun hit the existing full-flow test's 5-second timeout during native
package compilation (49 passed). c13-t1-frontend-timeout.txt retains that outcome.
The unchanged timeout/assertions passed on rerun: all 50 frontend tests passed.
TypeScript, production build and 42 Rust tests passed. Native rebuilding completed
before Python tests. Installed evidence from before the final focus fix is explicitly
superseded; final package checks must match the final source/assets.

Actual platform coverage is macOS arm64. Windows, other browsers and screen readers
remain untested. Deterministic checks cannot satisfy C8-T2 live acceptance.

Final ordinary Python outcome: 79 passed, 1 skipped (supervisor browser), with one
upstream Starlette/AnyIO deprecation warning. After the final frontend focus fix,
the frontend suite again passed all 50 tests and the production build passed.
The final installed package was then rebuilt and checked separately with:
`LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c13-t1-installed uv run --directory python --locked python -m pytest tests/test_installed_web.py`
→ c13-t1-installed-check.txt, 1 passed in 136.42 seconds. The earlier installed
artifacts are retained under c13-t1-installed-superseded and are not final evidence.

Final installed recovery Task: 5f2c72ee-b5ea-4665-8e7e-4e2bef713275. Killed process
exit: -9. Three attempts retained after restart and exactly three deterministic
provider submissions. Final wheel/assets/configuration/redaction checks passed.
All 53 final installed source/asset/wheel manifest entries match current bytes.

Harness check exited 0: “All configured checks passed.” All required ordinary
checks are now successful. Source/asset/document hashes are retained in
c13-t1-source-sha256.json. Final installed manifest verification is retained in
c13-t1-hash-verification.txt. Handoff: ready_for_verification, blocker_kind=none.
Supervisor browser artifacts and independent review are pending; this handoff
requests verification and does not complete or approve C13-T1.
