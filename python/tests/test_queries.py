"""Read-only native contract against real files and committed CLI processes."""
import sqlite3
import uuid

import pytest

from llm_engine import _native
from test_cli import cli  # shared subprocess fixture


@pytest.fixture
def database(cli, tmp_path):
    assert cli("agent", "list") == []  # existing CLI still initializes
    return tmp_path / "product.sqlite"


def test_empty_and_persisted_queries_observe_cli_commits(database, cli):
    path = str(database)
    before = database.read_bytes()
    assert _native.query_agents(path) == []
    assert _native.query_tasks(path) == []
    assert database.read_bytes() == before
    first = cli("agent", "create", "Designer")
    second = cli("agent", "create", "Developer")
    task = cli("task", "create", "Shared")
    cli("task", "assign", task["id"], first["id"], second["id"])
    before = database.read_bytes()
    assert _native.query_agent(path, first["id"]) == (first["id"], "Designer")
    assert set(_native.query_agents(path)) == {
        (first["id"], "Designer"), (second["id"], "Developer")}
    record = _native.query_task(path, task["id"])
    assert record[:3] == (task["id"], "Shared", "pending")
    assert set(record[3]) == {first["id"], second["id"]}
    assert _native.query_tasks(path) == [record]
    assert database.read_bytes() == before
    later = cli("task", "create", "Later committed write")
    assert {t[0] for t in _native.query_tasks(path)} == {task["id"], later["id"]}


@pytest.mark.parametrize("query,kind", [(_native.query_agent, "agent"),
                                         (_native.query_task, "task")])
def test_invalid_and_unknown_ids_preserve_database(database, query, kind):
    before = database.read_bytes()
    for value, message in [("bad", f"invalid {kind} ID"),
                           (str(uuid.uuid4()), f"unknown {kind}")]:
        with pytest.raises(ValueError, match=message):
            query(str(database), value)
        assert database.read_bytes() == before


def queries(path):
    return [lambda: _native.query_agents(str(path)),
            lambda: _native.query_tasks(str(path)),
            lambda: _native.query_agent(str(path), str(uuid.uuid4())),
            lambda: _native.query_task(str(path), str(uuid.uuid4()))]


def test_missing_path_never_created(tmp_path):
    path = tmp_path / "missing.sqlite"
    for query in queries(path):
        with pytest.raises(ValueError, match="database error"):
            query()
        assert not path.exists()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("kind", ["empty", "foreign", "wrong_owner", "future", "zero",
                                  "missing_table", "not_sqlite"])
def test_invalid_database_is_not_initialized_or_migrated(tmp_path, kind):
    path = tmp_path / "invalid.sqlite"
    if kind == "not_sqlite":
        path.write_bytes(b"not a SQLite database")
    else:
        if kind in {"wrong_owner", "future", "zero", "missing_table"}:
            _native.list_agents(str(path))
        with sqlite3.connect(path) as connection:
            if kind == "foreign":
                connection.execute("CREATE TABLE unrelated(value)")
            elif kind == "wrong_owner":
                connection.execute("PRAGMA application_id=123")
            elif kind == "future":
                connection.execute("PRAGMA user_version=99")
            elif kind == "zero":
                connection.execute("PRAGMA user_version=0")
            elif kind == "missing_table":
                connection.execute("DROP TABLE assignments")
    before = path.read_bytes()
    for query in queries(path):
        with pytest.raises(ValueError):
            query()
        assert path.read_bytes() == before


@pytest.mark.parametrize("mutation", [
    "UPDATE agents SET id='bad'",
    "UPDATE agents SET name=' padded '",
    "UPDATE tasks SET title=''",
    "UPDATE tasks SET status='done'",
    "UPDATE tasks SET status='in_progress'",
    "INSERT INTO assignments VALUES ('missing', 'missing')",
])
def test_invalid_stored_domain_rejected_without_repair(database, cli, mutation):
    cli("agent", "create", "A")
    cli("task", "create", "T")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA ignore_check_constraints=ON")
        connection.execute(mutation)
    before = database.read_bytes()
    for query in queries(database):
        with pytest.raises(ValueError, match="invalid stored"):
            query()
        assert database.read_bytes() == before
