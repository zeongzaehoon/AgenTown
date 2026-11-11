use super::*;
use llm_engine_core::{
    HookTarget,
    persistence::{HookRecord, LoopPolicyRecord, SkillRecord},
};
pub(super) fn load(db: &Connection, snapshot: &mut Snapshot) -> Result<(), StorageError> {
    let mut q = db.prepare("SELECT id,name,instructions,enabled FROM skills")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, bool>(3)?,
        ))
    })? {
        let (id, name, instructions, enabled) = row?;
        snapshot.skills.push(SkillRecord {
            id: parse_id(id)?,
            name,
            instructions,
            enabled,
        });
    }
    let mut q = db.prepare("SELECT id,name,skill_id,agent_id,team_id,event,enabled FROM hooks")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, bool>(6)?,
        ))
    })? {
        let (id, name, skill, agent, team, event, enabled) = row?;
        let target = match (agent, team) {
            (Some(id), None) => HookTarget::Agent(parse_id(id)?),
            (None, Some(id)) => HookTarget::Team(parse_id(id)?),
            _ => return Err(StorageError::InvalidData("invalid hook target".into())),
        };
        snapshot.hooks.push(HookRecord {
            id: parse_id(id)?,
            name,
            skill_id: parse_id(skill)?,
            target,
            event: event.parse()?,
            enabled,
        });
    }
    let mut q = db.prepare(
        "SELECT id,name,task_id,max_iterations,interval_seconds,enabled FROM loop_policies",
    )?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, u32>(3)?,
            r.get::<_, u32>(4)?,
            r.get::<_, bool>(5)?,
        ))
    })? {
        let (id, name, task, max_iterations, interval_seconds, enabled) = row?;
        snapshot.loop_policies.push(LoopPolicyRecord {
            id: parse_id(id)?,
            name,
            task_id: parse_id(task)?,
            max_iterations,
            interval_seconds,
            enabled,
        });
    }
    Ok(())
}
pub(super) fn persist(db: &Connection, before: &Core, after: &Core) -> Result<(), StorageError> {
    for old in before.hooks() {
        if after.hook(old.id()).is_err() {
            db.execute("DELETE FROM hooks WHERE id=?1", [old.id().to_string()])?;
        }
    }
    for old in before.loop_policies() {
        if after.loop_policy(old.id()).is_err() {
            db.execute(
                "DELETE FROM loop_policies WHERE id=?1",
                [old.id().to_string()],
            )?;
        }
    }
    for old in before.skills() {
        if after.skill(old.id()).is_err() {
            db.execute("DELETE FROM skills WHERE id=?1", [old.id().to_string()])?;
        }
    }
    for r in after.skills() {
        if before.skill(r.id()).ok() == Some(r) {
            continue;
        }
        db.execute("INSERT INTO skills(id,name,instructions,enabled) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,instructions=excluded.instructions,enabled=excluded.enabled", params![r.id().to_string(),r.name(),r.instructions(),r.enabled()])?;
    }
    for r in after.hooks() {
        if before.hook(r.id()).ok() == Some(r) {
            continue;
        }
        let (agent, team) = match r.target() {
            HookTarget::Agent(id) => (Some(id.to_string()), None),
            HookTarget::Team(id) => (None, Some(id.to_string())),
        };
        db.execute("INSERT INTO hooks(id,name,skill_id,agent_id,team_id,event,enabled) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,skill_id=excluded.skill_id,agent_id=excluded.agent_id,team_id=excluded.team_id,event=excluded.event,enabled=excluded.enabled", params![r.id().to_string(),r.name(),r.skill_id().to_string(),agent,team,r.event().as_str(),r.enabled()])?;
    }
    for r in after.loop_policies() {
        if before.loop_policy(r.id()).ok() == Some(r) {
            continue;
        }
        db.execute("INSERT INTO loop_policies(id,name,task_id,max_iterations,interval_seconds,enabled) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,task_id=excluded.task_id,max_iterations=excluded.max_iterations,interval_seconds=excluded.interval_seconds,enabled=excluded.enabled", params![r.id().to_string(),r.name(),r.task_id().to_string(),r.max_iterations(),r.interval_seconds(),r.enabled()])?;
    }
    Ok(())
}
