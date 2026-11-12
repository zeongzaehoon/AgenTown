# Inert product configuration

Skills, Hook bindings and Loop policies belong to the product SQLite database.
They start disabled. Enabling means **configuration enabled** only: creating,
editing and enabling never invokes a provider, runs a command, dispatches an
event, schedules work, creates a Run or reads `.agents`/`.harness` files.
Execution requires a separate explicit preview and admission/consent boundary;
configuration operations never cross it. See the single-Skill and terminal-Hook
flows below. The native Loop contract is documented below; its service/UI adapters are separate work. A Hook may reference a disabled
Skill, but such a Hook cannot be previewed for execution.

Python imports come from `llm_engine.configuration`. Each kind (`skill`, `hook`,
`loop`) has `create_<kind>(database, **fields)`, `update_<kind>(database, id,
**fields)`, `show_<kind>(database, id)`, `list_skills/list_hooks/list_loops(database)`
and `set_<kind>_enabled(database, id, enabled)`. Results are detached dictionaries
with named fields, including `id` and `enabled`; lists contain these records.
Updates replace all editable fields, preserving identity and enabled state.
Toggles are idempotent. Unknown fields and incorrect types are rejected;
integers do not accept booleans and enabled accepts only a boolean.

| Kind | Required editable fields |
| --- | --- |
| Skill | `name`, `instructions` |
| Hook | `name`, `skill_id`, `target_kind`, `target_id`, `event` |
| Loop | `name`, `task_id`, `max_iterations`, `interval_seconds` |

Rust validates trimmed names of 1–120 Unicode characters; Skill instructions
of 1–16000 Unicode characters with nonblank content; Hook targets `agent` or
`team` and events `task_created`, `run_completed`, `run_failed`; existing Skill,
target and Task references; Loop iterations 1–100 and intervals 60–86400 seconds.
IDs are stable opaque strings. Validation and missing-reference failures leave
the stored records unchanged. Python raises `ValueError` for invalid input,
`KeyError` for missing records/references and `OSError` for storage failures.

## Launch and exercise without credentials

After the normal product build/install, launch the documented product command:

```sh
agentown-web --database /tmp/configuration-demo.sqlite3 --port 8765
```

No model or provider credentials are needed for configuration. Any execution
configuration warning on the work screen does not prevent these APIs.
Collection endpoints `/api/config/v1/{skills,hooks,loops}` support GET/POST;
items `/{id}` support GET/PUT; `/{id}/enabled` supports PUT with only
`{"enabled":true}` or `{"enabled":false}`. Creation returns 201, other successes
200, invalid input 400, missing references/records 404 and unavailable storage
503. Collection responses use the plural key, e.g. `{"skills": [...]}`.
Existing loopback Host, same-origin JSON and body-size restrictions apply.

Run this in another terminal (use a fresh temporary database for each demo):

```python
import json
from urllib.request import Request, urlopen
origin = 'http://127.0.0.1:8765'
def request(path, fields=None, method=None):
    data = None if fields is None else json.dumps(fields).encode()
    req = Request(origin + path, data=data, method=method,
                  headers={'Origin': origin, 'Content-Type': 'application/json'})
    with urlopen(req) as response:
        return json.load(response)
base = '/api/config/v1/skills'
skill = request(base, {'name': 'Draft', 'instructions': 'Write a clear draft.'})
path = base + '/' + skill['id']
request(path, {'name': 'Edited draft', 'instructions': 'Use short sentences.'}, 'PUT')
saved = request(path + '/enabled', {'enabled': True}, 'PUT')
print(saved)
print(request(path))
```

Stop and restart the same server command, then GET the printed ID again:
`request('/api/config/v1/skills/' + saved['id'])`. The ID, edited instructions
and enabled value must match. Python example for all three kinds:

```python
from llm_engine import _native
from llm_engine import configuration as config
db = '/tmp/configuration-demo.sqlite3'
agent = _native.create_agent(db, 'Writer')[0]
task = _native.create_task(db, 'Draft announcement')[0]
skill = config.create_skill(db, name='Draft', instructions='Write clearly.')
hook = config.create_hook(db, name='Draft hook', skill_id=skill['id'],
                          target_kind='agent', target_id=agent, event='task_created')
loop = config.create_loop(db, name='Draft policy', task_id=task,
                          max_iterations=3, interval_seconds=60)
for kind, row in [('skill', skill), ('hook', hook), ('loop', loop)]:
    print(getattr(config, f'set_{kind}_enabled')(db, row['id'], True))
    print(getattr(config, f'show_{kind}')(db, row['id']))
```

Each Python call opens the store afresh. For process restart evidence, rerun
only the show calls with the printed IDs in a new interpreter.

For a repeatable real-process exercise, use the installed product environment's
Python interpreter (the same environment that supplies `agentown-web`):

```sh
python docs/configuration_demo.py --evidence /tmp/configuration-evidence
```

The exercise creates a fresh temporary database, starts the documented
`agentown-web --database ... --port ...` command without model credentials,
creates all three configuration kinds, edits their fields, disables and enables
them, then stops and restarts the command against the same database. It compares
the same IDs and complete edited/enabled records over HTTP and in a new Python
interpreter, and asserts that the referenced Task has no Runs. It never calls an
execution endpoint. The evidence directory receives `configuration-restart.json`
(commands, process IDs and before/after records), `configuration-server.log`
and a copy of `configuration.sqlite3`. Each invocation uses a fresh database.

`python/tests/test_installed_configuration.py` runs this exact exercise using the
existing installed-package fixture, so the supervisor's full installed-product
gate can retain the evidence. To run only that test in a built product development
environment: `uv run --directory python --locked python -m pytest
tests/test_installed_configuration.py`. The fixture builds and installs the wheel;
frontend assets must already have been built as for the other installed tests.

This isolated implementation worker checked script syntax only: its workspace
has no installed product environment, native adapter or pytest. The real-process
exercise and consolidated checks remain pending supervisor verification; this
is not execution evidence. Browser validation remains pending. Live provider
calls are skipped by user policy.

### Explicit single-Skill execution

Enabling configuration remains inert. The text-work HTTP API now accepts an
explicit single-Skill preview and admission flow; see
[text execution](text-execution.md#apply-one-saved-skill-explicitly-c27-t1) for
runnable requests. `POST /api/work/{task}/skill-preview` accepts exactly
`{"skill_id":"<enabled Skill ID>"}` and never invokes a provider. The returned
combined `input` must be reviewed before sending `preview_id` and `expected_runs`
to `POST /api/work/{task}/execute`. A fresh preview is required for each retry.
Hook configuration and terminal events never dispatch work automatically.
The explicit terminal-Hook flow below is a separate consent boundary. The native
Loop contract below requires its own explicit activation.

### Explicit terminal-Hook execution

`POST /api/work/{task}/hook-preview` accepts exactly `{"hook_id":"<Hook ID>"}`.
It previews the enabled Skill plus saved work for an enabled employee Hook whose
`run_completed` or `run_failed` event matches the latest saved terminal attempt.
Preview is available without provider configuration and never calls a provider.
The returned `preview_id` is submitted as `hook_preview_id`, together with
`expected_runs`, to the existing execute endpoint only after explicit inspection
and consent. Skill `preview_id` and Hook `hook_preview_id` cannot be combined.
Invalid or stale previews/consent return 409; oversized preview requests return
413; unavailable preview storage returns 503. Configuration endpoints retain their
existing status semantics.

See [runnable Hook requests and provenance](text-execution.md#explicit-terminal-hook-follow-up-c28-t1).
Configuration mutations and terminal events remain inert. Team targets and
`task_created` remain valid configuration records but are unsupported for this
execution flow. No automatic chains or Loop scheduler are enabled.

### Native bounded Loop execution (C29-T1)

This contract enables the execution-service feature in C29-T2. There is no
Loop HTTP endpoint or background dispatcher in this change. Enabling a policy,
creating a preview, and activating a session each dispatch **zero** provider
requests. Skill/Hook chains remain inactive.

The Rust/SQLite entities are `LoopPreview` (opaque consent ID), typed
`LoopSessionId` (one activation), and `LoopAttempt` (one existing typed `RunId`
under that session and the original Task). Schema v9 adds `loop_previews`,
`loop_sessions`, and `loop_attempts` transactionally; v1–v8 migrate and unknown
versions are rejected before writes. Records and snapshot contents are retained;
these records are execution provenance, never human quality verification.

Python `_native` exports these functions (Rust `SqliteStore` uses equivalent
methods without the database argument):

```python
preview_loop(database, policy_id, secrets=[]) -> dict
start_loop_session(database, preview_id, expected_runs, provider, model,
                   runtime_id, secrets=[]) -> dict
admit_loop_attempt(database, session_id, runtime_id, secrets=[]) -> ExecutionRecord | None
stop_loop_session(database, session_id) -> dict
recover_loop_sessions(database, runtime_id) -> None
loop_sessions(database) -> list[dict]
loop_attempts(database) -> list[dict]
```

A preview requires an enabled policy, saved nonempty text and exactly one assigned
employee, with no active Run. It returns `schema_version=1`, `preview_id`,
`policy_id`, `policy_name`, `policy_enabled=true`, `task_id`, `agent_id`, `input`,
`max_iterations`, `interval_seconds`, `expected_runs` (existing Task attempts),
and `created_at` (Unix milliseconds). Limits are 1–100 attempts and 60–86400
seconds. Start consumes this preview once, within five minutes, after checking
its expected count and unchanged policy/text/assignment. Changes invalidate
consent even if later restored. Another active session for the same Task is
rejected. Provider/model selection is snapshotted on explicit activation.

Session dictionaries contain `schema_version=1`, `session_id`, nested `preview`,
`state`, `provider`, `model`, `started_at`, `expires_at`, `admitted` and `next_at`.
States are `active`, `stopped`, `complete`, `failed`, `expired`, `restarted`, or
`stale`. Terminal states cannot be reactivated. Session lifetime is bounded to
`(interval_seconds * 1000 + 120000) * max_iterations + 120000` milliseconds.

**Service lifecycle requirement:** generate a fresh unpredictable `runtime_id`
once per execution-service process, keep it in memory, and call
`recover_loop_sessions` before accepting requests. Never reuse a previous token
or adopt persisted sessions after restart. Recovery atomically closes active
sessions owned by another runtime as `restarted`; admission with a mismatched
token also closes the session. Opening SQLite per API call does not imply a
service restart. Existing Run/result history remains available, and an already
admitted attempt may still finish. Recovery and stop do not claim to cancel a
provider request already dispatched.

Admission holds SQLite's immediate writer transaction while checking ownership,
expiry, stale consent, expected Task count, previous failure/interruption,
interval, attempt bound and active Run exclusion. It creates the ordinary
120-second execution lease, Run, session counter and immutable provenance in one
commit. Interval is measured between admission times. `None` means wait or a
terminal transition; inspect `loop_sessions` to distinguish them. Terminal session
admission raises a safe rejection. Stop is idempotent and serializes against
admission; after it commits no later admission succeeds. A racing admission that
commits first remains retained and may finish. Failures, including quota cooldown,
expiry and interruptions close the session on the next admission check; none
silently retry. Independent manual attempts invalidate continuation. Starting
a fresh session always requires a fresh preview and explicit user action.

The adapter must send only an ExecutionRecord returned by admission through the
existing provider path and finalize it through `finish_execution`. It must never
retry dispatch from `loop_attempts` or adopt an unfinished lease after restart.
Pass configured secret values at preview, start and admission; rejections expose
no stored input. Inspection returns saved input just like existing work history.

For a deterministic local exercise without provider credentials: create and
enable a policy using the configuration API, call `preview_loop`, inspect its
input/count, explicitly call `start_loop_session`, then call
`admit_loop_attempt`. Finalize that returned Run with a fixture result via
`finish_execution`, or stop immediately. Inspect `loop_sessions`, `loop_attempts`
and existing execution history after reopening the DB. Production adapters must
label fixture results honestly and must not dispatch from configuration reads.
The Rust `loop_execution::tests` fixtures use a controlled clock and real SQLite
connections to exercise timing, concurrent writers, stop, stale consent,
rollback, failure, expiry and reopen without real LLM calls.

### Loop HTTP runtime adapter (v1)

`agentown-web --database PATH --provider PROVIDER --model MODEL` exposes:

| Method | Endpoint | JSON body / result |
| --- | --- | --- |
| POST | `/api/loops/v1/preview` | `{policy_id}` → native version 1 preview |
| POST | `/api/loops/v1/start` | `{preview_id, expected_runs}` → native session (201) |
| GET | `/api/loops/v1` | `{schema_version:1, sessions, attempts, cancellation}` |
| POST | `/api/loops/v1/stop` | `{session_id}` → native session plus cancellation notice |

Mutation requests require the existing loopback same-origin JSON boundary and
120,000-byte limit. Bodies accept exactly the listed fields; expected count is a
nonnegative integer, never a boolean. Invalid/stale consent and unavailable
provider/model configuration return 409; oversized bodies return 413. Errors do
not expose raw storage errors or credentials. Inspection includes native attempt
fields plus `execution` with linked Run output/error and unverified quality.
Secrets are passed to native preview/start/admission and redacted from responses.
Runtime IDs are private to the service and cannot be supplied through HTTP.
See [text-execution.md](text-execution.md#bounded-saved-work-loop-service) for
explicit consent, cancellation uncertainty, recovery and runnable fixture steps.


Loop ownership and history (C34): launch `agentown-mcp --database /absolute/path/product.db`
and `agentown-web --database /absolute/path/product.db` against the same database
(use each command's `--help` for provider/model options). Opening the web screen
and polling Loop history does not claim execution authority, recover sessions or
dispatch work. Inspection adds `control: {state, can_control, message}`; states
are `available`, `local_authority`, `competing_owner`, `storage_failure` and
`closed`. Availability is advisory: Rust still exclusively admits every mutation.
No owner handle or runtime identity is returned.

When MCP owns execution, stop the Loop using `stop_loop_v1` on that same MCP
server. The web service cannot cancel another server's operation. To transfer
control, gracefully shut down the owning server, then explicitly start/stop from
the new service. Merely refreshing history after release does not recover or
replay work. Explicit control recovers abandoned sessions as restarted without
replaying them; a new activation needs a fresh, explicitly approved preview.
Storage failures require checking database/lock-file permissions and access,
not repeatedly trying to take control. Live provider validation remains skipped.
