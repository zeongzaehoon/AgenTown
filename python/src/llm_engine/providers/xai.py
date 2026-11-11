"""Grok through the official asynchronous xAI gRPC SDK."""
import grpc
import xai_sdk
from xai_sdk.chat import user

from .base import ProviderFailure


class XAIProvider:
    name = 'xai'

    def __init__(self, api_key: str):
        if not api_key.strip():
            raise ValueError('Set XAI_API_KEY in the server environment.')
        self._api_key = api_key

    async def generate(self, text: str, model: str) -> str:
        try:
            async with xai_sdk.AsyncClient(api_key=self._api_key, api_host='api.x.ai',
                    timeout=45, channel_options=[('grpc.enable_retries', 0)]) as client:
                chat = client.chat.create(model=model, max_tokens=2048)
                chat.append(user(text))
                response = await chat.sample()
            if response.finish_reason in ('REASON_MAX_LEN', 'REASON_MAX_CONTEXT'):
                raise ProviderFailure('output_limit')
            if response.finish_reason == 'REASON_TIME_LIMIT':
                raise ProviderFailure('timeout')
            if response.finish_reason != 'REASON_STOP' or response.tool_calls:
                raise ProviderFailure('malformed_response')
            output = response.content
            if not isinstance(output, str):
                raise ProviderFailure('malformed_response')
            if not output.strip():
                raise ProviderFailure('empty_response')
            return output.replace(self._api_key, '[redacted]')
        except ProviderFailure:
            raise
        except grpc.RpcError as exc:
            code = {grpc.StatusCode.UNAUTHENTICATED: 'authentication',
                    grpc.StatusCode.PERMISSION_DENIED: 'authentication',
                    grpc.StatusCode.RESOURCE_EXHAUSTED: 'rate_limit',
                    grpc.StatusCode.DEADLINE_EXCEEDED: 'timeout',
                    grpc.StatusCode.UNAVAILABLE: 'network'}.get(exc.code(), 'provider_error')
            raise ProviderFailure(code) from None
        except TimeoutError:
            raise ProviderFailure('timeout') from None
        except (AttributeError, TypeError, ValueError):
            raise ProviderFailure('malformed_response') from None
        except Exception:
            raise ProviderFailure('provider_error') from None
