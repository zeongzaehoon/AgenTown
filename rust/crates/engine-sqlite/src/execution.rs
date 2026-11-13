//! Provider-neutral execution commands. SDK I/O never holds a transaction.
use super::*;
use llm_engine_core::{AgentId, RunId, RunTimestamp, TaskId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Execution {
    pub run: RunId,
    pub input: String,
    pub provider: String,
    pub model: String,
    pub deadline: i64,
    pub output: Option<String>,
    pub error: Option<String>,
}
pub(super) fn now() -> Result<RunTimestamp, StorageError> {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StorageError::InvalidData("clock before epoch".into()))?
        .as_millis();
    Ok(RunTimestamp::from_unix_millis(i64::try_from(ms).map_err(
        |_| StorageError::InvalidData("clock overflow".into()),
    )?)?)
}
pub(super) fn get(tx: &Connection, id: RunId) -> Result<Execution, StorageError> {
    Ok(tx.query_row(
        "SELECT input, provider, model, deadline, output, error FROM executions WHERE run_id=?1",
        [id.to_string()],
        |r| {
            Ok(Execution {
                run: id,
                input: r.get(0)?,
                provider: r.get(1)?,
                model: r.get(2)?,
                deadline: r.get(3)?,
                output: r.get(4)?,
                error: r.get(5)?,
            })
        },
    )?)
}
pub(super) fn recover(tx: &Connection, timestamp: RunTimestamp) -> Result<(), StorageError> {
    let before = load(tx)?;
    let mut after = before.clone();
    let mut statement = tx.prepare(
        "SELECT run_id FROM executions WHERE output IS NULL AND error IS NULL AND deadline<=?1",
    )?;
    let ids = statement
        .query_map([timestamp.unix_millis()], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        let id = parse_id(id)?;
        after.finish_run(id, RunOutcome::Interruption, timestamp)?;
        tx.execute(
            "UPDATE executions SET error='interrupted' WHERE run_id=?1",
            [id.to_string()],
        )?;
    }
    persist_execution_changes(tx, &before, &after, true)
}
pub(super) fn validate(tx: &Connection, core: &Core) -> Result<(), StorageError> {
    let mut statement = tx.prepare("SELECT run_id FROM executions")?;
    for id in statement.query_map([], |r| r.get::<_, String>(0))? {
        let id = parse_id(id?)?;
        let e = get(tx, id)?;
        let run = core.run(id)?;
        let valid_terminal = match (run.state(), e.output.as_deref(), e.error.as_deref()) {
            (RunState::Active, None, None) => true,
            (
                RunState::Finished {
                    outcome: RunOutcome::ReportedSuccess,
                    ..
                },
                Some(text),
                None,
            ) => !text.trim().is_empty() && text.len() <= 1_000_000,
            (
                RunState::Finished {
                    outcome: RunOutcome::Interruption,
                    ..
                },
                None,
                Some("interrupted"),
            ) => true,
            (
                RunState::Finished {
                    outcome: RunOutcome::Failure,
                    ..
                },
                None,
                Some(
                    "authentication" | "rate_limit" | "timeout" | "network" | "malformed_response"
                    | "output_limit" | "empty_response" | "refusal" | "provider_error",
                ),
            ) => true,
            _ => false,
        };
        if !valid_terminal
            || run.stage() != "text_execution"
            || run.participants().len() != 1
            || e.deadline != run.started_at().unix_millis() + 120_000
            || e.provider != run.reporting_source()
            || e.input.trim().is_empty()
            || e.input.len() > 100_000
            || e.provider.trim().is_empty()
            || e.provider.len() > 80
            || e.model.trim().is_empty()
            || e.model.len() > 200
        {
            return Err(StorageError::InvalidData(
                "invalid execution relationship or result".into(),
            ));
        }
    }
    Ok(())
}
impl ReadOnlyStore {
    /// Inspect one coherent history snapshot without recovering expired leases.
    /// The read-only connection cannot initialize, migrate, or persist state.
    pub fn execution_snapshot(&mut self) -> Result<(Core, Vec<Execution>), StorageError> {
        let tx = self.connection.transaction()?;
        check_version(&tx)?;
        let core = load(&tx)?;
        let executions = snapshot_executions(&tx)?;
        tx.commit()?;
        Ok((core, executions))
    }
}

fn snapshot_executions(tx: &Connection) -> Result<Vec<Execution>, StorageError> {
    let mut statement = tx.prepare("SELECT run_id FROM executions ORDER BY run_id")?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter().map(|id| get(tx, parse_id(id)?)).collect()
}

impl SqliteStore {
    /// Recover leases and read all history from the same transaction. Separate
    /// run/result reads can straddle recovery or another process's completion.
    pub fn execution_snapshot(&mut self) -> Result<(Core, Vec<Execution>), StorageError> {
        self.execution_snapshot_at(now()?)
    }
    fn execution_snapshot_at(
        &mut self,
        timestamp: RunTimestamp,
    ) -> Result<(Core, Vec<Execution>), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        recover(&tx, timestamp)?;
        let core = load(&tx)?;
        let executions = snapshot_executions(&tx)?;
        tx.commit()?;
        Ok((core, executions))
    }

    pub fn recover_executions(&mut self) -> Result<(), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        recover(&tx, now()?)?;
        tx.commit()?;
        Ok(())
    }
    pub fn execution(&mut self, id: RunId) -> Result<Execution, StorageError> {
        self.recover_executions()?;
        get(&self.connection, id)
    }
    /// Inspect a persisted execution without recovering leases or changing Run state.
    /// Callers that need current lifecycle state must use `execution` instead.
    pub fn execution_read_only(&self, id: RunId) -> Result<Execution, StorageError> {
        get(&self.connection, id)
    }
    pub fn start_execution(
        &mut self,
        task: TaskId,
        agent: AgentId,
        input: &str,
        provider: &str,
        model: &str,
    ) -> Result<Execution, StorageError> {
        self.start_execution_guarded(task, agent, input, provider, model, None)
    }
    /// Compare the observed attempt count inside admission's write transaction.
    /// A replay (including after a fast response) cannot silently become a retry.
    pub fn start_execution_guarded(
        &mut self,
        task: TaskId,
        agent: AgentId,
        input: &str,
        provider: &str,
        model: &str,
        expected_runs: Option<usize>,
    ) -> Result<Execution, StorageError> {
        for (value, limit) in [(input, 100_000), (provider, 80), (model, 200)] {
            if value.trim().is_empty() || value.len() > limit {
                return Err(StorageError::InvalidData(
                    "execution configuration/input is empty or too long".into(),
                ));
            }
        }
        self.recover_executions()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let before = load(&tx)?;
        let mut after = before.clone();
        let timestamp = now()?;
        if let Some(expected) = expected_runs {
            if before.runs_for_task(task)?.count() != expected {
                return Err(StorageError::InvalidData(
                    "work changed; refresh before explicit retry".into(),
                ));
            }
        }
        let id = after.start_run(task, "text_execution", provider, timestamp, &[agent])?;
        persist_execution_changes(&tx, &before, &after, true)?;
        tx.execute(
            "INSERT INTO executions(run_id,input,provider,model,deadline) VALUES (?1,?2,?3,?4,?5)",
            params![
                id.to_string(),
                input,
                provider,
                model,
                timestamp.unix_millis() + 120_000
            ],
        )?;
        let result = get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    /// Explicit MCP admission. Saved input, assignment and attempt count are
    /// resolved under the same writer lock. Caller source is only a declaration.
    pub fn start_mcp_execution(
        &mut self,
        task: TaskId,
        provider: &str,
        model: &str,
        expected_runs: usize,
        resubmission_consent: bool,
        declared_source: &str,
    ) -> Result<Execution, StorageError> {
        for (value, limit) in [(provider, 80), (model, 200), (declared_source, 80)] {
            if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control)
            {
                return Err(StorageError::InvalidData(
                    "invalid execution configuration".into(),
                ));
            }
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = now()?;
        recover(&tx, timestamp)?;
        let before = load(&tx)?;
        let work = before.task(task)?;
        let assignees: Vec<_> = work.assignees().collect();
        if assignees.len() != 1 {
            return Err(StorageError::InvalidData(
                "work must have exactly one assigned employee".into(),
            ));
        }
        let count = before.runs_for_task(task)?.count();
        if count != expected_runs {
            return Err(StorageError::InvalidData(
                "work changed; refresh before explicit retry".into(),
            ));
        }
        if count > 0 && !resubmission_consent {
            return Err(StorageError::InvalidData(
                "explicit resubmission consent required".into(),
            ));
        }
        let input = work.title();
        if input.trim().is_empty() || input.len() > 100_000 {
            return Err(StorageError::InvalidData("invalid saved work text".into()));
        }
        let mut after = before.clone();
        let id = after.start_run(task, "text_execution", provider, timestamp, &assignees)?;
        persist_execution_changes(&tx, &before, &after, true)?;
        tx.execute(
            "INSERT INTO executions(run_id,input,provider,model,deadline) VALUES (?1,?2,?3,?4,?5)",
            params![
                id.to_string(),
                input,
                provider,
                model,
                timestamp.unix_millis() + 120_000
            ],
        )?;
        tx.execute(
            "INSERT INTO execution_sources(run_id,declared_source) VALUES (?1,?2)",
            params![id.to_string(), declared_source],
        )?;
        let result = get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    /// Metadata for history consumers; absence means legacy/non-MCP, not identity.
    pub fn execution_sources(&self) -> Result<Vec<(String, String)>, StorageError> {
        let mut statement = self
            .connection
            .prepare("SELECT run_id, declared_source FROM execution_sources ORDER BY run_id")?;
        Ok(statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn finish_execution(
        &mut self,
        id: RunId,
        output: Option<&str>,
        error: Option<&str>,
    ) -> Result<Execution, StorageError> {
        match (output, error) {
            (Some(value), None) if !value.trim().is_empty() && value.len() <= 1_000_000 => (),
            (
                None,
                Some(
                    "authentication" | "rate_limit" | "timeout" | "network" | "malformed_response"
                    | "output_limit" | "empty_response" | "refusal" | "provider_error"
                    | "interrupted",
                ),
            ) => (),
            _ => return Err(StorageError::InvalidData("invalid execution result".into())),
        }
        self.recover_executions()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = get(&tx, id)?;
        let before = load(&tx)?;
        let mut after = before.clone();
        let timestamp = now()?;
        if timestamp.unix_millis() >= record.deadline {
            return Err(StorageError::InvalidData(
                "expired execution; response rejected".into(),
            ));
        }
        let outcome = if output.is_some() {
            RunOutcome::ReportedSuccess
        } else if error == Some("interrupted") {
            RunOutcome::Interruption
        } else {
            RunOutcome::Failure
        };
        after.finish_run(id, outcome, timestamp)?;
        tx.execute(
            "UPDATE executions SET output=?2,error=?3 WHERE run_id=?1",
            params![id.to_string(), output, error],
        )?;
        persist_execution_changes(&tx, &before, &after, true)?;
        let result = get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seed(store: &mut SqliteStore) -> (AgentId, TaskId) {
        store
            .transact(|c| {
                let a = c.create_agent("Writer")?;
                let t = c.create_task("Summary")?;
                c.assign(t, a)?;
                Ok((a, t))
            })
            .unwrap()
    }
    #[test]
    fn restart_duplicate_terminal_atomicity_and_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = seed(&mut store);
        let first = store
            .start_execution(t, a, "Summarize: hello", "test", "fixture")
            .unwrap();
        let mut other = SqliteStore::open(&path).unwrap();
        assert!(other
            .start_execution(t, a, "duplicate", "test", "fixture")
            .is_err());
        assert!(other
            .transact(|c| c.finish_run(first.run, RunOutcome::Failure, now().unwrap()))
            .is_err());
        // Inject failure after result write, during terminal Run write.
        store.connection.execute_batch("CREATE TRIGGER fail_finish BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(store
            .finish_execution(first.run, Some("result"), None)
            .is_err());
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.execution(first.run).unwrap(), first);
        assert_eq!(
            store.read().unwrap().run(first.run).unwrap().state(),
            RunState::Active
        );
        store
            .connection
            .execute_batch("DROP TRIGGER fail_finish")
            .unwrap();
        let finished = store
            .finish_execution(first.run, Some("result"), None)
            .unwrap();
        assert!(store
            .finish_execution(first.run, Some("late"), None)
            .is_err());
        assert!(store
            .finish_execution(first.run, None, Some("secret error"))
            .is_err());
        let retry = store
            .start_execution(t, a, "Draft next", "test", "fixture")
            .unwrap();
        assert_ne!(first.run, retry.run);
        store
            .finish_execution(retry.run, None, Some("rate_limit"))
            .unwrap();
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.execution(first.run).unwrap(), finished);
        assert_eq!(
            store.read().unwrap().task(t).unwrap().status(),
            TaskStatus::Pending
        );
        assert_eq!(store.read().unwrap().runs_for_task(t).unwrap().count(), 2);
    }
    #[test]
    fn output_limit_is_atomic_and_retained_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = seed(&mut store);
        let old = store
            .start_execution(t, a, "original", "test", "model")
            .unwrap();
        let old = store
            .finish_execution(old.run, Some("retained result"), None)
            .unwrap();
        // Existing malformed-response records keep their original classification.
        let malformed = store
            .start_execution(t, a, "original", "test", "model")
            .unwrap();
        let malformed = store
            .finish_execution(malformed.run, None, Some("malformed_response"))
            .unwrap();
        let run = store
            .start_execution(t, a, "original", "test", "model")
            .unwrap();
        assert!(store
            .finish_execution(run.run, Some("partial"), Some("output_limit"))
            .is_err());
        assert!(store
            .finish_execution(run.run, None, Some("output_limit: private provider detail"))
            .is_err());
        assert_eq!(store.execution(run.run).unwrap(), run);
        store.connection.execute_batch("CREATE TRIGGER fail_limit BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(store
            .finish_execution(run.run, None, Some("output_limit"))
            .is_err());
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.execution(run.run).unwrap(), run);
        assert_eq!(
            store.read().unwrap().run(run.run).unwrap().state(),
            RunState::Active
        );
        store
            .connection
            .execute_batch("DROP TRIGGER fail_limit")
            .unwrap();
        let limited = store
            .finish_execution(run.run, None, Some("output_limit"))
            .unwrap();
        let core = store.read().unwrap();
        let terminal = core.run(run.run).unwrap();
        let RunState::Finished {
            outcome: RunOutcome::Failure,
            ended_at,
        } = terminal.state()
        else {
            panic!("output limit must be a terminal failure");
        };
        assert!(ended_at >= terminal.started_at());
        assert_eq!(terminal.task(), t);
        assert_eq!(terminal.participants().collect::<Vec<_>>(), vec![a]);
        assert_eq!(core.task(t).unwrap().status(), TaskStatus::Pending);
        assert_eq!(core.runs_for_task(t).unwrap().count(), 3);
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        // Recovery after the lease deadline must not reclassify or resubmit a
        // terminal attempt, or change its original terminal timestamp.
        let (recovered, _) = store
            .execution_snapshot_at(RunTimestamp::from_unix_millis(run.deadline).unwrap())
            .unwrap();
        assert_eq!(recovered, core);
        assert_eq!(store.execution(run.run).unwrap(), limited);
        assert_eq!(limited.output, None);
        assert_eq!(limited.error.as_deref(), Some("output_limit"));
        assert_eq!(limited.input, "original");
        assert_eq!(store.execution(old.run).unwrap(), old);
        assert_eq!(store.execution(malformed.run).unwrap(), malformed);
        assert_eq!(store.read().unwrap(), core);
        assert!(store.finish_execution(run.run, Some("late"), None).is_err());
        assert_eq!(ReadOnlyStore::open(&path).unwrap().read().unwrap(), core);
    }
    #[test]
    fn read_only_history_preserves_expired_lease_and_completed_result_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (agent, task) = seed(&mut store);
        let completed = store
            .start_execution(task, agent, "first", "test", "fixture")
            .unwrap();
        let completed = store
            .finish_execution(completed.run, Some("retained result"), None)
            .unwrap();
        let expired_task = store
            .transact(|core| {
                let task = core.create_task("Expired work")?;
                core.assign(task, agent)?;
                Ok(task)
            })
            .unwrap();
        // Persist a genuinely expired, valid lease without waiting for wall time.
        let expired = store
            .transact(|core| {
                core.start_run(
                    expired_task,
                    "text_execution",
                    "test",
                    RunTimestamp::from_unix_millis(1).unwrap(),
                    &[agent],
                )
            })
            .unwrap();
        store.connection.execute(
            "INSERT INTO executions(run_id,input,provider,model,deadline) VALUES (?1,'expired input','test','fixture',120001)",
            [expired.to_string()],
        ).unwrap();
        let before_core = store.read().unwrap();
        drop(store);
        let before_bytes = std::fs::read(&path).unwrap();
        let mut reader = ReadOnlyStore::open(&path).unwrap();
        let (core, executions) = reader.execution_snapshot().unwrap();
        assert_eq!(core, before_core);
        assert_eq!(core.run(expired).unwrap().state(), RunState::Active);
        assert_eq!(core.run(expired).unwrap().task(), expired_task);
        assert_eq!(
            core.run(expired)
                .unwrap()
                .participants()
                .collect::<Vec<_>>(),
            vec![agent]
        );
        assert_eq!(
            executions.iter().find(|e| e.run == completed.run),
            Some(&completed)
        );
        let pending = executions.iter().find(|e| e.run == expired).unwrap();
        assert_eq!(pending.deadline, 120001);
        assert_eq!(
            (pending.output.as_ref(), pending.error.as_ref()),
            (None, None)
        );
        drop(reader);
        assert_eq!(std::fs::read(&path).unwrap(), before_bytes);
        let reopened = ReadOnlyStore::open(&path)
            .unwrap()
            .execution_snapshot()
            .unwrap();
        assert_eq!(reopened, (core, executions));
        assert_eq!(std::fs::read(&path).unwrap(), before_bytes);
        // Existing default history inspection still recovers the same expired lease.
        let (recovered, results) = SqliteStore::open(&path)
            .unwrap()
            .execution_snapshot()
            .unwrap();
        assert!(matches!(
            recovered.run(expired).unwrap().state(),
            RunState::Finished {
                outcome: RunOutcome::Interruption,
                ..
            }
        ));
        assert_eq!(
            results
                .iter()
                .find(|e| e.run == expired)
                .unwrap()
                .error
                .as_deref(),
            Some("interrupted")
        );
        assert_eq!(
            results.iter().find(|e| e.run == completed.run),
            Some(&completed)
        );
    }

    #[test]
    fn history_snapshot_is_consistent_at_lease_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = seed(&mut store);
        let run = store
            .start_execution(t, a, "input", "test", "fixture")
            .unwrap();
        let (active, pending) = store
            .execution_snapshot_at(RunTimestamp::from_unix_millis(run.deadline - 1).unwrap())
            .unwrap();
        assert_eq!(active.run(run.run).unwrap().state(), RunState::Active);
        assert_eq!(pending, vec![run.clone()]);
        let (recovered, results) = store
            .execution_snapshot_at(RunTimestamp::from_unix_millis(run.deadline).unwrap())
            .unwrap();
        assert!(matches!(
            recovered.run(run.run).unwrap().state(),
            RunState::Finished {
                outcome: RunOutcome::Interruption,
                ..
            }
        ));
        assert_eq!(results[0].error.as_deref(), Some("interrupted"));
        assert_eq!(recovered.runs().len(), 1);
        // A retained snapshot remains coherent after recovery; reopening agrees.
        assert_eq!(active.run(run.run).unwrap().state(), RunState::Active);
        assert_eq!(pending[0].error, None);
        drop(store);
        let (reopened, persisted) = SqliteStore::open(&path)
            .unwrap()
            .execution_snapshot()
            .unwrap();
        assert_eq!(persisted, results);
        assert_eq!(
            reopened.run(run.run).unwrap(),
            recovered.run(run.run).unwrap()
        );
    }
    #[test]
    fn read_only_execution_never_recovers_a_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = seed(&mut store);
        let run = store
            .start_execution(t, a, "input", "test", "fixture")
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let inspected = store.execution_read_only(run.run).unwrap();
        assert_eq!(inspected, run);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            store.read().unwrap().run(run.run).unwrap().state(),
            RunState::Active
        );
        let (recovered, executions) = store
            .execution_snapshot_at(RunTimestamp::from_unix_millis(run.deadline).unwrap())
            .unwrap();
        assert!(matches!(
            recovered.run(run.run).unwrap().state(),
            RunState::Finished {
                outcome: RunOutcome::Interruption,
                ..
            }
        ));
        assert_eq!(executions[0].error.as_deref(), Some("interrupted"));
    }
    #[test]
    fn stale_recovery_never_resends_and_rejects_late_response() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = seed(&mut store);
        let run = store
            .start_execution(t, a, "input", "test", "fixture")
            .unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        recover(&tx, RunTimestamp::from_unix_millis(run.deadline).unwrap()).unwrap();
        tx.commit().unwrap();
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(
            store.execution(run.run).unwrap().error.as_deref(),
            Some("interrupted")
        );
        assert!(store.finish_execution(run.run, Some("late"), None).is_err());
        store.recover_executions().unwrap();
        assert_eq!(store.read().unwrap().runs().len(), 1);
        assert_ne!(
            store
                .start_execution(t, a, "input", "test", "fixture")
                .unwrap()
                .run,
            run.run
        );
    }
    #[test]
    fn migration_preserves_v3_and_rolls_back_failed_ddl() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = seed(&mut store);
        let old = store.read().unwrap();
        // Reconstruct v3 without later tables or triggers on legacy tables.
        store.connection.execute_batch("DROP TRIGGER loop_preview_policy; DROP TRIGGER loop_preview_work; DROP TRIGGER loop_preview_assignment_added; DROP TRIGGER loop_preview_assignment_removed; DROP TABLE loop_attempts; DROP TABLE loop_sessions; DROP TABLE loop_previews; DROP TRIGGER hook_preview_skill_configuration; DROP TRIGGER hook_preview_work; DROP TRIGGER hook_preview_assignment_added; DROP TRIGGER hook_preview_assignment_removed; DROP TRIGGER hook_preview_configuration; DROP TABLE hook_provenance; DROP TABLE hook_context; DROP TABLE hook_previews; DROP TRIGGER skill_preview_configuration; DROP TRIGGER skill_preview_work; DROP TRIGGER skill_preview_assignment_added; DROP TRIGGER skill_preview_assignment_removed; DROP TABLE skill_provenance; DROP TABLE skill_previews; DROP TABLE hooks; DROP TABLE loop_policies; DROP TABLE skills; DROP TABLE execution_sources; DROP TRIGGER execution_immutable; DROP TRIGGER execution_retained; DROP TABLE executions; PRAGMA user_version=3; CREATE TRIGGER execution_immutable BEFORE UPDATE ON runs BEGIN SELECT 1; END;").unwrap();
        drop(store);
        let sql = Connection::open(&path).unwrap();
        assert!(SqliteStore::open(&path).is_err());
        assert_eq!(
            sql.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
                .unwrap(),
            3
        );
        sql.execute_batch("DROP TRIGGER execution_immutable")
            .unwrap();
        assert_eq!(ReadOnlyStore::open(&path).unwrap().read().unwrap(), old);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.read().unwrap(), old);
        assert!(store
            .start_execution(t, a, "input", "test", "fixture")
            .is_ok());
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    #[test]
    fn execution_mutation_audit_and_invalid_restoration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = store
            .transact(|c| {
                let a = c.create_agent("A")?;
                let t = c.create_task("T")?;
                c.assign(t, a)?;
                Ok((a, t))
            })
            .unwrap();
        let first = store
            .start_execution(t, a, "input", "test", "model")
            .unwrap();
        store
            .finish_execution(first.run, Some("original"), None)
            .unwrap();
        store.connection.execute_batch("CREATE TABLE audit(kind TEXT, id TEXT);
        CREATE TRIGGER audit_execution AFTER UPDATE ON executions BEGIN INSERT INTO audit VALUES ('execution',NEW.run_id); END;
        CREATE TRIGGER audit_run AFTER UPDATE ON runs BEGIN INSERT INTO audit VALUES ('run',NEW.id); END;").unwrap();
        let retry = store
            .start_execution(t, a, "retry input", "test", "model")
            .unwrap();
        store
            .finish_execution(retry.run, None, Some("authentication"))
            .unwrap();
        store.recover_executions().unwrap();
        let rows = store
            .connection
            .prepare("SELECT kind,id FROM audit ORDER BY kind")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("execution".into(), retry.run.to_string()),
                ("run".into(), retry.run.to_string())
            ]
        );
        assert!(store
            .connection
            .execute(
                "UPDATE executions SET input='changed' WHERE run_id=?1",
                [first.run.to_string()]
            )
            .is_err());
        assert!(store
            .connection
            .execute(
                "DELETE FROM executions WHERE run_id=?1",
                [first.run.to_string()]
            )
            .is_err());
        // Corrupt fixture bypasses SQL protection; opening must reject, never repair.
        store
            .connection
            .execute_batch("DROP TRIGGER execution_immutable")
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE executions SET deadline=0 WHERE run_id=?1",
                [first.run.to_string()],
            )
            .unwrap();
        drop(store);
        let bytes = std::fs::read(&path).unwrap();
        assert!(SqliteStore::open(&path).is_err());
        assert!(ReadOnlyStore::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[cfg(test)]
mod web_admission_tests {
    use super::*;

    #[test]
    fn observed_attempt_count_rejects_replays_across_connections_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("work.db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (agent, task) = store
            .transact(|core| {
                let agent = core.create_agent("Writer")?;
                let task = core.create_task("Draft text")?;
                core.assign(task, agent)?;
                Ok((agent, task))
            })
            .unwrap();
        let mut other = SqliteStore::open(&path).unwrap();
        let first = store
            .start_execution_guarded(task, agent, "Draft text", "test", "model", Some(0))
            .unwrap();
        assert!(other
            .start_execution_guarded(task, agent, "Draft text", "test", "model", Some(0))
            .is_err());
        store
            .finish_execution(first.run, Some("response"), None)
            .unwrap();
        // Even a duplicate arriving after completion is not a new explicit retry.
        assert!(other
            .start_execution_guarded(task, agent, "Draft text", "test", "model", Some(0))
            .is_err());
        drop(store);
        let mut reopened = SqliteStore::open(&path).unwrap();
        assert_eq!(
            reopened
                .read()
                .unwrap()
                .runs_for_task(task)
                .unwrap()
                .count(),
            1
        );
        let retry = reopened
            .start_execution_guarded(task, agent, "Draft text", "test", "model", Some(1))
            .unwrap();
        assert_ne!(first.run, retry.run);
        assert_eq!(
            reopened.execution(first.run).unwrap().output.as_deref(),
            Some("response")
        );
    }
}

#[cfg(test)]
mod mcp_tests {
    use super::*;
    #[test]
    fn rejected_mcp_admission_preserves_saved_work() {
        let mut store = SqliteStore::open(":memory:").unwrap();
        let (task, agent) = store
            .transact(|c| {
                let agent = c.create_agent("Writer")?;
                let task = c.create_text_work("Saved input")?;
                Ok((task, agent))
            })
            .unwrap();
        // Missing assignment must not create an attempt or source record.
        assert!(store
            .start_mcp_execution(task, "test", "model", 0, false, "codex")
            .is_err());
        store.transact(|c| c.assign(task, agent)).unwrap();
        for (provider, model, source, expected) in [
            ("", "model", "codex", 0),
            ("test", "", "codex", 0),
            ("test", "model", "", 0),
            ("test", "model", "codex\n", 0),
            ("test", "model", "codex", 1),
        ] {
            assert!(store
                .start_mcp_execution(task, provider, model, expected, false, source)
                .is_err());
            let (core, executions) = store.execution_snapshot().unwrap();
            assert_eq!(core.task(task).unwrap().title(), "Saved input");
            assert_eq!(
                core.task(task).unwrap().assignees().collect::<Vec<_>>(),
                vec![agent]
            );
            assert_eq!(core.runs_for_task(task).unwrap().count(), 0);
            assert!(executions.is_empty());
            assert!(store.execution_sources().unwrap().is_empty());
        }
        assert!(store
            .start_mcp_execution(task, "test", "model", 0, false, "codex")
            .is_ok());
    }

    #[test]
    fn mcp_consent_atomic_provenance_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.db");
        let mut store = SqliteStore::open(&path).unwrap();
        let task = store
            .transact(|c| {
                let a = c.create_agent("Writer")?;
                let t = c.create_text_work("Saved input")?;
                c.assign(t, a)?;
                Ok(t)
            })
            .unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_source BEFORE INSERT ON execution_sources BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(store
            .start_mcp_execution(task, "test", "model", 0, false, "codex")
            .is_err());
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.read().unwrap().runs().len(), 0);
        assert!(store.execution_sources().unwrap().is_empty());
        store
            .connection
            .execute_batch("DROP TRIGGER fail_source")
            .unwrap();
        let first = store
            .start_mcp_execution(task, "test", "model", 0, false, "codex")
            .unwrap();
        assert_eq!(first.input, "Saved input");
        let mut other = SqliteStore::open(&path).unwrap();
        assert!(other
            .start_mcp_execution(task, "test", "model", 0, false, "codex")
            .is_err());
        assert!(other
            .start_mcp_execution(task, "test", "model", 1, true, "codex")
            .is_err());
        store
            .finish_execution(first.run, None, Some("provider_error"))
            .unwrap();
        assert!(other
            .start_mcp_execution(task, "test", "model", 0, true, "codex")
            .is_err());
        assert!(other
            .start_mcp_execution(task, "test", "model", 1, false, "codex")
            .is_err());
        let retry = other
            .start_mcp_execution(task, "test", "model", 1, true, "claude-code")
            .unwrap();
        assert_ne!(first.run, retry.run);
        other
            .finish_execution(retry.run, Some("result"), None)
            .unwrap();
        drop(other);
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(
            store.read().unwrap().runs_for_task(task).unwrap().count(),
            2
        );
        assert_eq!(
            store.execution(retry.run).unwrap().output.as_deref(),
            Some("result")
        );
        let sources = store.execution_sources().unwrap();
        assert!(sources.contains(&(first.run.to_string(), "codex".into())));
        assert!(sources.contains(&(retry.run.to_string(), "claude-code".into())));
        assert_eq!(
            store
                .read()
                .unwrap()
                .run(first.run)
                .unwrap()
                .reporting_source(),
            "test"
        );
    }

    #[test]
    fn v4_migration_keeps_legacy_source_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (agent, task) = store
            .transact(|c| {
                let a = c.create_agent("Writer")?;
                let t = c.create_text_work("Saved")?;
                c.assign(t, a)?;
                Ok((a, t))
            })
            .unwrap();
        let first = store
            .start_execution(task, agent, "Saved", "test", "model")
            .unwrap();
        store
            .connection
            // A v4 fixture must not retain v6–v8 tables or their triggers.
            .execute_batch("DROP TRIGGER loop_preview_policy; DROP TRIGGER loop_preview_work; DROP TRIGGER loop_preview_assignment_added; DROP TRIGGER loop_preview_assignment_removed; DROP TABLE loop_attempts; DROP TABLE loop_sessions; DROP TABLE loop_previews; DROP TRIGGER hook_preview_skill_configuration; DROP TRIGGER hook_preview_work; DROP TRIGGER hook_preview_assignment_added; DROP TRIGGER hook_preview_assignment_removed; DROP TRIGGER hook_preview_configuration; DROP TABLE hook_provenance; DROP TABLE hook_context; DROP TABLE hook_previews; DROP TRIGGER skill_preview_configuration; DROP TRIGGER skill_preview_work; DROP TRIGGER skill_preview_assignment_added; DROP TRIGGER skill_preview_assignment_removed; DROP TABLE skill_provenance; DROP TABLE skill_previews; DROP TABLE hooks; DROP TABLE loop_policies; DROP TABLE skills; DROP TABLE execution_sources; PRAGMA user_version=4;")
            .unwrap();
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.execution(first.run).unwrap(), first);
        assert!(store.execution_sources().unwrap().is_empty());
    }
}
