use llm_engine_core::{AgentId, Core, DomainError, TaskId, TaskStatus};

#[test]
fn creation_listing_and_stable_typed_id_round_trips() {
    let mut core = Core::default();
    assert_eq!(core.agents().len(), 0);
    assert_eq!(core.tasks().len(), 0);
    let a = core.create_agent(" Developer ").unwrap();
    let b = core.create_agent("Developer").unwrap();
    let t = core.create_task(" Build core ").unwrap();
    let u = core.create_task("Build core").unwrap();
    assert_ne!(a, b);
    assert_ne!(t, u);
    assert_eq!(core.agent(a).unwrap().name(), "Developer");
    assert_eq!(core.task(t).unwrap().title(), "Build core");
    assert_eq!(core.task(t).unwrap().status(), TaskStatus::Pending);
    assert_eq!(core.task(t).unwrap().assignees().len(), 0);
    assert_eq!(a.to_string().parse::<AgentId>().unwrap(), a);
    assert_eq!(t.to_string().parse::<TaskId>().unwrap(), t);
    assert!("bad-id".parse::<AgentId>().is_err());
    assert!("bad-id".parse::<TaskId>().is_err());
    let mut agents = vec![a, b];
    agents.sort();
    assert_eq!(core.agents().map(|a| a.id()).collect::<Vec<_>>(), agents);
    let mut tasks = vec![t, u];
    tasks.sort();
    assert_eq!(core.tasks().map(|t| t.id()).collect::<Vec<_>>(), tasks);
}

#[test]
fn two_assignees_and_duplicate_rejection_preserve_state() {
    let mut core = Core::default();
    let a = core.create_agent("Developer").unwrap();
    let b = core.create_agent("Reviewer").unwrap();
    let t = core.create_task("Implement").unwrap();
    core.assign(t, a).unwrap();
    core.assign(t, b).unwrap();
    let mut expected = vec![a, b];
    expected.sort();
    assert_eq!(
        core.task(t).unwrap().assignees().collect::<Vec<_>>(),
        expected
    );
    let before = core.clone();
    assert_eq!(
        core.assign(t, a),
        Err(DomainError::AlreadyAssigned { task: t, agent: a })
    );
    assert_eq!(core, before);
    let other = core.create_task("Another task").unwrap();
    core.assign(other, a).unwrap();
    assert_eq!(core.task(t).unwrap().assignees().len(), 2);
}

#[test]
fn unknown_ids_and_empty_values_never_mutate_state() {
    let mut core = Core::default();
    let a = core.create_agent("Developer").unwrap();
    let t = core.create_task("Implement").unwrap();
    let missing_a = "00000000-0000-0000-0000-000000000000"
        .parse::<AgentId>()
        .unwrap();
    let missing_t = "00000000-0000-0000-0000-000000000000"
        .parse::<TaskId>()
        .unwrap();
    let before = core.clone();
    assert_eq!(
        core.agent(missing_a),
        Err(DomainError::UnknownAgent(missing_a))
    );
    assert_eq!(
        core.task(missing_t),
        Err(DomainError::UnknownTask(missing_t))
    );
    assert_eq!(
        core.assign(t, missing_a),
        Err(DomainError::UnknownAgent(missing_a))
    );
    assert_eq!(core, before);
    assert_eq!(
        core.assign(missing_t, a),
        Err(DomainError::UnknownTask(missing_t))
    );
    assert_eq!(core, before);
    assert_eq!(
        core.transition(missing_t, TaskStatus::Cancelled),
        Err(DomainError::UnknownTask(missing_t))
    );
    assert_eq!(core, before);
    assert_eq!(core.create_agent(" \n\t"), Err(DomainError::EmptyName));
    assert_eq!(core, before);
    assert_eq!(core.create_task(" \n\t"), Err(DomainError::EmptyTitle));
    assert_eq!(core, before);
}

#[test]
fn every_lifecycle_edge_and_rejected_transition() {
    use TaskStatus::*;
    for from in [Pending, InProgress, Blocked, Cancelled] {
        for to in [Pending, InProgress, Blocked, Cancelled] {
            let mut core = Core::default();
            let a = core.create_agent("Developer").unwrap();
            let t = core.create_task("Implement").unwrap();
            core.assign(t, a).unwrap();
            if matches!(from, InProgress | Blocked) {
                core.transition(t, InProgress).unwrap();
            }
            if matches!(from, Blocked | Cancelled) {
                core.transition(t, from).unwrap();
            }
            let before = core.clone();
            let allowed = matches!(
                (from, to),
                (Pending, InProgress | Cancelled)
                    | (InProgress, Blocked | Cancelled)
                    | (Blocked, InProgress | Cancelled)
            );
            if allowed {
                core.transition(t, to).unwrap();
                assert_eq!(core.task(t).unwrap().status(), to);
                assert_eq!(core.task(t).unwrap().id(), t);
                assert_eq!(
                    core.task(t).unwrap().assignees().collect::<Vec<_>>(),
                    vec![a]
                );
            } else {
                assert_eq!(
                    core.transition(t, to),
                    Err(DomainError::InvalidTransition { task: t, from, to })
                );
                assert_eq!(core, before);
            }
        }
    }
}

#[test]
fn starting_requires_assignment_and_cancelled_tasks_are_frozen() {
    let mut core = Core::default();
    let t = core.create_task("Implement").unwrap();
    let a = core.create_agent("Developer").unwrap();
    let before = core.clone();
    assert_eq!(
        core.transition(t, TaskStatus::InProgress),
        Err(DomainError::NoAssignees(t))
    );
    assert_eq!(core, before);
    core.transition(t, TaskStatus::Cancelled).unwrap();
    let before = core.clone();
    assert_eq!(core.assign(t, a), Err(DomainError::TaskCancelled(t)));
    assert_eq!(core, before);
}

#[test]
fn text_work_preserves_whitespace_but_rejects_blank_requests() {
    let mut core = Core::default();
    let input = "\n  한글 😀 <b>literal</b>\n\t  ";
    let task = core.create_text_work(input).unwrap();
    assert_eq!(core.task(task).unwrap().title(), input);
    assert_eq!(
        core.create_text_work("\n \t\u{2003}"),
        Err(DomainError::EmptyTitle)
    );
    assert_eq!(core.tasks().len(), 1);
}
