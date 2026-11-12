"""Test-only stdio process: real MCP and native persistence, deterministic I/O.

Never registered as an installed entry point or selectable production provider.
"""
import asyncio
import sys
from pathlib import Path

from llm_engine.mcp_server import create_server
from llm_engine.providers import ProviderFailure


class FixtureProvider:
    name = "anthropic"

    def __init__(self, dispatch_log=None):
        self.dispatch_log = dispatch_log

    async def generate(self, text, model):
        if self.dispatch_log is not None:
            with self.dispatch_log.open("a") as log:
                log.write("dispatch\n")
        if model == "failure":
            raise ProviderFailure("provider_error")
        if model == "slow":
            await asyncio.sleep(0.5)
        return "Fixture result: " + text


def provider_factory(model, provider):
    if "--forbid-provider" in sys.argv:
        raise AssertionError("Read tools must never construct a provider")
    return FixtureProvider(Path(sys.argv[1] + ".dispatches"))


if __name__ == "__main__":
    if "--inspect-only" in sys.argv:
        from llm_engine import _native
        from llm_engine.loop_execution import LoopService

        def forbidden(*args, **kwargs):
            raise AssertionError("Inspection must not initialize, recover or dispatch")

        LoopService.__init__ = forbidden
        LoopService.initialize = forbidden
        for name in ("recover_loop_sessions", "recover_executions", "history_snapshot", "show_execution",
                     "preview_loop", "start_loop_session", "admit_loop_attempt"):
            setattr(_native, name, forbidden)
    create_server(sys.argv[1], provider_factory=provider_factory).run(
        transport="stdio", show_banner=False)
