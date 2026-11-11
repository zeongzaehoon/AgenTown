"""Deterministic SDK contract and persisted execution tests; no live requests."""
import asyncio
import json
import os
import subprocess
import sys
from types import SimpleNamespace as Obj

import anthropic
import pytest

from llm_engine import _native
from llm_engine.execution import AnthropicProvider, ProviderFailure, configured_provider, execute_text


@pytest.fixture
def assigned(tmp_path):
    db = str(tmp_path / 'product.db')
    a = _native.create_agent(db, 'Writer')[0]
    t = _native.create_task(db, 'Summarize')[0]
    _native.assign_task(db, t, [a])
    return db, t, a


def test_configuration(monkeypatch, assigned):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    with pytest.raises(ValueError, match='explicit'):
        configured_provider('')
    with pytest.raises(ValueError, match='ANTHROPIC_API_KEY'):
        configured_provider('chosen-model')
    assert _native.list_runs(assigned[0], assigned[1]) == []


def mock_sdk(monkeypatch, response):
    calls = []
    class Client:
        def __init__(self, **kwargs):
            assert kwargs['max_retries'] == 0
            assert kwargs['timeout'] == 45
            assert kwargs['base_url'] == 'https://api.anthropic.com'
            self.messages = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def create(self, **kwargs):
            calls.append(kwargs)
            if isinstance(response, Exception): raise response
            return response
    monkeypatch.setattr(anthropic, 'AsyncAnthropic', Client)
    return calls


@pytest.mark.parametrize(('response', 'error'), [
    (Obj(stop_reason='end_turn', content=[]), 'empty_response'),
    (Obj(stop_reason='end_turn', content=[Obj(type='text', text=' ')]), 'empty_response'),
    (Obj(stop_reason='end_turn', content=[Obj(type='tool_use')]), 'malformed_response'),
    (Obj(stop_reason='max_tokens', content=[]), 'output_limit'),
    (Obj(stop_reason='max_tokens', content=[Obj(type='text', text='DO-NOT-RETAIN secret')]), 'output_limit'),
    (Obj(stop_reason='max_tokens'), 'output_limit'),
    (Obj(stop_reason='max_tokens', content=None), 'output_limit'),
    (Obj(stop_reason='refusal', content=[]), 'refusal'),
    (Obj(stop_reason='refusal', content=[Obj(type='text', text='DO-NOT-RETAIN secret')]), 'refusal'),
    (Obj(stop_reason='end_turn', content=None), 'malformed_response'),
    (Obj(stop_reason='stop_sequence', content=[Obj(type='text', text='DO-NOT-RETAIN')]), 'malformed_response'),
    (Obj(), 'malformed_response'),
    (RuntimeError('DO-NOT-RETAIN'), 'provider_error'),
    (TimeoutError('DO-NOT-RETAIN'), 'timeout'),
])
def test_malformed_and_errors(monkeypatch, assigned, response, error):
    calls = mock_sdk(monkeypatch, response)
    result = asyncio.run(execute_text(*assigned, 'Summarize this.', 'explicit-model', AnthropicProvider('secret')))
    assert result['error'] == error
    assert len(calls) == 1
    assert calls[0]['max_tokens'] == 2048
    assert result['output'] is None
    assert 'DO-NOT-RETAIN' not in json.dumps(result)
    assert _native.show_run(assigned[0], result['run_id'])[7] == 'failure'


@pytest.mark.parametrize(('kind', 'code', 'status'), [
    (anthropic.AuthenticationError, 'authentication', 401),
    (anthropic.RateLimitError, 'rate_limit', 429),
])
def test_http_failures(monkeypatch, assigned, kind, code, status):
    # SDK v1 uses httpx2; the error constructor only requires a response contract.
    import httpx2
    response = httpx2.Response(status, request=httpx2.Request('POST', 'https://api.anthropic.com/v1/messages'))
    calls = mock_sdk(monkeypatch, kind('SECRET exception', response=response, body={'key': 'SECRET'}))
    result = asyncio.run(execute_text(*assigned, 'Input', 'model', AnthropicProvider('SECRET')))
    assert result['error'] == code and len(calls) == 1
    assert 'SECRET' not in json.dumps(result)


def test_success_restart_cli_and_retry(monkeypatch, assigned):
    calls = mock_sdk(monkeypatch, Obj(stop_reason='end_turn', content=[Obj(type='text', text='Summary. SECRET')]))
    first = asyncio.run(execute_text(*assigned, 'Summarize: A meeting was held.', 'model', AnthropicProvider('SECRET')))
    assert first['output'] == 'Summary. [redacted]'
    db, task, agent = assigned
    result = subprocess.run([sys.executable, '-m', 'llm_engine', '--database', db, '--json', 'work', 'show', first['run_id']], capture_output=True, text=True, check=True)
    shown = json.loads(result.stdout)
    assert shown['output'] == first['output'] and shown['quality'] == 'unverified'
    assert shown['run']['task_id'] == task
    assert _native.show_task(db, task)[2] == 'pending'
    second = asyncio.run(execute_text(*assigned, 'Draft another.', 'model', AnthropicProvider('SECRET')))
    assert second['run_id'] != first['run_id'] and len(calls) == 2
    assert len(_native.list_runs(db, task)) == 2


def test_duplicate_and_cancellation(assigned):
    class Waiting:
        name = 'test-fixture'
        calls = 0
        async def generate(self, text, model):
            self.calls += 1
            await asyncio.Event().wait()
    async def scenario():
        provider = Waiting()
        pending = asyncio.create_task(execute_text(*assigned, 'Input', 'fixture', provider))
        await asyncio.sleep(0)
        with pytest.raises(ValueError):
            await execute_text(*assigned, 'Input', 'fixture', provider)
        assert provider.calls == 1
        pending.cancel()
        with pytest.raises(asyncio.CancelledError): await pending
    asyncio.run(scenario())
    runs = _native.list_runs(assigned[0], assigned[1])
    assert len(runs) == 1 and runs[0][7] == 'interruption'
    assert _native.show_execution(assigned[0], runs[0][0])[6] == 'interrupted'
    with pytest.raises(ValueError):
        _native.finish_execution(assigned[0], runs[0][0], 'late output', None)


def test_killed_process_retains_attempt_without_resubmitting(assigned):
    db, task, agent = assigned
    script = '''
import asyncio, sys
from llm_engine.execution import execute_text
class Waiting:
    name = 'test-fixture'
    async def generate(self, text, model):
        print('provider-entered', flush=True)
        await asyncio.Event().wait()
asyncio.run(execute_text(*sys.argv[1:], 'Input', 'fixture', Waiting()))
'''
    child = subprocess.Popen([sys.executable, '-c', script, db, task, agent], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'provider-entered'
    finally:
        child.kill()
        child.communicate(timeout=10)
    runs = _native.list_runs(db, task)
    assert len(runs) == 1 and runs[0][6] == 'active'
    _native.recover_executions(db)  # live lease remains; recovery never resends
    assert len(_native.list_runs(db, task)) == 1
    with pytest.raises(ValueError):
        _native.start_execution(db, task, agent, 'Input', 'test-fixture', 'fixture')


def test_expired_restart_fixture_recovers_once(assigned):
    """Seed a valid historical attempt; test the real Rust clock without sleeping."""
    import sqlite3
    import uuid
    db, task, agent = assigned
    run = str(uuid.uuid4())
    with sqlite3.connect(db) as conn:
        conn.execute('INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL, NULL)', (run, task, 'text_execution', 'test-fixture', 1000))
        conn.execute('INSERT INTO run_participants VALUES (?, ?)', (run, agent))
        conn.execute('INSERT INTO executions VALUES (?, ?, ?, ?, ?, NULL, NULL)', (run, 'Historical input', 'test-fixture', 'fixture', 121000))
    process = subprocess.run([sys.executable, '-m', 'llm_engine', '--database', db, '--json', 'work', 'show', run], capture_output=True, text=True)
    assert process.returncode == 1
    result = json.loads(process.stdout)
    assert result['error'] == 'interrupted' and result['run']['outcome'] == 'interruption'
    _native.recover_executions(db)
    assert len(_native.list_runs(db, task)) == 1
    with pytest.raises(ValueError):
        _native.finish_execution(db, run, 'late', None)
    retry = _native.start_execution(db, task, agent, 'Historical input', 'test-fixture', 'fixture')
    assert retry[0] != run


def test_network_error(monkeypatch, assigned):
    import httpx2
    mock_sdk(monkeypatch, anthropic.APIConnectionError(request=httpx2.Request('POST', 'https://api.anthropic.com')))
    result = asyncio.run(execute_text(*assigned, 'Input', 'model', AnthropicProvider('SECRET')))
    assert result['error'] == 'network'
