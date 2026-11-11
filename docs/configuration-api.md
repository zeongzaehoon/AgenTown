# Inert product configuration

Skills, Hook bindings and Loop policies belong to the product SQLite database.
They start disabled. Enabling means **configuration enabled** only: creating,
editing and enabling never invokes a provider, runs a command, dispatches an
event, schedules work, creates a Run or reads `.agents`/`.harness` files.
A later execution adapter will need a separate explicit admission/consent
boundary, runtime event semantics, limits and execution evidence. These records
are not that adapter. A Hook may reference a disabled Skill.

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
