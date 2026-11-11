Current schema is v4: see [text execution](text-execution.md) for the added
Run-linked request/result records, transactional v1/v2/v3 migration and bounded
recovery. The historical v3 sections below describe the retained Run foundation.

# Product SQLite persistence

C2-T2 implements PLAN sections 2.2, 2.5 and 3. `llm-engine-core` defines
`persistence::Persistence`; `llm-engine-sqlite` implements it with rusqlite and
bundled SQLite. Core has no SQL dependency. Both are product workspace members
and work without `.harness` or `.agents`.

## Initialization and use

Pass an explicit dedicated product file path to `SqliteStore::open`, for example
`data/product.sqlite3` (create the parent directory first). There is no implicit
path, harness database discovery, or shared runtime state. Do not supply a
harness database. Nonempty unrecognized databases are rejected, not adopted.
Bundled SQLite requires a C compiler during the Rust build but no separately
installed SQLite runtime. Native Windows execution has not been validated.

```rust
use llm_engine_core::persistence::Persistence;
use llm_engine_sqlite::SqliteStore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut store = SqliteStore::open("product.sqlite3")?;
    let task = store.transact(|core| {
        let developer = core.create_agent("Developer")?;
        let reviewer = core.create_agent("Reviewer")?;
        let task = core.create_task("Shared work")?;
        core.assign(task, developer)?;
        core.assign(task, reviewer)?;
        Ok(task)
    })?;
    drop(store);
    let mut reopened = SqliteStore::open("product.sqlite3")?;
    assert_eq!(reopened.read()?.task(task)?.assignees().len(), 2);
    Ok(())
}
```

`read` returns an owned consistent Core snapshot. Editing that copy does not
persist it. `transact` loads current state, executes a batch of Core commands,
and returns its result only after commit. Callers should perform only domain
work in the closure: file/network side effects cannot be rolled back. Storage
errors distinguish domain rejection, SQLite failures, unsupported versions,
foreign databases, and invalid stored data.

## Schema and compatibility

Version 3 uses SQLite `user_version = 3` and `application_id = 0x4c4c4d45`
(`LLME`). The base schema is `rust/crates/engine-sqlite/src/schema.sql`; the additive v2 DDL is
`rust/crates/engine-sqlite/src/migration-v2.sql`; v3 adds
`rust/crates/engine-sqlite/src/migration-v3.sql`.

| Entity | Key | Relationships and data |
| --- | --- | --- |
| Agent | canonical UUID text, primary key | nonempty name |
| Task | canonical UUID text, primary key | nonempty title; explicit lifecycle status |
| Assignment | composite primary key `(task_id, agent_id)` | non-null foreign keys to Task and Agent |

AgentId and TaskId retain the Core's distinct types. UUIDs are generated once
by Core, stored without reallocation, and restored unchanged. Assignment identity
is the unique pair: multiple agents can share a task and one agent can have
multiple tasks. Duplicate assignment remains a typed `AlreadyAssigned` error;
SQL also enforces uniqueness. Foreign keys are explicitly enabled and checked
on every adapter connection before starting a transaction. Parent deletion is
restricted while referenced; an agent lookup index supports the inverse relation.

Writable opening initializes an empty version 0 file or migrates versions 1/2 to
version 3 in one IMMEDIATE transaction. Existing v1/v2/v3 files require the
product application ID. Each old schema is validated before the next additive
DDL; the final schema is validated before commit. Any failure rolls back all
initialization/migration DDL and version changes, including executed CREATEs.
Migration never rewrites existing identities, statuses, assignments or teams.
Other versions are rejected before writes. Read-only opening accepts v1/v2/v3
without migration. Every read/write rechecks version and ownership.

Restoration validates typed UUIDs, unique identities, trimmed nonempty text,
assignment references/uniqueness, and lifecycle state. InProgress and Blocked
require assignees. Cancelled tasks may retain historical assignments. Unknown
statuses, including Done, are rejected. Restoration is not a lifecycle transition
API and never synthesizes completion evidence. The lifecycle remains as defined
in [the Core contract](core.md).

## Atomicity and restart

Writes use BEGIN IMMEDIATE before reading, preventing two connections from
loading stale state and overwriting each other's accepted changes. Busy writers
wait up to five seconds and then receive a SQLite error. Reads use a transaction
so agents, tasks, and assignments come from one consistent snapshot.

C4-T1 compares the validated Core loaded under the writer lock with the final
Core after the entire command batch. It inserts new Agents and Tasks, updates
retained rows only when their scalar values differ, and computes assignment
pair differences independently (assignment changes do not update the Task row).
Only removed pairs/entities are deleted, children first; new parents precede new
assignments. Retained entities never use delete/reinsert or INSERT OR REPLACE.
The existing mutable-Core port also permits replacement with restored state,
so the comparison handles removals and changed names/titles as well as ordinary
create/assign/transition commands. Empty and net-zero batches issue no row DML.
C4-T1 retained schema v1; C4-T2 adds the transactional migration described above.
IDs, lifecycle validation, and the existing read-only API remain compatible. Restrictive external references to retained Agents,
Tasks, and assignment pairs survive these mutations.

Any domain, SQL, pre-commit,
or commit error drops the transaction and rolls back; the local Core is discarded.
No process-local cache needs repair. A fresh connection sees the previous commit
or the complete new commit, never a partial batch. SQLite's default rollback
journal is retained. Opening storage validates existing data and does not reset
Task states or generate new identities. It does not automatically resume work.

Writes now scale with changed rows, but reads still load and validate the full
Agent/Task/assignment/team/Run snapshot. Mutations also clone that Core and compare states
using ordered lookups and assignment sets. Memory remains proportional to total
state, comparison work includes ordered-map/set lookup cost, and the writer lock
covers this work. This is not yet a large-history read optimization.
Evidence, Artifact, and Meeting remain separate future entities. Runs are now
stored separately in v3; a retry has a new Run ID under
the same Task. Evidence will need source/time/version and explicit Run, Task,
and artifact relationships. No training export or human-validation label exists
in this slice.

## Research and decisions

Consulted on 2026-09-13 before adapter implementation:

- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html): enforcement is
  connection-specific and enabling it inside a transaction has no effect.
  Decision: enable and verify before any adapter transaction; use non-null
  references and a composite assignment primary key.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): IMMEDIATE
  acquires the writer transaction before reads; SQLite permits only one writer.
  Decision: serialize read-modify-write batches, and keep all related SQL writes
  inside one transaction. The requested `/transaction.html` URL returned an
  internal retrieval error; the canonical `/lang_transaction.html` page was read.
- [rusqlite Transaction](https://docs.rs/rusqlite/latest/rusqlite/struct.Transaction.html):
  transactions roll back on drop by default and expose explicit commit.
  Decision: propagate errors with `?`, committing only after all writes succeed.
- [SQLite PRAGMA](https://www.sqlite.org/pragma.html#pragma_user_version):
  user_version is application-managed; application_id identifies file ownership.
  Decision: version and identify this product schema separately from other files.

## Verification

Run `cargo test --manifest-path rust/Cargo.toml --workspace --locked`, `cargo fmt --all -- --check`, and the
required development check `python3 .harness/cli.py check` during implementation.
The SQLite tests use temporary files and real reopen operations. They cover
shared-task persistence, lifecycle retention, unknown IDs, duplicate assignments,
entire-batch domain rejection, SQL foreign keys on reopened adapter connections,
unsupported versions with byte-for-byte preservation, foreign databases,
invalid stored data, and updates from two connections. A private pre-commit hook
injects an error after all SQL mutations, then reopens and compares the complete
Core to the prior commit. The hook is not part of the public adapter API.

Implementation results on 2026-09-13: `/Users/hoon/.cargo/bin/cargo test
--workspace --locked` exited 0 (five Core integration tests, two SQLite unit
tests, five SQLite integration tests, and one compile-fail doctest passed).
`cargo fmt --all -- --check` and `git diff --check` exited 0.
`python3 .harness/cli.py check` exited 0 with Python 3.13.12 and reported
“All configured checks passed.” Cargo.lock includes the SQLite dependencies.
Only the C2-T2 implement stage ran; no independent review or additional agent
execution is claimed.

## Read-only inspection contract (C3-T1)

For PLAN 2.4 and 3, `ReadOnlyStore::open(path)` opens an existing version 1, 2 or 3
product database using SQLite READ_ONLY (without CREATE or URI interpretation).
It never initializes or migrates a database. Missing paths, empty/uninitialized
files, wrong application IDs, unsupported versions, unreadable schemas, and
invalid domain records are errors. It enables/verifies connection-local foreign
keys and uses the existing schema and Core restoration validation. The schema,
identities, assignment pairs, lifecycle, and CLI initialization behavior are unchanged.

`ReadOnlyStore::read()` returns an owned Core snapshot, exposing its typed agent
and Task list/lookup API. There is no persistence mutation method on this store;
changes to a returned Core affect only that copy. Opening validates a snapshot;
each subsequent read rechecks compatibility and all records in a new DEFERRED
transaction. The transaction ends before returning, so a later query sees
intervening committed writes. No snapshot or connection is cached in Python.
Busy connections wait up to five seconds before reporting an error.

Separate PyO3 functions in `llm_engine._native` are intended for external adapters:

| Function | Return value |
| --- | --- |
| `query_agents(database)` | list of `(id, name)` tuples |
| `query_agent(database, id)` | `(id, name)` tuple |
| `query_tasks(database)` | list of `(id, title, status, assignee_ids)` tuples |
| `query_task(database, id)` | `(id, title, status, assignee_ids)` tuple |

IDs are canonical UUID strings in output, lists and assignees follow Core's ID
ordering, and empty valid stores return empty lists. Rust parses lookup UUIDs
before opening storage; malformed IDs and unknown valid IDs raise `ValueError`
with `invalid agent/task ID` and `unknown agent/task` messages respectively.
Storage and invalid-record failures also raise `ValueError` with their Rust
error message. Every query validates the full snapshot, so corrupt unrelated
records also fail inspection. Existing native CLI functions keep their original
initializing behavior. No MCP server, mutation tool, or completion API is added.

Queries perform no persistent SQL writes, repairs, or journal-mode changes.
Tests compare database bytes after successful queries and errors under the
product's default rollback journal. SQLite-managed WAL sidecar behavior for
externally configured WAL databases is not a promise of zero filesystem activity.

Research consulted 2026-09-13 before choosing this path:

- [rusqlite OpenFlags](https://docs.rs/rusqlite/latest/rusqlite/struct.OpenFlags.html):
  READ_ONLY fails if the database is missing; default flags include CREATE.
  Decision: supply READ_ONLY explicitly and omit URI interpretation. The initial
  version-specific 0.32.1 documentation request failed; current documentation was
  read and the API is compiled/tested against the unchanged locked 0.38 dependency.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): a read
  transaction retains its historic snapshot until it ends. Decision: use short
  deferred transactions, including validation, and start anew for each read.
  The requested `/transaction.html` endpoint returned a retrieval error; this
  canonical page was successfully read.
- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html): enforcement must
  be enabled per connection before the transaction. Decision: retain that policy
  on inspection connections and reuse Core validation for stored references.

Execution outcomes are retained in [C3-T1 evidence](evidence/c3-t1-implementation.txt).

## C4-T1 research and verification

Consulted 2026-09-13 before implementation:

- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html): RESTRICT
  prevents deleting referenced parents; keep retained primary keys and pairs.
- [SQLite conflict handling](https://www.sqlite.org/lang_conflict.html): REPLACE
  deletes conflicting rows before insertion; use explicit INSERT/UPDATE instead.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): IMMEDIATE
  begins the write transaction before reading; retain serialization and rollback
  of the whole batch. The requested `/transaction.html` returned a retrieval
  error; the canonical page was read successfully.

The incremental-write integration test audits INSERT/UPDATE/DELETE triggers on
all three tables and asserts exact mutations for creation, assignment, lifecycle
changes, restored names/titles, empty batches, and net-zero lifecycle batches.
Restrictive references cover all three entity types. Separate-connection tests
check visibility of committed work. The private failure hook asserts that SQL
writes occurred before injecting an error, then checks the prior state on reopen.
Execution output and source SHA256 hashes: [C4-T1 evidence](evidence/c4-t1-implementation.txt).

## Teams and schema v2 (C4-T2)

Team has a distinct stable UUID `TeamId`, a trimmed nonempty name, and a set of
existing Agent IDs. Team names need not be unique. `Core::create_team`, `teams`,
and `team` provide creation, ID-ordered listing, and typed lookup.
`add_team_members(team, &[agent_ids])` validates the entire input before mutation;
duplicates within the input or existing membership return `AlreadyMember`.
An empty addition is a no-op. Agents may belong to several teams.

`assign_team(task, team)` validates all current members before adding any
assignment. Unknown references, an empty team, cancelled Task, or any member
already assigned cause typed errors and leave state unchanged. Assignment copies
the member IDs into ordinary Task/Agent assignments; subsequent membership
additions have no effect on previously assigned Tasks. Team has no execution or
completion lifecycle in this slice. Python team bindings/CLI remain C4-T3 work.

`teams(id, name)` and `team_members(team_id, agent_id)` use a Team primary key,
non-null foreign keys, a unique membership pair, and an inverse Agent index.
Incremental persistence inserts only new memberships and teams, preserving
retained rows and restrictive references. The mutable-Core port also handles
restored changes/removals: remove membership children before parents and insert
parents before children. No-op batches perform no row writes. Reads still load
and validate the full snapshot, now including teams/membership in v2; v1 has no
teams. Restart retains all identities and relationships. Invalid stored team
names, IDs, references, and duplicate membership are rejected without repair.

Research consulted 2026-09-13 before implementation:

- https://www.sqlite.org/foreignkeys.html — foreign keys require per-connection
  enabling before transactions. Use non-null references and unique member pairs.
- https://www.sqlite.org/lang_transaction.html — IMMEDIATE reserves the writer
  before reads; errors may undo only the failing statement. Keep migration DDL,
  validation, and version change under the existing rollback-on-drop transaction.
  The requested https://www.sqlite.org/transaction.html returned a retrieval
  error; the canonical URL above was successfully read.

`engine-core/tests/teams.rs` covers command atomicity and copy semantics.
`engine-sqlite/tests/teams.rs` covers migration preserving all four statuses and
assignments, v1 inspection without migration, v2 inspection across an existing
reader, migration DDL rollback and retry, restart, domain/SQL failed batches,
unique/FK enforcement, incremental membership audits, restrictive references,
and invalid stored membership. Existing query tests cover unsupported versions
without writes. Execution and source hashes are retained in
[C4-T2 evidence](evidence/c4-t2-implementation.txt).

## Runs and schema v3 (C5-T2)

For PLAN 2.5 and 3, Run is a recorded attempt at one Task stage. It has a distinct
stable UUID `RunId`; retries retain Task identity and allocate new Run IDs.

| Table | Key | Relationships and values |
| --- | --- | --- |
| runs | `id` canonical UUID text | non-null Task FK; trimmed nonempty stage and reporting source; start in UTC Unix milliseconds; optional paired outcome/end |
| run_participants | `(run_id, agent_id)` | non-null Run and Agent FKs; immutable, nonempty selected-participant ID snapshot |

Participant history references Agents directly, not current assignments or team
membership. Later changes to those relationships leave history intact. The
snapshot records participant identity, not a historical copy of Agent names.
The Core validates initial selection against current assignees. Restoration
validates all references, IDs, timestamps, terminal pairs and participant sets,
but does not reinterpret historical membership using current assignments.

Start persists an active Run with NULL outcome/end. Finish updates only its
outcome/end to `reported_success`, `failure`, or `interruption`; the end must be
at least the start. Times must be in 1970–9999. An SQL partial unique index on
Task where outcome is NULL reinforces the Core's one-active-Run rule. Finish
and retry in one batch updates the prior active Run before inserting the retry.
An outcome reports an attempt; success neither verifies work nor completes its
Task. Cancellation can leave an active Run, which can still be finalized.
Opening or restarting only loads and validates: it never executes, resumes or
finalizes an active Run. Explicit Rust commands remain necessary.

Before any row mutations, the adapter compares retained Runs even if the closure
replaced Core with a restored value. Deleting any Run, changing its original
fields or participants, and changing a terminal outcome/time are rejected.
Only active-to-terminal state changes are permitted. SQL triggers additionally
reject Run deletion, original-field rewriting, terminal updates, and participant
updates/deletions. Adapter commands never insert participants into retained Runs.
This is an adapter integrity contract, not protection against an external owner
who can alter schema/triggers or directly add rows. Invalid externally stored
history fails both writable opening and read-only inspection without repair.

Incremental writes insert new Runs/participants and update only newly finalized
Runs. Existing unrelated rows and prior terminal history receive no mutations;
there is no replace/delete-reinsert path. All changes share the existing
BEGIN IMMEDIATE transaction with Agent/Task/team changes. Foreign keys restrict
removal of referenced Tasks and Agents. All v1→v2→v3 DDL and version updates
commit together; v2→v3 adds only empty Run tables, indices and triggers. Existing
v1/v2 read-only inspection returns an empty Run collection without migration.

Remaining cost: reads still load and validate the full snapshot, now including
all Runs and participants. Writes also load and clone that snapshot and compare
it in memory. SQL mutations are incremental; reads and memory use are not yet
bounded by the queried Task. Run bindings and CLI commands remain C5-T3 work;
existing CLI and the four read-only MCP tools keep their contracts.

Research consulted 2026-09-13 before implementation:

- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html): enforcement is
  per connection and must be enabled before transactions. Retain the existing
  connection policy and non-null Run/Task/Agent references.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): CREATE is
  a write statement; IMMEDIATE obtains a write transaction before reads. Keep
  additive DDL, validation and version updates in one rollback-on-error
  transaction, and serialize competing start commands before loading state.
  The requested https://www.sqlite.org/transaction.html failed retrieval; this
  canonical page was read successfully.
- [SQLite partial indices](https://www.sqlite.org/partialindex.html): UNIQUE
  partial indices enforce uniqueness for only rows satisfying their predicate.
  Use `WHERE outcome IS NULL` for the one-active-Run-per-Task SQL constraint.

Coverage: `engine-sqlite/tests/run_boundary.rs` exercises restart/retry,
concurrent connections, closure replacement attacks, later relationship changes,
v2 read-only/migration and DDL rollback, corrupt history, SQL constraints, and
exact trigger-based mutation auditing. Existing `teams.rs` retains v1 migration
coverage for every Task status. A private unit-test hook observes Run SQL writes
and then fails before commit, verifying the prior snapshot on reopen. Execution
output and source SHA256 hashes are retained in
[C5-T2 evidence](evidence/c5-t2-implementation.txt).
