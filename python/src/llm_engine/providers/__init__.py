"""Provider contracts and explicit runtime configuration; no requests at selection."""
import os

from .anthropic import AnthropicProvider
from .base import ProviderFailure, TextProvider

PROVIDERS = ('anthropic', 'openai', 'bedrock', 'xai')
__all__ = ['AnthropicProvider', 'ProviderFailure', 'TextProvider', 'configured_provider', 'PROVIDERS']
SECRET_ENV = ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
              'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
              'AWS_BEARER_TOKEN_BEDROCK')


def runtime_secrets():
    return tuple(value for key in SECRET_ENV if (value := os.environ.get(key)))


def redact(text, secrets):
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, '[redacted]')
    return text


def configured_provider(model, provider='anthropic'):
    if provider not in PROVIDERS:
        raise ValueError('Choose --provider anthropic, openai, bedrock or xai.')
    if not model or not model.strip():
        raise ValueError('Supply an explicit --model available to your provider account.')
    if any(secret in model for secret in runtime_secrets()):
        raise ValueError('Remove configured credentials from the model.')
    if provider == 'anthropic':
        return AnthropicProvider(os.environ.get('ANTHROPIC_API_KEY', ''))
    if provider == 'openai':
        from .openai import OpenAIProvider
        return OpenAIProvider(os.environ.get('OPENAI_API_KEY', ''))
    if provider == 'xai':
        from .xai import XAIProvider
        return XAIProvider(os.environ.get('XAI_API_KEY', ''))
    from .bedrock import BedrockProvider
    return BedrockProvider(os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION', ''),
                           os.environ.get('AWS_PROFILE') or None)
