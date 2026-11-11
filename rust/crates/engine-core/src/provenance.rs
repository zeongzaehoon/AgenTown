//! Immutable caller assertions: no I/O, reporter authentication, or completion decision.
use crate::persistence::{ArtifactRecord, EvidenceRecord};
use crate::{ArtifactId, Core, DomainError, EvidenceId, RunId, RunState, RunTimestamp, TaskId};
use std::collections::BTreeSet;
use uuid::Uuid;

/// An assessment reported by a caller, never an independently verified result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportedOutcome {
    Pass,
    Fail,
    Inconclusive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    id: ArtifactId,
    run: RunId,
    locator: String,
    reported_sha256: String,
    reporting_source: String,
    recorded_at: RunTimestamp,
}
impl Artifact {
    pub fn id(&self) -> ArtifactId {
        self.id
    }
    pub fn run(&self) -> RunId {
        self.run
    }
    pub fn locator(&self) -> &str {
        &self.locator
    }
    pub fn reported_sha256(&self) -> &str {
        &self.reported_sha256
    }
    pub fn reporting_source(&self) -> &str {
        &self.reporting_source
    }
    pub fn recorded_at(&self) -> RunTimestamp {
        self.recorded_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evidence {
    id: EvidenceId,
    run: RunId,
    criterion: String,
    explanation: String,
    reported_outcome: ReportedOutcome,
    reporting_source: String,
    recorded_at: RunTimestamp,
    artifacts: BTreeSet<ArtifactId>,
}
impl Evidence {
    pub fn id(&self) -> EvidenceId {
        self.id
    }
    pub fn run(&self) -> RunId {
        self.run
    }
    pub fn criterion(&self) -> &str {
        &self.criterion
    }
    pub fn explanation(&self) -> &str {
        &self.explanation
    }
    pub fn reported_outcome(&self) -> ReportedOutcome {
        self.reported_outcome
    }
    pub fn reporting_source(&self) -> &str {
        &self.reporting_source
    }
    pub fn recorded_at(&self) -> RunTimestamp {
        self.recorded_at
    }
    pub fn artifacts(&self) -> impl ExactSizeIterator<Item = ArtifactId> + '_ {
        self.artifacts.iter().copied()
    }
}

impl Core {
    fn validate_recording(&self, run: RunId, time: RunTimestamp) -> Result<(), DomainError> {
        match self.run(run)?.state() {
            RunState::Active => Err(DomainError::RunNotTerminal(run)),
            RunState::Finished { ended_at, .. } if time < ended_at => {
                Err(DomainError::InvalidRecordingTime)
            }
            _ => Ok(()),
        }
    }
    pub(crate) fn validate_artifact(&self, r: ArtifactRecord) -> Result<Artifact, DomainError> {
        let recorded_at = RunTimestamp::from_unix_millis(r.recorded_at)?;
        self.validate_recording(r.run, recorded_at)?;
        if r.locator.trim().is_empty() {
            return Err(DomainError::EmptyArtifactLocator);
        }
        if r.reporting_source.trim().is_empty() {
            return Err(DomainError::EmptyReportingSource);
        }
        if r.reported_sha256.len() != 64
            || !r.reported_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(DomainError::InvalidReportedSha256);
        }
        Ok(Artifact {
            id: r.id,
            run: r.run,
            locator: r.locator.trim().into(),
            reported_sha256: r.reported_sha256.to_ascii_lowercase(),
            reporting_source: r.reporting_source.trim().into(),
            recorded_at,
        })
    }
    pub(crate) fn validate_evidence(&self, r: EvidenceRecord) -> Result<Evidence, DomainError> {
        let recorded_at = RunTimestamp::from_unix_millis(r.recorded_at)?;
        self.validate_recording(r.run, recorded_at)?;
        if r.criterion.trim().is_empty() {
            return Err(DomainError::EmptyEvidenceCriterion);
        }
        if r.explanation.trim().is_empty() {
            return Err(DomainError::EmptyEvidenceExplanation);
        }
        if r.reporting_source.trim().is_empty() {
            return Err(DomainError::EmptyReportingSource);
        }
        if r.artifacts.is_empty() {
            return Err(DomainError::EmptyEvidenceArtifacts);
        }
        let mut artifacts = BTreeSet::new();
        for id in r.artifacts {
            let artifact = self.artifact(id)?;
            if !artifacts.insert(id) {
                return Err(DomainError::DuplicateArtifactLink(id));
            }
            if artifact.run != r.run {
                return Err(DomainError::CrossRunArtifact(id));
            }
            if artifact.recorded_at > recorded_at {
                return Err(DomainError::InvalidRecordingTime);
            }
        }
        Ok(Evidence {
            id: r.id,
            run: r.run,
            criterion: r.criterion.trim().into(),
            explanation: r.explanation.trim().into(),
            reported_outcome: r.reported_outcome,
            reporting_source: r.reporting_source.trim().into(),
            recorded_at,
            artifacts,
        })
    }
    /// Register a locator and caller-reported digest without inspecting any content.
    pub fn register_artifact(
        &mut self,
        run: RunId,
        locator: &str,
        reported_sha256: &str,
        reporting_source: &str,
        recorded_at: RunTimestamp,
    ) -> Result<ArtifactId, DomainError> {
        let id = loop {
            let id = ArtifactId(Uuid::new_v4());
            if !self.artifacts.contains_key(&id) {
                break id;
            }
        };
        let artifact = self.validate_artifact(ArtifactRecord {
            id,
            run,
            locator: locator.into(),
            reported_sha256: reported_sha256.into(),
            reporting_source: reporting_source.into(),
            recorded_at: recorded_at.unix_millis(),
        })?;
        self.artifacts.insert(id, artifact);
        Ok(id)
    }
    /// Each report receives a new identity, including identical or contradictory reports.
    #[allow(clippy::too_many_arguments)]
    pub fn record_evidence(
        &mut self,
        run: RunId,
        criterion: &str,
        explanation: &str,
        reported_outcome: ReportedOutcome,
        reporting_source: &str,
        recorded_at: RunTimestamp,
        artifacts: &[ArtifactId],
    ) -> Result<EvidenceId, DomainError> {
        let id = loop {
            let id = EvidenceId(Uuid::new_v4());
            if !self.evidence.contains_key(&id) {
                break id;
            }
        };
        let evidence = self.validate_evidence(EvidenceRecord {
            id,
            run,
            criterion: criterion.into(),
            explanation: explanation.into(),
            reported_outcome,
            reporting_source: reporting_source.into(),
            recorded_at: recorded_at.unix_millis(),
            artifacts: artifacts.into(),
        })?;
        self.evidence.insert(id, evidence);
        Ok(id)
    }
    pub fn artifact(&self, id: ArtifactId) -> Result<&Artifact, DomainError> {
        self.artifacts
            .get(&id)
            .ok_or(DomainError::UnknownArtifact(id))
    }
    pub fn evidence(&self, id: EvidenceId) -> Result<&Evidence, DomainError> {
        self.evidence
            .get(&id)
            .ok_or(DomainError::UnknownEvidence(id))
    }
    pub fn artifacts(&self) -> impl ExactSizeIterator<Item = &Artifact> {
        self.artifacts.values()
    }
    pub fn evidence_records(&self) -> impl ExactSizeIterator<Item = &Evidence> {
        self.evidence.values()
    }
    pub fn artifacts_for_run(
        &self,
        run: RunId,
    ) -> Result<impl Iterator<Item = &Artifact>, DomainError> {
        self.run(run)?;
        Ok(self.artifacts.values().filter(move |a| a.run == run))
    }
    pub fn evidence_for_run(
        &self,
        run: RunId,
    ) -> Result<impl Iterator<Item = &Evidence>, DomainError> {
        self.run(run)?;
        Ok(self.evidence.values().filter(move |e| e.run == run))
    }
    pub fn artifacts_for_task(
        &self,
        task: TaskId,
    ) -> Result<impl Iterator<Item = &Artifact>, DomainError> {
        self.task(task)?;
        Ok(self
            .artifacts
            .values()
            .filter(move |a| self.runs[&a.run].task() == task))
    }
    pub fn evidence_for_task(
        &self,
        task: TaskId,
    ) -> Result<impl Iterator<Item = &Evidence>, DomainError> {
        self.task(task)?;
        Ok(self
            .evidence
            .values()
            .filter(move |e| self.runs[&e.run].task() == task))
    }
}
