"""Selected Hook API with real stdio/native admission and deterministic I/O."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
from uuid import uuid4

import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.application.apply_selected_hook import SelectedHookRequest as Request
from llm_engine.local_mcp_hook import LocalMcpHook, CONSENT_FIELDS
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}


def setup(db, model='fixture'):
    db = str(db)
    employee = _native.create_agent(db, 'Writer')[0]
    task = _native.create_assigned_work(db, 'Saved work', employee)[0]
    skill = _native.create_skill(db, 'Concise', 'Use short sentences.')['id']
    _native.set_skill_enabled(db, skill, True)
    hook = _native.create_hook(db, 'Follow up', skill, 'agent', employee, 'run_completed')['id']
    _native.set_hook_enabled(db, hook, True)
    row = _native.start_web_execution(db, task, 'anthropic', 'fixture', 0)
    _native.finish_execution(db, row[0], 'Source result', None)
    port = LocalMcpHook(db, 'anthropic', model, timeout=20)
    port.command = [sys.executable, str(Path(__file__).with_name('mcp_fixture_server.py')), db]
    return task, hook, port


def consent(preview):
    return {**{key: preview[key] for key in CONSENT_FIELDS},
            'preview_id': preview['preview_id'], 'execution_consent': True}


def test_api_discovery_preview_execution_reopening(tmp_path):
    db = tmp_path / 'hook.sqlite'
    task, hook, port = setup(db)
    with TestClient(create_app(db, model='fixture', hook_port=port), base_url=ORIGIN) as client:
        def call(operation, data):
            response = client.post('/api/connections/v1/hooks/' + operation, headers=HEADERS, json=data)
            assert response.status_code == 200, response.text
            return response.json()
        assert call('list', {})['data']['hooks'][0]['id'] == hook
        preview = call('preview', dict(task_id=task, hook_id=hook))['data']
        assert preview['expected_runs'] == 1
        assert 'Use short sentences.' in preview['input']
        assert not db.with_suffix('.sqlite.dispatches').exists()
        payload = consent(preview)
        for key in ('provider', 'model', 'declared_source', 'credentials'):
            assert client.post('/api/connections/v1/hooks/execute', headers=HEADERS,
                               json={**payload, key: 'forbidden'}).status_code == 400
        assert client.post('/api/connections/v1/hooks/execute', json=payload).status_code == 403
        assert client.post('/api/connections/v1/hooks/execute', headers=HEADERS,
                           json={**payload, 'execution_consent': False}).status_code == 400
        result = call('execute', payload)
        assert result['status'] == 'completed'
        assert result['data']['hook'] == _native.hook_provenance(str(db))[0]
        assert result['data']['execution']['input'] == preview['input']
        assert call('execute', payload)['code'] == 'admission_rejected'
    # Every native query reopens the database; provenance survives adapter restart.
    saved = _native.hook_provenance(str(db))[0]
    assert all(saved[key] == preview[key] for key in CONSENT_FIELDS if key != 'expected_runs')
    reopened = LocalMcpHook(db, 'anthropic', 'fixture')
    assert asyncio.run(reopened.execute_work(Request('execute', **payload))).code == 'admission_rejected'
    assert len(_native.history_snapshot_read_only(str(db))[2]) == 2
    assert db.with_suffix('.sqlite.dispatches').read_text() == 'dispatch\n'


@pytest.mark.parametrize('field', [*CONSENT_FIELDS, 'preview_id'])
def test_every_consent_mismatch_no_dispatch_or_consumption(tmp_path, field):
    db = tmp_path / 'mismatch.sqlite'
    task, hook, port = setup(db)
    async def scenario():
        preview = (await port.execute_work(Request('preview', task, hook))).data
        request = Request('execute', **consent(preview))
        value = (str(uuid4()) if field.endswith('_id') else
                 {'event': 'run_failed', 'source_outcome': 'failure', 'input': 'Different', 'expected_runs': 2}[field])
        changes = {field: value}
        # Both enum values are individually meaningful but refer to another source outcome.
        if field in ('event', 'source_outcome'):
            changes.update(event='run_failed', source_outcome='failure')
        assert (await port.execute_work(replace(request, **changes))).code == 'admission_rejected'
        assert not db.with_suffix('.sqlite.dispatches').exists()
        assert not _native.hook_provenance(str(db))
        assert (await port.execute_work(request)).status == 'completed'
    asyncio.run(scenario())


def test_unconfigured_discovery_preview_never_construct_provider(tmp_path):
    db = tmp_path / 'missing.sqlite'
    task, hook, port = setup(db, None)
    port.command.append('--forbid-provider')
    async def scenario():
        assert (await port.execute_work(Request('list'))).status == 'confirmed'
        preview = (await port.execute_work(Request('preview', task, hook))).data
        assert (await port.execute_work(Request('execute', **consent(preview)))).code == 'configuration_unavailable'
    asyncio.run(scenario())
    assert not db.with_suffix('.sqlite.dispatches').exists()


@pytest.mark.parametrize('stale', ['hook', 'skill', 'source'])
def test_stale_configuration_or_source_never_dispatches(tmp_path, stale):
    db = tmp_path / 'stale.sqlite'
    task, hook, port = setup(db)
    async def scenario():
        preview = (await port.execute_work(Request('preview', task, hook))).data
        if stale == 'hook':
            _native.set_hook_enabled(str(db), hook, False)
        elif stale == 'skill':
            _native.update_skill(str(db), preview['skill_id'], 'Changed', 'New instructions')
        else:
            row = _native.start_web_execution(str(db), task, 'anthropic', 'fixture', 1)
            _native.finish_execution(str(db), row[0], 'New source', None)
        assert (await port.execute_work(Request('execute', **consent(preview)))).code == 'admission_rejected'
    asyncio.run(scenario())
    assert not db.with_suffix('.sqlite.dispatches').exists()
    assert not _native.hook_provenance(str(db))


def test_competing_previews_only_one_admitted(tmp_path):
    db = tmp_path / 'race.sqlite'
    task, hook, first = setup(db, 'slow')
    second = LocalMcpHook(db, 'anthropic', 'slow', timeout=20)
    second.command = first.command
    async def scenario():
        previews = [ (await port.execute_work(Request('preview', task, hook))).data for port in (first, second)]
        results = await asyncio.gather(*(port.execute_work(Request('execute', **consent(preview)))
                                      for port, preview in zip((first, second), previews)))
        assert sorted(result.status for result in results) == ['completed', 'rejected']
    asyncio.run(scenario())
    assert db.with_suffix('.sqlite.dispatches').read_text() == 'dispatch\n'


def test_lost_receipt_persists_and_never_replays(tmp_path):
    db = tmp_path / 'lost.sqlite'
    task, hook, port = setup(db)
    preview = asyncio.run(port.execute_work(Request('preview', task, hook))).data
    script = tmp_path / 'lost.py'
    script.write_text('''import json, sys
from llm_engine import _native
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1:
        print(json.dumps(dict(jsonrpc='2.0', id=1, result=dict(protocolVersion='2025-03-26', capabilities=dict(tools={})))), flush=True)
    if message.get('id') == 2:
        a = message['params']['arguments']
        row = _native.start_hook_execution(sys.argv[1], a['task_id'], a['preview_id'], a['provider'], a['model'], a['expected_runs'], [], a['declared_source'])
        _native.finish_execution(sys.argv[1], row[0], 'Persisted before lost receipt', None)
        break
''')
    port.command = [sys.executable, str(script), str(db)]
    request = Request('execute', **consent(preview))
    assert asyncio.run(port.execute_work(request)).code == 'delivery_uncertain'
    assert len(_native.hook_provenance(str(db))) == 1
    assert asyncio.run(port.execute_work(request)).code == 'admission_rejected'


@pytest.mark.parametrize('field', [*CONSENT_FIELDS, 'preview_id', 'run_id', 'declared_source'])
def test_unverifiable_persisted_receipt_is_rejected(tmp_path, field):
    task, hook, port = setup(tmp_path / 'receipt.sqlite')
    preview = asyncio.run(port.execute_work(Request('preview', task, hook))).data
    request = Request('execute', **consent(preview))
    run_id = str(uuid4())
    execution = dict(schema_version=1, run_id=run_id, input=request.input, provider='anthropic',
                     model='fixture', deadline_unix_ms=123, output='Result', error=None, quality='unverified')
    provenance = {**preview, 'run_id': run_id}
    provenance.pop('expected_runs')
    run = dict(id=run_id, task_id=task, declared_source='agentown-local-product', execution=execution, hook=provenance)
    if field == 'declared_source':
        run[field] = 'wrong'
    elif field == 'expected_runs':
        # A missing admitted Run also prevents confirmation of the attempt identity.
        run['id'] = str(uuid4())
    else:
        provenance[field] = 'wrong'
    def envelope(data):
        return {'structuredContent': data, 'content': [{'type': 'text', 'text': json.dumps(data)}]}
    async def send(message):
        assert message['params']['arguments'] == {'task_id': task, 'read_only': True}
    async def receive(identifier):
        return envelope(dict(task={'id': task}, attempts=[{'id': preview['source_run_id']}, run]))
    with pytest.raises(ValueError):
        asyncio.run(port._verified_receipt(envelope(execution), request, send, receive))


@pytest.mark.parametrize('field,value', [('task_id', 'bad'), ('hook_id', 'bad'),
    ('agent_id', 'bad'), ('skill_id', 'bad'), ('source_run_id', 'bad'),
    ('expected_runs', True), ('expected_runs', -1), ('execution_consent', False),
    ('execution_consent', 1), ('preview_id', ''), ('input', ''),
    ('event', 'task_created'), ('source_outcome', 'unverified')])
def test_strict_consent_fields(field, value):
    identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    data = dict(task_id=identity, hook_id=identity, agent_id=identity, skill_id=identity,
                source_run_id=identity, event='run_completed', source_outcome='reported_success',
                expected_runs=1, input='Consented input', preview_id='opaque', execution_consent=True)
    with pytest.raises(ValueError):
        Request('execute', **{**data, field: value})
