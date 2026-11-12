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
