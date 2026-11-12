//! Process-lifetime exclusive authority. Dropping the handle releases the OS lock;
//! a crashed process cannot leave a stale lock. Never unlink the lock file.
use super::*;
use llm_engine_core::LoopSessionId;
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
};

pub struct LoopExecutionOwner {
    database: PathBuf,
    runtime: String,
    _lock: File,
}
impl LoopExecutionOwner {
    /// All product execution services must retain this handle until their workers
    /// have stopped. Acquisition does not recover sessions or consume consent.
    pub fn acquire(database: impl AsRef<Path>) -> Result<Self, StorageError> {
        let store = SqliteStore::open(database.as_ref())?;
        let database = std::fs::canonicalize(database).map_err(|_| Self::storage_failure())?;
        let mut lock_path = database.as_os_str().to_os_string();
        lock_path.push(".loop-owner");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| Self::storage_failure())?;
        lock.try_lock().map_err(|e| match e {
            std::fs::TryLockError::WouldBlock => Self::conflict(),
            _ => Self::storage_failure(),
        })?;
        let runtime = store
            .connection
            .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        Ok(Self {
            database,
            runtime,
            _lock: lock,
        })
    }
    fn storage_failure() -> StorageError {
        StorageError::InvalidData("Loop ownership storage unavailable".into())
    }
    fn conflict() -> StorageError {
        StorageError::LoopOwnershipUnavailable
    }
    /// Advisory shared-lock probe: never creates an execution owner, database,
    /// lock file, runtime identity or recovery work. Explicit control must still
    /// acquire the exclusive lock; availability can change immediately.
    pub fn control_available(database: impl AsRef<Path>) -> Result<bool, StorageError> {
        ReadOnlyStore::open(database.as_ref())?;
        let database = std::fs::canonicalize(database).map_err(|_| Self::storage_failure())?;
        let mut path = database.as_os_str().to_os_string();
        path.push(".loop-owner");
        let lock = match File::open(path) {
            Ok(lock) => lock,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(_) => return Err(Self::storage_failure()),
        };
        match lock.try_lock_shared() {
            Ok(()) => Ok(true),
            Err(std::fs::TryLockError::WouldBlock) => Ok(false),
            Err(_) => Err(Self::storage_failure()),
        }
    }
    pub fn recover(&self) -> Result<(), StorageError> {
        SqliteStore::open(&self.database)?.recover_loop_sessions(&self.runtime)
    }
    pub fn start(
        &self,
        preview_id: &str,
        expected_runs: usize,
        provider: &str,
        model: &str,
        secrets: &[String],
        declared_source: Option<&str>,
    ) -> Result<LoopSession, StorageError> {
        SqliteStore::open(&self.database)?.start_loop_at_source(
            preview_id,
            expected_runs,
            provider,
            model,
            &self.runtime,
            secrets,
            execution::now()?.unix_millis(),
            declared_source,
        )
    }
    pub fn admit(
        &self,
        id: LoopSessionId,
        secrets: &[String],
    ) -> Result<Option<Execution>, StorageError> {
        SqliteStore::open(&self.database)?.admit_loop_attempt(id, &self.runtime, secrets)
    }
    pub fn stop(&self, id: LoopSessionId) -> Result<LoopSession, StorageError> {
        let mut store = SqliteStore::open(&self.database)?;
        let runtime: String = store.connection.query_row(
            "SELECT runtime_id FROM loop_sessions WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )?;
        if runtime != self.runtime {
            return Err(Self::conflict());
        }
        store.stop_loop_session(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, PathBuf, LoopPreview) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("product.db");
        let mut store = SqliteStore::open(&path).unwrap();
        let policy = store
            .transact(|c| {
                let a = c.create_agent("Writer")?;
                let t = c.create_text_work("Saved input")?;
                c.assign(t, a)?;
                let p = c.create_loop_policy("Repeat", t, 2, 60)?;
                c.set_loop_policy_enabled(p, true)?;
                Ok(p)
            })
            .unwrap();
        let preview = store.preview_loop(policy, &[]).unwrap();
        (dir, path, preview)
    }
    #[test]
    fn advisory_inspection_never_creates_owner_or_recovers() {
        let (_dir, path, preview) = setup();
        let lock_path = PathBuf::from(format!("{}.loop-owner", path.display()));
        assert!(!lock_path.exists());
        assert!(LoopExecutionOwner::control_available(&path).unwrap());
        assert!(!lock_path.exists());
        let owner = LoopExecutionOwner::acquire(&path).unwrap();
        let session = owner
            .start(&preview.preview_id, 0, "fixture", "model", &[], Some("mcp"))
            .unwrap();
        assert!(!LoopExecutionOwner::control_available(&path).unwrap());
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.loop_sessions().unwrap(), vec![session.clone()]);
        assert!(store.loop_attempts().unwrap().is_empty());
        drop(owner);
        assert!(LoopExecutionOwner::control_available(&path).unwrap());
        assert_eq!(store.loop_sessions().unwrap(), vec![session]);
        assert!(store.loop_attempts().unwrap().is_empty());
        assert!(LoopExecutionOwner::control_available(path.join("missing")).is_err());
    }
    #[test]
    fn owner_lock_excludes_another_process() {
        const PATH_KEY: &str = "AGENTOWN_LOOP_OWNER_TEST_PATH";
        if let Some(path) = std::env::var_os(PATH_KEY) {
            let available = std::env::var_os("AGENTOWN_LOOP_OWNER_TEST_AVAILABLE").is_some();
            assert_eq!(
                LoopExecutionOwner::acquire(PathBuf::from(path)).is_ok(),
                available
            );
            return;
        }
        let (_dir, path, _) = setup();
        let owner = LoopExecutionOwner::acquire(&path).unwrap();
        let child = |available: bool| {
            let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
            cmd.args([
                "--exact",
                "loop_owner::tests::owner_lock_excludes_another_process",
            ])
            .env(PATH_KEY, &path)
            .env_remove("AGENTOWN_LOOP_OWNER_TEST_AVAILABLE");
            if available {
                cmd.env("AGENTOWN_LOOP_OWNER_TEST_AVAILABLE", "1");
            }
            assert!(cmd.status().unwrap().success());
        };
        child(false);
        drop(owner);
        child(true);
    }
    #[test]
    #[cfg(unix)]
    fn database_symlink_cannot_bypass_live_owner() {
        let (dir, path, preview) = setup();
        let alias = dir.path().join("alias.db");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let owner = LoopExecutionOwner::acquire(&path).unwrap();
        let session = owner
            .start(&preview.preview_id, 0, "fixture", "model", &[], Some("web"))
            .unwrap();

        assert!(LoopExecutionOwner::acquire(&alias).is_err());
        let store = SqliteStore::open(&alias).unwrap();
        assert_eq!(store.loop_sessions().unwrap()[0], session);
        assert!(store.loop_attempts().unwrap().is_empty());

        drop(owner);
        let restarted = LoopExecutionOwner::acquire(&alias).unwrap();
        assert!(LoopExecutionOwner::acquire(&path).is_err());
        restarted.recover().unwrap();
        assert_eq!(store.loop_sessions().unwrap()[0].state, "restarted");
        assert!(store.loop_attempts().unwrap().is_empty());
    }
    #[test]
    fn source_activation_rollback_and_v9_migration_survive_reopen() {
        let (_dir, path, p) = setup();
        // Reconstruct v9 and verify migration preserves previews and consent.
        let store = SqliteStore::open(&path).unwrap();
        store.connection.execute_batch("DROP TRIGGER loop_session_source_immutable; ALTER TABLE loop_sessions DROP COLUMN declared_source; PRAGMA user_version=9;").unwrap();
        drop(store);
        let owner = LoopExecutionOwner::acquire(&path).unwrap();
        let store = SqliteStore::open(&path).unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_loop_activation BEFORE INSERT ON loop_sessions BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(
            owner
                .start(&p.preview_id, 0, "fixture", "model", &[], Some("mcp"))
                .is_err()
        );
        drop(store);
        let store = SqliteStore::open(&path).unwrap();
        assert!(store.loop_sessions().unwrap().is_empty());
        assert!(store.loop_attempts().unwrap().is_empty());
        store
            .connection
            .execute_batch("DROP TRIGGER fail_loop_activation")
            .unwrap();
        let session = owner
            .start(&p.preview_id, 0, "fixture", "model", &[], Some("mcp"))
            .unwrap();
        drop(store);
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.loop_sessions().unwrap()[0], session);
        assert_eq!(session.declared_source.as_deref(), Some("mcp"));
    }
    #[test]
    fn live_owner_excludes_competitors_without_consuming_consent() {
        let (_dir, path, p) = setup();
        let owner = LoopExecutionOwner::acquire(&path).unwrap();
        let other = path.clone();
        assert!(
            std::thread::spawn(move || LoopExecutionOwner::acquire(other).is_err())
                .join()
                .unwrap()
        );
        let s = owner
            .start(
                &p.preview_id,
                0,
                "fixture",
                "model",
                &[],
                Some("mcp:untrusted"),
            )
            .unwrap();
        assert!(
            owner
                .start(&p.preview_id, 0, "fixture", "model", &[], None)
                .is_err()
        );
        assert!(LoopExecutionOwner::acquire(&path).is_err());
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.loop_sessions().unwrap()[0].state, "active");
        assert!(
            store
                .admit_loop_attempt(s.session_id, "foreign", &[])
                .is_err()
        );
        assert_eq!(store.loop_sessions().unwrap()[0].state, "active");
        assert!(store.loop_attempts().unwrap().is_empty());
        let run = owner.admit(s.session_id, &[]).unwrap().unwrap();
        assert_eq!(store.loop_attempts().unwrap()[0].run_id, run.run);
        owner.stop(s.session_id).unwrap();
        assert!(owner.admit(s.session_id, &[]).is_err());
        drop(owner);
        let restarted = LoopExecutionOwner::acquire(&path).unwrap();
        restarted.recover().unwrap();
        assert_eq!(
            store.loop_sessions().unwrap()[0].declared_source.as_deref(),
            Some("mcp:untrusted")
        );
        assert!(restarted.stop(s.session_id).is_err());
        assert_eq!(store.loop_attempts().unwrap().len(), 1);
    }
    #[test]
    fn abandoned_session_is_closed_without_replay_and_source_rejections_are_atomic() {
        let (_dir, path, p) = setup();
        let owner = LoopExecutionOwner::acquire(&path).unwrap();
        for source in ["", "bad\nsource", &"x".repeat(81), "secret"] {
            assert!(
                owner
                    .start(
                        &p.preview_id,
                        0,
                        "fixture",
                        "model",
                        &["secret".into()],
                        Some(source)
                    )
                    .is_err()
            );
        }
        let s = owner
            .start(&p.preview_id, 0, "fixture", "model", &[], Some("web"))
            .unwrap();
        drop(owner);
        let next = LoopExecutionOwner::acquire(&path).unwrap();
        next.recover().unwrap();
        assert!(next.admit(s.session_id, &[]).is_err());
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.loop_sessions().unwrap()[0].state, "restarted");
        assert_eq!(
            store.loop_sessions().unwrap()[0].declared_source.as_deref(),
            Some("web")
        );
        assert!(store.loop_attempts().unwrap().is_empty());
        assert!(
            store
                .connection
                .execute("UPDATE loop_sessions SET declared_source='spoofed'", [])
                .is_err()
        );
    }
}
