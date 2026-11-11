//! In-memory product domain. All mutations pass through [`Core`].
//! Completion is deliberately unavailable until verification evidence is modeled.
//!
//! Run IDs cannot be used as Task IDs:
//! ```compile_fail
//! use llm_engine_core::{Core, RunId};
//! let core = Core::default();
//! let run: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
//! core.task(run);
//! ```
//!
//! Agent and Task identities are different types:
//! ```compile_fail
//! use llm_engine_core::Core;
//! let mut core = Core::default();
//! let agent = core.create_agent("Developer").unwrap();
//! core.task(agent); // an AgentId cannot be used as a TaskId
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::{error::Error, fmt, str::FromStr};
use uuid::Uuid;

pub mod persistence;
mod provenance;
mod runs;
pub use provenance::{Artifact, Evidence, ReportedOutcome};
pub use runs::{Run, RunOutcome, RunState, RunTimestamp};

macro_rules! identity {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(Uuid);

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }
    };
}

identity!(AgentId);
identity!(TaskId);
identity!(TeamId);
identity!(RunId);
identity!(ArtifactId);
identity!(EvidenceId);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    id: AgentId,
    name: String,
}

impl Agent {
    pub fn id(&self) -> AgentId {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Team {
    id: TeamId,
    name: String,
    members: BTreeSet<AgentId>,
}
impl Team {
    pub fn id(&self) -> TeamId {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn members(&self) -> impl ExactSizeIterator<Item = AgentId> + '_ {
        self.members.iter().copied()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    id: TaskId,
    title: String,
    status: TaskStatus,
    assignees: BTreeSet<AgentId>,
}

impl Task {
    pub fn id(&self) -> TaskId {
        self.id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn status(&self) -> TaskStatus {
        self.status
    }
    pub fn assignees(&self) -> impl ExactSizeIterator<Item = AgentId> + '_ {
        self.assignees.iter().copied()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    EmptyArtifactLocator,
    InvalidReportedSha256,
    EmptyEvidenceCriterion,
    EmptyEvidenceExplanation,
    EmptyEvidenceArtifacts,
    RunNotTerminal(RunId),
    InvalidRecordingTime,
    UnknownArtifact(ArtifactId),
    UnknownEvidence(EvidenceId),
    DuplicateArtifactLink(ArtifactId),
    CrossRunArtifact(ArtifactId),
    EmptyRunStage,
    EmptyReportingSource,
    EmptyRunParticipants,
    InvalidRunTime,
    UnknownRun(RunId),
    ActiveRunExists(TaskId),
    RunAlreadyFinished(RunId),
    DuplicateRunParticipant(AgentId),
    UnassignedRunParticipant {
        task: TaskId,
        agent: AgentId,
    },
    EmptyName,
    EmptyTitle,
    EmptyTeamName,
    UnknownTeam(TeamId),
    EmptyTeam(TeamId),
    AlreadyMember {
        team: TeamId,
        agent: AgentId,
    },
    UnknownAgent(AgentId),
    UnknownTask(TaskId),
    AlreadyAssigned {
        task: TaskId,
        agent: AgentId,
    },
    TaskCancelled(TaskId),
    NoAssignees(TaskId),
    InvalidTransition {
        task: TaskId,
        from: TaskStatus,
        to: TaskStatus,
    },
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyArtifactLocator => write!(f, "artifact locator must not be empty"),
            Self::InvalidReportedSha256 => write!(
                f,
                "reported SHA-256 must be exactly 64 ASCII hexadecimal digits"
            ),
            Self::EmptyEvidenceCriterion => write!(f, "evidence criterion must not be empty"),
            Self::EmptyEvidenceExplanation => write!(f, "evidence explanation must not be empty"),
            Self::EmptyEvidenceArtifacts => write!(f, "evidence requires at least one artifact"),
            Self::RunNotTerminal(id) => write!(f, "run {id} is not terminal"),
            Self::InvalidRecordingTime => {
                write!(f, "recording time precedes run end or referenced artifact")
            }
            Self::UnknownArtifact(id) => write!(f, "unknown artifact: {id}"),
            Self::UnknownEvidence(id) => write!(f, "unknown evidence: {id}"),
            Self::DuplicateArtifactLink(id) => write!(f, "duplicate artifact link: {id}"),
            Self::CrossRunArtifact(id) => write!(f, "artifact {id} belongs to another run"),
            Self::EmptyRunStage => write!(f, "run stage must not be empty"),
            Self::EmptyReportingSource => write!(f, "reporting source must not be empty"),
            Self::EmptyRunParticipants => write!(f, "run participants must not be empty"),
            Self::InvalidRunTime => write!(f, "invalid run timestamp or end before start"),
            Self::UnknownRun(id) => write!(f, "unknown run: {id}"),
            Self::ActiveRunExists(id) => write!(f, "task {id} already has an active run"),
            Self::RunAlreadyFinished(id) => write!(f, "run {id} already finished"),
            Self::DuplicateRunParticipant(id) => write!(f, "duplicate run participant: {id}"),
            Self::UnassignedRunParticipant { task, agent } => {
                write!(f, "agent {agent} is not assigned to task {task}")
            }
            Self::EmptyName => write!(f, "agent name must not be empty"),
            Self::EmptyTeamName => write!(f, "team name must not be empty"),
            Self::UnknownTeam(id) => write!(f, "unknown team: {id}"),
            Self::EmptyTeam(id) => write!(f, "team {id} has no members"),
            Self::AlreadyMember { team, agent } => {
                write!(f, "agent {agent} is already a member of team {team}")
            }
            Self::EmptyTitle => write!(f, "task title must not be empty"),
            Self::UnknownAgent(id) => write!(f, "unknown agent: {id}"),
            Self::UnknownTask(id) => write!(f, "unknown task: {id}"),
            Self::AlreadyAssigned { task, agent } => {
                write!(f, "agent {agent} is already assigned to task {task}")
            }
            Self::TaskCancelled(id) => write!(f, "task {id} is cancelled"),
            Self::NoAssignees(id) => write!(f, "task {id} needs an assignee before starting"),
            Self::InvalidTransition { task, from, to } => {
                write!(f, "task {task} cannot transition from {from:?} to {to:?}")
            }
        }
    }
}

impl Error for DomainError {}

/// Owns domain state; returned entities are read-only. Lists are ordered by ID.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Core {
    agents: BTreeMap<AgentId, Agent>,
    teams: BTreeMap<TeamId, Team>,
    tasks: BTreeMap<TaskId, Task>,
    runs: BTreeMap<RunId, Run>,
    artifacts: BTreeMap<ArtifactId, Artifact>,
    evidence: BTreeMap<EvidenceId, Evidence>,
}

impl Core {
    pub fn create_team(&mut self, name: &str) -> Result<TeamId, DomainError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(DomainError::EmptyTeamName);
        }
        let id = loop {
            let id = TeamId(Uuid::new_v4());
            if !self.teams.contains_key(&id) {
                break id;
            }
        };
        self.teams.insert(
            id,
            Team {
                id,
                name: name.into(),
                members: BTreeSet::new(),
            },
        );
        Ok(id)
    }
    pub fn team(&self, id: TeamId) -> Result<&Team, DomainError> {
        self.teams.get(&id).ok_or(DomainError::UnknownTeam(id))
    }
    pub fn teams(&self) -> impl ExactSizeIterator<Item = &Team> {
        self.teams.values()
    }

    /// Validate the entire batch, including repeated inputs, before mutation.
    pub fn add_team_members(
        &mut self,
        team: TeamId,
        agents: &[AgentId],
    ) -> Result<(), DomainError> {
        let current = self.team(team)?;
        let mut additions = BTreeSet::new();
        for &agent in agents {
            self.agent(agent)?;
            if current.members.contains(&agent) || !additions.insert(agent) {
                return Err(DomainError::AlreadyMember { team, agent });
            }
        }
        self.teams
            .get_mut(&team)
            .expect("validated team")
            .members
            .extend(additions);
        Ok(())
    }

    /// Copy current membership; later membership changes cannot affect this Task.
    pub fn assign_team(&mut self, task: TaskId, team: TeamId) -> Result<(), DomainError> {
        let current = self.task(task)?;
        let members = &self.team(team)?.members;
        if current.status == TaskStatus::Cancelled {
            return Err(DomainError::TaskCancelled(task));
        }
        if members.is_empty() {
            return Err(DomainError::EmptyTeam(team));
        }
        for &agent in members {
            self.agent(agent)?;
            if current.assignees.contains(&agent) {
                return Err(DomainError::AlreadyAssigned { task, agent });
            }
        }
        let members = members.clone();
        self.tasks
            .get_mut(&task)
            .expect("validated task")
            .assignees
            .extend(members);
        Ok(())
    }

    pub fn create_agent(&mut self, name: &str) -> Result<AgentId, DomainError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(DomainError::EmptyName);
        }
        let id = loop {
            let id = AgentId(Uuid::new_v4());
            if !self.agents.contains_key(&id) {
                break id;
            }
        };
        self.agents.insert(
            id,
            Agent {
                id,
                name: name.into(),
            },
        );
        Ok(id)
    }

    pub fn create_task(&mut self, title: &str) -> Result<TaskId, DomainError> {
        self.create_text_work(title.trim())
    }

    /// Create work with verbatim request text, including surrounding whitespace.
    /// Whitespace-only requests remain invalid; ordinary task titles are trimmed.
    pub fn create_text_work(&mut self, title: &str) -> Result<TaskId, DomainError> {
        if title.trim().is_empty() {
            return Err(DomainError::EmptyTitle);
        }
        let id = loop {
            let id = TaskId(Uuid::new_v4());
            if !self.tasks.contains_key(&id) {
                break id;
            }
        };
        self.tasks.insert(
            id,
            Task {
                id,
                title: title.into(),
                status: TaskStatus::Pending,
                assignees: BTreeSet::new(),
            },
        );
        Ok(id)
    }

    pub fn agent(&self, id: AgentId) -> Result<&Agent, DomainError> {
        self.agents.get(&id).ok_or(DomainError::UnknownAgent(id))
    }

    pub fn task(&self, id: TaskId) -> Result<&Task, DomainError> {
        self.tasks.get(&id).ok_or(DomainError::UnknownTask(id))
    }

    pub fn agents(&self) -> impl ExactSizeIterator<Item = &Agent> {
        self.agents.values()
    }

    pub fn tasks(&self) -> impl ExactSizeIterator<Item = &Task> {
        self.tasks.values()
    }

    /// Duplicate assignments are errors. Every rejection leaves all state unchanged.
    pub fn assign(&mut self, task: TaskId, agent: AgentId) -> Result<(), DomainError> {
        let current = self.task(task)?;
        self.agent(agent)?;
        if current.status == TaskStatus::Cancelled {
            return Err(DomainError::TaskCancelled(task));
        }
        if current.assignees.contains(&agent) {
            return Err(DomainError::AlreadyAssigned { task, agent });
        }
        self.tasks
            .get_mut(&task)
            .expect("validated task")
            .assignees
            .insert(agent);
        Ok(())
    }

    /// Only documented lifecycle edges are accepted; starting requires an assignee.
    pub fn transition(&mut self, task: TaskId, to: TaskStatus) -> Result<(), DomainError> {
        use TaskStatus::*;
        let current = self.task(task)?;
        let from = current.status;
        if !matches!(
            (from, to),
            (Pending, InProgress | Cancelled)
                | (InProgress, Blocked | Cancelled)
                | (Blocked, InProgress | Cancelled)
        ) {
            return Err(DomainError::InvalidTransition { task, from, to });
        }
        if to == InProgress && current.assignees.is_empty() {
            return Err(DomainError::NoAssignees(task));
        }
        self.tasks.get_mut(&task).expect("validated task").status = to;
        Ok(())
    }
}
