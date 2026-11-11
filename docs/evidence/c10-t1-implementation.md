# C10-T1 implementation handoff

Implemented only C10-T1 with advisory role perspectives; no subagents ran. Existing
user/partial changes (including layout migration, PLAN.md and product trees) were
preserved. No PLAN.md, harness controls, service settings or installed service
runtime edits were made. Required package-manager builds used development/test
environments only.

`frontend/src/App.tsx` adds Use as new draft to the selected saved request. This
local action performs no API mutation. It copies exact input into the controlled
editor, reuses only an available sole assignee, otherwise requires selection, and
keeps draft state independent of history polling/selection. Nonempty text requires
Replace draft or Cancel; initial focus goes to Cancel, Escape cancels within the
inline confirmation, cancellation restores action focus, and replacement focuses
the editor. Save locks edits/replacement, keeps duplicate-click admission guarded,
and uses the existing save-only API. Retry/export and test/unverified labels remain.

`frontend/src/App.test.tsx` covers Unicode/multiline/literal markup, keyboard and
focus, announcements, replace/cancel/Escape, multiple history selections and a
captured replacement source, polling, missing/multiple/no assignees, offline use,
reconnection, unchanged history/mutation counts, duplicate saves and pending-save
locks. The original nine behavior tests remain; six added cases bring total to 15.
An initial TypeScript error in the parameterized fixture was corrected before the
retained successful run.

`python/tests/test_web_browser.py` extends the installed supervisor flow after the
existing export, failure/retry and killed-process recovery checks. It drafts offline,
cancels via keyboard, revises Unicode/multiline/markup, reconnects, double-clicks
Save, asserts a distinct Task with zero attempts and original record equality,
restarts the process and compares the full persisted state. It retains screenshots,
interaction details, both Task IDs/inputs, SQLite, JSON, traces and the unchanged
three-submission journal. Browser syntax compiles. Actual Chromium execution for
this snapshot is PENDING supervisor verification; no old browser artifact is used.

Usage, platform limits and researched authoritative URLs/findings are in
`docs/local-screen.md`, C10-T1 section. React controlled textarea guidance and W3C
keyboard/focus/status guidance informed the design; the confirmation is explicitly
an inline labelled region, not an ARIA modal.

Ordinary command outputs are retained in c10-t1-{frontend,build,cargo,native,pytest,harness}.txt:

- `npm --prefix frontend test`
- `npm --prefix frontend run build`
- `cargo test --manifest-path rust/Cargo.toml --workspace --locked`
- `uv run --directory python --locked maturin develop --locked`
- Only after native rebuilding exited 0:
  `LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c10-t1-installed uv run --directory python --locked python -m pytest`
- `python3 .harness/cli.py check`

Installed checks build a fresh wheel, install locked dependencies into an isolated
test environment outside the checkout, check served packaged assets, configuration,
credential redaction and process/restart recovery. See c10-t1-installed for exact
subprocess logs, wheel/source manifest and persisted recovery evidence.

Platform: macOS arm64, Python 3.13.12. Windows, screen-reader and other-browser
checks have not run. C8-T2 still awaits intentionally supplied live configuration
and live response/restart evidence. PLAN.md section 8 remains incomplete.

Final ordinary outcomes: all six commands exited 0. Frontend 15 tests passed with
TypeScript checking; production build passed; Rust 40 tests passed; native rebuild
completed before Python; pytest 56 passed, 1 skipped (supervisor browser), with one
upstream Starlette/AnyIO deprecation warning. Fresh installed-package assets,
configuration/redaction and process recovery passed: killed exit -9, three attempts
and exactly three submissions for Task d5cdde93-bda1-44ed-8b85-e482b9209948. Harness
reported “All configured checks passed.”

All 53 installed source/wheel manifest entries matched current bytes.
c10-t1-source-sha256.json retains 53 product source/asset/document hashes; mutable
caches are excluded. Implementation is ready_for_verification, blocker_kind=none.
Supervisor browser evidence and independent review remain pending for this snapshot.

## Verification repair

The first supervisor browser run rejected the revised save because trailing spaces
were removed. The React editor/API transport preserved text, but
`Core::create_task` normalized it as a title. `Core::create_text_work` now preserves
verbatim nonblank input, and `create_assigned_work` uses it. Existing CLI task-title
trimming remains unchanged. Snapshot restoration accepts surrounding whitespace
so these records reopen without normalization; whitespace-only requests remain
invalid. No schema migration or existing history rewrite is needed.

Authoritative research for this repair:
- https://doc.rust-lang.org/std/primitive.str.html#method.trim documents removal
  of leading/trailing whitespace. Decision: use trim only for blank validation
  of work input, retaining the original string for persistence.
- https://react.dev/reference/react-dom/components/textarea documents controlled
  textarea value/onChange. The existing editor preserves the value; no UI rewrite
  was needed.

Added a Core regression for exact Unicode/markup/whitespace and blank rejection.
Added an actual API/native/SQLite regression that executes original work twice,
saves revised text separately with no attempts, rejects blank input without extra
records, and reopens to compare both records and unchanged submission counts.
The supervisor browser assertions remain intact and must run after this handoff.

Repair logs use `c10-t1-repair-*`. The first frontend check hit its existing
5-second test timeout while builds ran concurrently (14 passed, 1 timeout);
that failure is retained. Final rerun outcomes are recorded below.

Final repair outcomes: frontend rerun 15 passed; production build passed; final
Rust workspace run 41 tests passed (including doctests); native rebuild exited 0
before Python started. Python: 57 passed, 1 supervisor-browser skip, one upstream
Starlette/AnyIO deprecation warning. Fresh installed-wheel checks passed, including
assets, configuration/redaction, actual process-kill and recovery. Harness check
exited 0 with “All configured checks passed.” All 53 installed source/wheel hashes
matched; `c10-t1-repair-source-sha256.json` also retains the current usage doc hash.

These results supersede the earlier ordinary outcomes for this repair snapshot.
Platform remains macOS arm64/Python 3.13.12; Windows and screen-reader coverage
remain unperformed. Supervisor browser verification and independent review are
pending, and C8-T2 live acceptance remains outstanding. Ready for verification;
no Task completion is claimed.
