//! Provider-neutral bounded Loop admission decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopAdmission {
    Admit,
    Wait,
    Complete,
    Failed,
    Expired,
}
/// Interval is measured between admission times. A failed/interrupted attempt
/// always closes the session, including when it was the final attempt.
pub fn loop_admission(
    now: i64,
    expires: i64,
    admitted: u32,
    limit: u32,
    next_at: i64,
    active: bool,
    failed: bool,
) -> LoopAdmission {
    if failed {
        LoopAdmission::Failed
    } else if now >= expires {
        LoopAdmission::Expired
    } else if active {
        LoopAdmission::Wait
    } else if admitted >= limit {
        LoopAdmission::Complete
    } else if now < next_at {
        LoopAdmission::Wait
    } else {
        LoopAdmission::Admit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_admission_decision_boundaries() {
        assert_eq!(
            loop_admission(100, 500, 0, 2, 100, false, false),
            LoopAdmission::Admit
        );
        assert_eq!(
            loop_admission(99, 500, 0, 2, 100, false, false),
            LoopAdmission::Wait
        );
        assert_eq!(
            loop_admission(200, 500, 1, 2, 100, true, false),
            LoopAdmission::Wait
        );
        assert_eq!(
            loop_admission(200, 500, 2, 2, 100, false, false),
            LoopAdmission::Complete
        );
        assert_eq!(
            loop_admission(500, 500, 0, 2, 100, false, false),
            LoopAdmission::Expired
        );
        assert_eq!(
            loop_admission(200, 500, 2, 2, 100, false, true),
            LoopAdmission::Failed
        );
    }
}
