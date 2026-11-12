//! Explicit employee Hook consent and atomic admission. No provider I/O.
use super::*;
use llm_engine_core::{HookId, HookTarget, SkillId, TaskId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookPreview {
    pub hook_id: String,
    pub hook_name: String,
    pub event: String,
    pub agent_id: String,
    pub source_run_id: String,
    pub source_outcome: String,
    pub skill_name: String,
    pub instructions: String,
    pub preview_id: String,
    pub task_id: TaskId,
    pub skill_id: SkillId,
    pub input: String,
    pub expected_runs: usize,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookProvenance {
    pub task_id: String,
    pub hook_id: String,
    pub hook_name: String,
    pub event: String,
    pub agent_id: String,
    pub source_run_id: String,
    pub source_outcome: String,
    pub run_id: String,
    pub preview_id: String,
    pub skill_id: String,
    pub skill_name: String,
    pub instructions: String,
    pub input: String,
    pub admitted_at: i64,
}
fn rejected() -> StorageError {
    StorageError::InvalidData("hook preview rejected; refresh and preview again".into())
}
fn no_secrets(values: &[&str], secrets: &[String]) -> Result<(), StorageError> {
    if secrets
        .iter()
        .filter(|s| !s.is_empty())
        .any(|s| values.iter().any(|v| v.contains(s.as_str())))
    {
        return Err(StorageError::InvalidData(
            "configured secret in hook input".into(),
        ));
    }
    Ok(())
}
impl SqliteStore {
    pub fn preview_hook(
        &mut self,
        task: TaskId,
        hook: HookId,
        secrets: &[String],
    ) -> Result<HookPreview, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let core = load(&tx)?;
        let work = core.task(task)?;
        let h = core.hook(hook)?;
        let skill = h.skill_id();
        let selected = core.skill(skill)?;
        let (source_run_id, source_outcome) = source(&tx, task)?;
        core.match_employee_hook(task, hook, parse_id(source_run_id.clone())?)?;
        let event = match source_outcome.as_str() {
            "reported_success" => "run_completed",
            "failure" => "run_failed",
            _ => return Err(rejected()),
        };
        if !h.enabled()
            || h.event().as_str() != event
            || !matches!(h.target(), HookTarget::Agent(a) if work.assignees().collect::<Vec<_>>() == vec![a])
        {
            return Err(rejected());
        }
        let agents: Vec<_> = work.assignees().collect();
        if !selected.enabled() || agents.len() != 1 {
            return Err(rejected());
        }
        let input = core.compose_skill_input(task, skill)?;
        no_secrets(
            &[
                work.title(),
                h.name(),
                selected.name(),
                selected.instructions(),
                &input,
            ],
            secrets,
        )?;
        let count = core.runs_for_task(task)?.count();
        let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        tx.execute("INSERT INTO hook_previews(id,task_id,skill_id,agent_id,work_text,skill_name,instructions,input,expected_runs,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id,task.to_string(),skill.to_string(),agents[0].to_string(),work.title(),selected.name(),selected.instructions(),input,count as i64,execution::now()?.unix_millis()])?;
        tx.execute("INSERT INTO hook_context(preview_id,hook_id,hook_name,event,source_run_id,source_outcome) VALUES (?1,?2,?3,?4,?5,?6)", params![id,hook.to_string(),h.name(),event,source_run_id,source_outcome])?;
        tx.commit()?;
        Ok(HookPreview {
            hook_id: hook.to_string(),
            hook_name: h.name().into(),
            event: event.into(),
            agent_id: agents[0].to_string(),
            source_run_id,
            source_outcome,
            skill_name: selected.name().into(),
            instructions: selected.instructions().into(),
            preview_id: id,
            task_id: task,
            skill_id: skill,
            input,
            expected_runs: count,
        })
    }
    pub fn start_hook_execution(
        &mut self,
        task: TaskId,
        preview_id: &str,
        provider: &str,
        model: &str,
        expected_runs: usize,
        secrets: &[String],
    ) -> Result<Execution, StorageError> {
        self.start_hook_execution_with_source(
            task,
            preview_id,
            provider,
            model,
            expected_runs,
            secrets,
            None,
        )
    }
    /// Untrusted caller attribution is committed atomically with Hook admission.
    pub fn start_hook_execution_with_source(
        &mut self,
        task: TaskId,
        preview_id: &str,
        provider: &str,
        model: &str,
        expected_runs: usize,
        secrets: &[String],
        declared_source: Option<&str>,
    ) -> Result<Execution, StorageError> {
        if let Some(source) = declared_source {
            if source.trim().is_empty() || source.len() > 80 || source.chars().any(char::is_control)
            {
                return Err(rejected());
            }
            no_secrets(&[source], secrets)?;
        }
        if preview_id.len() != 32 || !preview_id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(rejected());
        }
        for (value, limit) in [(provider, 80), (model, 200)] {
            if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control)
            {
                return Err(rejected());
            }
        }
        no_secrets(&[provider, model], secrets)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = execution::now()?;
        execution::recover(&tx, timestamp)?;
        let before = load(&tx)?;
        let snapshot: Option<(String,String,String,String,String,String,String,i64)> = tx.query_row(
            "SELECT task_id,skill_id,agent_id,work_text,skill_name,instructions,input,expected_runs FROM hook_previews WHERE id=?1 AND invalidated=0 AND consumed_run IS NULL",[preview_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional()?;
        let (saved_task, skill, agent, text, name, instructions, input, count) =
            snapshot.ok_or_else(rejected)?;
        let skill_id: SkillId = parse_id(skill.clone())?;
        let work = before.task(task)?;
        let selected = before.skill(skill_id)?;
        let agents: Vec<_> = work.assignees().collect();
        if saved_task != task.to_string()
            || count != expected_runs as i64
            || before.runs_for_task(task)?.count() != expected_runs
            || agents.len() != 1
            || agents[0].to_string() != agent
            || text != work.title()
            || !selected.enabled()
            || name != selected.name()
            || instructions != selected.instructions()
            || input != before.compose_skill_input(task, skill_id)?
        {
            return Err(rejected());
        }
        no_secrets(&[&text, &name, &instructions, &input], secrets)?;
        let (hook_id, hook_name, event, source_id, outcome): (String,String,String,String,String) = tx.query_row("SELECT hook_id,hook_name,event,source_run_id,source_outcome FROM hook_context WHERE preview_id=?1",[preview_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        let h = before.hook(parse_id(hook_id.clone())?)?;
        if !h.enabled()
            || h.name() != hook_name
            || h.skill_id() != skill_id
            || h.event().as_str() != event
            || h.target() != HookTarget::Agent(agents[0])
            || source(&tx, task)? != (source_id.clone(), outcome.clone())
        {
            return Err(rejected());
        }
        before.match_employee_hook(task, h.id(), parse_id(source_id.clone())?)?;
        no_secrets(&[&hook_name], secrets)?;
        let mut after = before.clone();
        let id = after.start_run(task, "text_execution", provider, timestamp, &agents)?;
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
            "INSERT INTO hook_provenance(run_id,preview_id,schema_version,skill_id,skill_name,instructions,input,admitted_at) VALUES (?1,?2,1,?3,?4,?5,?6,?7)",
            params![
                id.to_string(),
                preview_id,
                skill,
                name,
                instructions,
                input,
                timestamp.unix_millis()
            ],
        )?;
        tx.execute(
            "UPDATE hook_previews SET consumed_run=?2 WHERE id=?1",
            params![preview_id, id.to_string()],
        )?;
        if let Some(source) = declared_source {
            tx.execute(
                "INSERT INTO execution_sources(run_id,declared_source) VALUES (?1,?2)",
                params![id.to_string(), source],
            )?;
        }
        let result = execution::get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn hook_provenance(&self) -> Result<Vec<HookProvenance>, StorageError> {
        let mut statement=self.connection.prepare("SELECT p.run_id,p.preview_id,p.skill_id,p.skill_name,p.instructions,p.input,p.admitted_at,v.task_id,c.hook_id,c.hook_name,c.event,v.agent_id,c.source_run_id,c.source_outcome FROM hook_provenance p JOIN hook_previews v ON v.id=p.preview_id JOIN hook_context c ON c.preview_id=p.preview_id ORDER BY p.run_id")?;
        Ok(statement
            .query_map([], |r| {
                Ok(HookProvenance {
                    task_id: r.get(7)?,
                    hook_id: r.get(8)?,
                    hook_name: r.get(9)?,
                    event: r.get(10)?,
                    agent_id: r.get(11)?,
                    source_run_id: r.get(12)?,
                    source_outcome: r.get(13)?,
                    run_id: r.get(0)?,
                    preview_id: r.get(1)?,
                    skill_id: r.get(2)?,
                    skill_name: r.get(3)?,
                    instructions: r.get(4)?,
                    input: r.get(5)?,
                    admitted_at: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }
}
use rusqlite::OptionalExtension;

// SQLite rowid records save order, including attempts with identical timestamps.
fn source(db: &Connection, task: TaskId) -> Result<(String, String), StorageError> {
    db.query_row(
        "SELECT id,outcome FROM runs WHERE task_id=?1 ORDER BY rowid DESC LIMIT 1",
        [task.to_string()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(rejected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use llm_engine_core::{AgentId, HookEvent};
    fn seed(s: &mut SqliteStore, failed: bool) -> (TaskId, SkillId, HookId, AgentId) {
        let (t, k, h, a) = s
            .transact(|c| {
                let a = c.create_agent("Writer")?;
                let t = c.create_text_work("Saved work")?;
                c.assign(t, a)?;
                let k = c.create_skill("Concise", "Use one sentence.")?;
                c.set_skill_enabled(k, true)?;
                let h = c.create_hook(
                    "Follow up",
                    k,
                    HookTarget::Agent(a),
                    if failed {
                        HookEvent::RunFailed
                    } else {
                        HookEvent::RunCompleted
                    },
                )?;
                c.set_hook_enabled(h, true)?;
                Ok((t, k, h, a))
            })
            .unwrap();
        let e = s
            .start_execution(t, a, "Saved work", "fixture", "test")
            .unwrap();
        if failed {
            s.finish_execution(e.run, None, Some("provider_error"))
                .unwrap();
        } else {
            s.finish_execution(e.run, Some("Saved result"), None)
                .unwrap();
        }
        (t, k, h, a)
    }
    #[test]
    fn hook_restart_failure_and_immutable_provenance() {
        for failed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("db");
            let mut s = SqliteStore::open(&path).unwrap();
            let (t, k, h, _) = seed(&mut s, failed);
            let p = s.preview_hook(t, h, &[]).unwrap();
            assert_eq!(p.expected_runs, 1);
            assert_eq!(
                p.input,
                "Skill instructions:\nUse one sentence.\n\nWork:\nSaved work"
            );
            assert_eq!(s.read().unwrap().runs_for_task(t).unwrap().count(), 1);
            drop(s);
            let mut s = SqliteStore::open(&path).unwrap();
            let e = s
                .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
                .unwrap();
            s.finish_execution(e.run, None, Some("provider_error"))
                .unwrap();
            assert!(s
                .start_hook_execution(t, &p.preview_id, "fixture", "test", 2, &[])
                .is_err());
            s.transact(|c| c.update_skill(k, "Changed", "Changed"))
                .unwrap();
            s.transact(|c| c.set_hook_enabled(h, false)).unwrap();
            drop(s);
            let mut s = SqliteStore::open(&path).unwrap();
            let rows = s.hook_provenance().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].source_run_id, p.source_run_id);
            assert_eq!(rows[0].hook_name, "Follow up");
            assert_eq!(rows[0].instructions, "Use one sentence.");
            for sql in [
                "UPDATE hook_provenance SET instructions='Changed'",
                "DELETE FROM hook_provenance",
                "UPDATE hook_context SET hook_name='Changed'",
                "DELETE FROM hook_context",
                "UPDATE hook_previews SET input='Changed'",
                "UPDATE hook_previews SET consumed_run=NULL",
            ] {
                assert!(s.connection.execute_batch(sql).is_err(), "{sql}");
            }
            assert_eq!(s.hook_provenance().unwrap(), rows);
            assert_eq!(
                s.execution(e.run).unwrap().error.as_deref(),
                Some("provider_error")
            );
        }
    }
    #[test]
    fn hook_rejection_and_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut s = SqliteStore::open(&path).unwrap();
        let (t, k, h, a) = seed(&mut s, false);
        assert!(s.preview_hook(t, h, &["sentence".into()]).is_err());
        for mutation in 0..3 {
            let p = s.preview_hook(t, h, &[]).unwrap();
            match mutation {
                0 => {
                    s.transact(|c| c.set_hook_enabled(h, false)).unwrap();
                    s.transact(|c| c.set_hook_enabled(h, true)).unwrap();
                }
                1 => {
                    s.transact(|c| c.set_skill_enabled(k, false)).unwrap();
                    s.transact(|c| c.set_skill_enabled(k, true)).unwrap();
                }
                _ => {
                    s.transact(|c| {
                        c.update_hook(
                            h,
                            "Wrong event",
                            k,
                            HookTarget::Agent(a),
                            HookEvent::RunFailed,
                        )
                    })
                    .unwrap();
                }
            }
            assert!(s
                .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
                .is_err());
        }
        assert!(s.preview_hook(t, h, &[]).is_err());
        s.transact(|c| {
            c.update_hook(
                h,
                "Follow up",
                k,
                HookTarget::Agent(a),
                HookEvent::RunCompleted,
            )
        })
        .unwrap();
        let p = s.preview_hook(t, h, &[]).unwrap();
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 0, &[])
            .is_err());
        let other = s.transact(|c| c.create_text_work("Other work")).unwrap();
        assert!(s
            .start_hook_execution(other, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        s.connection.execute_batch("CREATE TRIGGER injected_hook_failure BEFORE INSERT ON hook_provenance BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        drop(s);
        let mut s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.read().unwrap().runs_for_task(t).unwrap().count(), 1);
        assert!(s.hook_provenance().unwrap().is_empty());
        s.connection
            .execute_batch("DROP TRIGGER injected_hook_failure")
            .unwrap();
        s.start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .unwrap();
    }
    #[test]
    fn hook_rejects_unsupported_targets_and_stale_source_or_assignment() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SqliteStore::open(dir.path().join("db")).unwrap();
        let (t, k, h, a) = seed(&mut s, false);
        let p = s.preview_hook(t, h, &[]).unwrap();
        let team = s.transact(|c| c.create_team("Team")).unwrap();
        s.transact(|c| {
            c.update_hook(
                h,
                "Team",
                k,
                HookTarget::Team(team),
                HookEvent::RunCompleted,
            )
        })
        .unwrap();
        assert!(s.preview_hook(t, h, &[]).is_err());
        s.transact(|c| {
            c.update_hook(
                h,
                "Created",
                k,
                HookTarget::Agent(a),
                HookEvent::TaskCreated,
            )
        })
        .unwrap();
        assert!(s.preview_hook(t, h, &[]).is_err());
        s.transact(|c| {
            c.update_hook(
                h,
                "Follow up",
                k,
                HookTarget::Agent(a),
                HookEvent::RunCompleted,
            )
        })
        .unwrap();
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        let p = s.preview_hook(t, h, &[]).unwrap();
        let b = s
            .transact(|c| {
                let b = c.create_agent("Other")?;
                c.assign(t, b)?;
                Ok(b)
            })
            .unwrap();
        assert!(s.preview_hook(t, h, &[]).is_err());
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        s.connection
            .execute(
                "DELETE FROM assignments WHERE task_id=?1 AND agent_id=?2",
                params![t.to_string(), b.to_string()],
            )
            .unwrap();
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        let p = s.preview_hook(t, h, &[]).unwrap();
        s.connection
            .execute(
                "UPDATE tasks SET title='Changed work' WHERE id=?1",
                [t.to_string()],
            )
            .unwrap();
        s.connection
            .execute(
                "UPDATE tasks SET title='Saved work' WHERE id=?1",
                [t.to_string()],
            )
            .unwrap();
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        let p = s.preview_hook(t, h, &[]).unwrap();
        let e = s
            .start_execution(t, a, "Saved work", "fixture", "test")
            .unwrap();
        assert!(s.preview_hook(t, h, &[]).is_err());
        s.finish_execution(e.run, Some("Second result"), None)
            .unwrap();
        assert!(s
            .start_hook_execution(t, &p.preview_id, "fixture", "test", 1, &[])
            .is_err());
        let latest = s.preview_hook(t, h, &[]).unwrap();
        assert_eq!(latest.source_run_id, e.run.to_string());
        assert_eq!(latest.expected_runs, 2);
        let empty = s
            .transact(|c| {
                let t = c.create_text_work("No attempt")?;
                c.assign(t, a)?;
                Ok(t)
            })
            .unwrap();
        assert!(s.preview_hook(empty, h, &[]).is_err());
    }
    #[test]
    fn hook_caller_attribution_is_atomic_and_retained() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (task, _, hook, _) = seed(&mut store, false);
        let preview = store.preview_hook(task, hook, &[]).unwrap();
        for source in ["", " ", "bad\nsource", &"é".repeat(41)] {
            assert!(store
                .start_hook_execution_with_source(
                    task,
                    &preview.preview_id,
                    "fixture",
                    "test",
                    1,
                    &[],
                    Some(source),
                )
                .is_err());
        }
        assert!(store
            .start_hook_execution_with_source(
                task,
                &preview.preview_id,
                "fixture",
                "test",
                1,
                &["configured-secret".into()],
                Some("configured-secret"),
            )
            .is_err());
        store.connection.execute_batch("CREATE TRIGGER fail_hook_source BEFORE INSERT ON execution_sources BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(store
            .start_hook_execution_with_source(
                task,
                &preview.preview_id,
                "fixture",
                "test",
                1,
                &[],
                Some("codex"),
            )
            .is_err());
        assert_eq!(
            store.read().unwrap().runs_for_task(task).unwrap().count(),
            1
        );
        assert!(store.hook_provenance().unwrap().is_empty());
        assert!(store.execution_sources().unwrap().is_empty());
        store
            .connection
            .execute_batch("DROP TRIGGER fail_hook_source")
            .unwrap();
        let run = store
            .start_hook_execution_with_source(
                task,
                &preview.preview_id,
                "fixture",
                "test",
                1,
                &[],
                Some("codex"),
            )
            .unwrap();
        store
            .finish_execution(run.run, None, Some("provider_error"))
            .unwrap();
        drop(store);
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(
            store.execution_sources().unwrap(),
            vec![(run.run.to_string(), "codex".into())]
        );
        assert_eq!(
            store.hook_provenance().unwrap()[0].run_id,
            run.run.to_string()
        );
    }
    #[test]
    fn hook_concurrent_duplicate_admission() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut s = SqliteStore::open(&path).unwrap();
        let (t, _, h, _) = seed(&mut s, true);
        let p = s.preview_hook(t, h, &[]).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let id = p.preview_id.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    let mut s = SqliteStore::open(path).unwrap();
                    b.wait();
                    s.start_hook_execution_with_source(
                        t,
                        &id,
                        "fixture",
                        "test",
                        1,
                        &[],
                        Some("codex"),
                    )
                    .is_ok()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| usize::from(h.join().unwrap()))
                .sum::<usize>(),
            1
        );
        assert_eq!(s.hook_provenance().unwrap().len(), 1);
        assert_eq!(s.execution_sources().unwrap().len(), 1);
        assert_eq!(s.execution_sources().unwrap()[0].1, "codex");
    }

    #[test]
    fn separate_previews_cannot_admit_twice_for_the_same_source() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SqliteStore::open(dir.path().join("db")).unwrap();
        let (t, _, h, _) = seed(&mut s, false);
        let first = s.preview_hook(t, h, &[]).unwrap();
        let second = s.preview_hook(t, h, &[]).unwrap();
        assert_ne!(first.preview_id, second.preview_id);
        assert_eq!(first.source_run_id, second.source_run_id);
        let admitted = s
            .start_hook_execution(t, &first.preview_id, "fixture", "test", 1, &[])
            .unwrap();
        s.finish_execution(admitted.run, Some("Follow-up result"), None)
            .unwrap();
        // Neither the original nor a refreshed count renews old source consent.
        for count in [1, 2] {
            assert!(s
                .start_hook_execution(t, &second.preview_id, "fixture", "test", count, &[])
                .is_err());
        }
        assert_eq!(s.read().unwrap().runs_for_task(t).unwrap().count(), 2);
        assert_eq!(s.hook_provenance().unwrap().len(), 1);
    }
}
