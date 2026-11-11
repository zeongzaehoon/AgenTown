"""Bedrock Converse through boto3. The worker performs I/O only, never DB writes."""
from contextlib import closing
import asyncio
import os

import boto3
from botocore.config import Config
from botocore.exceptions import (ClientError, NoCredentialsError, PartialCredentialsError,
                                CredentialRetrievalError, ProfileNotFound,
                                ConnectTimeoutError, ReadTimeoutError, HTTPClientError)

from .base import ProviderFailure


class BedrockProvider:
    name = 'bedrock'

    def __init__(self, region: str, profile: str | None = None):
        if not region.strip():
            raise ValueError('Set AWS_REGION or AWS_DEFAULT_REGION for Bedrock.')
        self.region, self.profile = region, profile

    async def generate(self, text: str, model: str) -> str:
        # A cancelled waiter cannot terminate boto3's socket call. Its bounded worker
        # can finish later, but cannot persist a result or automatically retry.
        return await asyncio.to_thread(self._generate, text, model)

    def _generate(self, text: str, model: str) -> str:
        try:
            session = boto3.Session(region_name=self.region, profile_name=self.profile)
            credentials = session.get_credentials()
            if credentials is None:
                raise ProviderFailure('authentication')
            frozen = credentials.get_frozen_credentials()
            with closing(session.client('bedrock-runtime', config=Config(
                    connect_timeout=5, read_timeout=45,
                    retries={'total_max_attempts': 1, 'mode': 'standard'},
                    ignore_configured_endpoint_urls=True))) as client:
                response = client.converse(modelId=model,
                    messages=[{'role': 'user', 'content': [{'text': text}]}],
                    inferenceConfig={'maxTokens': 2048})
            reason = response['stopReason']
            if reason in ('max_tokens', 'model_context_window_exceeded'):
                raise ProviderFailure('output_limit')
            if reason in ('guardrail_intervened', 'content_filtered'):
                raise ProviderFailure('refusal')
            if reason not in ('end_turn', 'stop_sequence'):
                raise ProviderFailure('malformed_response')
            message = response['output']['message']
            if message['role'] != 'assistant' or not isinstance(message['content'], list):
                raise ProviderFailure('malformed_response')
            parts = []
            for block in message['content']:
                if set(block) != {'text'} or not isinstance(block['text'], str):
                    raise ProviderFailure('malformed_response')
                parts.append(block['text'])
            output = '\n'.join(parts)
            if not output.strip():
                raise ProviderFailure('empty_response')
            for secret in (frozen.access_key, frozen.secret_key, frozen.token,
                           os.environ.get('AWS_BEARER_TOKEN_BEDROCK')):
                if secret:
                    output = output.replace(secret, '[redacted]')
            return output
        except ProviderFailure:
            raise
        except (NoCredentialsError, PartialCredentialsError, CredentialRetrievalError, ProfileNotFound):
            raise ProviderFailure('authentication') from None
        except ClientError as exc:
            code = exc.response.get('Error', {}).get('Code')
            mapped = {'AccessDeniedException': 'authentication', 'UnrecognizedClientException': 'authentication',
                      'ExpiredTokenException': 'authentication', 'InvalidSignatureException': 'authentication',
                      'ThrottlingException': 'rate_limit', 'ModelTimeoutException': 'timeout',
                      'ServiceUnavailableException': 'network'}.get(code, 'provider_error')
            raise ProviderFailure(mapped) from None
        except (ConnectTimeoutError, ReadTimeoutError, TimeoutError):
            raise ProviderFailure('timeout') from None
        except HTTPClientError:
            raise ProviderFailure('network') from None
        except (KeyError, AttributeError, TypeError, ValueError):
            raise ProviderFailure('malformed_response') from None
        except Exception:
            raise ProviderFailure('provider_error') from None
