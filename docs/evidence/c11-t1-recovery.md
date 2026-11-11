# C11-T1 recovery consistency repair

Implementation only; no subagents ran. Existing search, exact browser locators,
partial/user changes and current layout are preserved. No PLAN.md, harness
source/state/config, service settings or installed service runtime was edited.
The required native development build updates only the product development binding.

The previous retained failure in c11-t1-repair-harness-checks.log showed a single
API response combining an active Run with its interrupted execution result.
`web.state` read Runs before calling `show_execution`, which independently recovered
leases. A deadline between those reads produced contradictory UI data and broke
`state() == recovered` in the installed process-recovery test.

`SqliteStore.execution_snapshot` now recovers and collects Core and execution rows
in one immediate transaction. `history_snapshot` exposes this through PyO3; Python
formats that snapshot without further database queries. No schema, provider,
admission, retry or stored-content semantics changed. The existing full-store read
cost remains. This repair supports coherent polling of searchable saved history.

Regression coverage:
- Rust deterministic snapshots immediately before and at a lease deadline agree
  internally and preserve the earlier snapshot; recovered results survive reopen.
- Python completes an execution after native snapshot capture but before response
  formatting. The first response remains consistently active; the next response
  consistently reports the exact result, with one attempt and no provider calls.
- Existing installed recovery and browser assertions are retained unchanged.

Authoritative research consulted for this attempt:
- https://www.sqlite.org/isolation.html — a transaction provides consistent reads;
  BEGIN IMMEDIATE serializes writers. Decision: collect Run and execution rows in
  the same Rust-owned transaction as lease recovery.
- https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html — search counts
  should be programmatically announced without moving focus; unnecessary live
  region chatter can disrupt users. Retain existing count and focus behavior tests.
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/includes
  — includes performs literal, case-sensitive substring matching; the existing
  explicit lowercasing supplies documented case-insensitive matching.

Commands and exit codes: c11-t1-recovery-checks.json. Full ordinary outputs:
c11-t1-recovery-{frontend,build,cargo,native,pytest,harness}.txt. Native rebuild
finishes before pytest starts. Fresh installed wheel and process evidence:
c11-t1-recovery-installed/. Source and asset hashes are retained separately.

Supervisor browser verification and independent review are pending for this
snapshot. No historical supervisor artifact is claimed as current verification.
Platform coverage is macOS arm64 only. Windows and screen-reader checks remain
unperformed. C8-T2 still awaits intentional live provider configuration and a full
live response recovered after restart; PLAN.md section 8 remains incomplete.

Lesson: do not combine Run and result data from independent reads that can trigger
recovery. Test coherent snapshots at transition boundaries, and preserve the
installed equality and submission-count assertions that exposed this defect.

Final outcomes: all six required commands exited 0. Frontend 18 passed;
production build passed; Rust 42 passed including doctests; native rebuild passed
before Python began; Python 58 passed, 1 supervisor-browser skipped, 1 upstream
Starlette/AnyIO deprecation warning. Harness: All configured checks passed.
Its exact ordinary check log is copied to c11-t1-recovery-harness-checks.log.
The direct and harness repeated installed process-recovery tests both passed.
Latest retained installed Task: fe40edb7-90a3-4006-a523-eda67a9f0f2a;
killed exit -9; submissions 3.
All 53 installed source/wheel hashes and 54 source/asset/document
hashes match current bytes. Ready for supervisor verification, not Task approval.
