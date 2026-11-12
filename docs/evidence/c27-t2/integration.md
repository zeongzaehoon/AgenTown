# C27-T2 integration repair

This invocation read the existing implementation handoff, current frontend and
backend interfaces, and supplied verification failure excerpt. The referenced
`.harness/checks.log` was absent from this isolated checkout; no exact supervisor
verification artifact was supplied. No agents were invoked.

Found an integration defect: HistoryExport and SkillExecution were siblings
with identical work-ID keys. Switching selected work could therefore leave
duplicate history controls during React reconciliation. Gave the two component
keys distinct prefixes while retaining remounts on work changes. Added a
behavior regression that switches work three times, requires exactly one
history export and Skill panel, and checks the final downloaded work ID.

Inspected compatibility with the existing Python routes: preview sends skill_id;
explicit execution sends preview_id and expected_runs; ordinary execution keeps
its existing expected_runs payload. Saved Skill provenance remains displayed
from each attempt. No backend changes were needed.

Checks executed in this invocation using the available dependency tree through
an ignored local node_modules symlink (no installation):

- `vitest run --configLoader runner src/history-export.test.tsx src/SkillExecution.test.tsx`:
  2 files, 10 tests passed before adding the regression.
- `vitest run --configLoader runner src/history-export.test.tsx`:
  1 file, 5 tests passed including the new switching regression.
- `tsc --noEmit`: passed.

Consolidated mandatory tests/build and browser/visual validation are pending
supervisor verification for this snapshot. No full suite or browser checks were
rerun here. Live provider calls were skipped under user policy, not passed.

Lesson: give independently keyed sibling components distinct key namespaces
when both reset on selection changes; test switching selections as well as
initial rendering.


## Subsequent integration invocation: legacy fixture compatibility

Read the existing member handoff and integration record, Task instructions, and
actual SkillExecution/App request behavior. The supplied verification excerpt
identified legacy fixture failures; `.harness/checks.log` is absent in this copy
and no immutable verification artifact was supplied. No agents were invoked.

Updated deadlines fixtures to answer the independent Skills GET without treating
it as a mutation or triggering history failure. The unmount assertion includes
the new Skills polling interval and still requires all timers to clear. For an
uncertain execution, the existing deadline test now requires execution to stay
disabled until explicit successful refresh, matching the Task inspection guard.
No replay assertions were removed. History export fixtures answer Skills reads
and exclude only those independent reads from the no-network-on-download count;
any other unexpected request still fails the assertion.

Checks in this invocation:
- Initial focused integration run: App, history-export and outcomes passed;
  deadlines had 10 failures before fixture repair (102 passed, 10 failed total).
- After repair: deadlines and history-export passed, 19 tests across 2 files.
- `tsc --noEmit` passed.
- Full suites/build and browser/visual checks remain pending supervisor checks.
  Live provider calls skipped, not passed.

Reused current repository contract/research; no new research was necessary.

## Current implementation invocation: overview and team fixtures

Inspected the partial SkillExecution component, App execution/provenance guards,
existing evidence, and the supplied two-test failure excerpt. The referenced
`.harness/checks.log` is absent in this isolated checkout. Reused repository
research; no agents or new external research were invoked.

Updated only CompanyOverview.test.tsx and Teams.test.tsx fixtures to serve the
independent `/api/config/v1/skills` reads. Both explicitly require GET with no
body. The overview still requires exactly four workspace polls and rejects any
other request path; team navigation still permits only its expected read paths.
These assertions preserve detection of unintended mutations without mistaking
Skills discovery for workspace polling or team modification. Product behavior
and prior partial changes were preserved.

Local verification, using the existing dependency tree via an ignored local
node_modules symlink (no installation):
- Final `vitest run --configLoader runner src/CompanyOverview.test.tsx src/Teams.test.tsx`:
  2 files, all 7 tests passed.
- `tsc --noEmit`: passed.

Consolidated frontend tests/build and supervisor-selected checks, including any
browser/visual validation, remain pending for this snapshot. No full suite,
browser tests, native rebuild or live provider calls were run. Live calls remain
skipped, not passed, under user policy.
