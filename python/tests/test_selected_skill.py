"""API and real stdio Skill contracts using deterministic provider I/O only."""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys

import pytest
from starlette.testclient import TestClient

from llm_engine import _native
from llm_engine.application.apply_selected_skill import SelectedSkillRequest as Request
from llm_engine.local_mcp_skill import LocalMcpSkill
from llm_engine.web import create_app

ORIGIN = 'http://127.0.0.1:8765'
HEADERS = {'Origin': ORIGIN}


def setup(db, model='fixture'):
    agent = _native.create_agent(str(db), 'Writer')[0]
    task = _native.create_assigned_work(str(db), 'Saved work', agent)[0]
    skill = _native.create_skill(str(db), 'Concise', 'Use short sentences.')['id']
    _native.set_skill_enabled(str(db), skill, True)
    port = LocalMcpSkill(db, 'anthropic', model, timeout=20)
    port.command = [sys.executable, str(Path(__file__).with_name('mcp_fixture_server.py')), str(db)]
    return task, skill, port


def test_api_discover_preview_execute_and_consumed(tmp_path):
    db = tmp_path / 'skills.sqlite'
    task, skill, port = setup(db)
    with TestClient(create_app(db, model='fixture', skill_port=port), base_url=ORIGIN) as client:
        def call(operation, data):
            response = client.post('/api/connections/v1/skills/' + operation, headers=HEADERS, json=data)
            assert response.status_code == 200, response.text
            return response.json()
        assert call('list', {})['data']['skills'] == [{'id': skill, 'name': 'Concise', 'enabled': True}]
        preview = call('preview', dict(task_id=task, skill_id=skill))['data']
        assert 'Use short sentences.' in preview['input'] and 'Saved work' in preview['input']
        assert not db.with_suffix('.sqlite.dispatches').exists()
        payload = {key: value for key, value in preview.items() if key != 'schema_version'}
        payload['execution_consent'] = True
        for extra in ('provider', 'model', 'credentials', 'declared_source'):
            assert client.post('/api/connections/v1/skills/execute', headers=HEADERS,
                               json={**payload, extra: 'forbidden'}).status_code == 400
        assert client.post('/api/connections/v1/skills/execute', headers=HEADERS,
                           json={**payload, 'execution_consent': False}).status_code == 400
        result = call('execute', payload)
        assert result['status'] == 'completed'
        assert result['data']['execution']['input'] == preview['input']
        provenance = result['data']['skill']
        assert provenance['skill_id'] == skill and provenance['preview_id'] == preview['preview_id']
        assert provenance == _native.skill_provenance(str(db))[0]
        assert call('execute', payload)['code'] == 'admission_rejected'
    assert db.with_suffix('.sqlite.dispatches').read_text() == 'dispatch\n'


def test_missing_configuration_still_allows_discovery_preview(tmp_path):
    db = tmp_path / 'missing.sqlite'
    task, skill, port = setup(db, None)
    port.command.append('--forbid-provider')
    async def scenario():
        assert (await port.execute_work(Request('list'))).status == 'confirmed'
        result = await port.execute_work(Request('preview', task, skill))
        preview = result.data
        assert result.status == 'confirmed'
        request = Request('execute', task, skill, preview['preview_id'], preview['expected_runs'], preview['input'], True)
        assert (await port.execute_work(request)).code == 'configuration_unavailable'
    asyncio.run(scenario())
    assert not _native.history_snapshot_read_only(str(db))[2]


@pytest.mark.parametrize('field', ['task_id', 'skill_id', 'input', 'expected_runs', 'preview_id'])
def test_api_consent_mismatch_never_dispatches_or_consumes(tmp_path, field):
    db = tmp_path / 'consent.sqlite'
    task, skill, port = setup(db)
    with TestClient(create_app(db, model='fixture', skill_port=port), base_url=ORIGIN) as client:
        def call(operation, payload):
            response = client.post('/api/connections/v1/skills/' + operation,
                                   headers=HEADERS, json=payload)
            assert response.status_code == 200, response.text
            return response.json()
        preview = call('preview', dict(task_id=task, skill_id=skill))['data']
        payload = {key: value for key, value in preview.items() if key != 'schema_version'}
        payload['execution_consent'] = True
        changed = {'task_id': skill, 'skill_id': task, 'input': 'Different consented input',
                   'expected_runs': 1, 'preview_id': 'unknown'}[field]
        assert call('execute', {**payload, field: changed})['code'] == 'admission_rejected'
        assert not db.with_suffix('.sqlite.dispatches').exists()
        assert not _native.history_snapshot_read_only(str(db))[2]
        assert not _native.skill_provenance(str(db))
        # The original consent is still usable: rejection did not consume it.
        assert call('execute', payload)['status'] == 'completed'
    assert db.with_suffix('.sqlite.dispatches').read_text() == 'dispatch\n'


def test_stale_preview_and_duplicate_rust_admission(tmp_path):
    db = tmp_path / 'duplicate.sqlite'
    task, skill, first = setup(db, 'slow')
    second = LocalMcpSkill(db, 'anthropic', 'slow', timeout=20)
    second.command = first.command
    async def scenario():
        preview = (await first.execute_work(Request('preview', task, skill))).data
        request = Request('execute', task, skill, preview['preview_id'], 0, preview['input'], True)
        _native.update_skill(str(db), skill, 'Changed', 'New instructions')
        assert (await first.execute_work(request)).code == 'admission_rejected'
        preview = (await first.execute_work(Request('preview', task, skill))).data
        request = replace(request, preview_id=preview['preview_id'], input=preview['input'])
        other = (await second.execute_work(Request('preview', task, skill))).data
        other_request = replace(request, preview_id=other['preview_id'], input=other['input'])
        results = await asyncio.gather(first.execute_work(request), second.execute_work(other_request))
        assert sorted(result.status for result in results) == ['completed', 'rejected']
    asyncio.run(scenario())
    assert db.with_suffix('.sqlite.dispatches').read_text() == 'dispatch\n'


def test_preview_identity_mismatch_is_uncertain(tmp_path):
    task, skill, port = setup(tmp_path / 'identity.sqlite')
    request = Request('preview', task, skill)
    data = dict(schema_version=1, preview_id='opaque', task_id=skill, skill_id=skill, input='Input', expected_runs=0)
    async def unused(*args):
        raise AssertionError('No follow-up expected')
    with pytest.raises(ValueError, match='identity'):
        asyncio.run(port._verified_receipt({'structuredContent': data, 'content': [{'type': 'text', 'text': __import__('json').dumps(data)}]}, request, unused, unused))


@pytest.mark.parametrize('field,value', [('task_id', 'bad'), ('skill_id', 'bad'),
    ('expected_runs', True), ('expected_runs', -1), ('execution_consent', False), ('execution_consent', 1),
    ('preview_id', ''), ('input', '')])
def test_strict_execution_identity(field, value):
    data = dict(operation='execute', task_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                skill_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', preview_id='opaque', expected_runs=0,
                input='Previewed input', execution_consent=True)
    with pytest.raises(ValueError):
        Request(**{**data, field: value})


def test_post_dispatch_timeout_and_busy_never_replay(tmp_path):
    db = tmp_path / 'timeout.sqlite'
    task, skill, port = setup(db)
    preview = asyncio.run(port.execute_work(Request('preview', task, skill))).data
    script = tmp_path / 'silent.py'
    marker = tmp_path / 'sent'
    script.write_text('''import json, sys, time
from pathlib import Path
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1:
        print(json.dumps(dict(jsonrpc='2.0', id=1, result=dict(protocolVersion='2025-03-26', capabilities=dict(tools={})))), flush=True)
    if message.get('id') == 2:
        Path(sys.argv[1]).write_text('one dispatch')
        time.sleep(10)
''')
    port.command = [sys.executable, str(script), str(marker)]
    port.timeout = 1
    request = Request('execute', task, skill, preview['preview_id'], 0, preview['input'], True)
    async def scenario():
        pending = asyncio.create_task(port.execute_work(request))
        for _ in range(100):
            if marker.exists():
                break
            await asyncio.sleep(.005)
        assert marker.exists()
        assert (await port.execute_work(request)).code == 'execution_busy'
        result = await pending
        assert result.status == 'uncertain' and result.code == 'delivery_uncertain'
        assert port.active is None
        assert marker.read_text() == 'one dispatch'
    asyncio.run(scenario())


def test_delivery_loss_after_skill_persistence(tmp_path):
    db = tmp_path / 'lost.sqlite'
    task, skill, port = setup(db)
    preview = asyncio.run(port.execute_work(Request('preview', task, skill))).data
    script = tmp_path / 'lost.py'
    script.write_text('''import json, sys
from llm_engine import _native
for line in sys.stdin:
    message = json.loads(line)
    if message.get('id') == 1:
        print(json.dumps(dict(jsonrpc='2.0', id=1, result=dict(protocolVersion='2025-03-26', capabilities=dict(tools={})))), flush=True)
    if message.get('id') == 2:
        args = message['params']['arguments']
        row = _native.start_skill_execution(sys.argv[1], args['task_id'], args['preview_id'], args['provider'], args['model'], args['expected_runs'], [], args['declared_source'])
        _native.finish_execution(sys.argv[1], row[0], 'Persisted before delivery loss', None)
        break
''')
    port.command = [sys.executable, str(script), str(db)]
    request = Request('execute', task, skill, preview['preview_id'], 0, preview['input'], True)
    result = asyncio.run(port.execute_work(request))
    assert result.status == 'uncertain' and result.code == 'delivery_uncertain'
    provenance = _native.skill_provenance(str(db))
    assert len(provenance) == 1 and provenance[0]['preview_id'] == preview['preview_id']
    assert len(_native.history_snapshot_read_only(str(db))[2]) == 1


def test_server_configuration_and_predispatch_unavailability(tmp_path):
    db = tmp_path / 'config.sqlite'
    task, skill, port = setup(db)
    port.command.append('--forbid-provider')
    preview = asyncio.run(port.execute_work(Request('preview', task, skill))).data
    request = Request('execute', task, skill, preview['preview_id'], 0, preview['input'], True)
    assert asyncio.run(port.execute_work(request)).code == 'configuration_unavailable'
    assert not _native.history_snapshot_read_only(str(db))[2]
    port.command = [str(tmp_path / 'nonexistent')]
    assert asyncio.run(port.execute_work(request)).code == 'transport_unavailable'


@pytest.mark.parametrize('mismatch', ['task', 'skill', 'preview', 'input', 'run'])
def test_execution_receipt_requires_matching_persisted_identity(tmp_path, mismatch):
    import json
    task, skill, port = setup(tmp_path / 'receipt.sqlite')
    request = Request('execute', task, skill, 'opaque', 0, 'Consented input', True)
    run_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    execution = dict(schema_version=1, run_id=run_id, input=request.input, provider='anthropic',
                     model='fixture', deadline_unix_ms=123, output='Result', error=None, quality='unverified')
    provenance = dict(run_id=run_id, preview_id='opaque', skill_id=skill, input=request.input)
    run = dict(id=run_id, task_id=task, declared_source='agentown-local-product', execution=execution, skill=provenance)
    history = dict(task={'id': task}, attempts=[run])
    if mismatch == 'task':
        history['task']['id'] = skill
    elif mismatch == 'run':
        run['id'] = skill
    else:
        provenance[{'skill': 'skill_id', 'preview': 'preview_id', 'input': 'input'}[mismatch]] = 'wrong'
    def envelope(data):
        return {'structuredContent': data, 'content': [{'type': 'text', 'text': json.dumps(data)}]}
    async def send(message):
        assert message['params']['arguments'] == {'task_id': task, 'read_only': True}
    async def receive(identifier):
        assert identifier == 3
        return envelope(history)
    with pytest.raises(ValueError):
        asyncio.run(port._verified_receipt(envelope(execution), request, send, receive))
