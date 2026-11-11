# C11-T1 verification repair

Inspected `.harness/checks.log`: the installed browser flow failed at the first
post-restart history selection because Playwright matched both Saved work and
Search saved work. All five history label locators now use `exact=True`.
No assertions or product labels were removed or changed. Existing search, export,
draft reuse, restart, failure/retry, process-kill and three-submission coverage remains.
Existing user/partial changes were preserved; no subagents ran.

Research consulted for this repair:
- https://playwright.dev/python/docs/api/class-page#page-get-by-label — label
  matching defaults to non-exact; `exact=True` matches the whole label with case
  sensitivity. Use exact history labels to disambiguate the two accessible controls.
- https://www.w3.org/WAI/WCAG22/quickref/ — keyboard operation, meaningful labels,
  visible focus and status messages remain relevant. Preserve the distinct product
  labels and existing keyboard/count-announcement tests.

The existing frontend implementation and tests were inspected: filtering derives
from full loaded input independently of selection, draft and assignee; matching
uses literal Unicode lowercasing; offline state retains history. This repair is
limited to browser locator ambiguity.

Current ordinary results are retained in c11-t1-repair-*.txt and
c11-t1-repair-checks.json; fresh installed-package artifacts are in
c11-t1-repair-installed/. Native rebuilding runs before Python tests.
Supervisor browser execution and independent review are pending for this snapshot.
Only macOS arm64 checks are run here; Windows and screen readers are unverified.
C8-T2 live configuration/response validation remains outstanding.

Lesson: adding a label containing an existing label can invalidate Playwright's
substring locators even when Testing Library's default exact queries pass.
Use exact accessible names for distinct controls throughout installed flows.

Final ordinary outcomes: frontend 18 passed; production build passed; Rust 41
passed including doctests; native rebuild passed before Python; Python 57 passed,
1 browser skipped, 1 upstream deprecation warning. Fresh installed checks passed
with Task 84cb22c9-75cb-4778-956d-2166ace3c106, killed exit -9 and 3 submissions.
However, the required harness check exited 1: its repeated Python run failed
`test_installed_web_assets_and_process_recovery` at line 111 (`state() == recovered`),
with active versus finished/interruption state differences. Exact output is copied
to c11-t1-repair-harness-checks.log. This unresolved recovery consistency failure
prevents readiness; status is blocked, blocker_kind implementation. No recovery
assertions were weakened. Supervisor browser verification remains pending.
