"""Installed CLI team commands; each invocation opens a new process/store."""
import uuid

from test_cli import cli


def test_team_copy_and_restart(cli):
    assert cli('team', 'list') == []
    assert cli('team', 'list', machine=False).strip() == 'No teams yet.'
    team = cli('team', 'create', '  Delivery 한글  ')
    assert team['name'] == 'Delivery 한글' and team['members'] == []
    assert 'Members: none' in cli('team', 'show', team['id'], machine=False)
    a, b, c = [cli('agent', 'create', n)['id'] for n in ('A', 'B', 'C')]
    task = cli('task', 'create', 'Deliver')['id']
    cli('team', 'assign', team['id'], task, success=False)
    assert cli('task', 'show', task)['assignees'] == []
    populated = cli('team', 'add-members', team['id'], a, b)
    assert populated['members'] == sorted([a, b])
    assert cli('team', 'show', team['id']) == populated
    assert cli('team', 'list') == [populated]
    assigned = cli('team', 'assign', team['id'], task)
    assert assigned['assignees'] == sorted([a, b])
    cli('team', 'add-members', team['id'], c)
    assert cli('team', 'show', team['id'])['members'] == sorted([a, b, c])
    assert cli('task', 'show', task) == assigned
    other = cli('team', 'create', 'Shared')['id']
    cli('team', 'add-members', other, c, a)
    cli('team', 'assign', other, task, success=False)
    assert cli('task', 'show', task) == assigned
    text = cli('team', 'show', team['id'], machine=False)
    assert all(i in text for i in [a, b, c])


def test_team_invalid_batches_and_help(cli):
    team = cli('team', 'create', 'Team')['id']
    a, b = [cli('agent', 'create', n)['id'] for n in ('A', 'B')]
    task = cli('task', 'create', 'Task')['id']
    unknown = str(uuid.uuid4())
    assert 'must not be empty' in cli('team', 'create', ' ', success=False)
    for bad, word in [('bad', 'invalid'), (unknown, 'unknown')]:
        assert word in cli('team', 'show', bad, success=False)
        assert word in cli('team', 'add-members', bad, a, success=False)
        assert word in cli('team', 'assign', bad, task, success=False)
        assert word in cli('team', 'assign', team, bad, success=False)
        assert word in cli('team', 'add-members', team, a, bad, success=False)
        assert cli('team', 'show', team)['members'] == []
    cli('team', 'add-members', team, a, a, success=False)
    assert cli('team', 'show', team)['members'] == []
    cli('team', 'add-members', team, a)
    cli('team', 'add-members', team, b, a, success=False)
    assert cli('team', 'show', team)['members'] == [a]
    cli('team', 'add-members', team, success=False)
    assert 'add-members' in cli('team', '--help', machine=False)
    assert 'duplicate membership' in cli('team', 'add-members', '--help', machine=False)
    assert 'Later membership' in cli('team', 'assign', '--help', machine=False)
