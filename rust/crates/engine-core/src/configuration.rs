//! Inert product configuration. Enabled is a configuration flag only.
//! Future execution adapters must explicitly consume these records; this module
//! neither dispatches events nor starts Runs, processes, providers or schedulers.
use crate::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookTarget {
    Agent(AgentId),
    Team(TeamId),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    TaskCreated,
    RunCompleted,
    RunFailed,
}
impl HookEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskCreated => "task_created",
            Self::RunCompleted => "run_completed",
            Self::RunFailed => "run_failed",
        }
    }
}
impl FromStr for HookEvent {
    type Err = DomainError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "task_created" => Ok(Self::TaskCreated),
            "run_completed" => Ok(Self::RunCompleted),
            "run_failed" => Ok(Self::RunFailed),
            _ => Err(DomainError::InvalidConfiguration("event")),
        }
    }
}
fn validated_name(value: &str) -> Result<String, DomainError> {
    let value = value.trim();
    if !(1..=120).contains(&value.chars().count()) {
        return Err(DomainError::InvalidConfiguration(
            "name must contain 1–120 characters",
        ));
    }
    Ok(value.into())
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub(crate) id: SkillId,
    pub(crate) enabled: bool,
    pub(crate) name: String,
    pub(crate) instructions: String,
}
impl Skill {
    pub fn id(&self) -> SkillId {
        self.id
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn instructions(&self) -> &str {
        &self.instructions
    }
}
impl Core {
    pub fn create_skill(&mut self, name: &str, instructions: &str) -> Result<SkillId, DomainError> {
        let name = validated_name(name)?;
        if instructions.trim().is_empty() || instructions.chars().count() > 16000 {
            return Err(DomainError::InvalidConfiguration(
                "instructions must contain 1–16000 characters",
            ));
        }
        let id = loop {
            let id = SkillId(Uuid::new_v4());
            if !self.skills.contains_key(&id) {
                break id;
            }
        };
        self.skills.insert(
            id,
            Skill {
                id,
                enabled: false,
                name: name,
                instructions: instructions.into(),
            },
        );
        Ok(id)
    }
    pub fn update_skill(
        &mut self,
        id: SkillId,
        name: &str,
        instructions: &str,
    ) -> Result<(), DomainError> {
        let enabled = self.skill(id)?.enabled;
        let name = validated_name(name)?;
        if instructions.trim().is_empty() || instructions.chars().count() > 16000 {
            return Err(DomainError::InvalidConfiguration(
                "instructions must contain 1–16000 characters",
            ));
        }
        self.skills.insert(
            id,
            Skill {
                id,
                enabled,
                name: name,
                instructions: instructions.into(),
            },
        );
        Ok(())
    }
    pub fn skill(&self, id: SkillId) -> Result<&Skill, DomainError> {
        self.skills.get(&id).ok_or(DomainError::UnknownSkill(id))
    }
    pub fn skills(&self) -> impl ExactSizeIterator<Item = &Skill> {
        self.skills.values()
    }
    pub fn set_skill_enabled(&mut self, id: SkillId, enabled: bool) -> Result<(), DomainError> {
        self.skill(id)?;
        self.skills
            .get_mut(&id)
            .expect("validated configuration")
            .enabled = enabled;
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    pub(crate) id: HookId,
    pub(crate) enabled: bool,
    pub(crate) name: String,
    pub(crate) skill_id: SkillId,
    pub(crate) target: HookTarget,
    pub(crate) event: HookEvent,
}
impl Hook {
    pub fn id(&self) -> HookId {
        self.id
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn skill_id(&self) -> SkillId {
        self.skill_id
    }
    pub fn target(&self) -> HookTarget {
        self.target
    }
    pub fn event(&self) -> HookEvent {
        self.event
    }
}
impl Core {
    pub fn create_hook(
        &mut self,
        name: &str,
        skill_id: SkillId,
        target: HookTarget,
        event: HookEvent,
    ) -> Result<HookId, DomainError> {
        let name = validated_name(name)?;
        self.skill(skill_id)?;
        match target {
            HookTarget::Agent(id) => {
                self.agent(id)?;
            }
            HookTarget::Team(id) => {
                self.team(id)?;
            }
        }
        let id = loop {
            let id = HookId(Uuid::new_v4());
            if !self.hooks.contains_key(&id) {
                break id;
            }
        };
        self.hooks.insert(
            id,
            Hook {
                id,
                enabled: false,
                name: name,
                skill_id: skill_id,
                target: target,
                event: event,
            },
        );
        Ok(id)
    }
    pub fn update_hook(
        &mut self,
        id: HookId,
        name: &str,
        skill_id: SkillId,
        target: HookTarget,
        event: HookEvent,
    ) -> Result<(), DomainError> {
        let enabled = self.hook(id)?.enabled;
        let name = validated_name(name)?;
        self.skill(skill_id)?;
        match target {
            HookTarget::Agent(id) => {
                self.agent(id)?;
            }
            HookTarget::Team(id) => {
                self.team(id)?;
            }
        }
        self.hooks.insert(
            id,
            Hook {
                id,
                enabled,
                name: name,
                skill_id: skill_id,
                target: target,
                event: event,
            },
        );
        Ok(())
    }
    pub fn hook(&self, id: HookId) -> Result<&Hook, DomainError> {
        self.hooks.get(&id).ok_or(DomainError::UnknownHook(id))
    }
    pub fn hooks(&self) -> impl ExactSizeIterator<Item = &Hook> {
        self.hooks.values()
    }
    pub fn set_hook_enabled(&mut self, id: HookId, enabled: bool) -> Result<(), DomainError> {
        self.hook(id)?;
        self.hooks
            .get_mut(&id)
            .expect("validated configuration")
            .enabled = enabled;
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopPolicy {
    pub(crate) id: LoopPolicyId,
    pub(crate) enabled: bool,
    pub(crate) name: String,
    pub(crate) task_id: TaskId,
    pub(crate) max_iterations: u32,
    pub(crate) interval_seconds: u32,
}
impl LoopPolicy {
    pub fn id(&self) -> LoopPolicyId {
        self.id
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn task_id(&self) -> TaskId {
        self.task_id
    }
    pub fn max_iterations(&self) -> u32 {
        self.max_iterations
    }
    pub fn interval_seconds(&self) -> u32 {
        self.interval_seconds
    }
}
impl Core {
    pub fn create_loop_policy(
        &mut self,
        name: &str,
        task_id: TaskId,
        max_iterations: u32,
        interval_seconds: u32,
    ) -> Result<LoopPolicyId, DomainError> {
        let name = validated_name(name)?;
        self.task(task_id)?;
        if !(1..=100).contains(&max_iterations) || !(60..=86400).contains(&interval_seconds) {
            return Err(DomainError::InvalidConfiguration("loop limits"));
        }
        let id = loop {
            let id = LoopPolicyId(Uuid::new_v4());
            if !self.loop_policies.contains_key(&id) {
                break id;
            }
        };
        self.loop_policies.insert(
            id,
            LoopPolicy {
                id,
                enabled: false,
                name: name,
                task_id: task_id,
                max_iterations: max_iterations,
                interval_seconds: interval_seconds,
            },
        );
        Ok(id)
    }
    pub fn update_loop_policy(
        &mut self,
        id: LoopPolicyId,
        name: &str,
        task_id: TaskId,
        max_iterations: u32,
        interval_seconds: u32,
    ) -> Result<(), DomainError> {
        let enabled = self.loop_policy(id)?.enabled;
        let name = validated_name(name)?;
        self.task(task_id)?;
        if !(1..=100).contains(&max_iterations) || !(60..=86400).contains(&interval_seconds) {
            return Err(DomainError::InvalidConfiguration("loop limits"));
        }
        self.loop_policies.insert(
            id,
            LoopPolicy {
                id,
                enabled,
                name: name,
                task_id: task_id,
                max_iterations: max_iterations,
                interval_seconds: interval_seconds,
            },
        );
        Ok(())
    }
    pub fn loop_policy(&self, id: LoopPolicyId) -> Result<&LoopPolicy, DomainError> {
        self.loop_policies
            .get(&id)
            .ok_or(DomainError::UnknownLoopPolicy(id))
    }
    pub fn loop_policies(&self) -> impl ExactSizeIterator<Item = &LoopPolicy> {
        self.loop_policies.values()
    }
    pub fn set_loop_policy_enabled(
        &mut self,
        id: LoopPolicyId,
        enabled: bool,
    ) -> Result<(), DomainError> {
        self.loop_policy(id)?;
        self.loop_policies
            .get_mut(&id)
            .expect("validated configuration")
            .enabled = enabled;
        Ok(())
    }
}

impl Core {
    /// Version-one composition is deterministic and bounded by text execution's byte limit.
    pub fn compose_skill_input(&self, task: TaskId, skill: SkillId) -> Result<String, DomainError> {
        let work = self.task(task)?;
        let skill = self.skill(skill)?;
        if !skill.enabled() {
            return Err(DomainError::InvalidConfiguration("Skill must be enabled"));
        }
        let input = format!(
            "Skill instructions:\n{}\n\nWork:\n{}",
            skill.instructions(),
            work.title()
        );
        if input.len() > 100_000 {
            return Err(DomainError::InvalidConfiguration(
                "combined input exceeds 100000 bytes",
            ));
        }
        Ok(input)
    }
}
