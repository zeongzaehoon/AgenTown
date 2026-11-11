use llm_engine_core::{Core, TaskStatus, persistence::Persistence};
use llm_engine_sqlite::{ReadOnlyStore, SqliteStore, StorageError};
use rusqlite::{Connection, params};

fn v1(path: &std::path::Path) -> Core {
    let sql = Connection::open(path).unwrap();
    sql.execute_batch(include_str!("../src/schema.sql"))
        .unwrap();
    sql.execute_batch("PRAGMA application_id=1280068933; PRAGMA user_version=1;")
        .unwrap();
    let mut c = Core::default();
    let a = c.create_agent("A").unwrap();
    sql.execute("INSERT INTO agents VALUES (?1, 'A')", [a.to_string()])
        .unwrap();
    for status in [
        TaskStatus::Pending,
        TaskStatus::InProgress,
        TaskStatus::Blocked,
        TaskStatus::Cancelled,
    ] {
        let t = c.create_task("Work").unwrap();
        c.assign(t, a).unwrap();
        if matches!(status, TaskStatus::InProgress | TaskStatus::Blocked) {
            c.transition(t, TaskStatus::InProgress).unwrap();
        }
        if matches!(status, TaskStatus::Blocked | TaskStatus::Cancelled) {
            c.transition(t, status).unwrap();
        }
        let text = match status {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Cancelled => "cancelled",
        };
        sql.execute(
            "INSERT INTO tasks VALUES (?1, 'Work', ?2)",
            params![t.to_string(), text],
        )
        .unwrap();
        sql.execute(
            "INSERT INTO assignments VALUES (?1, ?2)",
            params![t.to_string(), a.to_string()],
        )
        .unwrap();
    }
    c
}

#[test]
fn writable_migration_preserves_v1_and_read_only_never_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let expected = v1(&path);
    let bytes = std::fs::read(&path).unwrap();
    let mut reader = ReadOnlyStore::open(&path).unwrap();
    assert_eq!(reader.read().unwrap(), expected);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let mut writer = SqliteStore::open(&path).unwrap();
    assert_eq!(writer.read().unwrap(), expected);
    let team = writer.transact(|c| c.create_team("TF")).unwrap();
    assert_eq!(reader.read().unwrap().team(team).unwrap().name(), "TF");
    drop(writer);
    assert_eq!(
        SqliteStore::open(&path).unwrap().read().unwrap(),
        reader.read().unwrap()
    );
    let sql = Connection::open(&path).unwrap();
    assert_eq!(
        sql.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        6
    );
}

#[test]
fn failed_migration_rolls_back_ddl_and_version_then_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let expected = v1(&path);
    let sql = Connection::open(&path).unwrap();
    // Collision occurs after CREATE TABLE teams, proving earlier DDL rolls back.
    sql.execute_batch(
        "CREATE TABLE team_members (sentinel TEXT); INSERT INTO team_members VALUES ('retained');",
    )
    .unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        SqliteStore::open(&path),
        Err(StorageError::Sqlite(_))
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        ReadOnlyStore::open(&path).unwrap().read().unwrap(),
        expected
    );
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='teams'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    sql.execute_batch("DROP TABLE team_members").unwrap();
    assert_eq!(SqliteStore::open(&path).unwrap().read().unwrap(), expected);
}

#[test]
fn membership_restart_atomic_batches_constraints_and_incremental_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = SqliteStore::open(&path).unwrap();
    let (a, b, team, t) = store
        .transact(|c| {
            let a = c.create_agent("A")?;
            let b = c.create_agent("B")?;
            let team = c.create_team("TF")?;
            let t = c.create_task("Work")?;
            c.add_team_members(team, &[a])?;
            c.assign_team(t, team)?;
            Ok((a, b, team, t))
        })
        .unwrap();
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE audit (entry TEXT);
      CREATE TRIGGER team_update AFTER UPDATE ON teams BEGIN INSERT INTO audit VALUES ('update'); END;
      CREATE TRIGGER team_delete AFTER DELETE ON teams BEGIN INSERT INTO audit VALUES ('delete'); END;
      CREATE TRIGGER member_insert AFTER INSERT ON team_members BEGIN INSERT INTO audit VALUES ('insert'); END;
      CREATE TRIGGER member_delete AFTER DELETE ON team_members BEGIN INSERT INTO audit VALUES ('delete'); END;
      CREATE TABLE retained(team TEXT REFERENCES teams(id));").unwrap();
    sql.execute("INSERT INTO retained VALUES (?1)", [team.to_string()])
        .unwrap();
    store.transact(|c| c.add_team_members(team, &[b])).unwrap();
    store.transact(|_| Ok(())).unwrap();
    assert_eq!(
        sql.query_row("SELECT group_concat(entry) FROM audit", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "insert"
    );
    let before = store.read().unwrap();
    assert!(
        store
            .transact(|c| {
                c.create_team("Rollback")?;
                c.assign_team(t, team)
            })
            .is_err()
    );
    assert!(
        store
            .transact(|c| {
                c.create_agent("Rollback")?;
                c.add_team_members(team, &[a])
            })
            .is_err()
    );
    // SQL failure after a team INSERT must roll back the new team and membership.
    sql.execute_batch("CREATE TRIGGER reject_member BEFORE INSERT ON team_members BEGIN SELECT RAISE(ABORT, 'injected membership failure'); END;").unwrap();
    assert!(
        store
            .transact(|c| {
                let team = c.create_team("Rollback")?;
                c.add_team_members(team, &[a])
            })
            .is_err()
    );
    drop(store);
    let reopened = SqliteStore::open(&path).unwrap().read().unwrap();
    assert_eq!(reopened, before);
    assert_eq!(reopened.team(team).unwrap().members().len(), 2);
    assert_eq!(
        reopened.task(t).unwrap().assignees().collect::<Vec<_>>(),
        vec![a]
    );
    sql.execute_batch("DROP TRIGGER reject_member").unwrap();
    for (team_id, agent_id) in [
        (team.to_string(), a.to_string()),
        (team.to_string(), "missing".into()),
        ("missing".into(), a.to_string()),
    ] {
        assert!(
            sql.execute(
                "INSERT INTO team_members VALUES (?1,?2)",
                params![team_id, agent_id]
            )
            .is_err()
        );
    }
}

#[test]
fn invalid_stored_membership_is_rejected_without_writes() {
    for corrupt in ["agent", "team", "uuid", "duplicate", "name"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, team) = store
            .transact(|c| {
                let a = c.create_agent("A")?;
                let team = c.create_team("TF")?;
                c.add_team_members(team, &[a])?;
                Ok((a, team))
            })
            .unwrap();
        drop(store);
        let sql = Connection::open(&path).unwrap();
        sql.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        match corrupt {
            "agent" => {
                sql.execute("DELETE FROM agents", []).unwrap();
            }
            "team" => {
                sql.execute("DELETE FROM teams", []).unwrap();
            }
            "uuid" => {
                sql.execute("UPDATE team_members SET agent_id='bad'", [])
                    .unwrap();
            }
            "name" => {
                sql.execute("UPDATE teams SET name=' TF '", []).unwrap();
            }
            _ => {
                sql.execute_batch("ALTER TABLE team_members RENAME TO old_members; CREATE TABLE team_members(team_id TEXT, agent_id TEXT); INSERT INTO team_members SELECT * FROM old_members;").unwrap();
                sql.execute(
                    "INSERT INTO team_members VALUES (?1,?2)",
                    params![team.to_string(), a.to_string()],
                )
                .unwrap();
            }
        }
        drop(sql);
        let bytes = std::fs::read(&path).unwrap();
        assert!(matches!(
            ReadOnlyStore::open(&path),
            Err(StorageError::InvalidData(_))
        ));
        assert!(matches!(
            SqliteStore::open(&path),
            Err(StorageError::InvalidData(_))
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}
