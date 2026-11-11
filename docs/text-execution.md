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
