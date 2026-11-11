use llm_engine_core::{
    persistence::{RunRecord, Snapshot},
    *,
};
fn time(n: i64) -> RunTimestamp {
    RunTimestamp::from_unix_millis(n).unwrap()
}
fn setup() -> (Core, TaskId, AgentId) {
    let mut c = Core::default();
    let a = c.create_agent("developer").unwrap();
    let t = c.create_task("work").unwrap();
    c.assign(t, a).unwrap();
    (c, t, a)
}
#[test]
fn retries_keep_history_and_success_does_not_complete_task() {
    let (mut c, t, a) = setup();
    assert_eq!(c.runs_for_task(t).unwrap().count(), 0);
    for outcome in [
        RunOutcome::Failure,
        RunOutcome::Interruption,
        RunOutcome::ReportedSuccess,
    ] {
        let before: Vec<_> = c.runs().cloned().collect();
        let r = c
            .start_run(t, " implement ", " operator:local ", time(10), &[a])
            .unwrap();
        assert_eq!(r.to_string().parse::<RunId>().unwrap(), r);
        assert_eq!(c.run(r).unwrap().stage(), "implement");
        assert_eq!(c.run(r).unwrap().reporting_source(), "operator:local");
        assert_eq!(c.run(r).unwrap().started_at().unix_millis(), 10);
        c.finish_run(r, outcome, time(10)).unwrap();
        assert_eq!(
            c.run(r).unwrap().state(),
            RunState::Finished {
                outcome,
                ended_at: time(10)
            }
        );
        for old in before {
            assert_eq!(c.run(old.id()).unwrap(), &old);
        }
        assert_eq!(c.task(t).unwrap().status(), TaskStatus::Pending);
        let frozen = c.clone();
        for again in [
            RunOutcome::Failure,
            RunOutcome::Interruption,
            RunOutcome::ReportedSuccess,
        ] {
            assert_eq!(
                c.finish_run(r, again, time(11)),
                Err(DomainError::RunAlreadyFinished(r))
            );
            assert_eq!(c, frozen);
        }
    }
    assert_eq!(c.runs_for_task(t).unwrap().count(), 3);
    assert_eq!(Core::restore(snapshot(&c)).unwrap(), c);
}
#[test]
fn rejected_commands_are_atomic_and_tasks_have_independent_active_runs() {
    let (mut c, t, a) = setup();
    let b = c.create_agent("unassigned").unwrap();
    let unknown_a = "00000000-0000-0000-0000-000000000001".parse().unwrap();
    let unknown_t = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let unknown_r = "00000000-0000-0000-0000-000000000003".parse().unwrap();
    for (task, stage, source, participants, error) in [
        (
            unknown_t,
            "stage",
            "source",
            vec![a],
            DomainError::UnknownTask(unknown_t),
        ),
        (t, " \n", "source", vec![a], DomainError::EmptyRunStage),
        (
            t,
            "stage",
            " \t",
            vec![a],
            DomainError::EmptyReportingSource,
        ),
        (
            t,
            "stage",
            "source",
            vec![],
            DomainError::EmptyRunParticipants,
        ),
        (
            t,
            "stage",
            "source",
            vec![a, a],
            DomainError::DuplicateRunParticipant(a),
        ),
        (
            t,
            "stage",
            "source",
            vec![a, b],
            DomainError::UnassignedRunParticipant { task: t, agent: b },
        ),
        (
            t,
            "stage",
            "source",
            vec![a, unknown_a],
            DomainError::UnknownAgent(unknown_a),
        ),
    ] {
        let before = c.clone();
        assert_eq!(
            c.start_run(task, stage, source, time(20), &participants),
            Err(error)
        );
        assert_eq!(c, before);
    }
    assert!(matches!(
        c.runs_for_task(unknown_t),
        Err(DomainError::UnknownTask(_))
    ));
    assert_eq!(c.run(unknown_r), Err(DomainError::UnknownRun(unknown_r)));
    let before = c.clone();
    assert_eq!(
        c.finish_run(unknown_r, RunOutcome::Failure, time(30)),
        Err(DomainError::UnknownRun(unknown_r))
    );
    assert_eq!(c, before);
    let r = c.start_run(t, "stage", "source", time(20), &[a]).unwrap();
    let before = c.clone();
    assert_eq!(
        c.start_run(t, "different", "other", time(21), &[a]),
        Err(DomainError::ActiveRunExists(t))
    );
    assert_eq!(
        c.finish_run(r, RunOutcome::Failure, time(19)),
        Err(DomainError::InvalidRunTime)
    );
    assert_eq!(c, before);
    let other = c.create_task("other").unwrap();
    c.assign(other, a).unwrap();
    c.start_run(other, "stage", "source", time(20), &[a])
        .unwrap();
    for invalid in [-1, i64::MIN, 253_402_300_800_000, i64::MAX] {
        assert_eq!(
            RunTimestamp::from_unix_millis(invalid),
            Err(DomainError::InvalidRunTime)
        );
    }
    assert_eq!(time(0).unix_millis(), 0);
    assert_eq!(time(253_402_300_799_999).unix_millis(), 253_402_300_799_999);
}
#[test]
fn all_task_transitions_and_cancellation_remain_explicit() {
    use TaskStatus::*;
    for from in [Pending, InProgress, Blocked, Cancelled] {
        for to in [Pending, InProgress, Blocked, Cancelled] {
            let (mut c, t, a) = setup();
            let r = c.start_run(t, "stage", "source", time(0), &[a]).unwrap();
            if from != Pending {
                c.transition(t, InProgress).unwrap();
            }
            if from == Blocked {
                c.transition(t, Blocked).unwrap();
            }
            if from == Cancelled {
                c.transition(t, Cancelled).unwrap();
            }
            let before = c.clone();
            let valid = matches!(
                (from, to),
                (Pending, InProgress | Cancelled)
                    | (InProgress, Blocked | Cancelled)
                    | (Blocked, InProgress | Cancelled)
            );
            assert_eq!(c.transition(t, to).is_ok(), valid);
            if !valid {
                assert_eq!(c, before);
            }
            assert_eq!(c.run(r).unwrap().state(), RunState::Active);
            let status = c.task(t).unwrap().status();
            c.finish_run(r, RunOutcome::ReportedSuccess, time(1))
                .unwrap();
            assert_eq!(c.task(t).unwrap().status(), status);
            let before = c.clone();
            let retry = c.start_run(t, "stage", "source", time(2), &[a]);
            if status == Cancelled {
                assert_eq!(retry, Err(DomainError::TaskCancelled(t)));
                assert_eq!(c, before);
            } else {
                assert!(retry.is_ok());
            }
        }
    }
}
fn snapshot(c: &Core) -> Snapshot {
    Snapshot {
        artifacts: vec![],
        evidence: vec![],
        agents: c.agents().map(|a| (a.id(), a.name().into())).collect(),
        tasks: c
            .tasks()
            .map(|t| (t.id(), t.title().into(), t.status()))
            .collect(),
        assignments: c
            .tasks()
            .flat_map(|t| t.assignees().map(move |a| (t.id(), a)))
            .collect(),
        teams: c.teams().map(|t| (t.id(), t.name().into())).collect(),
        memberships: c
            .teams()
            .flat_map(|t| t.members().map(move |a| (t.id(), a)))
            .collect(),
        runs: c
            .runs()
            .map(|r| RunRecord {
                id: r.id(),
                task: r.task(),
                stage: r.stage().into(),
                reporting_source: r.reporting_source().into(),
                started_at: r.started_at().unix_millis(),
                terminal: match r.state() {
                    RunState::Active => None,
                    RunState::Finished { outcome, ended_at } => {
                        Some((outcome, ended_at.unix_millis()))
                    }
                },
                participants: r.participants().collect(),
            })
            .collect(),
    }
}
#[test]
fn historical_membership_and_active_state_survive_restoration() {
    let (mut c, t, a) = setup();
    let team = c.create_team("team").unwrap();
    c.add_team_members(team, &[a]).unwrap();
    let r = c.start_run(t, "stage", "source", time(0), &[a]).unwrap();
    let b = c.create_agent("later").unwrap();
    c.add_team_members(team, &[b]).unwrap();
    c.assign(t, b).unwrap();
    assert_eq!(
        c.run(r).unwrap().participants().collect::<Vec<_>>(),
        vec![a]
    );
    assert_eq!(Core::restore(snapshot(&c)).unwrap(), c);
    c.transition(t, TaskStatus::Cancelled).unwrap();
    let mut historical = snapshot(&c);
    historical.assignments.clear();
    historical.memberships.clear();
    let mut restored = Core::restore(historical).unwrap();
    assert_eq!(restored.run(r).unwrap(), c.run(r).unwrap());
    restored
        .finish_run(r, RunOutcome::Interruption, time(1))
        .unwrap();
    assert_eq!(Core::restore(snapshot(&restored)).unwrap(), restored);
}
#[test]
fn restoration_rejects_malformed_run_history() {
    let (mut c, t, a) = setup();
    c.start_run(t, "stage", "source", time(10), &[a]).unwrap();
    let base = snapshot(&c);
    for case in 0..13 {
        let mut s = base.clone();
        match case {
            0 => s.runs[0].stage.clear(),
            1 => s.runs[0].reporting_source = " ".into(),
            2 => s.runs[0].stage = " stage".into(),
            3 => s.runs[0].reporting_source = "source ".into(),
            4 => s.runs[0].started_at = -1,
            5 => s.runs[0].terminal = Some((RunOutcome::Failure, 9)),
            6 => s.runs[0].terminal = Some((RunOutcome::Failure, i64::MAX)),
            7 => s.runs[0].participants.clear(),
            8 => s.runs[0].participants.push(a),
            9 => {
                s.runs[0].participants[0] = "00000000-0000-0000-0000-000000000001".parse().unwrap()
            }
            10 => s.runs[0].task = "00000000-0000-0000-0000-000000000001".parse().unwrap(),
            11 => {
                s.runs[0].terminal = Some((RunOutcome::Failure, 10));
                s.runs.push(s.runs[0].clone());
            }
            12 => {
                let mut second = s.runs[0].clone();
                second.id = "00000000-0000-0000-0000-000000000001".parse().unwrap();
                s.runs.push(second);
            }
            _ => unreachable!(),
        }
        assert!(Core::restore(s).is_err(), "case {case}");
    }
    assert_eq!(Core::restore(base).unwrap(), c);
}

#[test]
fn selected_multiple_participants_are_copied_in_id_order() {
    let (mut c, t, a) = setup();
    let b = c.create_agent("second").unwrap();
    let d = c.create_agent("not selected").unwrap();
    c.assign(t, b).unwrap();
    c.assign(t, d).unwrap();
    let r = c.start_run(t, "stage", "source", time(0), &[b, a]).unwrap();
    let mut selected = vec![a, b];
    selected.sort();
    assert_eq!(
        c.run(r).unwrap().participants().collect::<Vec<_>>(),
        selected
    );
    assert_eq!(Core::restore(snapshot(&c)).unwrap(), c);
}
