"""OpenAI Responses API, text only; no SDK retry or server-side storage."""
import openai

from .base import ProviderFailure


class OpenAIProvider:
    name = 'openai'

    def __init__(self, api_key: str):
        if not api_key.strip():
            raise ValueError('Set OPENAI_API_KEY in the server environment.')
        self._api_key = api_key

    async def generate(self, text: str, model: str) -> str:
        try:
            async with openai.AsyncOpenAI(api_key=self._api_key,
                    base_url='https://api.openai.com/v1', max_retries=0, timeout=45) as client:
                response = await client.responses.create(
                    model=model, input=text, max_output_tokens=2048, store=False)
            if response.status == 'incomplete':
                reason = getattr(response.incomplete_details, 'reason', None)
                raise ProviderFailure('output_limit' if reason == 'max_output_tokens' else
                                      'refusal' if reason == 'content_filter' else 'malformed_response')
            if response.status != 'completed':
                raise ProviderFailure('provider_error')
            parts = []
            for item in response.output:
                if item.type == 'reasoning':
                    continue
                if item.type != 'message' or item.role != 'assistant' or item.status != 'completed':
                    raise ProviderFailure('malformed_response')
                for block in item.content:
                    if block.type == 'refusal':
                        raise ProviderFailure('refusal')
                    if block.type != 'output_text' or not isinstance(block.text, str):
                        raise ProviderFailure('malformed_response')
                    parts.append(block.text)
            output = '\n'.join(parts)
            if not output.strip():
                raise ProviderFailure('empty_response')
            return output.replace(self._api_key, '[redacted]')
        except ProviderFailure:
            raise
        except (openai.AuthenticationError, openai.PermissionDeniedError):
            raise ProviderFailure('authentication') from None
        except openai.RateLimitError:
            raise ProviderFailure('rate_limit') from None
        except (TimeoutError, openai.APITimeoutError):
            raise ProviderFailure('timeout') from None
        except openai.APIConnectionError:
            raise ProviderFailure('network') from None
        except (AttributeError, TypeError, ValueError):
            raise ProviderFailure('malformed_response') from None
        except Exception:
            raise ProviderFailure('provider_error') from None
