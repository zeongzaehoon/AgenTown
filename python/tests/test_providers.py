"""Offline SDK contracts and persisted multi-provider HTTP execution."""
import asyncio
from types import SimpleNamespace as Obj
from unittest.mock import AsyncMock

import boto3
import grpc
import openai
import pytest
import xai_sdk
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.cli import parser
from llm_engine.execution import execute_text
from llm_engine.providers import configured_provider
from llm_engine.providers.openai import OpenAIProvider
from llm_engine.providers.xai import XAIProvider
from llm_engine.providers.bedrock import BedrockProvider
from llm_engine.web import create_app


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for key in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'AWS_REGION',
                'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
                'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('AWS_EC2_METADATA_DISABLED', 'true')


def sdk_client(monkeypatch, module, attr, response):
    calls = []
    class Client:
        def __init__(self, **kw):
            calls.append(kw)
            self.responses = self.chat = self
        async def __aenter__(self): return self
        async def __aexit__(self, *args): calls.append('closed')
        async def create_response(self, **kw):
            calls.append(kw)
            if isinstance(response, Exception): raise response
            return response
        def create(self, **kw):
            if module is openai: return self.create_response(**kw)
            calls.append(kw)
            return self
        def append(self, message): calls.append(message)
        async def sample(self):
            if isinstance(response, Exception): raise response
            return response
    monkeypatch.setattr(module, attr, Client)
    return calls


def openai_response(**kw):
    return Obj(**({'status': 'completed', 'output': [Obj(type='message', role='assistant',
        status='completed', content=[Obj(type='output_text', text='Full answer SECRET')])]} | kw))


@pytest.mark.parametrize('name,key', [('openai', 'OPENAI_API_KEY'), ('xai', 'XAI_API_KEY')])
def test_selection_missing_key_and_cli(monkeypatch, name, key):
    with pytest.raises(ValueError, match=key): configured_provider('model', name)
    monkeypatch.setenv(key, 'SECRET')
    assert configured_provider('model', name).name == name
    args = parser().parse_args(['--database', 'db', 'work', 'execute', 'task', '--agent', 'agent',
        '--input-file', 'input.txt', '--model', 'model', '--provider', name])
    assert args.provider == name


def test_bedrock_region_preflight(monkeypatch):
    with pytest.raises(ValueError, match='AWS_REGION'): configured_provider('model', 'bedrock')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    monkeypatch.setenv('AWS_PROFILE', 'intentional-profile')
    provider = configured_provider('model', 'bedrock')
    assert provider.region == 'us-east-1' and provider.profile == 'intentional-profile'
    with pytest.raises(ValueError, match='Choose'): configured_provider('model', 'unknown')


@pytest.mark.parametrize('name', ['openai', 'xai', 'bedrock'])
def test_web_configuration_identifies_selected_provider(tmp_path, name):
    with TestClient(create_app(tmp_path / 'db', 'model', provider_name=name),
                    base_url='http://127.0.0.1:8765') as client:
        state = client.post('/api/state', json={}, headers={'Origin': 'http://127.0.0.1:8765'}).json()
        assert state['provider'] == name and state['configuration']


@pytest.mark.parametrize('response,error', [
    (openai_response(), None),
    (openai_response(status='incomplete', incomplete_details=Obj(reason='max_output_tokens')), 'output_limit'),
    (openai_response(output=[Obj(type='message', role='assistant', status='completed', content=[Obj(type='refusal')])]), 'refusal'),
    (openai_response(output=[]), 'empty_response'),
    (openai_response(output=[Obj(type='function_call')]), 'malformed_response'),
    (Obj(), 'malformed_response'),
    (TimeoutError('SECRET'), 'timeout'),
    (RuntimeError('SECRET'), 'provider_error'),
])
def test_openai_contract_and_persistence(monkeypatch, tmp_path, response, error):
    calls = sdk_client(monkeypatch, openai, 'AsyncOpenAI', response)
    db = str(tmp_path / 'db'); agent = _native.create_agent(db, 'Writer')[0]
    task = _native.create_task(db, 'Work')[0]; _native.assign_task(db, task, [agent])
    result = asyncio.run(execute_text(db, task, agent, 'Input', 'model', OpenAIProvider('SECRET')))
    assert result['error'] == error
    assert result['output'] == (None if error else 'Full answer [redacted]')
    assert result['provider'] == 'openai'
    assert calls[0]['max_retries'] == 0 and calls[0]['base_url'] == 'https://api.openai.com/v1'
    assert calls[1] == {'model': 'model', 'input': 'Input', 'max_output_tokens': 2048, 'store': False}
    assert calls[-1] == 'closed'
    assert _native.show_execution(db, result['run_id'])[5:] == (result['output'], error)


@pytest.mark.parametrize('reason,error', [('REASON_STOP', None), ('REASON_MAX_LEN', 'output_limit'),
    ('REASON_MAX_CONTEXT', 'output_limit'), ('REASON_TIME_LIMIT', 'timeout'),
    ('REASON_TOOL_CALLS', 'malformed_response')])
def test_xai_contract(monkeypatch, reason, error):
    response = Obj(finish_reason=reason, content='Answer SECRET', tool_calls=[])
    calls = sdk_client(monkeypatch, xai_sdk, 'AsyncClient', response)
    provider = XAIProvider('SECRET')
    if error:
        from llm_engine.providers import ProviderFailure
        with pytest.raises(ProviderFailure, match=error): asyncio.run(provider.generate('Input', 'model'))
    else:
        assert asyncio.run(provider.generate('Input', 'model')) == 'Answer [redacted]'
    assert calls[0]['channel_options'] == [('grpc.enable_retries', 0)]
    assert calls[1] == {'model': 'model', 'max_tokens': 2048}
    assert calls[2].content[0].text == 'Input'
    assert calls[-1] == 'closed'


@pytest.mark.parametrize('code,error', [(grpc.StatusCode.UNAUTHENTICATED, 'authentication'),
    (grpc.StatusCode.RESOURCE_EXHAUSTED, 'rate_limit'), (grpc.StatusCode.DEADLINE_EXCEEDED, 'timeout'),
    (grpc.StatusCode.UNAVAILABLE, 'network')])
def test_xai_errors(monkeypatch, code, error):
    class Failure(grpc.RpcError):
        def code(self): return code
    sdk_client(monkeypatch, xai_sdk, 'AsyncClient', Failure('SECRET'))
    from llm_engine.providers import ProviderFailure
    with pytest.raises(ProviderFailure, match=error): asyncio.run(XAIProvider('SECRET').generate('Input', 'model'))


@pytest.mark.parametrize('reason,error', [('end_turn', None), ('max_tokens', 'output_limit'),
    ('content_filtered', 'refusal'), ('tool_use', 'malformed_response')])
def test_bedrock_real_sdk_request_shape(monkeypatch, reason, error):
    # Explicit synthetic credentials: never consult a profile or metadata service.
    session = boto3.Session(region_name='us-east-1', aws_access_key_id='TESTACCESS', aws_secret_access_key='SECRET')
    client = session.client('bedrock-runtime')
    captured = []
    def make_client(service, **kw):
        captured.append(kw['config'])
        assert service == 'bedrock-runtime'
        return client
    monkeypatch.setattr(session, 'client', make_client)
    monkeypatch.setattr(boto3, 'Session', lambda **kw: session)
    with Stubber(client) as stub:
        stub.add_response('converse', {'stopReason': reason,
            'output': {'message': {'role': 'assistant', 'content': [{'text': 'Answer SECRET'}]}},
            'usage': {'inputTokens': 1, 'outputTokens': 2, 'totalTokens': 3},
            'metrics': {'latencyMs': 1}},
            {'modelId': 'model', 'messages': [{'role': 'user', 'content': [{'text': 'Input'}]}],
             'inferenceConfig': {'maxTokens': 2048}})
        from llm_engine.providers import ProviderFailure
        if error:
            with pytest.raises(ProviderFailure, match=error):
                asyncio.run(BedrockProvider('us-east-1').generate('Input', 'model'))
        else:
            assert asyncio.run(BedrockProvider('us-east-1').generate('Input', 'model')) == 'Answer [redacted]'
        stub.assert_no_pending_responses()
    assert captured[0].retries['total_max_attempts'] == 1
    assert captured[0].read_timeout == 45


@pytest.mark.parametrize('name', ['openai', 'xai', 'bedrock'])
def test_selected_web_execution_and_restart(monkeypatch, tmp_path, name):
    monkeypatch.setenv('OPENAI_API_KEY', 'OPENAI_SECRET')
    monkeypatch.setenv('XAI_API_KEY', 'XAI_SECRET')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    cls = {'openai': OpenAIProvider, 'xai': XAIProvider, 'bedrock': BedrockProvider}[name]
    generate = AsyncMock(return_value='Answer OPENAI_SECRET XAI_SECRET')
    monkeypatch.setattr(cls, 'generate', generate)
    db = tmp_path / 'db'; origin = 'http://127.0.0.1:8765'; headers = {'Origin': origin}
    with TestClient(create_app(db, 'chosen-model', provider_name=name), base_url=origin) as client:
        employee = client.post('/api/employees', json={'name': 'Writer'}, headers=headers).json()['id']
        assert client.post('/api/employees', json={'name': 'OPENAI_SECRET'}, headers=headers).status_code == 400
        task = client.post('/api/work', json={'input': 'Input', 'employee': employee}, headers=headers).json()['id']
        path = f'/api/work/{task}/execute'
        result = client.post(path, json={'expected_runs': 0}, headers=headers).json()
        assert result['output'] == 'Answer [redacted] [redacted]' and result['provider'] == name
        assert client.post(path, json={'expected_runs': 0}, headers=headers).status_code == 409
    with TestClient(create_app(db, 'chosen-model', provider_name=name), base_url=origin) as client:
        attempts = client.post('/api/state', json={}, headers=headers).json()['work'][0]['attempts']
        assert len(attempts) == 1 and attempts[0]['provider'] == name
    assert generate.await_count == 1
    assert b'OPENAI_SECRET' not in db.read_bytes() and b'XAI_SECRET' not in db.read_bytes()


@pytest.mark.parametrize('kind,status,error', [(openai.AuthenticationError, 401, 'authentication'),
    (openai.PermissionDeniedError, 403, 'authentication'), (openai.RateLimitError, 429, 'rate_limit')])
def test_openai_sdk_errors(monkeypatch, kind, status, error):
    import httpx
    from llm_engine.providers import ProviderFailure
    response = httpx.Response(status, request=httpx.Request('POST', 'https://api.openai.com/v1/responses'))
    sdk_client(monkeypatch, openai, 'AsyncOpenAI', kind('SECRET', response=response, body=None))
    with pytest.raises(ProviderFailure, match=error): asyncio.run(OpenAIProvider('SECRET').generate('Input', 'model'))


@pytest.mark.parametrize('code,error', [('AccessDeniedException', 'authentication'),
    ('ThrottlingException', 'rate_limit'), ('ModelTimeoutException', 'timeout'),
    ('ServiceUnavailableException', 'network'), ('ValidationException', 'provider_error')])
def test_bedrock_sdk_errors(monkeypatch, code, error):
    from llm_engine.providers import ProviderFailure
    class Client:
        def converse(self, **kw):
            raise ClientError({'Error': {'Code': code, 'Message': 'SECRET'}}, 'Converse')
        def close(self): pass
    session = Obj(get_credentials=lambda: Obj(get_frozen_credentials=lambda: Obj(
        access_key='ACCESS', secret_key='SECRET', token=None)), client=lambda *a, **kw: Client())
    monkeypatch.setattr(boto3, 'Session', lambda **kw: session)
    with pytest.raises(ProviderFailure, match=error):
        asyncio.run(BedrockProvider('us-east-1').generate('Input', 'model'))


def test_bedrock_worker_cancellation_cannot_overwrite_interruption(monkeypatch, tmp_path):
    import threading
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    def worker(self, text, model):
        entered.set()
        assert release.wait(5)
        finished.set()
        return 'Late answer'
    monkeypatch.setattr(BedrockProvider, '_generate', worker)
    db = str(tmp_path / 'db'); agent = _native.create_agent(db, 'Writer')[0]
    task = _native.create_task(db, 'Work')[0]; _native.assign_task(db, task, [agent])
    async def scenario():
        pending = asyncio.create_task(execute_text(db, task, agent, 'Input', 'model', BedrockProvider('us-east-1')))
        try:
            for _ in range(100):
                if entered.is_set(): break
                await asyncio.sleep(.01)
            assert entered.is_set()
            pending.cancel()
            with pytest.raises(asyncio.CancelledError): await pending
        finally:
            release.set()
    asyncio.run(scenario())
    assert finished.is_set()
    runs = _native.list_runs(db, task)
    assert len(runs) == 1 and runs[0][7] == 'interruption'
    assert _native.show_execution(db, runs[0][0])[5:] == (None, 'interrupted')


def test_openai_real_sdk_transport(monkeypatch):
    import httpx
    import json
    real_client = openai.AsyncOpenAI
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={'id': 'resp_test', 'object': 'response',
            'created_at': 1, 'model': 'model', 'status': 'completed',
            'output': [{'id': 'msg_test', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                        'content': [{'type': 'output_text', 'text': 'Actual SDK parsing', 'annotations': []}]}]})
    monkeypatch.setattr(openai, 'AsyncOpenAI', lambda **kw: real_client(**kw,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))))
    assert asyncio.run(OpenAIProvider('TESTKEY').generate('Input', 'model')) == 'Actual SDK parsing'
    assert len(requests) == 1
    assert str(requests[0].url) == 'https://api.openai.com/v1/responses'
    assert json.loads(requests[0].content)['store'] is False


def test_xai_real_proto_response(monkeypatch):
    from xai_sdk.chat import Response
    from xai_sdk.proto import chat_pb2, sample_pb2
    response = Response(chat_pb2.GetChatCompletionResponse(outputs=[chat_pb2.CompletionOutput(
        index=0, finish_reason=sample_pb2.REASON_STOP,
        message=chat_pb2.CompletionMessage(role=chat_pb2.ROLE_ASSISTANT, content='Actual SDK parsing'))]), 0)
    sdk_client(monkeypatch, xai_sdk, 'AsyncClient', response)
    assert asyncio.run(XAIProvider('TESTKEY').generate('Input', 'model')) == 'Actual SDK parsing'
