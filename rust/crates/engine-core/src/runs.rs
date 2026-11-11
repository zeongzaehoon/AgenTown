//! Recorded attempts only: no execution, verification, or Task status changes.
use crate::{AgentId, Core, DomainError, RunId, TaskId, TaskStatus};
use std::collections::BTreeSet;
use uuid::Uuid;

/// UTC Unix milliseconds, from 1970-01-01 through 9999-12-31 inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RunTimestamp(i64);
impl RunTimestamp {
    pub fn from_unix_millis(value: i64) -> Result<Self, DomainError> {
        if !(0..=253_402_300_799_999).contains(&value) {
            return Err(DomainError::InvalidRunTime);
        }
        Ok(Self(value))
    }
    pub fn unix_millis(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    ReportedSuccess,
    Failure,
    Interruption,
}

/// A terminal outcome and its time are always present together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Active,
    Finished {
        outcome: RunOutcome,
        ended_at: RunTimestamp,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub(crate) id: RunId,
    pub(crate) task: TaskId,
    pub(crate) stage: String,
    pub(crate) reporting_source: String,
    pub(crate) started_at: RunTimestamp,
    pub(crate) participants: BTreeSet<AgentId>,
    pub(crate) state: RunState,
}
impl Run {
    pub fn id(&self) -> RunId {
        self.id
    }
    pub fn task(&self) -> TaskId {
        self.task
    }
    pub fn stage(&self) -> &str {
        &self.stage
    }
    pub fn reporting_source(&self) -> &str {
        &self.reporting_source
    }
    pub fn started_at(&self) -> RunTimestamp {
        self.started_at
    }
    pub fn state(&self) -> RunState {
        self.state
    }
    pub fn participants(&self) -> impl ExactSizeIterator<Item = AgentId> + '_ {
        self.participants.iter().copied()
    }
}
impl Core {
    /// Snapshot selected current assignees. Validate every input before inserting.
    pub fn start_run(
        &mut self,
        task: TaskId,
        stage: &str,
        reporting_source: &str,
        started_at: RunTimestamp,
        participants: &[AgentId],
    ) -> Result<RunId, DomainError> {
        let current = self.task(task)?;
        if current.status() == TaskStatus::Cancelled {
            return Err(DomainError::TaskCancelled(task));
        }
        if stage.trim().is_empty() {
            return Err(DomainError::EmptyRunStage);
        }
        if reporting_source.trim().is_empty() {
            return Err(DomainError::EmptyReportingSource);
        }
        if participants.is_empty() {
            return Err(DomainError::EmptyRunParticipants);
        }
        let mut selected = BTreeSet::new();
        for &agent in participants {
            self.agent(agent)?;
            if !selected.insert(agent) {
                return Err(DomainError::DuplicateRunParticipant(agent));
            }
            if !current.assignees.contains(&agent) {
                return Err(DomainError::UnassignedRunParticipant { task, agent });
            }
        }
        if self
            .runs
            .values()
            .any(|run| run.task == task && run.state == RunState::Active)
        {
            return Err(DomainError::ActiveRunExists(task));
        }
        let id = loop {
            let id = RunId(Uuid::new_v4());
            if !self.runs.contains_key(&id) {
                break id;
            }
        };
        self.runs.insert(
            id,
            Run {
                id,
                task,
                stage: stage.trim().into(),
                reporting_source: reporting_source.trim().into(),
                started_at,
                participants: selected,
                state: RunState::Active,
            },
        );
        Ok(id)
    }
    pub fn run(&self, id: RunId) -> Result<&Run, DomainError> {
        self.runs.get(&id).ok_or(DomainError::UnknownRun(id))
    }
    pub fn runs(&self) -> impl ExactSizeIterator<Item = &Run> {
        self.runs.values()
    }
    /// Stable ID order, not chronological order. Unknown Tasks are errors.
    pub fn runs_for_task(&self, task: TaskId) -> Result<impl Iterator<Item = &Run>, DomainError> {
        self.task(task)?;
        Ok(self.runs.values().filter(move |run| run.task == task))
    }
    /// Finalization remains available after cancellation and never transitions a Task.
    pub fn finish_run(
        &mut self,
        id: RunId,
        outcome: RunOutcome,
        ended_at: RunTimestamp,
    ) -> Result<(), DomainError> {
        let run = self.run(id)?;
        if run.state != RunState::Active {
            return Err(DomainError::RunAlreadyFinished(id));
        }
        if ended_at < run.started_at {
            return Err(DomainError::InvalidRunTime);
        }
        self.runs.get_mut(&id).expect("validated run").state =
            RunState::Finished { outcome, ended_at };
        Ok(())
    }
}
