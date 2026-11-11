use llm_engine_core::persistence::Persistence;
use llm_engine_sqlite::{ReadOnlyStore, SqliteStore};

#[test]
fn existing_reader_observes_commits_and_snapshots_cannot_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product.sqlite");
    assert!(ReadOnlyStore::open(&path).is_err());
    assert!(!path.exists());
    let mut writer = SqliteStore::open(&path).unwrap();
    let mut reader = ReadOnlyStore::open(&path).unwrap();
    assert_eq!(reader.read().unwrap().agents().len(), 0);
    let (a, b, task) = writer
        .transact(|core| {
            let a = core.create_agent("A")?;
            let b = core.create_agent("B")?;
            let task = core.create_task("Shared")?;
            core.assign(task, a)?;
            core.assign(task, b)?;
            Ok((a, b, task))
        })
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let mut snapshot = reader.read().unwrap();
    assert_eq!(
        snapshot.task(task).unwrap().assignees().collect::<Vec<_>>(),
        {
            let mut ids = vec![a, b];
            ids.sort();
            ids
        }
    );
    snapshot.create_agent("Only in memory").unwrap();
    assert_eq!(reader.read().unwrap().agents().len(), 2);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(reader);
    assert_eq!(
        ReadOnlyStore::open(&path)
            .unwrap()
            .read()
            .unwrap()
            .tasks()
            .len(),
        1
    );
    // Recheck compatibility for an already-open reader as well as at open time.
    let mut reader = ReadOnlyStore::open(&path).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(reader.read().is_err());
    assert!(ReadOnlyStore::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
