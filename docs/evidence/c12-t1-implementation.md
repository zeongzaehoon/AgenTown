# C12-T1 implementation handoff

Scope: C12-T1 only. No subagents ran; role perspectives were advisory. Existing
partial/user changes and layout were preserved. No PLAN.md, harness source/state/
config, service settings or installed service runtime edits were made.

The API now exposes nullable `ended` from Run tuple index 5 in the existing native
history snapshot. No schema or native code changes and no separate history read.
React displays exact recorded UTC start/end dates with year and millisecond precision
and ISO `datetime` attributes. Active attempts explicitly have no recorded end;
interruption wording identifies recording time rather than precise process-stop time.
Caller-reported attempts have no provider request/waiting claim. Test and unverified
labels remain. Invalid/missing/out-of-range times render “Time unavailable.”
No timers, elapsed durations, progress estimates or new live announcements were added.

Frontend behavior tests cover active/success/failure/interruption and caller reports,
null/missing/invalid times, epoch/year-9999 limits, timezone/year and DST boundaries,
polling without DOM announcements, stale disconnected dates and unchanged mutations.
Existing export, search, selection, expanded results, draft/assignee and focus tests
remain. API tests compare exact native start/end values, coherent active-to-terminal
snapshots for three outcomes, and reported attempts across restart.

The installed supervisor browser flow additionally reads native Runs using the
isolated installed Python, compares all six displayed ISO dates against the three
persisted attempts after restart, retains IDs/timestamps in interactions, and takes
an additional screenshot. Original exact input/export, retry, kill, three-submission,
search and draft assertions remain. Syntax compilation passed. Actual supervisor
browser validation is PENDING for this snapshot; no older browser run is evidence.

Research and usage: ../local-screen.md, “Recorded attempt times (C12-T1)”.
Primary sources consulted before implementation:
- https://html.spec.whatwg.org/multipage/text-level-semantics.html#the-time-element : machine-readable datetime can accompany visible text.
- https://tc39.es/ecma402/#datetimeformat-objects : explicit time zone formatting avoids implicit device-zone ambiguity; selected fixed UTC ISO-derived text.
- https://www.w3.org/WAI/WCAG22/quickref/ : preserve keyboard/focus and status semantics; dates stay outside live regions.

Commands and retained outputs:
- npm --prefix frontend test → c12-t1-frontend.txt
- npm --prefix frontend run build → c12-t1-build.txt
- cargo test --manifest-path rust/Cargo.toml --workspace --locked → c12-t1-cargo.txt
- uv run --directory python --locked maturin develop --locked → c12-t1-native.txt
- After native rebuild: LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c12-t1-installed uv run --directory python --locked python -m pytest → c12-t1-pytest.txt
- python3 .harness/cli.py check → c12-t1-harness.txt

Installed-package tests build a fresh wheel and install it in a disposable isolated
environment outside the checkout; they verify assets/configuration/redaction,
restart and process termination without changing the running installed service.
Platform coverage: macOS arm64 only. Windows, other browsers and screen readers
are untested. C8-T2 intentional live configuration and actual response/restart
acceptance remain outstanding. PLAN.md section 8 remains incomplete.

Ordinary outcomes: frontend 34 passed with TypeScript checking; production
build passed; Rust workspace 42 tests passed including doctests; native rebuild
exited 0 before Python verification began. Python: 63 passed, 1 skipped (supervisor
browser), one upstream Starlette/AnyIO deprecation warning. Fresh installed-wheel
checks passed, including killed exit -9, all three attempts retained and exactly
three provider submissions. Installed recovery Task ID:
3c869c24-082f-4705-9b32-45e75cdb45ef. All 53 installed source/wheel manifest entries
match current bytes. Ordinary checks ran on macOS arm64.

Harness check exited 0: “All configured checks passed.” All required ordinary
commands exited 0. Source/asset/document hashes are retained in
c12-t1-source-sha256.json (mutable caches excluded). Handoff requests
ready_for_verification with blocker_kind=none; supervisor browser artifacts and
independent review remain pending. This does not approve or complete the Task.
