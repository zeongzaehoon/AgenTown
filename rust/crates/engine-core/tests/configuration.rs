use llm_engine_core::*;
#[test]
fn inert_configuration_validates_before_mutating() {
    let mut c = Core::default();
    let a = c.create_agent("A").unwrap();
    let team = c.create_team("Team").unwrap();
    let t = c.create_task("T").unwrap();
    let s = c.create_skill(" Skill ", "instructions").unwrap();
    let h = c
        .create_hook("Hook", s, HookTarget::Agent(a), HookEvent::TaskCreated)
        .unwrap();
    let l = c.create_loop_policy("Loop", t, 1, 60).unwrap();
    assert!(!c.skill(s).unwrap().enabled());
    assert!(!c.hook(h).unwrap().enabled());
    assert!(!c.loop_policy(l).unwrap().enabled());
    c.set_skill_enabled(s, true).unwrap();
    c.set_hook_enabled(h, true).unwrap();
    c.set_loop_policy_enabled(l, true).unwrap();
    c.update_skill(s, "Edited", "new instructions").unwrap();
    c.update_hook(h, "Edited", s, HookTarget::Team(team), HookEvent::RunFailed)
        .unwrap();
    c.update_loop_policy(l, "Edited", t, 100, 86400).unwrap();
    assert!(c.skill(s).unwrap().enabled());
    let before = c.clone();
    assert!(c.update_skill(s, "bad", " ").is_err());
    assert!(
        c.update_hook(
            h,
            "bad",
            "00000000-0000-0000-0000-000000000001".parse().unwrap(),
            HookTarget::Agent(a),
            HookEvent::RunCompleted
        )
        .is_err()
    );
    for (iterations, interval) in [(0, 60), (101, 60), (1, 59), (1, 86401)] {
        assert!(
            c.update_loop_policy(l, "bad", t, iterations, interval)
                .is_err()
        );
    }
    assert_eq!(c, before);
    assert_eq!(c.runs().len(), 0);
    assert_eq!(c.task(t).unwrap().status(), TaskStatus::Pending);
    assert!(
        c.create_skill(&"한".repeat(120), &"文".repeat(16000))
            .is_ok()
    );
    assert!(c.create_skill(&"한".repeat(121), "x").is_err());
    assert!(c.create_skill("x", &"文".repeat(16001)).is_err());
    assert!("unsupported".parse::<HookEvent>().is_err());
}
