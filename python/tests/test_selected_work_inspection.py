"""Selected local MCP inspection never admits execution or provider calls."""
import asyncio
import copy
import json
import sys
from uuid import uuid4

import pytest

from llm_engine.application.inspect_selected_work import InspectSelectedWork
from llm_engine.connection_diagnostic import ConnectionDiagnostic, validated_inspection

TASK = '11111111-1111-4111-8111-111111111111'
RUN = '22222222-2222-4222-8222-222222222222'
SKILL = '33333333-3333-4333-8333-333333333333'
HOOK = '44444444-4444-4444-8444-444444444444'
AGENT = '55555555-5555-4555-8555-555555555555'
FOLLOW_UP = '66666666-6666-4666-8666-666666666666'


def records():
    task = dict(id=TASK, title='Saved work', status='pending', assignees=[])
    run = dict(id=RUN, task_id=TASK, stage='implement', reporting_source='mcp',
               declared_source=None, started_at=1, ended_at=2, state='finished',
               outcome='reported_success', participants=[], execution=dict(
                   schema_version=1, run_id=RUN, input='Work', provider='fixture',
                   model='fixture', deadline_unix_ms=10, output='Available result',
                   error=None, quality='unverified'), skill=None, hook=None)
    return task, dict(schema_version=1, task=copy.deepcopy(task), attempts=[run])


def envelope(data):
    return dict(structuredContent=data, content=[dict(type='text', text=json.dumps(data))], isError=False)


def provenance_records(kind):
    task, history = records()
    run = history['attempts'][0]
    saved = dict(schema_version=1, run_id=RUN, preview_id='saved-preview',
                 skill_id=SKILL, skill_name='Saved Skill', instructions='Saved instructions',
                 input='Saved effective input', admitted_at=1)
    if kind == 'hook':
        source = copy.deepcopy(run)
        run.update(id=FOLLOW_UP, started_at=3, ended_at=4, participants=[AGENT])
        run['execution']['run_id'] = FOLLOW_UP
        saved.update(run_id=FOLLOW_UP, admitted_at=3, task_id=TASK,
                     hook_id=HOOK, hook_name='Saved Hook', hook_enabled=True,
                     target_kind='agent', agent_id=AGENT, event='run_completed',
                     source_run_id=RUN, source_outcome='reported_success', skill_enabled=True)
        history['attempts'].insert(0, source)
    run[kind] = saved
    run['execution']['input'] = saved['input']
    return task, history


@pytest.mark.parametrize('kind', ['skill', 'hook'])
def test_saved_provenance_survives_application_mapping(kind):
    from llm_engine.application.inspect_selected_work import InspectionResult
    task, history = provenance_records(kind)
    inspection = validated_inspection(envelope(task), envelope(history), TASK)
    class Port:
        async def inspect_work(self, task_id):
            return InspectionResult('passed', 'inspection_passed', 'Inspected', '', inspection)
    result = asyncio.run(InspectSelectedWork(Port()).execute(TASK))
    assert result['status'] == 'success'
    assert [{k: v for k, v in row.items() if k != 'loop'} for row in result['inspection']['attempts']] == history['attempts']


@pytest.mark.parametrize('kind', ['skill', 'hook'])
@pytest.mark.parametrize('field,value', [
    ('run_id', TASK), ('skill_id', 'invalid'), ('preview_id', ''),
    ('skill_name', ''), ('instructions', ''), ('input', 'Contradiction'),
    ('admitted_at', 99), ('schema_version', 2),
])
def test_rejects_malformed_or_contradictory_saved_provenance(kind, field, value):
    task, history = provenance_records(kind)
    history['attempts'][-1][kind][field] = value
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK)


@pytest.mark.parametrize('field,value', [
    ('task_id', RUN), ('source_run_id', FOLLOW_UP), ('source_run_id', SKILL),
    ('source_outcome', 'failure'), ('event', 'run_failed'), ('agent_id', SKILL),
    ('hook_id', 'invalid'), ('hook_name', ''), ('hook_enabled', False),
    ('skill_enabled', False),
])
def test_rejects_contradictory_hook_relationships(field, value):
    task, history = provenance_records('hook')
    history['attempts'][-1]['hook'][field] = value
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK)


@pytest.mark.parametrize('kind', ['skill', 'hook'])
def test_provenance_requires_recorded_execution(kind):
    task, history = provenance_records(kind)
    history['attempts'][-1]['execution'] = None
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK)


@pytest.mark.parametrize('change', [
    lambda t, h: t.update(id=str(uuid4())),
    lambda t, h: h['task'].update(id=str(uuid4())),
    lambda t, h: h['attempts'][0].update(task_id=str(uuid4())),
    lambda t, h: h['attempts'][0]['execution'].update(run_id=str(uuid4())),
    lambda t, h: h['attempts'].append(copy.deepcopy(h['attempts'][0])),
    lambda t, h: h['attempts'][0].update(ended_at=None),
    lambda t, h: h['attempts'][0].update(started_at='1'),
    lambda t, h: h.update(extra='unexpected'),
    lambda t, h: h['attempts'][0]['execution'].update(error='Conflicting failure'),
    lambda t, h: h['attempts'][0].update(state='active', ended_at=None, outcome=None),
])
def test_rejects_inconsistent_or_malformed_records(change):
    task, history = records()
    change(task, history)
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK)


def test_empty_and_nullable_execution():
    task, history = records()
    history['attempts'][0]['execution'] = None
    assert validated_inspection(envelope(task), envelope(history), TASK).attempts[0].execution is None
    history['attempts'] = []
    assert validated_inspection(envelope(task), envelope(history), TASK).attempts == []


def command(tmp_path, mode):
    task, history = records()
    if mode in ('skill', 'hook', 'contradictory_hook'):
        task, history = provenance_records('skill' if mode == 'skill' else 'hook')
        if mode == 'contradictory_hook':
            history['attempts'][-1]['hook']['skill_id'] = 'invalid'
    trace = tmp_path / 'inspection.jsonl'
    script = '''
import json, sys, time
mode, trace, task, history = sys.argv[1:]
for line in sys.stdin:
    msg = json.loads(line)
    with open(trace, 'a') as log: log.write(json.dumps(msg) + '\\n')
    if mode == 'timeout': time.sleep(60)
    if msg['method'] == 'initialize':
        result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}}
    elif msg['method'] == 'tools/call':
        data = json.loads(task if msg['params']['name'] == 'get_task' else history)
        if msg['params']['name'] == 'inspect_loop_sessions_v1': data = {'schema_version': 1, 'control': {'state': 'available', 'can_control': True, 'message': 'Available'}, 'sessions': [], 'attempts': []}
        if msg['params']['name'] == 'preflight_text_work_v1':
            data = {'schema_version': 1, 'task_id': json.loads(task)['id'], 'input': 'Exact saved input\\n  with spacing', 'employee_ids': ['55555555-5555-4555-8555-555555555555'], 'expected_runs': 7, 'active_attempt': False, 'eligibility': 'eligible', 'resubmission_consent_required': True}
            if mode == 'missing': data.update(input=None, employee_ids=[], expected_runs=0, eligibility='missing', resubmission_consent_required=False)
            if mode == 'ineligible': data.update(active_attempt=True, eligibility='ineligible')
            if mode == 'bad_preflight': data['expected_runs'] = '7'
            if mode == 'preflight_error':
                print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'isError': True, 'content': []}}), flush=True)
                continue
        if msg['params']['name'] == 'preflight_text_work_v1' and mode == 'preflight_timeout': time.sleep(60)
        if msg['params']['name'] == 'preflight_text_work_v1' and mode == 'disconnect': sys.exit(0)
        if mode == 'mismatch': data['id' if 'id' in data else 'schema_version'] = 'invalid'
        result = {'structuredContent': data, 'content': [{'type': 'text', 'text': json.dumps(data)}], 'isError': mode == 'error'}
    else: continue
    print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}), flush=True)
'''
    return [sys.executable, '-u', '-c', script, mode, str(trace), json.dumps(task), json.dumps(history)], trace


@pytest.mark.parametrize('mode,status', [('success', 'passed'), ('error', 'failed'),
                                         ('missing', 'passed'), ('ineligible', 'passed'),
                                         ('bad_preflight', 'failed'), ('preflight_error', 'failed'),
                                         ('preflight_timeout', 'timeout'), ('disconnect', 'failed'),
                                         ('skill', 'passed'), ('hook', 'passed'),
                                         ('contradictory_hook', 'failed'),
                                         ('mismatch', 'failed'), ('timeout', 'timeout')])
def test_installed_transport_only_reads_and_reaps(tmp_path, monkeypatch, mode, status):
    async def exercise():
        database = tmp_path / 'selected.db'
        database.write_bytes(b'unchanged')
        service = ConnectionDiagnostic(database, timeout=.5)
        service.command, trace = command(tmp_path, mode)
        processes = []
        spawn = asyncio.create_subprocess_exec
        async def capture(*args, **kwargs):
            process = await spawn(*args, **kwargs)
            processes.append(process)
            return process
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', capture)
        # No provider factory is part of this application/adapter path.
        import llm_engine.mcp_server as mcp
        monkeypatch.setattr(mcp, 'configured_provider', lambda *a, **k: pytest.fail('provider called'))
        result = await InspectSelectedWork(service).execute(TASK)
        assert result['status'] == ('success' if status == 'passed' else 'failure')
        assert result['requested_task_id'] == TASK
        if status == 'passed':
            assert result['inspection']['task']['id'] == TASK
            assert result['inspection']['attempts'][0]['execution']['output'] == 'Available result'
            if mode in ('skill', 'hook'):
                assert [{k: v for k, v in row.items() if k != 'loop'} for row in result['inspection']['attempts']] == provenance_records(mode)[1]['attempts']
            readiness = result['inspection']['readiness']
            assert readiness['expected_runs'] == (0 if mode == 'missing' else 7)  # Independent of history.
            assert readiness['eligibility'] == (mode if mode in ('missing', 'ineligible') else 'eligible')
            assert readiness['input'] == (None if mode == 'missing' else 'Exact saved input\n  with spacing')
            assert readiness['resubmission_consent_required'] is (mode != 'missing')
            assert result['inspection']['evidence'] == dict(
                source='installed_local_mcp', tools=['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'],
                read_only=True, external_client_verified=False)
        else:
            assert result['inspection'] is None
        calls = [json.loads(line)['params'] for line in trace.read_text().splitlines()
                 if json.loads(line)['method'] == 'tools/call']
        if mode != 'timeout':
            assert calls == [dict(name='get_task', arguments=dict(task_id=TASK)),
                             dict(name='get_work_history_v1', arguments=dict(task_id=TASK, read_only=True)),
                             dict(name='inspect_loop_sessions_v1', arguments={}),
                             dict(name='preflight_text_work_v1', arguments=dict(task_id=TASK))]
        assert database.read_bytes() == b'unchanged'
        assert service.active is None and processes[0].returncode is not None
        await service.close()
    asyncio.run(exercise())


def test_inspection_shares_admission_and_cancellation_cleanup(tmp_path):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'selected.db')
        service.command, trace = command(tmp_path, 'timeout')
        task = asyncio.create_task(InspectSelectedWork(service).execute(TASK))
        while not trace.exists():
            await asyncio.sleep(.01)
        assert (await service.run())['status'] == 'busy'
        assert (await service.run_shared_data())['status'] == 'busy'
        busy = await InspectSelectedWork(service).execute(TASK)
        assert busy['status'] == 'failure' and busy['code'] == 'inspection_busy' and busy['inspection'] is None
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.active is None
        await service.close()
    asyncio.run(exercise())


def test_api_fixed_identity_input_and_failure_envelope(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from llm_engine.application.inspect_selected_work import InspectionResult
    from llm_engine.web import create_app
    calls = []
    async def inspect(self, task_id):
        calls.append(task_id)
        return InspectionResult('failed', 'inspection_failed', 'Unavailable', 'Inspect explicitly again.')
    monkeypatch.setattr(ConnectionDiagnostic, 'inspect_work', inspect)
    class NoProvider:
        async def complete(self, *args, **kwargs):
            pytest.fail('provider called')
    origin = 'http://127.0.0.1:8765'
    with TestClient(create_app(str(tmp_path / 'api.db'), provider=NoProvider()), base_url=origin) as client:
        route = '/api/connections/v1/inspect-work'
        headers = {'Origin': origin}
        for data in ({}, {'task_id': 'invalid'}, {'task_id': None},
                     {'task_id': TASK, 'command': 'anything'}, {'task_id': TASK, 'read_only': False}):
            assert client.post(route, json=data, headers=headers).status_code == 400
        assert calls == []
        assert client.post(route, json={'task_id': TASK}).status_code == 403
        result = client.post(route, json={'task_id': TASK}, headers=headers)
        assert result.status_code == 200
        assert result.json() == dict(schema_version=1, requested_task_id=TASK, status='failure',
                                     code='inspection_failed', message='Unavailable',
                                     recovery='Inspect explicitly again.', inspection=None)
        assert calls == [TASK]


@pytest.mark.parametrize('kind', ['skill', 'hook'])
def test_api_returns_saved_provenance_without_execution(tmp_path, monkeypatch, kind):
    from starlette.testclient import TestClient
    from llm_engine.application.inspect_selected_work import InspectionResult
    from llm_engine.web import create_app
    task, history = provenance_records(kind)
    inspection = validated_inspection(envelope(task), envelope(history), TASK)
    calls = []
    async def inspect(self, task_id):
        calls.append(task_id)
        return InspectionResult('passed', 'inspection_passed', 'Inspected', '', inspection)
    monkeypatch.setattr(ConnectionDiagnostic, 'inspect_work', inspect)
    class NoProvider:
        async def complete(self, *args, **kwargs):
            pytest.fail('provider called')
    origin = 'http://127.0.0.1:8765'
    with TestClient(create_app(str(tmp_path / 'api.db'), provider=NoProvider()), base_url=origin) as client:
        response = client.post('/api/connections/v1/inspect-work',
                               json={'task_id': TASK}, headers={'Origin': origin})
        assert response.status_code == 200
        payload = response.json()
        assert payload['status'] == 'success'
        assert [{k: v for k, v in row.items() if k != 'loop'} for row in payload['inspection']['attempts']] == history['attempts']
        assert payload['inspection']['evidence']['read_only'] is True
    assert calls == [TASK]


@pytest.mark.parametrize('change', [
    lambda result: result.update(isError=True),
    lambda result: result.update(content=[]),
    lambda result: result['content'][0].update(text='{}'),
    lambda result: result.update(structuredContent=[]),
])
def test_error_and_malformed_envelopes_never_succeed(change):
    task, history = records()
    result = envelope(task)
    change(result)
    with pytest.raises(Exception):
        validated_inspection(result, envelope(history), TASK)


@pytest.mark.parametrize('status', ['failed', 'busy', 'timeout', 'passed'])
def test_unconfirmed_port_result_never_exposes_inspection(status):
    from llm_engine.application.inspect_selected_work import (
        InspectionResult, LocalInspection, InspectedTask)
    class Port:
        async def inspect_work(self, task_id):
            # Even a contradictory failed result cannot leak successful evidence.
            inspection = (LocalInspection(InspectedTask(TASK, 'Saved', 'pending', []), [])
                          if status != 'passed' else None)
            return InspectionResult(status, 'inspection_unavailable', 'Unavailable',
                                    'Inspect explicitly again.', inspection)
    result = asyncio.run(InspectSelectedWork(Port()).execute(TASK))
    assert result['status'] == 'failure'
    assert result['inspection'] is None


SESSION = '77777777-7777-4777-8777-777777777777'


def loop_records():
    task, history = records()
    history['attempts'][0]['participants'] = [AGENT]
    preview = dict(schema_version=1, preview_id='saved-loop-preview', policy_id=SKILL,
                   policy_name='Saved policy before editing', policy_enabled=True,
                   task_id=TASK, agent_id=AGENT, input='Work', max_iterations=3,
                   interval_seconds=60, expected_runs=0, created_at=0)
    session = dict(schema_version=1, session_id=SESSION, preview=preview, state='active',
                   provider='fixture', model='fixture', started_at=1, expires_at=100,
                   admitted=0, next_at=1, declared_source=None)
    link = dict(schema_version=1, session_id=SESSION, run_id=RUN, ordinal=1,
                admitted_at=1, execution=copy.deepcopy(history['attempts'][0]['execution']))
    loops = dict(schema_version=1, control=dict(state='available', can_control=True,
                 message='Available'), sessions=[session], attempts=[link])
    return task, history, loops


def test_loop_saved_snapshot_and_separate_progress_observations():
    task, history, loops = loop_records()
    before = copy.deepcopy((task, history, loops))
    # Session admitted count predates the link read. Execution was read later
    # than history; its mutable output may also differ without invalidating identity.
    loops['attempts'][0]['execution']['output'] = 'Later observation'
    result = validated_inspection(envelope(task), envelope(history), TASK, envelope(loops))
    loop = result.attempts[0].loop
    assert loop.linkage == 'confirmed' and loop.session['session_id'] == SESSION and loop.ordinal == 1
    assert loop.session['preview']['policy_name'] == 'Saved policy before editing'
    assert loop.session['preview']['input'] == 'Work' and loop.session['preview']['max_iterations'] == 3
    assert loop.session['admitted'] == 0
    assert loop.admitted_at == history['attempts'][0]['started_at']
    from dataclasses import asdict
    assert set(asdict(loop)) == {'linkage', 'session', 'ordinal', 'admitted_at'}
    assert result.attempts[0].execution.output == 'Available result'
    assert (task, history) == before[:2]


@pytest.mark.parametrize('change', [
    lambda l: l['attempts'].append(copy.deepcopy(l['attempts'][0])),
    lambda l: l['sessions'].append(copy.deepcopy(l['sessions'][0])),
    lambda l: l['attempts'][0].update(session_id=TASK),
    lambda l: l['attempts'][0].update(ordinal=0),
    lambda l: l['attempts'][0].update(admitted_at=2),
    lambda l: l['attempts'][0]['execution'].update(input='Changed input'),
    lambda l: l['sessions'][0]['preview'].update(agent_id=HOOK),
    lambda l: l['sessions'][0]['preview'].update(task_id=RUN),
    lambda l: l['sessions'][0].update(provider='different'),
    lambda l: l['sessions'][0]['preview'].update(policy_name=''),
    lambda l: l.update(extra=True),
])
def test_loop_rejects_malformed_or_mismatched_admission(change):
    task, history, loops = loop_records()
    change(loops)
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK, envelope(loops))


def test_missing_link_is_uncertain_and_later_attempt_is_allowed():
    task, history, loops = loop_records()
    loops['attempts'][0]['run_id'] = FOLLOW_UP
    loops['attempts'][0]['execution']['run_id'] = FOLLOW_UP
    result = validated_inspection(envelope(task), envelope(history), TASK, envelope(loops))
    assert result.attempts[0].loop.linkage == 'uncertain'
    history['attempts'][0]['execution'] = None
    result = validated_inspection(envelope(task), envelope(history), TASK, envelope(loops))
    assert result.attempts[0].loop.linkage == 'absent'


def readiness_record():
    return dict(schema_version=1, task_id=TASK, input='  Saved\ninput  ',
                employee_ids=[AGENT], expected_runs=9, active_attempt=False,
                eligibility='eligible', resubmission_consent_required=True)


def test_preflight_and_task_reads_preserve_concurrent_observations():
    from dataclasses import asdict
    task, history = records()
    history['task'].update(title='Later title', assignees=[HOOK])
    preflight = readiness_record()
    before = copy.deepcopy((task, history, preflight))
    result = validated_inspection(envelope(task), envelope(history), TASK,
                                  fourth=envelope(preflight))
    assert result.task.title == 'Saved work'
    assert result.task.assignees == []
    assert len(result.attempts) == 1
    assert asdict(result.readiness) == preflight
    assert (task, history, preflight) == before


@pytest.mark.parametrize('field,value', [
    ('schema_version', True), ('schema_version', 2), ('task_id', RUN),
    ('task_id', 'invalid'), ('input', 123), ('employee_ids', ['invalid']),
    ('employee_ids', [AGENT, AGENT]), ('employee_ids', None),
    ('expected_runs', True), ('expected_runs', '9'), ('expected_runs', -1),
    ('active_attempt', 1), ('eligibility', 'ready'),
    ('input', None), ('employee_ids', []), ('active_attempt', True),
    ('eligibility', 'missing'), ('resubmission_consent_required', False),
    ('expected_runs', 9007199254740992),
    ('resubmission_consent_required', 'false'), ('extra', True),
])
def test_preflight_rejects_wrong_identity_and_shape(field, value):
    task, history = records()
    preflight = readiness_record()
    preflight[field] = value
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK,
                             fourth=envelope(preflight))


@pytest.mark.parametrize('field', list(readiness_record()))
def test_preflight_requires_every_field(field):
    task, history = records()
    preflight = readiness_record()
    del preflight[field]
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK,
                             fourth=envelope(preflight))


@pytest.mark.parametrize('mode', ['bad_preflight', 'preflight_error', 'preflight_timeout', 'disconnect'])
def test_preflight_failure_allows_explicit_recovery(tmp_path, mode):
    async def exercise():
        service = ConnectionDiagnostic(tmp_path / 'selected.db', timeout=.5)
        service.command, _ = command(tmp_path, mode)
        failed = await InspectSelectedWork(service).execute(TASK)
        assert failed['status'] == 'failure' and failed['inspection'] is None
        assert service.active is None
        service.command, _ = command(tmp_path, 'success')
        recovered = await InspectSelectedWork(service).execute(TASK)
        assert recovered['status'] == 'success'
        assert recovered['inspection']['readiness']['eligibility'] == 'eligible'
        await service.close()
    asyncio.run(exercise())


@pytest.mark.parametrize('change', [
    lambda result: result.update(isError=True),
    lambda result: result.update(content=[]),
    lambda result: result['content'][0].update(text='{}'),
    lambda result: result.update(structuredContent=None),
])
def test_preflight_error_envelope_rejected(change):
    task, history = records()
    result = envelope(readiness_record())
    change(result)
    with pytest.raises(Exception):
        validated_inspection(envelope(task), envelope(history), TASK, fourth=result)
