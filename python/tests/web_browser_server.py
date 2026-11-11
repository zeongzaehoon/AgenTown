"""Deterministic subprocess fixture, never imported by the product entry point."""
import asyncio
import json
import sys
from pathlib import Path

import uvicorn
from llm_engine.execution import ProviderFailure
from llm_engine.web import create_app


class FixtureProvider:
    name = 'deterministic-test'

    async def generate(self, text, model):
        if text.startswith('Output-limit scenario:'):
            with Path(sys.argv[3]).with_suffix('.limit-calls').open('a') as calls:
                calls.write(json.dumps({'input': text, 'model': model}) + '\n')
                calls.flush()
            if 'two sentences' not in text:
                raise ProviderFailure('output_limit')
            return 'TEST RESPONSE — unverified: A shorter answer.'
        with Path(sys.argv[3]).with_suffix('.calls').open('a') as calls:
            calls.write('submitted\n'); calls.flush()
        # A file gate lets the browser observe running without timing assumptions.
        while not Path(sys.argv[3]).exists():
            await asyncio.sleep(.05)
        if Path(sys.argv[3]).read_text() == 'fail':
            raise ProviderFailure('rate_limit')
        return '  한글 😀\tTEST RESPONSE — unverified\r\n<script>window.injected = true</script>\n' + text + '\nEND OF FULL RESULT'


uvicorn.run(create_app(sys.argv[1], 'test-model', port=int(sys.argv[2]), provider=FixtureProvider()),
            host='127.0.0.1', port=int(sys.argv[2]), access_log=False)
