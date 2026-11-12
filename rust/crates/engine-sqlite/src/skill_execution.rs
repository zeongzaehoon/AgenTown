//! Explicit single-Skill consent and atomic admission. No provider I/O.
use super::*;
use llm_engine_core::{SkillId, TaskId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPreview {
    pub preview_id: String,
    pub task_id: TaskId,
    pub skill_id: SkillId,
    pub input: String,
    pub expected_runs: usize,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillProvenance {
    pub run_id: String,
    pub preview_id: String,
    pub skill_id: String,
    pub skill_name: String,
    pub instructions: String,
    pub input: String,
    pub admitted_at: i64,
}
fn rejected() -> StorageError {
    StorageError::InvalidData("skill preview rejected; refresh and preview again".into())
}
fn no_secrets(values: &[&str], secrets: &[String]) -> Result<(), StorageError> {
    if secrets
        .iter()
        .filter(|s| !s.is_empty())
        .any(|s| values.iter().any(|v| v.contains(s.as_str())))
    {
        return Err(StorageError::InvalidData(
            "configured secret in skill input".into(),
        ));
    }
    Ok(())
}
impl SqliteStore {
    pub fn preview_skill(
        &mut self,
        task: TaskId,
        skill: SkillId,
        secrets: &[String],
    ) -> Result<SkillPreview, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let core = load(&tx)?;
        let work = core.task(task)?;
        let selected = core.skill(skill)?;
        let agents: Vec<_> = work.assignees().collect();
        if !selected.enabled() || agents.len() != 1 {
            return Err(rejected());
        }
        let input = core.compose_skill_input(task, skill)?;
        no_secrets(
            &[
                work.title(),
                selected.name(),
                selected.instructions(),
                &input,
            ],
            secrets,
        )?;
        let count = core.runs_for_task(task)?.count();
        let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        tx.execute("INSERT INTO skill_previews(id,task_id,skill_id,agent_id,work_text,skill_name,instructions,input,expected_runs,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id,task.to_string(),skill.to_string(),agents[0].to_string(),work.title(),selected.name(),selected.instructions(),input,count as i64,execution::now()?.unix_millis()])?;
        tx.commit()?;
        Ok(SkillPreview {
            preview_id: id,
            task_id: task,
            skill_id: skill,
            input,
            expected_runs: count,
        })
    }
    pub fn start_skill_execution(
        &mut self,
        task: TaskId,
        preview_id: &str,
        provider: &str,
        model: &str,
        expected_runs: usize,
        secrets: &[String],
    ) -> Result<Execution, StorageError> {
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
            "SELECT task_id,skill_id,agent_id,work_text,skill_name,instructions,input,expected_runs FROM skill_previews WHERE id=?1 AND invalidated=0 AND consumed_run IS NULL",[preview_id],
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
            "INSERT INTO skill_provenance VALUES (?1,?2,1,?3,?4,?5,?6,?7)",
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
            "UPDATE skill_previews SET consumed_run=?2 WHERE id=?1",
            params![preview_id, id.to_string()],
        )?;
        let result = execution::get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn skill_provenance(&self) -> Result<Vec<SkillProvenance>, StorageError> {
        let mut statement=self.connection.prepare("SELECT run_id,preview_id,skill_id,skill_name,instructions,input,admitted_at FROM skill_provenance ORDER BY run_id")?;
        Ok(statement
            .query_map([], |r| {
                Ok(SkillProvenance {
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

#[cfg(test)]
mod tests {
    use super::*;
    fn seed(store: &mut SqliteStore) -> (TaskId, SkillId) {
        store
            .transact(|c| {
                let a = c.create_agent("Writer")?;
                let t = c.create_text_work("Summarize this text")?;
                c.assign(t, a)?;
                let s = c.create_skill("Concise", "Use one sentence.")?;
                c.set_skill_enabled(s, true)?;
                Ok((t, s))
            })
            .unwrap()
    }
    #[test]
    fn skill_execution_restart_provenance_and_explicit_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (t, s) = seed(&mut store);
        let p = store.preview_skill(t, s, &[]).unwrap();
        assert_eq!(store.read().unwrap().runs_for_task(t).unwrap().count(), 0);
        assert_eq!(
            p.input,
            "Skill instructions:\nUse one sentence.\n\nWork:\nSummarize this text"
        );
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        let e = store
            .start_skill_execution(t, &p.preview_id, "fixture", "test", 0, &[])
            .unwrap();
        assert_eq!(e.input, p.input);
        store
            .finish_execution(e.run, None, Some("provider_error"))
            .unwrap();
        assert!(
            store
                .start_skill_execution(t, &p.preview_id, "fixture", "test", 1, &[])
                .is_err()
        );
        store
            .transact(|c| c.update_skill(s, "Concise", "New instructions"))
            .unwrap();
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        let provenance = store.skill_provenance().unwrap();
        assert_eq!(provenance.len(), 1);
        assert_eq!(provenance[0].instructions, "Use one sentence.");
        assert_eq!(
            store.execution(e.run).unwrap().error.as_deref(),
            Some("provider_error")
        );
        let retry = store.preview_skill(t, s, &[]).unwrap();
        assert_eq!(retry.expected_runs, 1);
        let e2 = store
            .start_skill_execution(t, &retry.preview_id, "fixture", "test", 1, &[])
            .unwrap();
        assert_ne!(e.run, e2.run);
        store
            .finish_execution(e2.run, Some("Deterministic success"), None)
            .unwrap();
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(
            store.execution(e2.run).unwrap().output.as_deref(),
            Some("Deterministic success")
        );
        assert_eq!(store.skill_provenance().unwrap().len(), 2);
    }
    #[test]
    fn skill_execution_stale_secret_and_transaction_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (t, s) = seed(&mut store);
        assert!(store.preview_skill(t, s, &["sentence".into()]).is_err());
        let p = store.preview_skill(t, s, &[]).unwrap();
        store.transact(|c| c.set_skill_enabled(s, false)).unwrap();
        store.transact(|c| c.set_skill_enabled(s, true)).unwrap();
        assert!(
            store
                .start_skill_execution(t, &p.preview_id, "fixture", "test", 0, &[])
                .is_err()
        );
        let p = store.preview_skill(t, s, &[]).unwrap();
        store.connection.execute_batch("CREATE TRIGGER injected_failure BEFORE INSERT ON skill_provenance BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(
            store
                .start_skill_execution(t, &p.preview_id, "fixture", "test", 0, &[])
                .is_err()
        );
        drop(store);
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.read().unwrap().runs_for_task(t).unwrap().count(), 0);
        assert!(store.skill_provenance().unwrap().is_empty());
        store
            .connection
            .execute_batch("DROP TRIGGER injected_failure")
            .unwrap();
        assert!(
            store
                .start_skill_execution(t, &p.preview_id, "fixture", "test", 0, &["sentence".into()])
                .is_err()
        );
        store
            .start_skill_execution(t, &p.preview_id, "fixture", "test", 0, &[])
            .unwrap();
    }
    #[test]
    fn skill_execution_concurrent_duplicate_admission() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (t, s) = seed(&mut store);
        let p = store.preview_skill(t, s, &[]).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let id = p.preview_id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut store = SqliteStore::open(path).unwrap();
                    barrier.wait();
                    store
                        .start_skill_execution(t, &id, "fixture", "test", 0, &[])
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
        assert_eq!(store.read().unwrap().runs_for_task(t).unwrap().count(), 1);
        assert_eq!(store.skill_provenance().unwrap().len(), 1);
    }
}
