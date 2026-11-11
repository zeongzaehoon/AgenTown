import asyncio

from .base import ProviderFailure


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str):
        if not api_key.strip():
            raise ValueError("Set ANTHROPIC_API_KEY intentionally in your runtime environment.")
        self._api_key = api_key

    async def generate(self, text: str, model: str) -> str:
        import anthropic

        try:
            async with anthropic.AsyncAnthropic(
                api_key=self._api_key, base_url="https://api.anthropic.com",
                timeout=45.0, max_retries=0,
            ) as client:
                async with asyncio.timeout(60):
                    response = await client.messages.create(
                        model=model, max_tokens=2048,
                        messages=[{"role": "user", "content": text}],
                    )
            if response.stop_reason == "max_tokens":
                raise ProviderFailure("output_limit")
            if response.stop_reason == "refusal":
                raise ProviderFailure("refusal")
            if response.stop_reason != "end_turn" or not isinstance(response.content, list):
                raise ProviderFailure("malformed_response")
            parts = []
            for block in response.content:
                if block.type != "text" or not isinstance(block.text, str):
                    raise ProviderFailure("malformed_response")
                parts.append(block.text)
            output = "\n".join(parts)
            if not output.strip():
                raise ProviderFailure("empty_response")
            return output.replace(self._api_key, "[redacted]")
        except ProviderFailure:
            raise
        except anthropic.AuthenticationError:
            raise ProviderFailure("authentication") from None
        except anthropic.RateLimitError:
            raise ProviderFailure("rate_limit") from None
        except (TimeoutError, anthropic.APITimeoutError):
            raise ProviderFailure("timeout") from None
        except anthropic.APIConnectionError:
            raise ProviderFailure("network") from None
        except (AttributeError, TypeError):
            raise ProviderFailure("malformed_response") from None
        except Exception:
            raise ProviderFailure("provider_error") from None

