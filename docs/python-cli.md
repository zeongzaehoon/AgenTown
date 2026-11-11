# Python package and CLI

This slice implements PLAN.md 2.1, 2.2 and 3: persistent agent creation,
Task creation and multiple assignees. It does not execute agents or complete Tasks.
Python 3.13 handles arguments and presentation; the separate `engine-python`
PyO3 adapter calls the existing Rust Core and SQLite adapter. No product import,
build dependency or runtime lookup uses local development tooling.

## Install from source

Prerequisites: Python 3.13, uv, and Rust/Cargo supporting edition 2024. Building
bundled SQLite also needs a C compiler. On macOS install Xcode Command Line Tools;
on Windows install Visual Studio Build Tools with Desktop development with C++
and a Windows SDK, and use the MSVC Rust toolchain. Run from the repository root.

macOS (shell):

```sh
uv sync --directory python --locked
uv run --directory python --locked agentown --help
```

Windows (PowerShell):

```powershell
uv sync --directory python --locked
uv run --directory python --locked agentown --help
```

This is a source package and CLI, not a desktop installer. Windows instructions
have not been executed on Windows in this Task. Native wheels must be built for
each target OS, architecture and Python version; a macOS wheel is not a Windows wheel.

## Complete flow

Global options precede `agent` or `task`. `--database` is required, so the chosen
file is explicit on every invocation. Its parent must exist. A new database is
initialized by Rust; use the same path on subsequent invocations to reopen it.
Use a dedicated product database (see [persistence](persistence.md)).

macOS (JSON extracts the generated IDs):

```sh
A=$(uv run --directory python --locked agentown --database ./company.sqlite --json agent create Designer | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
B=$(uv run --directory python --locked agentown --database ./company.sqlite --json agent create Developer | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
T=$(uv run --directory python --locked agentown --database ./company.sqlite --json task create 'Build workspace' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
uv run --directory python --locked agentown --database ./company.sqlite task assign "$T" "$A" "$B"
uv run --directory python --locked agentown --database ./company.sqlite agent list
uv run --directory python --locked agentown --database ./company.sqlite task list
uv run --directory python --locked agentown --database ./company.sqlite task show "$T"
```

Windows PowerShell:

```powershell
$a = (uv run --directory python --locked agentown --database ./company.sqlite --json agent create Designer | ConvertFrom-Json).id
$b = (uv run --directory python --locked agentown --database ./company.sqlite --json agent create Developer | ConvertFrom-Json).id
$t = (uv run --directory python --locked agentown --database ./company.sqlite --json task create 'Build workspace' | ConvertFrom-Json).id
uv run --directory python --locked agentown --database ./company.sqlite task assign $t $a $b
uv run --directory python --locked agentown --database ./company.sqlite agent list
uv run --directory python --locked agentown --database ./company.sqlite task list
uv run --directory python --locked agentown --database ./company.sqlite task show $t
```

Assignments are atomic per command: unknown agents, duplicate IDs within the
command, or already assigned agents reject the entire batch. Failures print a
readable error to stderr and exit 1; argument errors exit 2. Empty lists print
`No agents yet.` / `No tasks yet.` or JSON `[]`. JSON objects contain `id` and
`name` for agents; `id`, `title`, `status`, and `assignees` for Tasks. Lists and
assignees follow Rust's ID order. Binding calls return detached tuple records,
never mutable domain objects; errors become Python ValueError.

## Checks and wheel installation

```sh
cargo test --manifest-path rust/Cargo.toml --workspace --locked
uv run --directory python --locked python -m pytest
uv run --directory python --locked maturin build --locked --out dist
uv venv --python 3.13 /tmp/agentown-wheel
uv pip install --python /tmp/agentown-wheel/bin/python python/dist/*.whl
/tmp/agentown-wheel/bin/agentown --help
```

On Windows use a temporary directory under `$env:TEMP` and its
`Scripts/python.exe` and `Scripts/agentown.exe` paths. Wheel consumers need
Python 3.13, but do not need Rust or a checkout. `python/tests/test_cli.py` accepts
`LLM_ENGINE_TEST_CLI` pointing to a clean environment's installed executable,
so the same subprocess suite verifies a wheel outside the source directory.

## Research and decisions

- https://pyo3.rs/v0.27.2/ — PyO3 0.27.2 supports CPython 3.13 and native
  extension modules. Selected this exact version with a separate adapter crate;
  the extension-module feature is enabled by maturin, not default Cargo tests.
- https://www.maturin.rs/project_layout.html — mixed Rust/Python projects use
  `python-source` and a dotted `module-name`. Selected `llm_engine._native` so
  Python CLI code and the compiled adapter ship in one wheel.
- https://docs.python.org/3.13/library/argparse.html — argparse supplies nested
  subcommands, help and usage errors. Selected the standard library parser;
  domain validation and database operations remain in Rust.

## C2-T3 retained execution evidence

The implementation retry records commands, working directories, exit codes,
source SHA256 hashes, wheel SHA256, installed module paths, and verbose test
results in [c2-t3-implementation.txt](evidence/c2-t3-implementation.txt).
The standalone check copies only product sources to a temporary directory,
builds a wheel there, installs it into a fresh Python 3.13 environment, removes
the copied source tree, and runs the existing subprocess integration suite
outside the checkout. Neither `.harness` nor `.agents` is copied. Build tools
may reuse dependency caches; those caches are not product runtime dependencies.
This evidence is from macOS arm64; it does not establish Windows validation.

Additional research for this verification:

- https://docs.python.org/3.13/library/venv.html — virtual environments have
  independent installed packages by default. Use a fresh environment and inspect
  imported module paths to establish that the wheel supplies the runtime.
- https://www.maturin.rs/distribution.html — `maturin build` produces installable
  wheels. Verify the built wheel separately from the development installation.
- https://pyo3.rs/v0.27.2/ — the selected version supports native Python extension
  modules and CPython 3.13; retain the existing separate PyO3 adapter.

## Teams (C4-T3)

Global options also precede `team`. Rust owns team names, IDs, membership
validation and transactions. Separate bindings expose `create_team`, `list_teams`,
`show_team`, `add_team_members`, and `assign_team`. Team JSON records contain
`id`, `name`, and `members` (agent IDs in Rust ID order); assignment returns the
Task record. Empty teams show `Members: none`; an empty list shows `No teams yet.`.
Use `team --help`, `team add-members --help`, and `team assign --help` with the
same database option for nested usage.

After installing, the complete macOS shell flow is:

```sh
A=$(agentown --database ./company.sqlite --json agent create Designer | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
B=$(agentown --database ./company.sqlite --json agent create Developer | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
TEAM=$(agentown --database ./company.sqlite --json team create Delivery | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
T=$(agentown --database ./company.sqlite --json task create 'Build workspace' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
agentown --database ./company.sqlite team add-members "$TEAM" "$A" "$B"
agentown --database ./company.sqlite team list
agentown --database ./company.sqlite team show "$TEAM"
agentown --database ./company.sqlite team assign "$TEAM" "$T"
agentown --database ./company.sqlite task show "$T"
```

Windows PowerShell, after installation:

```powershell
$a = (agentown --database ./company.sqlite --json agent create Designer | ConvertFrom-Json).id
$b = (agentown --database ./company.sqlite --json agent create Developer | ConvertFrom-Json).id
$team = (agentown --database ./company.sqlite --json team create Delivery | ConvertFrom-Json).id
$t = (agentown --database ./company.sqlite --json task create 'Build workspace' | ConvertFrom-Json).id
agentown --database ./company.sqlite team add-members $team $a $b
agentown --database ./company.sqlite team list
agentown --database ./company.sqlite team show $team
agentown --database ./company.sqlite team assign $team $t
agentown --database ./company.sqlite task show $t
```

Activate the installed environment or use its executable's full path. With the
source development environment, prefix each command with `uv run --directory python --locked`.
Each invocation reopens storage, so the last two inspection commands also work
in a new terminal using the same database path.

Assignment **copies current membership**. Later additions to a team do not add
assignees to earlier Tasks. Agents can join multiple teams. Duplicate membership
(including repeats in one command) rejects the entire addition. Assigning an
empty team, unknown references, cancelled Task, or a team with any already
assigned member rejects the entire assignment, including otherwise new members.
Argument failures exit 2; Rust failures exit 1 with readable stderr, also when
`--json` is selected. No successful-looking JSON is printed on failure.
The existing four read-only MCP tools inspect agents and resulting Tasks;
no team or mutation MCP tools are added.

Research consulted for C4-T3:

- https://pyo3.rs/v0.27.2/function.html documents `#[pyfunction]` and module
  registration. Keep each team operation a separate registered function in the
  existing adapter crate, returning detached records and translated errors.
- https://docs.python.org/3.13/library/argparse.html documents subparsers,
  `nargs='+'`, and separate help/description text. Use required multi-ID arguments
  and descriptions that explain atomic copy behavior in nested help.

Required check output is retained in
[evidence/c4-t3-implementation.txt](evidence/c4-t3-implementation.txt); wheel build,
installation, subprocess output and source hashes are retained in
[evidence/c4-t3-wheel.txt](evidence/c4-t3-wheel.txt).
The installed wheel checks run outside the checkout on macOS arm64 with Python
3.13. Windows commands are documented but Windows execution and live external
client validation are unperformed.

## Recorded attempts and retries (C5-T3)

`run start`, `run finish`, `run list TASK_ID`, and `run show RUN_ID` record and
inspect attempts. They do not execute agents, verify results or complete Tasks.
`reported_success` is the reporter's claim, not verification. Reporting source is
an explicit, nonempty label supplied on start, not an authenticated identity;
it remains part of the immutable attempt when finished. No separate finalizer
identity is recorded. Participants must be a nonempty selection of current Task
assignees. Rust validates inputs, obtains UTC Unix milliseconds from the system
clock inside the transaction, and persists the change. Python only parses and
presents. A backwards clock that would end before start rejects finalization;
retry the finish command after the clock is corrected.

After the complete team setup above, macOS:

```sh
R1=$(agentown --database ./company.sqlite --json run start "$T" --stage implement --reporting-source operator --participants "$A" "$B" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
agentown --database ./company.sqlite run show "$R1"
agentown --database ./company.sqlite run finish "$R1" --outcome failure
# Each command is a new process; the same database retains history across restart.
R2=$(agentown --database ./company.sqlite --json run start "$T" --stage implement --reporting-source operator --participants "$B" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
agentown --database ./company.sqlite run finish "$R2" --outcome reported_success
agentown --database ./company.sqlite --json run list "$T"
agentown --database ./company.sqlite task show "$T"
```

After the Windows team setup above, PowerShell:

```powershell
$r1 = (agentown --database ./company.sqlite --json run start $t --stage implement --reporting-source operator --participants $a $b | ConvertFrom-Json).id
agentown --database ./company.sqlite run show $r1
agentown --database ./company.sqlite run finish $r1 --outcome failure
$r2 = (agentown --database ./company.sqlite --json run start $t --stage implement --reporting-source operator --participants $b | ConvertFrom-Json).id
agentown --database ./company.sqlite run finish $r2 --outcome reported_success
agentown --database ./company.sqlite --json run list $t
agentown --database ./company.sqlite task show $t
```

To report interruption, finish the active Run with `--outcome interruption`.
Closing a terminal does not finalize or resume a Run. Inspect history and explicitly
finish the active record before starting another. Retries receive distinct Run
IDs under the same Task; even reported success leaves Task status unchanged.
Later team membership and Task assignment additions do not rewrite participants.
Only one Run per Task may be active; repeated finalization is an error.

Global `--database PATH` and optional `--json` precede `run`. Use
`agentown --database ./company.sqlite run start --help` (and finish/list/show)
for nested help. Errors follow the existing exit 1 (Rust) / exit 2 (arguments)
contract with stderr and no successful JSON. Empty history is `[]` or `No runs yet.`.
List/show use existing read-only storage: they require an existing database and
never initialize or migrate it. Lists use ID order, not chronological order.
JSON fields are `id`, `task_id`, `stage`, `reporting_source`, `started_at_unix_ms`,
`ended_at_unix_ms`, `state`, `outcome`, `participants`. Active records have null
end/outcome; finished records have both populated. Participant IDs are sorted.
Separate native functions are `start_run`, `finish_run`, `list_runs`, `show_run`.
MCP still exposes exactly its original four read-only agent/Task tools.

Research consulted before implementation:

- https://pyo3.rs/v0.27.2/function.html — the selected PyO3 version exposes Rust
  functions with `#[pyfunction]` and module registration. Retain separate commands
  returning detached records rather than mutable Core objects.
- https://docs.python.org/3.13/library/argparse.html — subparsers, required options,
  choices and `nargs='+'` provide nested help and argument failures. Rust still
  validates binding calls independently of the CLI.
- https://doc.rust-lang.org/std/time/struct.SystemTime.html — system time is not
  monotonic and duration calculations can fail. Convert time in Rust with checked
  conversion and preserve Core's end-before-start rejection without clamping.

C5-T3 evidence is retained in `evidence/c5-t3-implementation.txt`,
`evidence/c5-t3-wheel.txt`, and `evidence/c5-t3-source-sha256.txt`.
Windows execution and live external-client validation are unperformed; local
macOS checks and real MCP protocol subprocess tests do not establish those claims.
