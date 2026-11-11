# Product Core

C2-T1 implements PLAN sections 2.1, 2.2, 2.5 and 3 with the Rust
`llm-engine-core` library. The root Cargo workspace contains only product crates.
It needs Rust/Cargo and registry dependencies, with no local runner, Python,
provider, database, or UI dependency. The root product `Cargo.lock` records the
resolved dependencies and is retained for locked builds and tests.

## Domain contract

`Core::default()` creates an empty in-memory domain. `create_agent` and
`create_task` return distinct `AgentId` and `TaskId` types wrapping UUIDs.
IDs are generated once using UUID v4, checked against existing keys before
insertion, and remain unchanged across assignment and lifecycle changes.
Names/titles are trimmed, must be nonempty, and need not be unique. IDs have
canonical hyphenated text output and accept UUID input through `FromStr`.
Parsing establishes an ID value, not existence: lookup still validates it.
IDs are not credentials. Dropping an in-memory Core loses that copy; C2-T2 adds
an optional [SQLite persistence adapter](persistence.md) for durable storage.

`agent`/`task` return read-only entities or typed unknown-ID errors.
`agents`/`tasks` list all entities in ID order (not creation order).
`assign(task, agent)` validates both references and adds one relationship.
One Task may have many Agents; an Agent may have many Tasks. Duplicate pairs
return `AlreadyAssigned`, without changing state. Assignments are allowed in
Pending, InProgress, and Blocked; Cancelled Tasks are frozen. When both IDs are
unknown, the Task error takes precedence. Reference validation precedes status
and duplicate checks. No mutable entity references or fields escape the Core.
Every returned mutation error leaves the entire Core unchanged.

## Lifecycle

New Tasks are Pending. Only these transitions are supported:

| From | Allowed destinations |
| --- | --- |
| Pending | InProgress, Cancelled |
| InProgress | Blocked, Cancelled |
| Blocked | InProgress, Cancelled |
| Cancelled | none |

Entering InProgress requires at least one assignee. Self-transitions and all
unlisted edges are errors. Resuming a Blocked Task preserves its identity and
assignments. Cancellation is terminal and does not imply successful completion.
There is deliberately no Done status or completion API: verification evidence
is not implemented, so successful completion cannot be recorded in this slice.

## Future relationships and boundaries

Task is the durable unit of requested work. The C5-T1 Run domain below records
one reported attempt at one stage under one Task, with independent historical
Agent references. Durable Run storage remains a subsequent slice.
Evidence should reference the Run and its Task, record verification outcomes
and provenance, and link artifacts separately from status and free text. Future
completion must validate successful verification evidence for the relevant work;
a provider response or attempted Run alone must never complete a Task.

C2-T2 adds a persistence port and a separate SQLite adapter that preserve IDs,
enforce assignment references/uniqueness, validate loaded lifecycle state, and
commit related mutations atomically. See [persistence](persistence.md) for the
schema and restart contract. Core validation belongs in Rust; future Python
interfaces handle input and presentation. Providers and UI remain adapters.

## Research and decisions

Consulted for C2-T1 on 2026-09-13:

- [Rust Book: advanced types](https://doc.rust-lang.org/book/ch20-03-advanced-types.html)
  explains that newtypes enforce distinct types and hide implementation, whereas
  aliases do not. Decision: private UUID wrappers prevent mixing Agent/Task IDs.
- [Cargo Book: workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)
  describes explicit members, shared lockfiles and the explicit resolver needed
  by virtual workspaces. Decision: root virtual workspace with one product member
  and resolver 3; no dependency on development tooling.
- [uuid crate documentation](https://docs.rs/uuid/latest/uuid/)
  documents UUID text parsing/formatting and random generation with feature `v4`.
  Decision: UUID v4 gives identities independent of process-local counters without
  requiring a database allocator; no time ordering is needed in this slice.

## Validation

Run `cargo test --manifest-path rust/Cargo.toml --workspace --locked` and `cargo fmt --all -- --check` from the
repository root. Public API integration tests exercise identity round trips,
empty input, multiple assignments, unknown references, duplicate rejection,
all 16 status pairs, and whole-state equality after rejected mutations.
A compile-fail doctest checks Agent/Task type separation. These checks can run
with only Cargo.toml, Cargo.lock and crates/ copied to a separate directory.
Native Windows execution has not been validated in this Task.

### Successful recovery validation (2026-09-13)

After the operator resolved the dependency blocker, this implement-stage retry
inspected and preserved the existing Core, integration tests, README, and
resolved Cargo.lock. No domain changes were needed. The Cargo workspace, Rust
newtype, and Uuid API references above were consulted again; their documented
workspace isolation, type separation, and UUID v4 behavior support retaining
the existing design.

Actual checks in this retry (Cargo invoked as `/Users/hoon/.cargo/bin/cargo`
because it is outside the session PATH):

- `cargo test --manifest-path rust/Cargo.toml --workspace --locked`: exit 0; five integration tests and one
  compile-fail doctest passed.
- `cargo fmt --all -- --check`: exit 0.
- `python3 .harness/cli.py check`: exit 0, Python 3.13.12;
  reported "All configured checks passed."
- Copied only Cargo.toml, Cargo.lock, and crates/ into a fresh temporary
  directory under /private/tmp, with a fresh target directory and neither
  .harness/ nor .agents/. Both `cargo build --workspace --locked` and
  `cargo test --manifest-path rust/Cargo.toml --workspace --locked` exited 0; the same five integration tests
  and one doctest passed. Dependencies came from the available Cargo cache.

These results supersede the historical blockers below. Only C2-T1's implement
stage ran; no additional agents or independent review ran. Lesson: after a
dependency recovery, validate the retained lockfile and an isolated product
copy before treating successful harness checks as sufficient evidence.

### Previous blocked attempts

Implementation validation was initially blocked: the initial `cargo test
--workspace` could not resolve index.crates.io, and `cargo test --workspace
--offline` found no cached uuid package. Product compilation/tests have not run,
and no lockfile was generated. Recovery: restore registry access (or provide an
approved Cargo cache), run `cargo generate-lockfile`, then the locked product
checks above and a build/test from a directory containing only product files.
Formatting passed. The separately required `python3 .harness/cli.py check`
passed; it does not validate this product crate.

The C2-T1 implementation retry on 2026-09-13 preserved the existing domain,
tests, and README changes. Research reconfirmed the workspace boundary using
the Cargo workspace reference above and UUID generation/parsing using the
[Uuid API reference](https://docs.rs/uuid/latest/uuid/struct.Uuid.html).
The [Cargo test reference](https://doc.rust-lang.org/cargo/commands/cargo-test.html)
explains that `--locked` requires an unchanged lockfile and `--offline` uses
locally available dependencies. Decision: retain UUID identities and report
the missing dependency prerequisite rather than substitute a weaker allocator.
Cargo was absent from this session's PATH but available at
`/Users/hoon/.cargo/bin/cargo`. Invoking it directly with registry retries
disabled still failed to resolve `index.crates.io` (exit 101) before compilation.
The direct formatting check passed (exit 0), and
`python3 .harness/cli.py check` reported all configured checks passed (exit 0).
The harness check log is `.harness/checks.log`; its success does not establish
product test success. Locked and isolated product validation remain pending
dependency resolution.

The third implementation attempt on 2026-09-13 again inspected and preserved
the existing product code and tests. The Uuid API and Cargo test references
above were reopened: they confirm `v4` generation, hyphenated Display output,
and the distinction between locked and offline dependency resolution. The
decision remains to retain the existing identity contract.
`/Users/hoon/.cargo/bin/cargo test --workspace` failed before compilation with
exit 101 because `index.crates.io` could not resolve;
`/Users/hoon/.cargo/bin/cargo test --workspace --offline` failed with exit 101
because `uuid` is not cached. Formatting passed with exit 0, and
`python3 .harness/cli.py check` passed with exit 0 using Python 3.13.12.
No product tests executed, and locked/isolated validation remains blocked.
Further retries need restored registry access or a populated dependency cache;
the harness check alone cannot satisfy C2-T1 acceptance.

## Teams (C4-T2)

`TeamId` is a separate UUID type. `Core::create_team`, `team`, and `teams`
create and inspect teams with trimmed nonempty names. `add_team_members` accepts
an atomic batch of existing Agent IDs; duplicates are typed `AlreadyMember`
errors. One Agent can join multiple teams. `assign_team` atomically copies a
nonempty team's current members into a Task's assignees, retaining the existing
`AlreadyAssigned` policy. Any overlap rejects the entire command; cancelled
Tasks and unknown references are rejected. Later membership additions do not
change prior assignments. See [schema v2 and migration](persistence.md#teams-and-schema-v2-c4-t2).

## Recorded Runs (C5-T1)

For PLAN 2.2, 2.5 and 3, `RunId` is a distinct private UUID newtype, with
parsing/display and a compile-fail type-separation test. `Core::start_run(task,
stage, reporting_source, started_at, participants)` creates one recorded attempt
at one stage. Stage and reporting source are explicit, trimmed, nonempty text.
The source identifies the reporter (for example `operator:local`); it is an
assertion, not authenticated provenance or evidence of execution.

`RunTimestamp::from_unix_millis` accepts UTC Unix milliseconds in
0..=253402300799999 (1970 through year 9999). Negative and out-of-range values
fail. Times are supplied by callers, not read from a clock inside the domain;
future dates are not checked against wall time. Finish time must be at least
start time; equal times are valid. There is no cross-Run chronological ordering
constraint: reported times are not a scheduler or proof of exclusive execution.

A Run references exactly one existing Task and a nonempty immutable set copied
from selected current Task assignees. Unknown, unassigned, and repeated input
Agents are typed errors. A subset is allowed. Later team membership or Task
assignment additions do not change that snapshot. Names are not snapshotted;
Agent identity is retained. Lists use stable ID order, not chronological order.
`run(id)` shows one Run; `runs_for_task(task)` lists a Task's history and rejects
unknown Tasks; `runs()` exposes read-only records for adapters.

Only one Run per Task may be Active. Different Tasks may each have an Active
Run. `finish_run(id, outcome, ended_at)` changes Active to Finished exactly once,
with `ReportedSuccess`, `Failure`, or `Interruption`. The enum pairs outcome and
end time so partially finalized states cannot be represented. There is no edit
or deletion command. Retrying calls start again, retaining the Task and all prior
Runs but generating a new Run ID. All command errors preserve the entire Core.

Runs and Task status are independent. Start is allowed for assigned Pending,
InProgress, or Blocked Tasks and never transitions them. Existing Task lifecycle
edges remain unchanged even during an active Run. Cancelling a Task prevents new
Runs but leaves its active Run open: cancellation has neither a reporting time
nor an execution result. Explicit finalization remains allowed with any of the
three reported outcomes after cancellation. Restoring an active Run does not
resume execution or finalize it. Run success never completes a Task, verifies
work, or supplies a human-validated learning label.

`Snapshot.runs` contains raw `RunRecord` transport rows. `Core::restore` validates
unique Run IDs, Task/Agent references, canonical nonempty text, times, nonempty
unique participants and at most one Active Run per Task before returning a Core.
Restoration deliberately does not require historical participants to remain
current assignees or team members, including for still-open records. Original
selection eligibility is validated at start and cannot be proven from a later
snapshot; storage adapters must protect retained history from replacement.

C5-T1 introduced the in-memory domain and restoration boundary. C5-T2 now
persists Runs in [schema v3](persistence.md#runs-and-schema-v3-c5-t2), protecting
retained history even when a persistence closure replaces Core. C5-T3 owns
bindings/CLI exposure. Providers, processes, scheduling, Evidence and UI remain
outside this slice. Windows execution was not performed.

### C5-T1 research (2026-09-13)

- [Rust Book: advanced types](https://doc.rust-lang.org/book/ch20-03-advanced-types.html):
  newtypes provide type safety rather than aliases. Retain private UUID wrappers
  and use a validated timestamp wrapper.
- [Rust Book: pattern syntax](https://doc.rust-lang.org/book/ch19-03-pattern-syntax.html):
  enums carry associated data and can be destructured. Pair terminal time with
  outcome in one variant, avoiding independent optional fields.
- [Rust SystemTime](https://doc.rust-lang.org/std/time/struct.SystemTime.html):
  wall clocks are not monotonic and time comparisons can fail. Explicitly validate
  reported start/end ordering; do not infer elapsed execution from a clock.
- [Cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html):
  `--workspace` selects workspace members and `--locked` requires the lockfile
  to remain unchanged. Run that command and the compile-fail doctests.
- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html): references
  require explicit connection enforcement. Retain the adapter's existing settings.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): explicit
  transactions end in commit/rollback, and errors need not undo an entire batch.
  Reject unsupported Run state before DML and test reopening for whole-batch
  rollback. The requested `/transaction.html` URL returned an internal browsing
  error; the official `/lang_transaction.html` page was successfully read.

C5-T1 execution logs and source hashes: [implementation evidence](evidence/c5-t1-implementation.txt).
