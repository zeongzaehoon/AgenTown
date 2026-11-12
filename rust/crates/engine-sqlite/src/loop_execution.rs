//! Explicit Loop consent; all admission and stop decisions share a writer lock.
use super::*;
use llm_engine_core::{
    AgentId, LoopAdmission, LoopPolicyId, LoopSessionId, RunId, RunTimestamp, TaskId,
    loop_admission,
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopPreview {
    pub preview_id: String,
    pub policy_id: LoopPolicyId,
    pub task_id: TaskId,
    pub agent_id: AgentId,
    pub policy_name: String,
    pub input: String,
    pub max_iterations: u32,
    pub interval_seconds: u32,
    pub expected_runs: usize,
    pub created_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopSession {
    pub session_id: LoopSessionId,
    pub preview: LoopPreview,
    pub state: String,
    pub provider: String,
    pub model: String,
    pub started_at: i64,
    pub expires_at: i64,
    pub admitted: u32,
    pub next_at: i64,
    /// Untrusted caller declaration, never an authenticated identity.
    pub declared_source: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopAttempt {
    pub run_id: RunId,
    pub session_id: LoopSessionId,
    pub ordinal: u32,
    pub admitted_at: i64,
}
fn rejected() -> StorageError {
    StorageError::InvalidData(
        "loop command rejected; refresh and explicitly preview/start again".into(),
    )
}
fn safe(values: &[(&str, usize)], secrets: &[String]) -> Result<(), StorageError> {
    if values.iter().any(|(v, n)| {
        v.trim().is_empty()
            || v.len() > *n
            || v.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
            || secrets
                .iter()
                .filter(|s| !s.is_empty())
                .any(|s| v.contains(s.as_str()))
    }) {
        return Err(rejected());
    }
    Ok(())
}
fn preview(db: &Connection, id: &str) -> Result<LoopPreview, StorageError> {
    let (policy,task,agent,name,input,max,interval,count,created):(String,String,String,String,String,u32,u32,i64,i64)=db.query_row("SELECT policy_id,task_id,agent_id,policy_name,input,max_iterations,interval_seconds,expected_runs,created_at FROM loop_previews WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)))?;
    Ok(LoopPreview {
        preview_id: id.into(),
        policy_id: parse_id(policy)?,
        task_id: parse_id(task)?,
        agent_id: parse_id(agent)?,
        policy_name: name,
        input,
        max_iterations: max,
        interval_seconds: interval,
        expected_runs: usize::try_from(count).map_err(|_| {
            StorageError::InvalidData("invalid loop preview expected run count".into())
        })?,
        created_at: created,
    })
}
fn session(db: &Connection, id: LoopSessionId) -> Result<LoopSession, StorageError> {
    let (p,state,provider,model,start,expires,admitted,next):(String,String,String,String,i64,i64,u32,i64)=db.query_row("SELECT preview_id,state,provider,model,started_at,expires_at,admitted,next_at FROM loop_sessions WHERE id=?1",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))?;
    Ok(LoopSession {
        session_id: id,
        preview: preview(db, &p)?,
        state,
        provider,
        model,
        started_at: start,
        expires_at: expires,
        admitted,
        next_at: next,
        declared_source: db.query_row(
            "SELECT declared_source FROM loop_sessions WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )?,
    })
}
fn fresh(db: &Connection, p: &LoopPreview, count: usize) -> Result<bool, StorageError> {
    let c = load(db)?;
    let w = c.task(p.task_id)?;
    let l = c.loop_policy(p.policy_id)?;
    let invalid: bool = db.query_row(
        "SELECT invalidated FROM loop_previews WHERE id=?1",
        [&p.preview_id],
        |r| r.get(0),
    )?;
    Ok(!invalid
        && w.status() != TaskStatus::Cancelled
        && l.enabled()
        && l.task_id() == p.task_id
        && l.name() == p.policy_name
        && l.max_iterations() == p.max_iterations
        && l.interval_seconds() == p.interval_seconds
        && w.title() == p.input
        && w.assignees().collect::<Vec<_>>() == vec![p.agent_id]
        && c.runs_for_task(p.task_id)?.count() == count)
}
fn close(db: &Connection, id: LoopSessionId, state: &str) -> Result<(), StorageError> {
    db.execute(
        "UPDATE loop_sessions SET state=?2 WHERE id=?1 AND state='active'",
        params![id.to_string(), state],
    )?;
    Ok(())
}
impl SqliteStore {
    pub fn preview_loop(
        &mut self,
        policy: LoopPolicyId,
        secrets: &[String],
    ) -> Result<LoopPreview, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = load(&tx)?;
        let l = c.loop_policy(policy)?;
        let w = c.task(l.task_id())?;
        let agents = w.assignees().collect::<Vec<_>>();
        if !l.enabled()
            || w.status() == TaskStatus::Cancelled
            || agents.len() != 1
            || c.runs_for_task(w.id())?
                .any(|r| matches!(r.state(), RunState::Active))
        {
            return Err(rejected());
        }
        safe(&[(w.title(), 100_000), (l.name(), 120)], secrets)?;
        let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        tx.execute("INSERT INTO loop_previews(id,policy_id,task_id,agent_id,policy_name,input,max_iterations,interval_seconds,expected_runs,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,policy.to_string(),w.id().to_string(),agents[0].to_string(),l.name(),w.title(),l.max_iterations(),l.interval_seconds(),c.runs_for_task(w.id())?.count() as i64,execution::now()?.unix_millis()])?;
        let p = preview(&tx, &id)?;
        tx.commit()?;
        Ok(p)
    }
    #[cfg(test)]
    fn start_loop_at(
        &mut self,
        pid: &str,
        count: usize,
        provider: &str,
        model: &str,
        runtime: &str,
        secrets: &[String],
        now: i64,
    ) -> Result<LoopSession, StorageError> {
        self.start_loop_at_source(pid, count, provider, model, runtime, secrets, now, None)
    }
    pub(super) fn start_loop_at_source(
        &mut self,
        pid: &str,
        count: usize,
        provider: &str,
        model: &str,
        runtime: &str,
        secrets: &[String],
        now: i64,
        declared_source: Option<&str>,
    ) -> Result<LoopSession, StorageError> {
        if let Some(source) = declared_source {
            safe(&[(source, 80)], secrets)?;
            if source != source.trim() || source.chars().any(char::is_control) {
                return Err(rejected());
            }
        }
        safe(&[(provider, 80), (model, 200), (runtime, 120)], secrets)?;
        if [provider, model, runtime]
            .iter()
            .any(|v| *v != v.trim() || v.chars().any(char::is_control))
        {
            return Err(rejected());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let p = preview(&tx, pid)?;
        if p.expected_runs != count
            || !fresh(&tx, &p, count)?
            || now < p.created_at
            || now - p.created_at >= 300_000
        {
            return Err(rejected());
        }
        safe(&[(&p.input, 100_000), (&p.policy_name, 120)], secrets)?;
        let c = load(&tx)?;
        if c.runs_for_task(p.task_id)?
            .any(|r| matches!(r.state(), RunState::Active))
        {
            return Err(rejected());
        }
        let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        let id: LoopSessionId = parse_id(id)?;
        let expires = now
            + (i64::from(p.interval_seconds) * 1000 + 120_000) * i64::from(p.max_iterations)
            + 120_000;
        tx.execute("INSERT INTO loop_sessions(id,preview_id,task_id,runtime_id,provider,model,state,started_at,expires_at,next_at,declared_source) VALUES (?1,?2,?3,?4,?5,?6,'active',?7,?8,?7,?9)",params![id.to_string(),pid,p.task_id.to_string(),runtime,provider,model,now,expires,declared_source])?;
        let s = session(&tx, id)?;
        tx.commit()?;
        Ok(s)
    }
    /// Runtime token is generated once per execution-service process, never reused
    /// after restart. Call recover_loop_sessions at startup before serving requests.
    pub(crate) fn recover_loop_sessions(&mut self, runtime_id: &str) -> Result<(), StorageError> {
        safe(&[(runtime_id, 120)], &[])?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE loop_sessions SET state='restarted' WHERE state='active' AND runtime_id!=?1",
            [runtime_id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn stop_loop_session(
        &mut self,
        id: LoopSessionId,
    ) -> Result<LoopSession, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        close(&tx, id, "stopped")?;
        let s = session(&tx, id)?;
        tx.commit()?;
        Ok(s)
    }
    pub(crate) fn admit_loop_attempt(
        &mut self,
        id: LoopSessionId,
        runtime: &str,
        secrets: &[String],
    ) -> Result<Option<Execution>, StorageError> {
        self.admit_loop_at(id, runtime, secrets, execution::now()?.unix_millis())
    }
    fn admit_loop_at(
        &mut self,
        id: LoopSessionId,
        runtime: &str,
        secrets: &[String],
        now: i64,
    ) -> Result<Option<Execution>, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        let s = session(&tx, id)?;
        if s.state != "active" {
            tx.commit()?;
            return Err(rejected());
        }
        let owner: String = tx.query_row(
            "SELECT runtime_id FROM loop_sessions WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )?;
        if owner != runtime {
            return Err(rejected());
        }
        execution::recover(&tx, RunTimestamp::from_unix_millis(now)?)?;
        let failed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM loop_attempts a JOIN executions e ON a.run_id=e.run_id WHERE a.session_id=?1 AND e.error IS NOT NULL)",[id.to_string()],|r|r.get(0))?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND outcome IS NULL)",
            [s.preview.task_id.to_string()],
            |r| r.get(0),
        )?;
        let decision = loop_admission(
            now,
            s.expires_at,
            s.admitted,
            s.preview.max_iterations,
            s.next_at,
            active,
            failed,
        );
        let terminal = if !fresh(
            &tx,
            &s.preview,
            s.preview.expected_runs + s.admitted as usize,
        )? {
            Some("stale")
        } else {
            match decision {
                LoopAdmission::Failed => Some("failed"),
                LoopAdmission::Expired => Some("expired"),
                LoopAdmission::Complete => Some("complete"),
                _ => None,
            }
        };
        if let Some(state) = terminal {
            close(&tx, id, state)?;
            tx.commit()?;
            return Ok(None);
        }
        if decision == LoopAdmission::Wait {
            tx.commit()?;
            return Ok(None);
        }
        safe(
            &[
                (&s.preview.input, 100_000),
                (&s.provider, 80),
                (&s.model, 200),
            ],
            secrets,
        )?;
        let before = load(&tx)?;
        let mut after = before.clone();
        let stamp = RunTimestamp::from_unix_millis(now)?;
        let run = after.start_run(
            s.preview.task_id,
            "text_execution",
            &s.provider,
            stamp,
            &[s.preview.agent_id],
        )?;
        persist_execution_changes(&tx, &before, &after, true)?;
        tx.execute(
            "INSERT INTO executions(run_id,input,provider,model,deadline) VALUES (?1,?2,?3,?4,?5)",
            params![
                run.to_string(),
                s.preview.input,
                s.provider,
                s.model,
                now + 120_000
            ],
        )?;
        tx.execute(
            "INSERT INTO loop_attempts(run_id,session_id,ordinal,admitted_at) VALUES (?1,?2,?3,?4)",
            params![run.to_string(), id.to_string(), s.admitted + 1, now],
        )?;
        tx.execute(
            "UPDATE loop_sessions SET admitted=admitted+1,next_at=?2 WHERE id=?1",
            params![
                id.to_string(),
                now + i64::from(s.preview.interval_seconds) * 1000
            ],
        )?;
        let e = execution::get(&tx, run)?;
        tx.commit()?;
        Ok(Some(e))
    }
    pub fn loop_sessions(&self) -> Result<Vec<LoopSession>, StorageError> {
        let mut stmt = self
            .connection
            .prepare("SELECT id FROM loop_sessions ORDER BY rowid")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| session(&self.connection, parse_id(r?)?))
            .collect()
    }
    pub fn loop_attempts(&self) -> Result<Vec<LoopAttempt>, StorageError> {
        let mut stmt = self.connection.prepare(
            "SELECT run_id,session_id,ordinal,admitted_at FROM loop_attempts ORDER BY rowid",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u32>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        rows.map(|r| {
            let (run, id, ordinal, at) = r?;
            Ok(LoopAttempt {
                run_id: parse_id(run)?,
                session_id: parse_id(id)?,
                ordinal,
                admitted_at: at,
            })
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seed(s: &mut SqliteStore, limit: u32) -> LoopPolicyId {
        s.transact(|c| {
            let a = c.create_agent("Writer")?;
            let t = c.create_text_work("Saved text")?;
            c.assign(t, a)?;
            let p = c.create_loop_policy("Repeat", t, limit, 60)?;
            c.set_loop_policy_enabled(p, true)?;
            Ok(p)
        })
        .unwrap()
    }
    fn start(s: &mut SqliteStore, p: LoopPolicyId) -> LoopSession {
        let p = s.preview_loop(p, &[]).unwrap();
        s.start_loop_at(
            &p.preview_id,
            p.expected_runs,
            "fixture",
            "test",
            "runtime-a",
            &[],
            p.created_at,
        )
        .unwrap()
    }
    // Controlled clock fixture finalizes through the same Core and persistence
    // transitions as finish_execution; no sleeps or real provider calls.
    fn finish(s: &mut SqliteStore, e: &Execution, at: i64, failed: bool) {
        let tx = s
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let before = load(&tx).unwrap();
        let mut after = before.clone();
        after
            .finish_run(
                e.run,
                if failed {
                    RunOutcome::Failure
                } else {
                    RunOutcome::ReportedSuccess
                },
                RunTimestamp::from_unix_millis(at).unwrap(),
            )
            .unwrap();
        tx.execute(
            "UPDATE executions SET output=?2,error=?3 WHERE run_id=?1",
            params![
                e.run.to_string(),
                if failed { None } else { Some("result") },
                if failed { Some("provider_error") } else { None }
            ],
        )
        .unwrap();
        persist_execution_changes(&tx, &before, &after, true).unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn loop_limits_interval_active_and_retained_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut s = SqliteStore::open(&path).unwrap();
        let p = seed(&mut s, 2);
        assert!(s.loop_sessions().unwrap().is_empty());
        let v = s.preview_loop(p, &[]).unwrap();
        assert_eq!(v.expected_runs, 0);
        assert_eq!(s.read().unwrap().runs().count(), 0);
        let a = start(&mut s, p);
        let t = a.started_at;
        let e = s
            .admit_loop_at(a.session_id, "runtime-a", &[], t)
            .unwrap()
            .unwrap();
        assert!(
            s.admit_loop_at(a.session_id, "runtime-a", &[], t + 60_000)
                .unwrap()
                .is_none()
        );
        finish(&mut s, &e, t + 1, false);
        assert!(
            s.admit_loop_at(a.session_id, "runtime-a", &[], t + 59_999)
                .unwrap()
                .is_none()
        );
        let e2 = s
            .admit_loop_at(a.session_id, "runtime-a", &[], t + 60_000)
            .unwrap()
            .unwrap();
        assert_ne!(e.run, e2.run);
        finish(&mut s, &e2, t + 60_001, false);
        assert!(
            s.admit_loop_at(a.session_id, "runtime-a", &[], t + 120_000)
                .unwrap()
                .is_none()
        );
        assert_eq!(s.loop_sessions().unwrap()[0].state, "complete");
        drop(s);
        let mut s = SqliteStore::open(path).unwrap();
        assert_eq!(s.loop_attempts().unwrap().len(), 2);
        assert_eq!(s.read().unwrap().runs().count(), 2);
        for sql in [
            "DELETE FROM loop_attempts",
            "UPDATE loop_attempts SET ordinal=99",
            "DELETE FROM loop_sessions",
            "UPDATE loop_sessions SET state='active'",
            "UPDATE loop_previews SET input='changed'",
        ] {
            assert!(s.connection.execute_batch(sql).is_err(), "{sql}");
        }
    }
    #[test]
    fn loop_failure_expiry_restart_and_stop_never_replay() {
        for mode in 0..5 {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("db");
            let mut s = SqliteStore::open(&path).unwrap();
            let p = seed(&mut s, 2);
            let a = start(&mut s, p);
            let t = a.started_at;
            match mode {
                0 => {
                    let e = s
                        .admit_loop_at(a.session_id, "runtime-a", &[], t)
                        .unwrap()
                        .unwrap();
                    finish(&mut s, &e, t + 1, true);
                    s.admit_loop_at(a.session_id, "runtime-a", &[], t + 60_000)
                        .unwrap();
                }
                1 => {
                    s.admit_loop_at(a.session_id, "runtime-a", &[], a.expires_at)
                        .unwrap();
                }
                2 => {
                    drop(s);
                    s = SqliteStore::open(&path).unwrap();
                    s.recover_loop_sessions("runtime-b").unwrap();
                }
                3 => {
                    let e = s
                        .admit_loop_at(a.session_id, "runtime-a", &[], t)
                        .unwrap()
                        .unwrap();
                    s.stop_loop_session(a.session_id).unwrap();
                    finish(&mut s, &e, t + 1, false);
                }
                _ => {
                    s.admit_loop_at(a.session_id, "runtime-a", &[], t).unwrap();
                    s.admit_loop_at(a.session_id, "runtime-a", &[], t + 120_000)
                        .unwrap();
                }
            }
            assert_eq!(
                s.loop_sessions().unwrap()[0].state,
                ["failed", "expired", "restarted", "stopped", "failed"][mode]
            );
            assert!(
                s.admit_loop_at(a.session_id, "runtime-a", &[], t + 180_000)
                    .is_err()
            );
            assert!(
                s.start_loop_at(
                    &a.preview.preview_id,
                    0,
                    "fixture",
                    "test",
                    "runtime-a",
                    &[],
                    t
                )
                .is_err()
            );
            let count = s.loop_attempts().unwrap().len();
            drop(s);
            let s = SqliteStore::open(path).unwrap();
            assert_eq!(s.loop_attempts().unwrap().len(), count);
        }
    }
    #[test]
    fn loop_stale_snapshot_expiry_and_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut s = SqliteStore::open(&path).unwrap();
        let p = seed(&mut s, 2);
        let v = s.preview_loop(p, &[]).unwrap();
        assert!(
            s.start_loop_at(
                &v.preview_id,
                0,
                "fixture",
                "test",
                "runtime-a",
                &[],
                v.created_at + 300_000
            )
            .is_err()
        );
        s.transact(|c| c.set_loop_policy_enabled(p, false)).unwrap();
        s.transact(|c| c.set_loop_policy_enabled(p, true)).unwrap();
        assert!(
            s.start_loop_at(
                &v.preview_id,
                0,
                "fixture",
                "test",
                "runtime-a",
                &[],
                v.created_at
            )
            .is_err()
        );
        let a = start(&mut s, p);
        s.connection.execute_batch("CREATE TRIGGER injected_loop_failure BEFORE INSERT ON loop_attempts BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(
            s.admit_loop_at(a.session_id, "runtime-a", &[], a.started_at)
                .is_err()
        );
        drop(s);
        let mut s = SqliteStore::open(&path).unwrap();
        assert!(s.loop_attempts().unwrap().is_empty());
        assert_eq!(s.read().unwrap().runs().count(), 0);
        assert_eq!(s.loop_sessions().unwrap()[0].admitted, 0);
        s.connection
            .execute_batch("DROP TRIGGER injected_loop_failure")
            .unwrap();
        let v = s.preview_loop(p, &[]).unwrap();
        s.connection
            .execute(
                "UPDATE tasks SET title='Changed' WHERE id=?1",
                [v.task_id.to_string()],
            )
            .unwrap();
        s.connection
            .execute(
                "UPDATE tasks SET title='Saved text' WHERE id=?1",
                [v.task_id.to_string()],
            )
            .unwrap();
        assert!(
            s.start_loop_at(
                &v.preview_id,
                0,
                "fixture",
                "test",
                "runtime-a",
                &[],
                v.created_at
            )
            .is_err()
        );
        assert!(
            s.admit_loop_at(a.session_id, "runtime-a", &[], a.started_at)
                .unwrap()
                .is_none()
        );
        assert_eq!(s.loop_sessions().unwrap()[0].state, "stale");
    }
    #[test]
    fn loop_preview_assignment_count_secret_and_start_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut s = SqliteStore::open(&path).unwrap();
        let policy = seed(&mut s, 1);
        assert!(s.preview_loop(policy, &["Saved".into()]).is_err());
        let p = s.preview_loop(policy, &[]).unwrap();
        assert!(
            s.start_loop_at(
                &p.preview_id,
                1,
                "fixture",
                "test",
                "runtime-a",
                &[],
                p.created_at
            )
            .is_err()
        );
        assert!(
            s.start_loop_at(
                &p.preview_id,
                0,
                " fixture",
                "test",
                "runtime-a",
                &[],
                p.created_at
            )
            .is_err()
        );
        s.connection.execute_batch("CREATE TRIGGER injected_loop_start BEFORE INSERT ON loop_sessions BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(
            s.start_loop_at(
                &p.preview_id,
                0,
                "fixture",
                "test",
                "runtime-a",
                &[],
                p.created_at
            )
            .is_err()
        );
        drop(s);
        let mut s = SqliteStore::open(&path).unwrap();
        assert!(s.loop_sessions().unwrap().is_empty());
        s.connection
            .execute_batch("DROP TRIGGER injected_loop_start")
            .unwrap();
        let second = s
            .transact(|c| {
                let a = c.create_agent("Second")?;
                c.assign(p.task_id, a)?;
                Ok(a)
            })
            .unwrap();
        assert!(s.preview_loop(policy, &[]).is_err());
        s.connection
            .execute(
                "DELETE FROM assignments WHERE task_id=?1 AND agent_id=?2",
                params![p.task_id.to_string(), second.to_string()],
            )
            .unwrap();
        assert!(
            s.start_loop_at(
                &p.preview_id,
                0,
                "fixture",
                "test",
                "runtime-a",
                &[],
                p.created_at
            )
            .is_err()
        );
        let a = start(&mut s, policy);
        let other = s.preview_loop(policy, &[]).unwrap();
        assert!(
            s.start_loop_at(
                &other.preview_id,
                0,
                "fixture",
                "test",
                "runtime-a",
                &[],
                other.created_at
            )
            .is_err()
        );
        assert!(
            s.admit_loop_at(a.session_id, "runtime-a", &["Saved".into()], a.started_at)
                .is_err()
        );
        assert!(s.loop_attempts().unwrap().is_empty());
        assert_eq!(s.loop_sessions().unwrap()[0].admitted, 0);
    }
    #[test]
    fn loop_concurrent_starts_admissions_and_stop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut s = SqliteStore::open(&path).unwrap();
        let p = seed(&mut s, 2);
        let v = s.preview_loop(p, &[]).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let v = v.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    let mut s = SqliteStore::open(path).unwrap();
                    b.wait();
                    s.start_loop_at(
                        &v.preview_id,
                        0,
                        "fixture",
                        "test",
                        "runtime-a",
                        &[],
                        v.created_at,
                    )
                    .is_ok()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|v| *v)
                .count(),
            1
        );
        let a = s.loop_sessions().unwrap().remove(0);
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let a = a.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    let mut s = SqliteStore::open(path).unwrap();
                    b.wait();
                    s.admit_loop_at(a.session_id, "runtime-a", &[], a.started_at)
                        .unwrap()
                        .is_some()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|v| *v)
                .count(),
            1
        );
        assert_eq!(s.loop_attempts().unwrap().len(), 1);
        let e = execution::get(&s.connection, s.loop_attempts().unwrap()[0].run_id).unwrap();
        finish(&mut s, &e, a.started_at + 1, false);
        let other = path.clone();
        let b = barrier.clone();
        let id = a.session_id;
        let t = a.started_at;
        let handle = std::thread::spawn(move || {
            let mut s = SqliteStore::open(other).unwrap();
            b.wait();
            s.admit_loop_at(id, "runtime-a", &[], t + 60_000)
        });
        barrier.wait();
        s.stop_loop_session(id).unwrap();
        match handle.join().unwrap() {
            // Admission may acquire the writer lock before stop.
            Ok(Some(_)) => {}
            // If stop acquires it first, admission must reject the terminal session.
            Err(StorageError::InvalidData(message)) => assert_eq!(
                message,
                "loop command rejected; refresh and explicitly preview/start again"
            ),
            other => panic!("unexpected stop/admission race outcome: {other:?}"),
        }
        assert_eq!(s.loop_sessions().unwrap()[0].state, "stopped");
        assert!(s.admit_loop_at(id, "runtime-a", &[], t + 120_000).is_err());
        assert!(s.loop_attempts().unwrap().len() <= 2);
    }
}
