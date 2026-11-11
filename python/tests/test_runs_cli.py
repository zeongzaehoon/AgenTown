"""Each command is a separately launched installed CLI, with no cached state."""
import uuid

from test_cli import cli


def setup(cli):
    a, b, c = [cli('agent', 'create', name)['id'] for name in ('A', 'B', 'C')]
    team = cli('team', 'create', 'Delivery')['id']
    cli('team', 'add-members', team, a, b)
    task = cli('task', 'create', 'Deliver')['id']
    assigned = cli('team', 'assign', team, task)
    return a, b, c, team, assigned


def start(cli, task, *participants, **kwargs):
    return cli('run', 'start', task, '--stage', 'implement',
               '--reporting-source', 'operator 한글', '--participants', *participants, **kwargs)


def test_retry_history_and_membership(cli):
    a, b, c, team, task = setup(cli)
    t = task['id']
    assert cli('run', 'list', t) == []
    assert cli('run', 'list', t, machine=False).strip() == 'No runs yet.'
    first = start(cli, t, a, b)
    assert first['participants'] == sorted([a, b])
    assert first['state'] == 'active' and first['outcome'] is None
    assert first['ended_at_unix_ms'] is None
    assert first['task_id'] == t and first['reporting_source'] == 'operator 한글'
    assert first['stage'] == 'implement' and first['started_at_unix_ms'] > 0
    # Process exit/reopen never implicitly finalizes an attempt.
    assert cli('run', 'show', first['id']) == first
    assert 'not finished' in cli('run', 'show', first['id'], machine=False)
    start(cli, t, a, success=False)
    assert cli('run', 'list', t) == [first]
    failed = cli('run', 'finish', first['id'], '--outcome', 'failure')
    assert failed == {**first, 'state': 'finished', 'outcome': 'failure',
                      'ended_at_unix_ms': failed['ended_at_unix_ms']}
    assert failed['ended_at_unix_ms'] >= failed['started_at_unix_ms']
    cli('run', 'finish', first['id'], '--outcome', 'reported_success', success=False)
    retry = start(cli, t, b)
    assert retry['id'] != first['id']
    success = cli('run', 'finish', retry['id'], '--outcome', 'reported_success')
    assert success['outcome'] == 'reported_success'
    assert cli('task', 'show', t) == task  # success is not Task completion
    cli('team', 'add-members', team, c)
    assert cli('task', 'show', t) == task
    cli('task', 'assign', t, c)
    assert cli('run', 'show', first['id']) == failed
    assert cli('run', 'show', retry['id']) == success
    interrupted = start(cli, t, c)
    end = cli('run', 'finish', interrupted['id'], '--outcome', 'interruption')
    assert end['outcome'] == 'interruption'
    assert cli('run', 'list', t) == sorted([failed, success, end], key=lambda r: r['id'])
    assert 'Recorded attempt' in cli('run', 'show', first['id'], machine=False)
    assert cli('task', 'show', t)['status'] == 'pending'


def test_invalid_inputs_are_atomic(cli, tmp_path):
    a, b, c, team, task = setup(cli)
    t = task['id']
    database = tmp_path / 'product.sqlite'
    before = database.read_bytes()
    for bad, word in [('bad', 'invalid'), (str(uuid.uuid4()), 'unknown')]:
        assert word in start(cli, bad, a, success=False)
        assert word in start(cli, t, bad, success=False)
        assert word in cli('run', 'list', bad, success=False)
        assert word in cli('run', 'show', bad, success=False)
        assert word in cli('run', 'finish', bad, '--outcome', 'failure', success=False)
    start(cli, t, c, success=False)
    start(cli, t, a, a, success=False)
    for stage, source in [(' ', 'operator'), ('implement', ' ')]:
        cli('run', 'start', t, '--stage', stage, '--reporting-source', source,
            '--participants', a, success=False)
    assert database.read_bytes() == before
    for action in ['start', 'finish', 'list', 'show']:
        help_text = cli('run', action, '--help', machine=False)
        assert 'do not execute agents' in help_text
        assert 'complete Tasks' in help_text
    assert 'record' in cli('run', '--help', machine=False).lower()
    cli('run', 'start', t, '--stage', 'implement', '--participants', a, success=False)
    cli('run', 'start', t, '--stage', 'implement', '--reporting-source', 'op', success=False)
    cli('run', 'finish', str(uuid.uuid4()), '--outcome', 'success', success=False)
    assert database.read_bytes() == before
