use llm_engine_core::{
    AgentId, Core, DomainError, RunId, RunOutcome, RunState, RunTimestamp, TaskId,
    persistence::{Persistence, RunRecord, Snapshot},
};
use llm_engine_sqlite::{ReadOnlyStore, SqliteStore, StorageError};
use rusqlite::{Connection, params};

fn time(n: i64) -> RunTimestamp {
    RunTimestamp::from_unix_millis(n).unwrap()
}
fn seed(store: &mut SqliteStore) -> (AgentId, TaskId, RunId) {
    store
        .transact(|c| {
            let a = c.create_agent("A")?;
            let t = c.create_task("T")?;
            let team = c.create_team("TF")?;
            c.add_team_members(team, &[a])?;
            c.assign_team(t, team)?;
            let r = c.start_run(t, "implement", "operator", time(10), &[a])?;
            Ok((a, t, r))
        })
        .unwrap()
}
fn snapshot(c: &Core) -> Snapshot {
    Snapshot {
        skills: vec![],
        hooks: vec![],
        loop_policies: vec![],
        artifacts: Vec::new(),
        evidence: Vec::new(),
        agents: c.agents().map(|a| (a.id(), a.name().into())).collect(),
        tasks: c
            .tasks()
            .map(|t| (t.id(), t.title().into(), t.status()))
            .collect(),
        assignments: c
            .tasks()
            .flat_map(|t| t.assignees().map(move |a| (t.id(), a)))
            .collect(),
        teams: c.teams().map(|t| (t.id(), t.name().into())).collect(),
        memberships: c
            .teams()
            .flat_map(|t| t.members().map(move |a| (t.id(), a)))
            .collect(),
        runs: c
            .runs()
            .map(|r| RunRecord {
                id: r.id(),
                task: r.task(),
                stage: r.stage().into(),
                reporting_source: r.reporting_source().into(),
                started_at: r.started_at().unix_millis(),
                participants: r.participants().collect(),
                terminal: match r.state() {
                    RunState::Active => None,
                    RunState::Finished { outcome, ended_at } => {
                        Some((outcome, ended_at.unix_millis()))
                    }
                },
            })
            .collect(),
    }
}
#[test]
fn restart_retry_history_and_exact_mutation_audit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = SqliteStore::open(&path).unwrap();
    let (a, t, first) = seed(&mut store);
    let before = store.read().unwrap();
    drop(store);
    let bytes = std::fs::read(&path).unwrap();
    let mut store = SqliteStore::open(&path).unwrap();
    assert_eq!(store.read().unwrap(), before); // opening does not resume/finalize
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TABLE audit (entry TEXT NOT NULL);")
        .unwrap();
    for table in [
        "agents",
        "tasks",
        "assignments",
        "teams",
        "team_members",
        "runs",
        "run_participants",
    ] {
        for op in ["INSERT", "UPDATE", "DELETE"] {
            sql.execute_batch(&format!("CREATE TRIGGER audit_{table}_{op} AFTER {op} ON {table} BEGIN INSERT INTO audit VALUES ('{table}:{op}'); END;")).unwrap();
        }
    }
    let retry = store
        .transact(|c| {
            c.finish_run(first, RunOutcome::Failure, time(20))?;
            c.start_run(t, "implement", "operator", time(30), &[a])
        })
        .unwrap();
    store.transact(|_| Ok(())).unwrap();
    assert_eq!(
        sql.query_row("SELECT group_concat(entry) FROM audit", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "runs:UPDATE,runs:INSERT,run_participants:INSERT"
    );
    sql.execute_batch("DELETE FROM audit").unwrap();
    // Subsequent writes must never touch previous history or its participant rows.
    store
        .transact(|c| c.finish_run(retry, RunOutcome::ReportedSuccess, time(40)))
        .unwrap();
    assert_eq!(
        sql.query_row("SELECT group_concat(entry) FROM audit", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "runs:UPDATE"
    );
    let final_state = store.read().unwrap();
    assert_eq!(
        final_state.run(first).unwrap().state(),
        RunState::Finished {
            outcome: RunOutcome::Failure,
            ended_at: time(20)
        }
    );
    assert_eq!(final_state.task(t).unwrap(), before.task(t).unwrap());
    assert_ne!(first, retry);
    assert!(
        store
            .transact(|c| c.finish_run(first, RunOutcome::Interruption, time(50)))
            .is_err()
    );
    drop(store);
    assert_eq!(
        ReadOnlyStore::open(&path).unwrap().read().unwrap(),
        final_state
    );
    assert_eq!(
        SqliteStore::open(&path).unwrap().read().unwrap(),
        final_state
    );
}
#[test]
fn replacement_closures_cannot_erase_or_rewrite_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = SqliteStore::open(&path).unwrap();
    let (_, _, r) = seed(&mut store);
    for terminal in [false, true] {
        if terminal {
            store
                .transact(|c| c.finish_run(r, RunOutcome::Failure, time(20)))
                .unwrap();
        }
        let before = store.read().unwrap();
        for change in [
            "remove",
            "stage",
            "source",
            "start",
            "participants",
            "task",
            "outcome",
            "end",
            "reactivate",
        ] {
            if !terminal && ["outcome", "end", "reactivate"].contains(&change) {
                continue;
            }
            let mut data = snapshot(&before);
            match change {
                "remove" => data.runs.clear(),
                "stage" => data.runs[0].stage = "review".into(),
                "source" => data.runs[0].reporting_source = "another".into(),
                "start" => data.runs[0].started_at = 9,
                "participants" => {
                    let mut tmp = Core::default();
                    let a = tmp.create_agent("B").unwrap();
                    data.agents.push((a, "B".into()));
                    data.runs[0].participants.push(a);
                }
                "task" => {
                    let mut tmp = Core::default();
                    let t = tmp.create_task("Other").unwrap();
                    data.tasks
                        .push((t, "Other".into(), llm_engine_core::TaskStatus::Pending));
                    data.runs[0].task = t;
                }
                "outcome" => data.runs[0].terminal = Some((RunOutcome::ReportedSuccess, 20)),
                "end" => data.runs[0].terminal = Some((RunOutcome::Failure, 21)),
                _ => data.runs[0].terminal = None,
            }
            let replacement = Core::restore(data).unwrap();
            assert!(
                matches!(
                    store.transact(|c| {
                        *c = replacement;
                        Ok(())
                    }),
                    Err(StorageError::InvalidData(_))
                ),
                "{change}"
            );
            assert_eq!(store.read().unwrap(), before);
        }
    }
    let mut data = snapshot(&store.read().unwrap());
    data.assignments.clear();
    data.memberships.clear();
    let expected = Core::restore(data).unwrap();
    store
        .transact(|c| {
            *c = expected.clone();
            Ok(())
        })
        .unwrap();
    drop(store);
    assert_eq!(SqliteStore::open(&path).unwrap().read().unwrap(), expected);
}
#[test]
fn separate_connections_racing_to_start_have_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = SqliteStore::open(&path).unwrap();
    let (a, t, r) = seed(&mut store);
    store
        .transact(|c| c.finish_run(r, RunOutcome::Interruption, time(20)))
        .unwrap();
    drop(store);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut store = SqliteStore::open(path).unwrap();
                barrier.wait();
                store.transact(|c| c.start_run(t, "retry", "operator", time(30), &[a]))
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(
                r,
                Err(StorageError::Domain(DomainError::ActiveRunExists(_)))
            ))
            .count(),
        1
    );
    assert_eq!(
        SqliteStore::open(path)
            .unwrap()
            .read()
            .unwrap()
            .runs()
            .len(),
        2
    );
}
#[test]
fn v2_migration_and_failure_after_run_ddl_preserve_every_existing_record() {
    for fail in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let sql = Connection::open(&path).unwrap();
        sql.execute_batch(include_str!("../src/schema.sql"))
            .unwrap();
        sql.execute_batch(include_str!("../src/migration-v2.sql"))
            .unwrap();
        sql.execute_batch("PRAGMA application_id=1280068933; PRAGMA user_version=2;")
            .unwrap();
        let mut c = Core::default();
        let a = c.create_agent("A").unwrap();
        let t = c.create_task("T").unwrap();
        let team = c.create_team("TF").unwrap();
        sql.execute("INSERT INTO agents VALUES (?1,'A')", [a.to_string()])
            .unwrap();
        sql.execute(
            "INSERT INTO tasks VALUES (?1,'T','blocked')",
            [t.to_string()],
        )
        .unwrap();
        sql.execute(
            "INSERT INTO assignments VALUES (?1,?2)",
            params![t.to_string(), a.to_string()],
        )
        .unwrap();
        sql.execute("INSERT INTO teams VALUES (?1,'TF')", [team.to_string()])
            .unwrap();
        sql.execute(
            "INSERT INTO team_members VALUES (?1,?2)",
            params![team.to_string(), a.to_string()],
        )
        .unwrap();
        if fail {
            sql.execute_batch("CREATE TABLE run_participants(sentinel TEXT); INSERT INTO run_participants VALUES ('retained');").unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        let expected = ReadOnlyStore::open(&path).unwrap().read().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        if fail {
            assert!(SqliteStore::open(&path).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(
                sql.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name='runs'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            sql.execute_batch("DROP TABLE run_participants").unwrap();
        }
        assert_eq!(SqliteStore::open(&path).unwrap().read().unwrap(), expected);
        assert_eq!(
            sql.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            8
        );
    }
}
#[test]
fn malformed_stored_history_is_rejected_without_repair() {
    for corruption in [
        "task",
        "agent",
        "empty",
        "stage",
        "source",
        "start",
        "end",
        "pair",
        "outcome",
        "uuid",
        "duplicate_active",
        "duplicate_participant",
        "orphan_participant",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, _, _) = seed(&mut store);
        drop(store);
        let sql = Connection::open(&path).unwrap();
        // Simulate an externally corrupted file, bypassing constraints and protective triggers.
        sql.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;
            DROP TRIGGER preserve_runs; DROP TRIGGER preserve_participants; DROP TRIGGER retain_participants;").unwrap();
        match corruption {
            "task" => {
                sql.execute(
                    "UPDATE runs SET task_id=?1",
                    ["00000000-0000-4000-8000-000000000001"],
                )
                .unwrap();
            }
            "agent" => {
                sql.execute("DELETE FROM agents", []).unwrap();
            }
            "empty" => {
                sql.execute("DELETE FROM run_participants", []).unwrap();
            }
            "stage" => {
                sql.execute("UPDATE runs SET stage=' '", []).unwrap();
            }
            "source" => {
                sql.execute("UPDATE runs SET reporting_source=' operator '", [])
                    .unwrap();
            }
            "start" => {
                sql.execute("UPDATE runs SET started_at=-1", []).unwrap();
            }
            "end" => {
                sql.execute("UPDATE runs SET outcome='failure', ended_at=9", [])
                    .unwrap();
            }
            "pair" => {
                sql.execute("UPDATE runs SET ended_at=20", []).unwrap();
            }
            "outcome" => {
                sql.execute("UPDATE runs SET outcome='verified', ended_at=20", [])
                    .unwrap();
            }
            "uuid" => {
                sql.execute("UPDATE runs SET id='bad'", []).unwrap();
            }
            "duplicate_active" => {
                sql.execute_batch("DROP INDEX one_active_run_per_task")
                    .unwrap();
                let other = "00000000-0000-4000-8000-000000000001";
                sql.execute("INSERT INTO runs SELECT ?1, task_id, stage, reporting_source, started_at, outcome, ended_at FROM runs", [other]).unwrap();
                sql.execute(
                    "INSERT INTO run_participants VALUES (?1, ?2)",
                    params![other, a.to_string()],
                )
                .unwrap();
            }
            "duplicate_participant" => {
                sql.execute_batch("ALTER TABLE run_participants RENAME TO old_participants; CREATE TABLE run_participants(run_id TEXT, agent_id TEXT); INSERT INTO run_participants SELECT * FROM old_participants; INSERT INTO run_participants SELECT * FROM old_participants;").unwrap();
            }
            _ => {
                sql.execute(
                    "UPDATE run_participants SET run_id=?1",
                    ["00000000-0000-4000-8000-000000000001"],
                )
                .unwrap();
            }
        }
        drop(sql);
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            matches!(
                ReadOnlyStore::open(&path),
                Err(StorageError::InvalidData(_))
            ),
            "{corruption}"
        );
        assert!(
            matches!(SqliteStore::open(&path), Err(StorageError::InvalidData(_))),
            "{corruption}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{corruption}");
    }
}
#[test]
fn sql_constraints_enforce_references_active_uniqueness_and_retention() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = SqliteStore::open(&path).unwrap();
    let (_, _, r) = seed(&mut store);
    let sql = Connection::open(&path).unwrap();
    sql.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    for command in [
        "INSERT INTO runs SELECT 'other',task_id,stage,reporting_source,started_at,outcome,ended_at FROM runs",
        "INSERT INTO runs VALUES ('other','missing','stage','source',0,NULL,NULL)",
        "INSERT INTO run_participants VALUES ('missing','missing')",
        "INSERT INTO run_participants SELECT run_id,'missing' FROM run_participants",
        "INSERT INTO run_participants SELECT * FROM run_participants",
        "DELETE FROM runs",
        "DELETE FROM run_participants",
        "DELETE FROM tasks",
        "DELETE FROM agents",
        "UPDATE run_participants SET agent_id='missing'",
        "UPDATE runs SET stage='changed'",
        "UPDATE runs SET outcome='failure'",
        "UPDATE runs SET outcome='failure',ended_at=9",
    ] {
        assert!(sql.execute(command, []).is_err(), "{command}");
    }
    store
        .transact(|c| c.finish_run(r, RunOutcome::Failure, time(20)))
        .unwrap();
    for command in [
        "UPDATE runs SET outcome='reported_success'",
        "UPDATE runs SET ended_at=21",
        "UPDATE runs SET outcome=NULL,ended_at=NULL",
    ] {
        assert!(sql.execute(command, []).is_err(), "{command}");
    }
}
