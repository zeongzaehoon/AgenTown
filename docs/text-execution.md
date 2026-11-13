# Text execution (C7-T1)

Design: one immutable execution row belongs to one existing Run and therefore one
Task; the Run snapshots one assigned Agent. Input, provider, model and expiry are
immutable. Output or an allowlisted error and terminal Run outcome commit in one
Rust SQLite transaction. Provider success is unverified and never completes a Task.
Schema v4 adds only execution records; writable v1/v2/v3 migration preserves rows;
read-only legacy inspection remains supported. Partial Artifact/Evidence work is
preserved and still rejected by persistence.

The MCP workflow adds schema v5 for declared integration provenance, preserving
the v4 execution records and seven-field execution adapter result. See the
[versioned MCP workflow](mcp.md) for explicit retry consent and attempt-count
admission; declared source is metadata, never authenticated identity.

Rust serializes admission with BEGIN IMMEDIATE and the existing active-Run guard.
Attempts expire after 120 seconds. Inspection through `work show` and explicit
`work recover` terminalize expired executions, never resend. Opening the generic
store retains its existing read-only lifecycle semantics. A killed process is
therefore recoverable after the deadline; no background service is required.
Late responses are rejected. Retry is explicit and creates a new Run on the same
Task. Existing recorded-attempt commands cannot finalize an execution Run.

Research (2026-09-13):
- https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/python documents
  Messages text blocks, explicit model/max_tokens, typed authentication/429/network
  errors, configurable timeouts and SDK retries. Decision: one non-streaming text
  request, retries disabled, async wall timeout plus transport timeout, sanitized
  error codes rather than exception strings.
- https://github.com/anthropics/anthropic-sdk-python documents runtime API key
  configuration and Messages creation. Only ANTHROPIC_API_KEY intentionally set by
  the operator is consumed; no credential discovery or .env loading.

Live validation is outstanding: no credentials were intentionally supplied for
this implementation. Deterministic responses are test evidence only. Section 8
also needs the subsequent screen and installed workflow Tasks.

## Run it

From the checkout (macOS, Python 3.13):

```sh
uv sync --directory python --locked
uv run --directory python --locked maturin develop
uv run --directory python --locked agentown --database /tmp/work.sqlite3 --json agent create Writer
uv run --directory python --locked agentown --database /tmp/work.sqlite3 --json task create 'Meeting summary'
uv run --directory python --locked agentown --database /tmp/work.sqlite3 task assign TASK_ID AGENT_ID
```

Save `Summarize in one sentence: The team agreed to ship the draft on Friday.`
in `input.txt`. Intentionally supply `ANTHROPIC_API_KEY` through your runtime
secret configuration (do not put it in a command argument or repository file).
Choose a model available to your account; there is deliberately no default.

```sh
uv run --directory python --locked agentown --database /tmp/work.sqlite3 --json work execute TASK_ID --agent AGENT_ID --input-file input.txt --model YOUR_MODEL_ID
uv run --directory python --locked agentown --database /tmp/work.sqlite3 --json run list TASK_ID
uv run --directory python --locked agentown --database /tmp/work.sqlite3 --json work show RUN_ID
uv run --directory python --locked agentown --database /tmp/work.sqlite3 work recover
```

The response includes `run_id`, immutable `input`, `provider`, `model`, `output`,
`error`, deadline and `quality: unverified`, plus the Run and Task identities.
Failure returns exit 1 with a retained Run. Configuration errors occur before
admission and print an actionable message. Authentication means check the key;
rate_limit means wait and retry explicitly; timeout/network/interrupted mean
remote execution may have occurred, so inspect before deciding to retry.
Malformed/empty/refused responses retain no purported successful output.
`work execute` again is an explicit retry even after success; it preserves the
Task ID and all earlier Runs. `run finish` cannot bypass execution finalization.

On Windows, use a writable explicit path such as `C:\\Users\\YOU\\work.sqlite3`
and the same commands in PowerShell, with your runtime environment supplying the
key. Windows execution was not performed. macOS source checks are recorded in
`docs/evidence/c7-t1-implementation.txt`; installed-wheel/browser validation belongs
to the subsequent integration Task. No screen is supplied by C7-T1.

Restart never resubmits a request. Run `work recover` or inspect `work show` after
120 seconds to mark a killed attempt interrupted. Normal cancellation finalizes
immediately. Recovery is idempotent. No automatic provider retry occurs, including
for 429; each explicit retry obtains a new Run. The provider call has a 60-second
wall limit inside a 65-second port limit and a 45-second transport timeout.

Storage keeps the existing full-Core snapshot read cost; execution validation also
reads each execution record. Admission concurrency is one active Run per Task
across processes, matching the existing Core policy. It is not a global employee
scheduler. No tools, streaming or automatic quality decisions are supported in
this text port. All binding calls return detached values; each call opens its own
Rust-owned store. Result presentation has `schema_version: 1`.

## Additional providers

Use `--provider openai`, `--provider bedrock` or `--provider xai` for the official
SDK adapters. Anthropic remains the default. See [configuration and limits](providers.md).

## Apply one saved Skill explicitly (C27-T1)

The HTTP API can preview one enabled Skill with saved work, without provider
configuration or a provider call. Enabling a Skill alone does not execute it.
Hook configuration and Loops remain inert. The preview's `input` is composed by Rust; clients
must display it before explicitly submitting its opaque `preview_id`. Clients
must not construct an execution input from local Skill text.

Start the existing server with an explicit database and configured provider/model:

```sh
agentown-web --database /tmp/agentown-skill.sqlite --provider anthropic --model YOUR_MODEL
```

The following requests require `curl` and `jq`. They save configuration and work;
only the final execute request can call the configured provider. Real provider
calls are currently waived: skip that request without intentional configuration.

```sh
base=http://127.0.0.1:8765
employee=$(curl -fsS "$base/api/employees" -H "Origin: $base" -H 'Content-Type: application/json' -d '{"name":"Writer"}' | jq -r .id)
task=$(jq -n --arg employee "$employee" '{employee:$employee,input:"Draft a short project update."}' | curl -fsS "$base/api/work" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- | jq -r .id)
skill=$(curl -fsS "$base/api/config/v1/skills" -H "Origin: $base" -H 'Content-Type: application/json' -d '{"name":"Concise","instructions":"Use short sentences."}' | jq -r .id)
curl -fsS -X PUT "$base/api/config/v1/skills/$skill/enabled" -H "Origin: $base" -H 'Content-Type: application/json' -d '{"enabled":true}'
jq -n --arg skill "$skill" '{skill_id:$skill}' | curl -fsS "$base/api/work/$task/skill-preview" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- > /tmp/agentown-preview.json
jq . /tmp/agentown-preview.json
# Explicit consent after inspecting input; this is the provider-calling step:
jq '{preview_id,expected_runs}' /tmp/agentown-preview.json | curl -sS "$base/api/work/$task/execute" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @-
# Durable attempts, outcome, exact admitted instructions and composed input:
curl -fsS "$base/api/state" -H "Origin: $base" -H 'Content-Type: application/json' -d '{}'
```

Preview returns `schema_version: 1`, `preview_id`, `task_id`, `skill_id`, `input`
and `expected_runs`. Admission accepts exactly `preview_id` and `expected_runs`.
No input or instructions may be supplied at admission. A stale, disabled,
changed, consumed or wrong-task preview returns HTTP 409 without provider I/O.
Refreshing history and requesting a fresh preview is required for explicit retry;
changing `expected_runs` does not make a consumed preview reusable. Existing
execution with only `expected_runs` continues to execute without a Skill.

Skill executions return the existing execution record plus `skill` provenance;
`/api/state` exposes the same provenance per attempt, including `skill_id` and
exact `instructions`. Subsequent Skill edits cannot rewrite admitted provenance.
Provider failures persist a terminal attempt and its provenance. Provider success
remains quality-unverified and does not complete a Task. Configured secret values
are passed transiently to native validation, rejected before preview/admission
persistence, and redacted from HTTP and persisted provider output.

Deterministic acceptance command after native integration:

```sh
cd python
python -m pytest tests/test_skill_execution.py tests/test_web.py tests/test_configuration.py
```

The fixture provider exercises exact preview input, success, persisted failure,
fresh-preview retry, stale rejection, simultaneous duplicate submission, restart
retention and secret handling. These tests do not contact a real provider.

The React work screen now exposes this same preview/admission contract. See
[local screen flow](local-screen.md#preview-and-execute-one-skill). The UI displays
only the server-composed preview input, sends exactly `preview_id` and
`expected_runs` on Skill execution, and displays `attempt.skill` as saved
provenance. Ordinary execution still sends only `expected_runs`. Configuration
records are polled; changed server configuration also invalidates admission even
before the next screen refresh. Unknown submission outcomes require an explicit
history refresh and a new preview, with no automatic resend.

## Explicit terminal-Hook follow-up (C28-T1)

Prerequisite: the C27 saved-Skill flow and integrated C28 native bindings. Launch
`agentown-web --database /tmp/agentown-hook.sqlite --provider anthropic --model YOUR_MODEL`.
The HTTP flow selects an enabled employee-target Hook for the latest saved
terminal attempt on the same work. `run_completed` matches reported provider
success; `run_failed` matches failure. Provider success still has
`quality: unverified`. A terminal event alone never starts a follow-up.
Team targets, `task_created` dispatch, Loops and automatic chains are unsupported.
The Hook work-screen controls belong to the subsequent C28-T2 UI slice.

Use the employee, task and enabled Skill creation requests above, against this
server. Set `base`, `employee`, `task` and `skill` to their returned values.
Create and enable the employee Hook (no execution occurs):

```sh
hook=$(jq -n --arg employee "$employee" --arg skill "$skill" '{name:"Follow up",skill_id:$skill,target_kind:"agent",target_id:$employee,event:"run_completed"}' | curl -fsS "$base/api/config/v1/hooks" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- | jq -r .id)
curl -fsS -X PUT "$base/api/config/v1/hooks/$hook/enabled" -H "Origin: $base" -H 'Content-Type: application/json' -d '{"enabled":true}'
```

A fresh work item has no terminal attempt and cannot match a Hook. If intentionally
configured to make a provider call, explicitly create the initial attempt below;
otherwise skip it under the live-test waiver. Never substitute a fixture response
as live provider evidence.

```sh
# Provider-calling step: only for an intentionally configured live exercise.
curl -sS "$base/api/work/$task/execute" -H "Origin: $base" -H 'Content-Type: application/json' -d '{"expected_runs":0}'
```

For an initial failure, configure a `run_failed` Hook instead. Inspect history to
choose the event matching the actual latest saved outcome. Preview and inspect
the complete native response, including source Run, Hook/Skill snapshots and
combined input; the preview requires no provider configuration or I/O:

```sh
jq -n --arg hook "$hook" '{hook_id:$hook}' | curl -fsS "$base/api/work/$task/hook-preview" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- > /tmp/agentown-hook-preview.json
jq . /tmp/agentown-hook-preview.json
# Explicit consent after inspection; this request can call the provider once.
# Skip while live calls are waived and credentials are unavailable.
jq '{hook_preview_id:.preview_id,expected_runs}' /tmp/agentown-hook-preview.json | curl -sS "$base/api/work/$task/execute" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @-
# Inspect immutable attempt provenance; repeat after restarting the same server.
curl -fsS "$base/api/state" -H "Origin: $base" -H 'Content-Type: application/json' -d '{}' | jq '.work[].attempts[] | {id,outcome,quality,input,hook}'
```

Admission accepts exactly `hook_preview_id` and `expected_runs`. Mixing Skill
`preview_id` and Hook consent, or supplying input/snapshot overrides, is rejected.
Rust revalidates the current assignment, latest source attempt, event and enabled
Hook/Skill snapshots and consumes the preview in the same transaction that creates
one attempt. Stale, changed, disabled, wrong-task, consumed and simultaneous
duplicate requests return HTTP 409 without provider I/O. Refresh history and
request a fresh preview before any explicit retry. Unknown HTTP outcomes require
history inspection rather than an automatic resend.

The execution response's `hook` and history's `attempt.hook` expose the immutable
native provenance keyed by resulting `run_id`, including `hook_id`,
`source_run_id` and Skill `instructions`. Subsequent edits cannot rewrite the
admitted snapshot. Provider failure retains the attempt and its provenance;
restart never resubmits it. HTTP responses and persisted provider output retain
the existing configured-secret redaction, and preview/admission reject configured
secrets before saving composed input.

After native integration, deterministic acceptance can be run with:

```sh
cd python
python -m pytest tests/test_hook_execution.py tests/test_skill_execution.py tests/test_web.py tests/test_configuration.py
```

These fixtures exercise success/failure matching, missing terminal source,
unsupported targets/events, disabled configuration, changed snapshots/assignment/
source, wrong-task and consumed consent, concurrent duplicates, failure provenance,
restart and secret rejection. They never contact a real provider. This worker's
local checks and pending integration gates are recorded in
[evidence](evidence/c28-t1/ai-developer.md).

### Bounded saved-work Loop service

Launch `agentown-web --database /absolute/path/company.db --provider anthropic --model MODEL`
with the selected provider's normal environment configuration. Missing configuration
still permits preview and history, but activation returns 409 before creating a
session. Enabling a policy does not start execution. No real-provider validation
was performed for this slice; deterministic fixture outputs are not LLM evidence.

Use the existing configuration API to create an enabled Loop for saved work with
one employee. From the documented loopback origin, send same-origin JSON requests
(`Origin: http://127.0.0.1:8765`, `Content-Type: application/json`):

1. `POST /api/loops/v1/preview` with `{"policy_id":"POLICY_ID"}`.
   Inspect the saved input, employee, maximum calls, interval and expected count.
2. Explicitly consent with `POST /api/loops/v1/start` and
   `{"preview_id":"PREVIEW_ID","expected_runs":0}` using the preview's actual
   count. A 201 response supplies the session ID. Reusing consent returns 409.
3. `GET /api/loops/v1` shows native sessions and immutable attempt links with
   execution output/error, Run ID and `quality: unverified`. Existing
   `/api/state` also shows those ordinary Runs. Poll inspection without starting
   another session.
4. `POST /api/loops/v1/stop` with `{"session_id":"SESSION_ID"}` commits stop
   before attempting cancellation of local async provider work. Repeating stop is
   safe. An already dispatched remote request may complete despite cancellation;
   interrupted local output does not prove remote cancellation or absence of cost.

Rust checks admission before every call, including the first, and owns all timing,
limits and durable transitions. Python polls Rust while waiting and never computes
eligibility. Provider failures terminate continuation; there is no silent retry.
Graceful shutdown stops local workers; restart uses a fresh runtime identity and
marks remaining active sessions `restarted`, without dispatching them. A new
session requires fresh preview and explicit consent. Run leases/results remain
inspectable after restart; remote completion can remain uncertain.

Credential-free runnable fixtures (in the normal product development environment,
with the current native bindings already built):

```sh
cd python
python -m pytest tests/test_loop_execution.py -q
```

These fixtures create a temporary database, employee, saved work and enabled
policy and inject an explicitly labelled deterministic provider. They exercise
the actual HTTP endpoints and Rust persistence, maximum call bound, duplicate
start/admission, interval refusal, stop before/during dispatch, failure and restart.
Rust's existing controlled-clock Loop fixtures cover advancing interval boundaries
and concurrent writer ordering; Python fixtures require no minute-long waits.
No public HTTP endpoint permits injecting a fixture provider or finalizing output.

### Explicit local product execution API

Launch the installed product against the selected database:

```sh
agentown-web --database /absolute/path/product.sqlite --port 8765 --provider anthropic --model YOUR_CONFIGURED_MODEL
```

Provider credentials stay in the server environment. Live provider validation is
currently skipped by user policy; deterministic fixture results are not live evidence.
The existing inspection action remains read-only. After selecting saved ordinary
text, POST `/api/connections/v1/inspect-work` with `{"task_id":"<canonical UUID>"}`
and display its saved input, attempts and readiness. Preflight is advisory and
never grants execution authority.

A separate action, POST `/api/connections/v1/execute-work`, accepts exactly:

```json
{"task_id":"11111111-1111-4111-8111-111111111111","expected_runs":0,"resubmission_consent":false}
```

`task_id` must be canonical lowercase UUID text, `expected_runs` a JSON integer
(not boolean) at least zero observed in fresh inspection, and
`resubmission_consent` an explicit JSON boolean. Resubmission requires fresh user
consent (`true`); initial execution can use `false`. Extra fields, including
credentials, provider, model and source overrides, are rejected with HTTP 400.
The API requires same-origin JSON at `http://127.0.0.1:8765` (Origin header and
matching Host); oversized requests return 413 and origin violations return 403.

Valid requests return HTTP 200 with `schema_version: 1`, `requested_task_id`,
`status`, `code`, `execution` and `recovery`. Status/code pairs are:

| Status | Code | Meaning |
| --- | --- | --- |
| completed | execution_recorded | A finalized execution record was received; inspect its output/error. |
| rejected | configuration_unavailable | Configure provider/model in the server environment/launch and restart. |
| rejected | execution_busy | A local request is running or shutting down. |
| rejected | admission_rejected | Rust rejected admission; refresh assignment, attempts and consent. |
| unavailable | transport_unavailable | No execution dispatch was attempted. Check installation. |
| uncertain | delivery_uncertain | Dispatch may have reached MCP. Never automatically replay. |

`execution` is null except for completed responses, where it contains
`schema_version`, `run_id`, `input`, `provider`, `model`, `deadline_unix_ms`,
`output`, `error`, and `quality: "unverified"`. A recorded provider failure is a
completed transport operation with an error, not a successful provider result or
quality approval. Admission errors are deliberately grouped because existing MCP
errors do not reliably distinguish stale count, active attempt and consent.

The application uses a separate typed execution port and starts the installed
local MCP server with the same absolute database. It calls only
`execute_text_work_v1`, with configured provider/model and the fixed declared
source `agentown-local-product`. This source is honest, untrusted caller metadata,
not authentication or proof of an external client connection. Rust retains all
admission, concurrency and Run/result/source persistence authority.

For timeout, disconnect, malformed reply, cancellation or service interruption,
keep the database and inspect selected work again. A missing HTTP reply is not
proof of failed execution. Read-only inspection does not recover expired leases;
an active/expired attempt must be reconciled before a fresh request. Wait for
the active attempt to finish; for an expired lease explicitly invoke the existing
MCP `get_work_history_v1` with `{"task_id":"<canonical UUID>","read_only":false}`
to let Rust reconcile it, then refresh read-only inspection. Review the latest persisted result and
attempt count, then obtain fresh explicit consent before resubmitting. Neither
adapter nor API automatically retries or resumes the costly call. The product screen exposes this boundary through explicit inspection, a one-request
consent checkbox and Execute once through local MCP. Every returned response,
including rejection, consumes the inspection for execution purposes. Explicitly
inspect again before granting fresh consent. The screen uses the observed
`expected_runs` and sends `resubmission_consent: true` only after fresh resubmission
consent for a nonzero count. Client timeout covers 75 seconds and does not prove
remote cancellation. See [screen steps](local-screen.md#execute-selected-saved-work-through-local-mcp).

Deterministic implementation evidence for this boundary: scoped execution plus
inspection checks passed (129 cases), followed by execution plus web checks
(55 cases, including additional request/timeout/configuration coverage). These
used the available Python 3.13 environment/native extension and a temporary source
overlay; web checks reused existing built assets, without a frontend/native
rebuild. Persisted fixture inspection found two finalized attempts/results for
initial execution plus consented resubmission, one attempt/result from racing MCP
processes, one saved result after lost delivery, and zero attempts for missing
server configuration. Saved execution sources were `agentown-local-product`.
The CLI reached startup on port 8765 but binding failed because it was occupied;
a separate temporary-database launch on port 18765 returned HTTP 200 for state
and `configuration_unavailable` for execution without settings. No existing
service was changed. Consolidated supervisor checks, fresh installed-package
validation and browser validation are pending; live provider calls were skipped.

### Explicit expired-attempt recovery through local MCP

Start the installed product against a disposable database (no API key or model
is required for recovery):

```sh
agentown-web --database /tmp/agentown-recovery.sqlite --port 8765
```

Use an existing selected Task UUID from that database. Ordinary selected-work
inspection is read-only:

```sh
curl -s http://127.0.0.1:8765/api/connections/v1/inspect-work \
  -H 'Origin: http://127.0.0.1:8765' -H 'Content-Type: application/json' \
  -d '{"task_id":"REPLACE_WITH_CANONICAL_TASK_UUID"}'
```

After separately consenting to expired-lease reconciliation, send:

```sh
curl -s http://127.0.0.1:8765/api/connections/v1/reconcile-work \
  -H 'Origin: http://127.0.0.1:8765' -H 'Content-Type: application/json' \
  -d '{"task_id":"REPLACE_WITH_CANONICAL_TASK_UUID","recovery_consent":true}'
```

The endpoint invokes the installed local MCP `get_work_history_v1` operation
with `read_only=false` exactly once. Rust owns expiry and persistent transitions.
Expired execution attempts become finished with `error: interrupted`; live leases
remain active. Recovery creates no Run and performs no provider execution. It is
separate from execution/retry consent and does not require provider configuration.
The current MCP operation takes a database history snapshot and **may reconcile
other expired leases in that snapshot**. The selected Task limits the returned
history, not the mutation scope. Obtain consent with this scope understood.

`status: confirmed`, `code: reconciliation_confirmed` confirms a validated
selected-Task history receipt, not that every attempt was interrupted or that
anything changed. `inspection.attempts` contains the resulting observed state;
`evidence.mutation_scope` is `snapshot_expired_leases`. MCP tool errors remain uncertain: their sanitized category does not establish
whether reconciliation already occurred. Failure before dispatch is
`unavailable/transport_unavailable`. Missing/malformed receipts, timeouts or
transport loss after dispatch are `uncertain/delivery_uncertain`: reconciliation
may already have persisted. Inspect read-only before deciding on a new explicit
request. The adapter never automatically replays. A busy/closing adapter returns
`rejected/recovery_busy`. These operational outcomes use HTTP 200; malformed or
unconsented bodies use 400, oversized bodies 413, and origin violations 403.
No credentials, model, provider, or additional fields are accepted.

Deterministic coverage, including installed `agentown-web` and its installed MCP
child against a temporary database:

```sh
uv run --directory python --locked python -m pytest tests/test_selected_work_recovery.py
```

The installed-process test uses the shared fresh-wheel fixture. It records
`selected-work-recovery.json` under `LLM_ENGINE_PACKAGE_EVIDENCE` when set (or
its temporary directory), containing persisted before/after history and the API
receipt. Fixtures seed historical expired attempts without waiting for expiry;
a live attempt stays active. Provider construction is forbidden by the
stdio-fixture tests, and no real provider calls are used. Building the wheel
requires the repository's normal native/frontend build prerequisites.

### Product-screen recovery demo

For a disposable deterministic database, reuse `seed` in
`python/tests/test_selected_work_recovery.py`: it creates two expired attempts
with historical timestamps (1000, deadline 121000) and one live attempt. Run this
from a configured product development environment with native bindings available:

```sh
uv run --directory python --locked python -c 'import runpy; from pathlib import Path; seed = runpy.run_path("tests/test_selected_work_recovery.py")["seed"]; print(seed(Path("/tmp/agentown-recovery.sqlite")))'
agentown-web --database /tmp/agentown-recovery.sqlite --port 8765
```

Use a fresh disposable filename each time. The printed IDs identify selected
expired work, other expired work, and live work in that order. At
`http://127.0.0.1:8765`, select the first work, inspect through local MCP, review
recovery scope, check the explicit authorization and reconcile once. The receipt
shows interrupted attempts; selecting and inspecting the live work shows its
active lease until its actual deadline. No provider call is needed. Inspect again
before giving fresh execution consent. For an uncertain-delivery demonstration,
interrupt the local server after submitting; the screen retains selected-work
recovery access and never automatically resends. A lost response alone cannot
prove whether reconciliation persisted.
