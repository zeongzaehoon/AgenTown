"""Provider-neutral async I/O port; Rust admits and finalizes every attempt."""
import asyncio

from . import _native
from .providers import runtime_secrets, redact


# Re-export the original public adapter names for existing integrations.
from .providers import (AnthropicProvider, ProviderFailure, TextProvider,
                        configured_provider)


def record(row):
    result = dict(zip(("run_id", "input", "provider", "model", "deadline_unix_ms", "output", "error"), row, strict=True))
    result["schema_version"] = 1
    result["quality"] = "unverified"
    return result



async def execute_text(database, task, agent, text, model, provider: TextProvider):
    if any(secret in text or secret in model for secret in runtime_secrets()):
        raise ValueError("Remove configured credentials from the input and model.")
    row = _native.start_execution(database, task, agent, text, provider.name, model)
    return await finish_text(database, row, provider)


async def finish_text(database, row, provider: TextProvider):
    """Perform only async provider I/O for an already Rust-admitted execution."""
    run = row[0]
    try:
        async with asyncio.timeout(65):
            output = await provider.generate(row[1], row[3])
        if not isinstance(output, str):
            raise ProviderFailure("malformed_response")
        if not output.strip():
            raise ProviderFailure("empty_response")
        if len(output.encode("utf-8")) > 1_000_000:
            raise ProviderFailure("malformed_response")
    except (asyncio.CancelledError, KeyboardInterrupt):
        _native.finish_execution(database, run, None, "interrupted")
        raise
    except TimeoutError:
        return record(_native.finish_execution(database, run, None, "timeout"))
    except ProviderFailure as exc:
        return record(_native.finish_execution(database, run, None, exc.code))
    except Exception:
        return record(_native.finish_execution(database, run, None, "provider_error"))
    return record(_native.finish_execution(database, run, redact(output, runtime_secrets()), None))
