use llm_engine_core::{persistence::Persistence, *};
use llm_engine_sqlite::{ReadOnlyStore, SqliteStore};
#[test]
fn configuration_reopens_without_execution_and_failed_batch_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product.db");
    let mut db = SqliteStore::open(&path).unwrap();
    let (s, h, l) = db
        .transact(|c| {
            let a = c.create_agent("Existing employee")?;
            let t = c.create_task("Existing work")?;
            let s = c.create_skill("Skill", "instructions")?;
            let h = c.create_hook("Hook", s, HookTarget::Agent(a), HookEvent::RunCompleted)?;
            let l = c.create_loop_policy("Loop", t, 3, 120)?;
            c.set_skill_enabled(s, true)?;
            c.set_hook_enabled(h, true)?;
            c.set_loop_policy_enabled(l, true)?;
            c.update_skill(s, "Edited", "persisted instructions")?;
            c.update_hook(
                h,
                "Edited hook",
                s,
                HookTarget::Agent(a),
                HookEvent::RunFailed,
            )?;
            c.update_loop_policy(l, "Edited loop", t, 7, 600)?;
            Ok((s, h, l))
        })
        .unwrap();
    let before = db.read().unwrap();
    assert!(
        db.transact(|c| {
            c.update_skill(s, "Must roll back", "changed")?;
            {
                let task = c.tasks().next().unwrap().id();
                c.create_loop_policy("invalid", task, 0, 60)
            }
        })
        .is_err()
    );
    drop(db);
    let mut db = SqliteStore::open(&path).unwrap();
    let c = db.read().unwrap();
    assert_eq!(before, c);
    assert_eq!(c.skill(s).unwrap().instructions(), "persisted instructions");
    assert!(c.hook(h).unwrap().enabled());
    assert_eq!(c.loop_policy(l).unwrap().max_iterations(), 7);
    assert_eq!(c.runs().len(), 0);
    assert_eq!(c.agents().len(), 1);
    assert_eq!(c.tasks().len(), 1);
    assert_eq!(ReadOnlyStore::open(&path).unwrap().read().unwrap(), c);
    let sql = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM executions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn v5_migration_preserves_existing_product_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch(include_str!("../src/schema.sql"))
        .unwrap();
    for migration in [
        include_str!("../src/migration-v2.sql"),
        include_str!("../src/migration-v3.sql"),
        include_str!("../src/migration-v4.sql"),
        include_str!("../src/migration-v5.sql"),
    ] {
        sql.execute_batch(migration).unwrap();
    }
    sql.execute_batch("PRAGMA application_id=1280068933; PRAGMA user_version=5; INSERT INTO agents VALUES ('00000000-0000-0000-0000-000000000001','Legacy');").unwrap();
    drop(sql);
    let mut db = SqliteStore::open(&path).unwrap();
    let before = db.read().unwrap();
    assert_eq!(before.agents().next().unwrap().name(), "Legacy");
    assert_eq!(before.skills().len(), 0);
    db.transact(|c| c.create_skill("New", "instructions"))
        .unwrap();
    drop(db);
    let c = SqliteStore::open(&path).unwrap().read().unwrap();
    assert_eq!(c.agents().next(), before.agents().next());
    assert_eq!(c.skills().len(), 1);
}
