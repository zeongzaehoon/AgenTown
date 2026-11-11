//! Storage boundary: adapters restore validated state and atomically run commands.
use crate::{Agent, AgentId, Core, DomainError, Task, TaskId, TaskStatus, Team, TeamId};
use std::{error::Error, fmt};

/// Transport records, not mutable domain entities. Restoration validates all rows.
#[derive(Debug, Default, Clone)]
pub struct Snapshot {
    pub artifacts: Vec<ArtifactRecord>,
    pub evidence: Vec<EvidenceRecord>,
    pub runs: Vec<RunRecord>,
    pub agents: Vec<(AgentId, String)>,
    pub tasks: Vec<(TaskId, String, TaskStatus)>,
    pub teams: Vec<(TeamId, String)>,
    pub memberships: Vec<(TeamId, AgentId)>,
    pub assignments: Vec<(TaskId, AgentId)>,
}

/// Raw transport data. Historical participants need existing Agents, not current assignments.
#[derive(Debug, Clone)]
pub struct RunRecord {
    pub id: crate::RunId,
    pub task: TaskId,
    pub stage: String,
    pub reporting_source: String,
    pub started_at: i64,
    pub terminal: Option<(crate::RunOutcome, i64)>,
    pub participants: Vec<AgentId>,
}

/// Raw caller assertions; IDs and every relationship are validated during restoration.
#[derive(Debug, Clone)]
pub struct ArtifactRecord {
    pub id: crate::ArtifactId,
    pub run: crate::RunId,
    pub locator: String,
    pub reported_sha256: String,
    pub reporting_source: String,
    pub recorded_at: i64,
}
#[derive(Debug, Clone)]
pub struct EvidenceRecord {
    pub id: crate::EvidenceId,
    pub run: crate::RunId,
    pub criterion: String,
    pub explanation: String,
    pub reported_outcome: crate::ReportedOutcome,
    pub reporting_source: String,
    pub recorded_at: i64,
    pub artifacts: Vec<crate::ArtifactId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidSnapshot(pub &'static str);

impl fmt::Display for InvalidSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid stored domain: {}", self.0)
    }
}
impl Error for InvalidSnapshot {}

impl Core {
    pub fn restore(snapshot: Snapshot) -> Result<Self, InvalidSnapshot> {
        let mut core = Self::default();
        for (id, name) in snapshot.agents {
            if name.trim().is_empty() || name.trim() != name {
                return Err(InvalidSnapshot("invalid agent name"));
            }
            if core.agents.insert(id, Agent { id, name }).is_some() {
                return Err(InvalidSnapshot("duplicate agent ID"));
            }
        }
        for (id, name) in snapshot.teams {
            if name.trim().is_empty() || name.trim() != name {
                return Err(InvalidSnapshot("invalid team name"));
            }
            if core
                .teams
                .insert(
                    id,
                    Team {
                        id,
                        name,
                        members: Default::default(),
                    },
                )
                .is_some()
            {
                return Err(InvalidSnapshot("duplicate team ID"));
            }
        }
        for (team, agent) in snapshot.memberships {
            if !core.agents.contains_key(&agent) {
                return Err(InvalidSnapshot("unknown membership agent"));
            }
            let team = core
                .teams
                .get_mut(&team)
                .ok_or(InvalidSnapshot("unknown membership team"))?;
            if !team.members.insert(agent) {
                return Err(InvalidSnapshot("duplicate membership"));
            }
        }
        for (id, title, status) in snapshot.tasks {
            if title.trim().is_empty() {
                return Err(InvalidSnapshot("invalid task title"));
            }
            if core
                .tasks
                .insert(
                    id,
                    Task {
                        id,
                        title,
                        status,
                        assignees: Default::default(),
                    },
                )
                .is_some()
            {
                return Err(InvalidSnapshot("duplicate task ID"));
            }
        }
        for (task, agent) in snapshot.assignments {
            if !core.agents.contains_key(&agent) {
                return Err(InvalidSnapshot("unknown assignment agent"));
            }
            let task = core
                .tasks
                .get_mut(&task)
                .ok_or(InvalidSnapshot("unknown assignment task"))?;
            if !task.assignees.insert(agent) {
                return Err(InvalidSnapshot("duplicate assignment"));
            }
        }
        for task in core.tasks.values() {
            if matches!(task.status, TaskStatus::InProgress | TaskStatus::Blocked)
                && task.assignees.is_empty()
            {
                return Err(InvalidSnapshot("active task has no assignees"));
            }
        }
        for record in snapshot.runs {
            use crate::{Run, RunState, RunTimestamp};
            if !core.tasks.contains_key(&record.task) {
                return Err(InvalidSnapshot("unknown run task"));
            }
            if record.stage.trim().is_empty()
                || record.stage.trim() != record.stage
                || record.reporting_source.trim().is_empty()
                || record.reporting_source.trim() != record.reporting_source
            {
                return Err(InvalidSnapshot("invalid run stage or reporting source"));
            }
            let started_at = RunTimestamp::from_unix_millis(record.started_at)
                .map_err(|_| InvalidSnapshot("invalid run start"))?;
            let state = match record.terminal {
                None => RunState::Active,
                Some((outcome, end)) => {
                    let ended_at = RunTimestamp::from_unix_millis(end)
                        .map_err(|_| InvalidSnapshot("invalid run end"))?;
                    if ended_at < started_at {
                        return Err(InvalidSnapshot("run end before start"));
                    }
                    RunState::Finished { outcome, ended_at }
                }
            };
            let mut participants = std::collections::BTreeSet::new();
            if record.participants.is_empty() {
                return Err(InvalidSnapshot("empty run participants"));
            }
            for agent in record.participants {
                if !core.agents.contains_key(&agent) {
                    return Err(InvalidSnapshot("unknown run participant"));
                }
                if !participants.insert(agent) {
                    return Err(InvalidSnapshot("duplicate run participant"));
                }
            }
            if state == RunState::Active
                && core
                    .runs
                    .values()
                    .any(|run| run.task() == record.task && run.state() == RunState::Active)
            {
                return Err(InvalidSnapshot("multiple active runs for task"));
            }
            let run = Run {
                id: record.id,
                task: record.task,
                stage: record.stage,
                reporting_source: record.reporting_source,
                started_at,
                state,
                participants,
            };
            if core.runs.insert(record.id, run).is_some() {
                return Err(InvalidSnapshot("duplicate run ID"));
            }
        }
        for record in snapshot.artifacts {
            let artifact = core
                .validate_artifact(record)
                .map_err(|_| InvalidSnapshot("invalid artifact"))?;
            if core.artifacts.insert(artifact.id(), artifact).is_some() {
                return Err(InvalidSnapshot("duplicate artifact ID"));
            }
        }
        for record in snapshot.evidence {
            let evidence = core
                .validate_evidence(record)
                .map_err(|_| InvalidSnapshot("invalid evidence"))?;
            if core.evidence.insert(evidence.id(), evidence).is_some() {
                return Err(InvalidSnapshot("duplicate evidence ID"));
            }
        }
        Ok(core)
    }
}

/// A fresh consistent read; mutations load the latest state under a writer lock.
/// Implementations must roll back the entire command batch on any error.
pub trait Persistence {
    type Error: Error;
    fn read(&mut self) -> Result<Core, Self::Error>;
    fn transact<T>(
        &mut self,
        command: impl FnOnce(&mut Core) -> Result<T, DomainError>,
    ) -> Result<T, Self::Error>;
}
