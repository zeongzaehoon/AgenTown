use llm_engine_core::{AgentId, DomainError, TaskId, TaskStatus, persistence::Persistence};
use llm_engine_sqlite::{SqliteStore, StorageError};
use rusqlite::Connection;

#[test]
fn identities_relationships_and_lifecycle_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product.sqlite3");
    let mut store = SqliteStore::open(&path).unwrap();
    assert_eq!(store.read().unwrap().agents().len(), 0);
    assert_eq!(store.read().unwrap().tasks().len(), 0);
    let (a, b, t) = store
        .transact(|c| {
            let a = c.create_agent("Developer")?;
            let b = c.create_agent("Reviewer")?;
            let t = c.create_task("Shared task")?;
            c.assign(t, a)?;
            c.assign(t, b)?;
            c.transition(t, TaskStatus::InProgress)?;
            c.transition(t, TaskStatus::Blocked)?;
            Ok((a, b, t))
        })
        .unwrap();
    let before = store.read().unwrap();
    drop(store);
    let mut store = SqliteStore::open(&path).unwrap();
    let restored = store.read().unwrap();
    assert_eq!(restored, before);
    assert_eq!(restored.agent(a).unwrap().name(), "Developer");
    assert_eq!(restored.agent(b).unwrap().name(), "Reviewer");
    assert_eq!(restored.task(t).unwrap().assignees().len(), 2);
    assert_eq!(restored.task(t).unwrap().status(), TaskStatus::Blocked);
    store
        .transact(|c| c.transition(t, TaskStatus::Cancelled))
        .unwrap();
    drop(store);
    let mut store = SqliteStore::open(&path).unwrap();
    assert_eq!(
        store.read().unwrap().task(t).unwrap().status(),
        TaskStatus::Cancelled
    );
    assert!(matches!(
        store.transact(|c| c.transition(t, TaskStatus::InProgress)),
        Err(StorageError::Domain(DomainError::InvalidTransition { .. }))
    ));
}

#[test]
fn domain_errors_roll_back_entire_batches() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product.sqlite3");
    let mut store = SqliteStore::open(&path).unwrap();
    let (a, t) = store
        .transact(|c| {
            let a = c.create_agent("A")?;
            let t = c.create_task("T")?;
            c.assign(t, a)?;
            Ok((a, t))
        })
        .unwrap();
    let before = store.read().unwrap();
    let missing_a: AgentId = "00000000-0000-0000-0000-000000000000".parse().unwrap();
    let missing_t: TaskId = "00000000-0000-0000-0000-000000000000".parse().unwrap();
    assert!(
        matches!(store.transact(|c| c.assign(t, missing_a)), Err(StorageError::Domain(DomainError::UnknownAgent(id))) if id == missing_a)
    );
    assert!(
        matches!(store.transact(|c| c.assign(missing_t, a)), Err(StorageError::Domain(DomainError::UnknownTask(id))) if id == missing_t)
    );
    assert!(matches!(
        store.transact(|c| {
            c.create_agent("Must roll back")?;
            c.assign(t, a)
        }),
        Err(StorageError::Domain(DomainError::AlreadyAssigned { .. }))
    ));
    drop(store);
    assert_eq!(SqliteStore::open(&path).unwrap().read().unwrap(), before);
}

#[test]
fn unsupported_versions_and_foreign_databases_are_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    for version in [-1, 7, 999] {
        let path = dir.path().join(format!("v{version}.sqlite3"));
        let mut store = SqliteStore::open(&path).unwrap();
        store.transact(|c| c.create_agent("Retain me")).unwrap();
        drop(store);
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
        drop(connection);
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            matches!(SqliteStore::open(&path), Err(StorageError::UnsupportedVersion(v)) if v == version)
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    let path = dir.path().join("unrelated.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retain');",
        )
        .unwrap();
    drop(connection);
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        SqliteStore::open(&path),
        Err(StorageError::ForeignDatabase)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn separate_connections_load_latest_committed_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product.sqlite3");
    let mut first = SqliteStore::open(&path).unwrap();
    let mut second = SqliteStore::open(&path).unwrap();
    let a = first.transact(|c| c.create_agent("A")).unwrap();
    let t = second
        .transact(|c| {
            let t = c.create_task("T")?;
            c.assign(t, a)?;
            Ok(t)
        })
        .unwrap();
    assert_eq!(
        first
            .read()
            .unwrap()
            .task(t)
            .unwrap()
            .assignees()
            .collect::<Vec<_>>(),
        vec![a]
    );
}

#[test]
fn invalid_stored_lifecycle_and_ids_are_rejected_without_repair() {
    let dir = tempfile::tempdir().unwrap();
    for (name, sql) in [
        (
            "status",
            "INSERT INTO tasks VALUES ('00000000-0000-0000-0000-000000000001', 'T', 'blocked')",
        ),
        ("id", "INSERT INTO agents VALUES ('bad-id', 'A')"),
        (
            "reference",
            "PRAGMA foreign_keys=OFF; INSERT INTO assignments VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')",
        ),
    ] {
        let path = dir.path().join(name);
        drop(SqliteStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(sql).unwrap();
        drop(connection);
        let bytes = std::fs::read(&path).unwrap();
        assert!(matches!(
            SqliteStore::open(&path),
            Err(StorageError::InvalidData(_))
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn incremental_writes_preserve_references_and_skip_net_noops() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product.sqlite3");
    let mut store = SqliteStore::open(&path).unwrap();
    let (a, t) = store
        .transact(|c| {
            let a = c.create_agent("Retained")?;
            let t = c.create_task("Retained task")?;
            c.assign(t, a)?;
            Ok((a, t))
        })
        .unwrap();
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch(
        "PRAGMA foreign_keys=ON;
        CREATE TABLE retained_refs (
            agent TEXT REFERENCES agents(id) ON DELETE RESTRICT,
            task TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
            FOREIGN KEY(task, agent) REFERENCES assignments(task_id, agent_id) ON DELETE RESTRICT
        );
        CREATE TABLE writes (entity TEXT, operation TEXT, id TEXT);",
    )
    .unwrap();
    sql.execute(
        "INSERT INTO retained_refs VALUES (?1, ?2)",
        rusqlite::params![a.to_string(), t.to_string()],
    )
    .unwrap();
    for (table, key) in [
        ("agents", "id"),
        ("tasks", "id"),
        ("assignments", "task_id || ':' || NEW.agent_id"),
    ] {
        for (op, row) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            let key = key.replace("NEW.", &format!("{row}."));
            sql.execute_batch(&format!(
                "CREATE TRIGGER audit_{table}_{op} AFTER {op} ON {table} BEGIN
                 INSERT INTO writes VALUES ('{table}', '{op}', {row}.{key}); END;"
            ))
            .unwrap();
        }
    }
    let mutations = || -> Vec<(String, String, String)> {
        sql.prepare("SELECT entity, operation, id FROM writes ORDER BY rowid")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let b = store.transact(|c| c.create_agent("New agent")).unwrap();
    assert_eq!(
        mutations(),
        vec![("agents".into(), "INSERT".into(), b.to_string())]
    );
    sql.execute("DELETE FROM writes", []).unwrap();
    store.transact(|c| c.assign(t, b)).unwrap();
    assert_eq!(
        mutations(),
        vec![("assignments".into(), "INSERT".into(), format!("{t}:{b}"))]
    );
    sql.execute("DELETE FROM writes", []).unwrap();
    store
        .transact(|c| c.transition(t, TaskStatus::InProgress))
        .unwrap();
    assert_eq!(
        mutations(),
        vec![("tasks".into(), "UPDATE".into(), t.to_string())]
    );
    sql.execute("DELETE FROM writes", []).unwrap();
    store.transact(|_| Ok(())).unwrap();
    store
        .transact(|c| {
            c.transition(t, TaskStatus::Blocked)?;
            c.transition(t, TaskStatus::InProgress)
        })
        .unwrap();
    assert!(mutations().is_empty());
    // Restored state can replace the Core through the existing persistence port.
    store
        .transact(|c| {
            let mut snapshot = llm_engine_core::persistence::Snapshot::default();
            snapshot.agents = vec![(a, "Renamed".into()), (b, "New agent".into())];
            snapshot.tasks = vec![(t, "Retitled".into(), TaskStatus::InProgress)];
            snapshot.assignments = vec![(t, a), (t, b)];
            *c = llm_engine_core::Core::restore(snapshot).unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        mutations(),
        vec![
            ("agents".into(), "UPDATE".into(), a.to_string()),
            ("tasks".into(), "UPDATE".into(), t.to_string()),
        ]
    );
    drop(store);
    let restored = SqliteStore::open(&path).unwrap().read().unwrap();
    assert_eq!(restored.agent(a).unwrap().name(), "Renamed");
    assert_eq!(restored.task(t).unwrap().assignees().len(), 2);
    assert_eq!(
        sql.query_row("SELECT count(*) FROM retained_refs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        6
    );
}
