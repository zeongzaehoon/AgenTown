use llm_engine_core::{Core, DomainError, TaskStatus, TeamId};

#[test]
fn team_commands_validate_whole_batches_and_copy_membership() {
    let mut c = Core::default();
    let a = c.create_agent("A").unwrap();
    let b = c.create_agent("B").unwrap();
    let missing = Core::default().create_agent("Missing").unwrap();
    let team = c.create_team(" TF ").unwrap();
    let other = c.create_team("Other").unwrap();
    let task = c.create_task("Work").unwrap();
    assert_eq!(team.to_string().parse::<TeamId>().unwrap(), team);
    assert!("bad".parse::<TeamId>().is_err());
    assert_eq!(c.team(team).unwrap().name(), "TF");
    assert_eq!(c.teams().len(), 2);
    let before = c.clone();
    assert_eq!(c.create_team(" \t"), Err(DomainError::EmptyTeamName));
    assert_eq!(c.assign_team(task, team), Err(DomainError::EmptyTeam(team)));
    assert_eq!(
        c.add_team_members(team, &[a, missing]),
        Err(DomainError::UnknownAgent(missing))
    );
    assert_eq!(
        c.add_team_members(team, &[a, a]),
        Err(DomainError::AlreadyMember { team, agent: a })
    );
    let unknown = Core::default().create_team("Missing").unwrap();
    assert_eq!(
        c.add_team_members(unknown, &[a]),
        Err(DomainError::UnknownTeam(unknown))
    );
    assert_eq!(
        c.assign_team(task, unknown),
        Err(DomainError::UnknownTeam(unknown))
    );
    let unknown_task = Core::default().create_task("Missing").unwrap();
    assert_eq!(
        c.assign_team(unknown_task, team),
        Err(DomainError::UnknownTask(unknown_task))
    );
    assert_eq!(c, before);
    c.add_team_members(team, &[a]).unwrap();
    c.add_team_members(other, &[a, b]).unwrap();
    c.assign_team(task, team).unwrap();
    c.add_team_members(team, &[b]).unwrap();
    assert_eq!(
        c.task(task).unwrap().assignees().collect::<Vec<_>>(),
        vec![a]
    );
    let before = c.clone();
    assert!(matches!(
        c.assign_team(task, other),
        Err(DomainError::AlreadyAssigned { .. })
    ));
    assert!(matches!(
        c.add_team_members(team, &[missing, a]),
        Err(DomainError::UnknownAgent(_))
    ));
    assert_eq!(c, before);
    c.transition(task, TaskStatus::Cancelled).unwrap();
    let before = c.clone();
    assert_eq!(
        c.assign_team(task, team),
        Err(DomainError::TaskCancelled(task))
    );
    assert_eq!(c, before);
}
