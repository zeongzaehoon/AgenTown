# C9-T1 implementation handoff

Scope: saved-result Copy result and Download text in the existing React attempt
view, associated DOM behavior tests, installed supervisor browser flow and usage
notes. Existing checkout changes were present before this Task (including PLAN.md,
README.md, layout migration and untracked product trees) and were preserved. No
harness source/state/configuration, PLAN.md, service settings or installed service
runtime was edited. No subagents were invoked.

Implementation: local event handlers use the selected attempt's full output. Copy
awaits clipboard success and catches missing/denied access; downloads use UTF-8
plain-text Blob data and a safe attempt-specific filename. Neither handler calls
the API. Native buttons retain keyboard/focus behavior, status is polite/atomic,
and the existing test/unverified labels and layout remain. URLs are released after
60 seconds. Download feedback reports a request, not a confirmed disk save.

Frontend tests cover two different saved outputs after remount; long Unicode,
CRLF, tabs, leading/trailing whitespace and literal markup; exact clipboard input;
success/rejection/missing API; exact download text and filenames; Enter/Space/Tab;
focus preservation; disconnected access; and unchanged mutation calls/state.

The installed supervisor browser entry point now retains clipboard readback and
focus evidence after restart, denied-copy feedback and exact downloaded UTF-8 bytes
while disconnected, plus a historical result download after actual interruption.
Original failure/retry, three provider submissions, process kill, natural lease
recovery, retained history, mobile, screenshot and trace assertions remain.
Supervisor execution is PENDING for this snapshot, as required by the handoff
contract; no old run's browser evidence is substituted. No sandbox Chromium launch
was attempted.

Research URLs, findings and usage: docs/local-screen.md, C9-T1 section. Sources are
W3C Clipboard API, File API, WCAG status messages/quick reference, and WHATWG HTML
download resources. Findings informed permission error handling, plain-text byte
encoding, suggested filenames and focus-preserving announcements.

Ordinary commands (outputs retained alongside this report):

- `npm --prefix frontend test` → c9-t1-frontend.txt
- `npm --prefix frontend run build` → c9-t1-build.txt
- `cargo test --manifest-path rust/Cargo.toml --workspace --locked` → c9-t1-cargo.txt
- `uv run --directory python --locked maturin develop --locked` → c9-t1-native.txt
- After native rebuild exited successfully:
  `LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c9-t1-installed uv run --directory python --locked python -m pytest`
  → c9-t1-pytest.txt (includes fresh installed-package checks)
- `python3 .harness/cli.py check` → c9-t1-harness.txt

Final outcomes: all commands above exited 0. Frontend: 9 tests passed with
TypeScript checking. Production Vite build passed. Rust: 40 tests passed. Native
rebuild completed before Python verification. Python: 56 passed, 1 skipped (the
opt-in supervisor browser), one upstream Starlette/AnyIO deprecation warning.
Installed-wheel checks passed within that suite, including package assets, locked
dependencies, entry-point configuration/redaction, restart and killed-process
recovery. Killed exit was -9; three attempts and exactly three provider submissions
were retained for Task 5411892e-e23c-4a0a-96d4-17dc8fb24408. Harness check:
“All configured checks passed.”

`c9-t1-source-sha256.json` records 53 product source/asset/document hashes.
`c9-t1-installed/package/source-wheel-sha256.json` records 52 source/asset hashes
and the fresh wheel hash; all 53 entries were checked against current files and
matched. Installed subprocess output, runtime location, served asset hashes,
recovery JSON and SQLite database are retained in `c9-t1-installed/`.
Browser test Python syntax was checked; actual browser interaction remains pending.

Handoff: ready_for_verification, blocker_kind=none. This requests supervisor checks
and independent review; it does not approve or complete the Task.

Platform: macOS arm64, Python 3.13.12. Windows, other browsers and screen-reader
validation have not run. Clipboard OS/paste newline conventions are outside the
application; downloads preserve the exact text bytes. C8-T2 remains waiting for
intentionally supplied live-provider configuration and actual response/restart
validation. PLAN.md section 8 and whole-product acceptance remain incomplete.
