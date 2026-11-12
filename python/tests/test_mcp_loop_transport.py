"""In-process MCP contract checks; no provider calls or native ownership required."""
import asyncio

from fastmcp import Client
import pytest

from llm_engine import _native
from llm_engine.mcp_server import create_server


def test_discovery_preview_and_poll_never_construct_execution_service(tmp_path, monkeypatch):
    import llm_engine.mcp_server as module

    db = str(tmp_path / 'loops.sqlite')
    employee = _native.create_agent(db, 'Writer')[0]
    work = _native.create_assigned_work(db, 'Saved input', employee)[0]
    policy = _native.create_loop(db, 'Bounded', work, 2, 60)
    _native.set_loop_enabled(db, policy['id'], True)

    def forbidden(*args, **kwargs):
        raise AssertionError('inspection/preview constructed execution machinery')

    monkeypatch.setattr(module, 'LoopService', forbidden)
    server = create_server(db, provider_factory=forbidden)

    async def scenario():
        async with Client(server) as client:
            tools = {tool.name: tool for tool in await client.list_tools()}
            assert tools['preview_loop_v1'].annotations.readOnlyHint is False
            assert tools['preview_loop_v1'].annotations.openWorldHint is False
            assert tools['start_loop_v1'].annotations.openWorldHint is True
            assert tools['stop_loop_v1'].annotations.idempotentHint is True
            preview = await client.call_tool('preview_loop_v1', {'policy_id': policy['id']})
            assert preview.structured_content['input'] == 'Saved input'
            assert preview.structured_content['max_iterations'] == 2
            assert preview.structured_content['expected_runs'] == 0
            inspection = await client.call_tool('inspect_loop_sessions_v1', {})
            assert inspection.structured_content == {'schema_version': 1, 'sessions': [], 'attempts': []}

    asyncio.run(scenario())


def test_start_rejects_boolean_count_and_oversized_utf8_source(tmp_path):
    from fastmcp.exceptions import ToolError

    db = str(tmp_path / 'loops.sqlite')
    _native.create_agent(db, 'Writer')
    calls = []
    server = create_server(db, provider_factory=lambda *a: calls.append(a))
    payload = {'preview_id': 'opaque', 'expected_runs': 0, 'provider': 'anthropic',
               'model': 'fixture', 'declared_source': 'fixture'}

    async def scenario():
        async with Client(server) as client:
            with pytest.raises(ToolError):
                await client.call_tool('start_loop_v1', {**payload, 'expected_runs': True})
            with pytest.raises(ToolError):
                await client.call_tool('start_loop_v1', {**payload, 'declared_source': '한' * 30})
        assert calls == []

    asyncio.run(scenario())
