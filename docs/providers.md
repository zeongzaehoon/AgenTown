# Text provider SDKs

The CLI and web server support `--provider anthropic|openai|bedrock|xai`.
The default remains Anthropic. Supply `--model` explicitly; there is no automatic
model selection or provider fallback. Each attempt records its provider and model.
Restarting with another provider affects subsequent attempts, not historical results.

| Provider | Official Python SDK / operation | Runtime configuration |
| --- | --- | --- |
| `anthropic` | `anthropic.AsyncAnthropic.messages.create` | `ANTHROPIC_API_KEY` |
| `openai` | `openai.AsyncOpenAI.responses.create` | `OPENAI_API_KEY` |
| `bedrock` | `boto3` Bedrock Runtime `converse` | `AWS_REGION` or `AWS_DEFAULT_REGION`; standard AWS IAM credentials, optionally `AWS_PROFILE` |
| `xai` (Grok) | `xai_sdk.AsyncClient.chat.create` + `sample` | `XAI_API_KEY` |

All adapters are in `python/src/llm_engine/providers/`. The existing
`llm_engine.execution` imports remain compatible. Python owns SDK I/O; Rust still
admits execution and atomically persists its terminal result.

## Launch

From the repository root, install the locked dependencies and rebuild the assets:

```sh
uv sync --directory python --locked
npm --prefix frontend ci
npm --prefix frontend run build
uv run --directory python --locked maturin develop --locked
```

Set the selected provider's credentials in the server environment using your usual
secret configuration, then launch one of the following. Replace the uppercase model
placeholder with a model available to your account. API keys do not go in command arguments.

```sh
uv run --directory python --locked agentown-web --database /tmp/work.sqlite3 --provider openai --model OPENAI_MODEL_ID
uv run --directory python --locked agentown-web --database /tmp/work.sqlite3 --provider xai --model GROK_MODEL_ID
uv run --directory python --locked agentown-web --database /tmp/work.sqlite3 --provider bedrock --model BEDROCK_MODEL_OR_INFERENCE_PROFILE_ID
```

Open `http://127.0.0.1:8765`, create an employee, save work and execute it.
On Windows use a database path in an existing writable directory, such as
`C:\Users\YOUR_USER\work.sqlite3`. Bedrock uses the normal boto3 IAM credential
chain at execution time, including environment credentials, configured profiles,
and workload roles. The region must be explicitly supplied through the environment.
Bedrock API-key-only authentication is not supported by this adapter.
Missing/expired AWS credentials and access denial become an `authentication` failure;
configure IAM access to the chosen model and retry explicitly.

The CLI uses the same provider selection:

```sh
uv run --directory python --locked agentown --database /tmp/work.sqlite3 --json work execute TASK_ID --agent AGENT_ID --input-file request.txt --provider openai --model OPENAI_MODEL_ID
```

## Boundaries and validation

This slice supports one text request and a complete text response. Streaming, tool
execution, images and agent role prompts are not implemented here. Generation is
limited to 2,048 output tokens (including reasoning budget where the API counts it).
A truncated response produces `output_limit`; partial text is not saved as success.
OpenAI reasoning metadata is ignored while final text is retained. Bedrock non-text
content blocks are rejected. xAI's normal stop does not itself establish whether
natural-language output is a refusal; results remain unverified.

SDK automatic retries are disabled for every provider. SDK request timeouts are
45 seconds, with the shared execution timeout at 65 seconds. Bedrock's synchronous
socket runs in an I/O worker (5-second connect / 45-second read timeout). Cancelling
its waiter cannot terminate that socket call; the worker can finish later but has
no database access and cannot overwrite the recorded interruption. Timeout/read
limits are not a guarantee that the remote provider stopped processing a request.
Retries always require an explicit user action.

Raw SDK exceptions are not persisted. Known runtime environment credentials are
blocked from new input and redacted from output; resolved AWS credential values are
also redacted from Bedrock output. Credentials from a profile are resolved only by
the AWS SDK at runtime, not searched by development tests.

`python/tests/test_providers.py` exercises request shapes, error mapping, redaction,
provider selection, persistent HTTP execution/restart, replay rejection and late
Bedrock-worker completion. AWS request shapes use the installed botocore Stubber.
These are offline tests with synthetic credentials. Actual authenticated requests
and supervisor browser verification for this change remain outstanding.

## SDK references checked 2026-09-13

- [OpenAI SDK](https://developers.openai.com/api/docs/libraries): use the official async client and Responses API.
- [Bedrock Converse](https://docs.aws.amazon.com/boto3/latest/reference/services/bedrock-runtime/client/converse.html): shared message/content structure and explicit stop reasons.
- [xAI async SDK](https://docs.x.ai/developers/advanced-api-usage/async): create chat, append a user message, await sampling.

The installed SDK source was also inspected for xAI channel retry overrides and
finish-reason enums. Resolved versions are recorded in `python/uv.lock`.
