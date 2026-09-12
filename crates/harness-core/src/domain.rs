use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedTask {
    pub title: String,
    pub owner: String,
    pub acceptance: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub status: String,
    pub summary: String,
    pub evidence: Vec<String>,
    pub research: Vec<String>,
    pub lessons: Vec<String>,
    pub tasks: Vec<ProposedTask>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub meeting: u64,
    pub spec: ProposedTask,
    pub status: String,
    pub attempts: u32,
    pub feedback: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub cycle: u64,
    pub phase: String,
    pub tasks: Vec<Task>,
    pub current: Option<usize>,
    pub next_at: u64,
    pub infrastructure_failures: u32,
    pub quota_failures: u32,
    pub last_summary: String,
    pub lessons: Vec<String>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            cycle: 0,
            phase: "meeting".into(),
            tasks: vec![],
            current: None,
            next_at: 0,
            infrastructure_failures: 0,
            quota_failures: 0,
            last_summary: "Harness initialized; select the first useful development Task.".into(),
            lessons: vec![],
        }
    }
}
impl State {
    pub fn validate_report(&self, r: &Report) -> Result<()> {
        if !["success", "blocked", "complete"].contains(&r.status.as_str())
            || r.summary.trim().is_empty()
        {
            bail!("invalid status or empty summary");
        }
        if r.status == "complete" && self.phase != "meeting" {
            bail!("only meeting can declare project completion");
        }
        if r.status != "blocked"
            && (r.evidence.is_empty() || r.evidence.iter().any(|x| x.trim().is_empty()))
        {
            bail!("successful report requires concrete evidence");
        }
        if self.phase == "meeting" && r.status == "success" {
            if r.tasks.is_empty() || r.tasks.len() > 3 {
                bail!("meeting requires 1..3 tasks");
            }
            if !r.research.iter().any(|x| x.contains("https://")) {
                bail!("meeting requires research source URLs");
            }
            for t in &r.tasks {
                if t.title.trim().is_empty()
                    || t.owner.trim().is_empty()
                    || t.acceptance.trim().is_empty()
                {
                    bail!("incomplete task");
                }
            }
            let mut titles = std::collections::HashSet::new();
            if r.tasks
                .iter()
                .any(|t| !titles.insert(t.title.trim().to_lowercase()))
            {
                bail!("duplicate tasks in meeting");
            }
        } else if !r.tasks.is_empty() {
            bail!("tasks only allowed in a successful meeting");
        }
        Ok(())
    }
    pub fn apply(&mut self, r: Report, now: u64, idle: u64, max_attempts: u32) -> Result<()> {
        self.validate_report(&r)?;
        self.infrastructure_failures = 0;
        self.quota_failures = 0;
        self.next_at = 0;
        self.last_summary = r.summary.clone();
        self.lessons.extend(r.lessons);
        if self.lessons.len() > 30 {
            self.lessons.drain(..self.lessons.len() - 30);
        }
        if self.phase == "meeting" {
            if r.status != "success" {
                self.next_at = now + idle;
                return Ok(());
            }
            self.cycle += 1;
            for (i, spec) in r.tasks.into_iter().enumerate() {
                self.tasks.push(Task {
                    id: format!("C{}-T{}", self.cycle, i + 1),
                    meeting: self.cycle,
                    spec,
                    status: "pending".into(),
                    attempts: 0,
                    feedback: String::new(),
                });
            }
            self.select_next();
        } else if r.status == "blocked" {
            self.task_failed(r.summary, max_attempts);
        } else if self.phase == "implement" {
            self.tasks[self.current.unwrap()].feedback = serde_json::to_string(&r.evidence)?;
            self.phase = "verify".into();
        } else if self.phase == "review" {
            let task = &mut self.tasks[self.current.unwrap()];
            task.status = "done".into();
            task.feedback = r.summary;
            self.select_next();
        } else {
            bail!("unexpected report phase {}", self.phase);
        }
        Ok(())
    }
    pub fn task_failed(&mut self, feedback: String, max: u32) {
        let task = &mut self.tasks[self.current.expect("task phase requires current")];
        task.attempts += 1;
        task.feedback = feedback;
        if task.attempts >= max {
            task.status = "blocked".into();
            self.select_next();
        } else {
            self.phase = "implement".into();
        }
    }
    fn select_next(&mut self) {
        self.current = self.tasks.iter().position(|x| x.status == "pending");
        self.phase = if self.current.is_some() {
            "implement"
        } else {
            "meeting"
        }
        .into();
    }
}

pub fn cooldown(base: u64, cap: u64, attempt: u32) -> u64 {
    base.saturating_mul(1u64 << attempt.saturating_sub(1).min(16))
        .min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report() -> Report {
        Report {
            status: "success".into(),
            summary: "selected".into(),
            evidence: vec!["PLAN.md".into()],
            research: vec!["https://example.com/official".into()],
            lessons: vec![],
            tasks: vec![ProposedTask {
                title: "Task lifecycle".into(),
                owner: "Rust Developer".into(),
                acceptance: "restart test passes".into(),
            }],
        }
    }
    #[test]
    fn completion_requires_review() {
        let mut s = State::default();
        s.apply(report(), 0, 60, 3).unwrap();
        let mut r = report();
        r.tasks.clear();
        s.apply(r.clone(), 0, 60, 3).unwrap();
        assert_eq!(s.phase, "verify");
        assert_eq!(s.tasks[0].status, "pending");
        s.phase = "review".into();
        s.apply(r, 0, 60, 3).unwrap();
        assert_eq!(s.tasks[0].status, "done");
        assert_eq!(s.phase, "meeting");
    }
    #[test]
    fn failed_review_never_completes_task() {
        let mut s = State::default();
        s.apply(report(), 0, 60, 2).unwrap();
        s.phase = "review".into();
        s.task_failed("test failed".into(), 2);
        assert_eq!(s.phase, "implement");
        assert_eq!(s.tasks[0].attempts, 1);
        s.task_failed("still fails".into(), 2);
        assert_eq!(s.tasks[0].status, "blocked");
        assert_eq!(s.phase, "meeting");
    }
    #[test]
    fn invalid_output_does_not_advance() {
        let mut s = State::default();
        let mut r = report();
        r.tasks.clear();
        assert!(s.apply(r, 0, 60, 3).is_err());
        assert_eq!(s.cycle, 0);
    }
    #[test]
    fn idle_and_backoff_are_bounded() {
        assert_eq!(cooldown(300, 3600, 20), 3600);
        let mut s = State::default();
        let mut r = report();
        r.status = "complete".into();
        r.tasks.clear();
        s.apply(r, 100, 3600, 3).unwrap();
        assert_eq!(s.next_at, 3700);
    }
}
