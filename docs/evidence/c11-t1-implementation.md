# C11-T1 implementation handoff

Only C11-T1 was implemented; role perspectives were advisory and no agents were
spawned. Existing partial/user changes and layout were preserved. No PLAN.md,
harness source/state/config, service settings or installed service runtime edits.

The React screen filters full loaded input with Unicode lowercase literal substring
matching, using a labelled search input, Clear search, a persistent count status,
a separate no-matches state and stable full Work IDs. Selection is independent of
the filtered list; excluded details remain selected with an explanation. Polling
retains selection and keyed expanded attempts; drafts and assignees stay independent.
A successful save selects new work even outside the search. Offline history remains
searchable with stale messaging and disabled mutations. No API or persistence
contract changed; export, draft reuse, explicit retries and unverified labels remain.

frontend/src/App.test.tsx adds three behavior tests (18 total) covering full input
beyond identical prefixes, stable IDs, Unicode/literal markup, keyboard clear/focus,
no matches/counts, independent selection, expanded result retention, polling with
no count DOM mutations, offline selection, disabled mutations, unchanged stored
fixtures, zero execution calls and exactly one explicit save of excluded new work.

python/tests/test_web_browser.py extends the existing installed supervisor flow
with original/revised full-text searches after restart, exact DOM text and persisted
state comparisons, explicit selection and attempt-history inspection, no matches,
keyboard clear/focus, screenshots, interaction data and both Task IDs. Existing
export, draft reuse, failure/retry, process-kill and three-submission checks remain.
Browser syntax compilation passed. Actual supervisor browser execution is PENDING
for this snapshot; no prior run is used as current evidence.

Usage, matching limits and primary-source URLs/findings are recorded in
../local-screen.md, Search saved work (C11-T1). Research covered React derived
render state, ECMAScript Unicode lowercasing/literal matching, W3C status messages
and WCAG keyboard/focus guidance.

Ordinary outputs: c11-t1-{frontend,build,cargo,native,pytest,harness}.txt.
Commands:
- npm --prefix frontend test
- npm --prefix frontend run build
- cargo test --manifest-path rust/Cargo.toml --workspace --locked
- uv run --directory python --locked maturin develop --locked
- After native rebuild completes: LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c11-t1-installed uv run --directory python --locked python -m pytest
- python3 .harness/cli.py check

Installed-package checks build and install a fresh wheel in an isolated test
environment outside the checkout, checking packaged assets, configuration/redaction
and deterministic process recovery. Retained evidence lives in c11-t1-installed;
source hashes exclude mutable caches.

Platform: macOS arm64. Windows, other browsers and screen-reader checks were not
performed. C8-T2 still awaits intentional live configuration and live response/restart
validation; PLAN.md section 8 remains incomplete.

Final outcomes: all six required commands exited 0. Frontend: 18 passed with
TypeScript checking. Production build passed. Rust: 41 tests passed including
doctests. Native rebuild completed before pytest started. Python: 57 passed,
1 skipped (supervisor browser), one upstream Starlette/AnyIO deprecation warning.
Fresh installed-wheel checks passed (assets, configuration/redaction, restart,
killed exit -9, retained three attempts and exactly three provider submissions).
Installed recovery Task: 2ad45c1c-c959-4759-9782-91898220100d.
Harness: “All configured checks passed.”

All 53 installed source/wheel manifest entries matched current bytes.
c11-t1-source-sha256.json retains 53 source/asset/document hashes, excluding
mutable caches. Ordinary logs and installed evidence are retained beside this file.
This is ready_for_verification with blocker_kind=none, not Task approval.
Supervisor browser artifacts and independent review remain pending.
