"""Run: uv run --locked python docs/evidence/c7-t1-demo.py
Deterministic port fixture ONLY. Does not make an Anthropic request.
"""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from llm_engine import _native
from llm_engine.execution import ProviderFailure, execute_text


class Fixture:
    name = 'test-fixture'

    def __init__(self, fail):
        self.fail = fail

    async def generate(self, text, model):
        if self.fail:
            raise ProviderFailure('rate_limit')
        return 'TEST RESPONSE: The team agreed to ship the draft on Friday.'


db = str(Path(tempfile.mkdtemp(prefix='llm-engine-c7-')) / 'work.sqlite3')
agent = _native.create_agent(db, 'Writer')[0]
task = _native.create_task(db, 'Meeting summary')[0]
_native.assign_task(db, task, [agent])
text = 'Summarize in one sentence: The team agreed to ship the draft on Friday.'
failed = asyncio.run(execute_text(db, task, agent, text, 'fixture-model', Fixture(True)))
success = asyncio.run(execute_text(db, task, agent, text, 'fixture-model', Fixture(False)))
assert failed['run_id'] != success['run_id']
print(json.dumps({'validation': 'DETERMINISTIC TEST ONLY; live validation outstanding',
                  'database': db, 'agent_id': agent, 'task_id': task,
                  'failed': failed, 'success': success}, indent=2))
for command in [('work', 'show', success['run_id']), ('run', 'list', task), ('task', 'show', task)]:
    argv = [sys.executable, '-m', 'llm_engine', '--database', db, '--json', *command]
    result = subprocess.run(argv, text=True, capture_output=True, check=True)
    print(json.dumps({'command': argv, 'exit': result.returncode, 'stdout': json.loads(result.stdout)}))
    if command[0] == 'task':
        assert json.loads(result.stdout)['status'] == 'pending'
    if command[0] == 'work':
        assert json.loads(result.stdout)['output'] == success['output']
