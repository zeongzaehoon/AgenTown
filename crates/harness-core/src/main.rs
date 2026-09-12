mod domain;
mod executor;
mod store;

use anyhow::{bail, Context, Result};
use domain::{cooldown, State};
use executor::{AgentExecutor, Codex, Failure, Outcome};
use fs2::FileExt;
use serde::Deserialize;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use store::Store;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub codex_command: String,
    pub model: Option<String>,
    pub stage_timeout_seconds: u64,
    pub poll_seconds: u64,
    pub cooldown_seconds: u64,
    pub max_cooldown_seconds: u64,
    pub idle_seconds: u64,
    pub max_task_attempts: u32,
    pub max_infrastructure_failures: u32,
    pub checks: Vec<Vec<String>>,
}
impl Config {
    fn load(root: &Path) -> Result<Self> {
        let c: Self = serde_json::from_str(&fs::read_to_string(root.join("harness/config.json"))?)?;
        anyhow::ensure!(
            !c.codex_command.is_empty()
                && c.stage_timeout_seconds > 0
                && c.poll_seconds > 0
                && c.cooldown_seconds > 0
                && c.max_cooldown_seconds >= c.cooldown_seconds
                && c.idle_seconds > 0
                && c.max_task_attempts > 0
                && c.max_infrastructure_failures > 0
                && !c.checks.is_empty()
                && c.checks.iter().all(|x| !x.is_empty() && !x[0].is_empty()),
            "invalid harness configuration"
        );
        Ok(c)
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn acquire(root: &Path) -> Result<File> {
    acquire_named(root, "runner.lock")
}
fn acquire_named(root: &Path, name: &str) -> Result<File> {
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(".harness").join(name))?;
    f.try_lock_exclusive()
        .context("another runner or its child is already active")?;
    // Keep the lease alive in descendants if the supervisor is killed abruptly.
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        unsafe {
            let fd = f.as_raw_fd();
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags == -1 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
    }
    Ok(f)
}
fn failure(
    db: &mut Store,
    s: &mut State,
    c: &Config,
    kind: Failure,
    message: String,
) -> Result<()> {
    s.last_summary = message.chars().take(6000).collect();
    match kind {
        Failure::Quota => {
            s.quota_failures = s.quota_failures.saturating_add(1);
            s.next_at =
                now() + cooldown(c.cooldown_seconds, c.max_cooldown_seconds, s.quota_failures);
        }
        Failure::Auth => {
            db.pause(true)?;
        }
        Failure::Transient => {
            s.infrastructure_failures += 1;
            s.next_at = now()
                + cooldown(
                    c.cooldown_seconds,
                    c.max_cooldown_seconds,
                    s.infrastructure_failures,
                );
            if s.infrastructure_failures >= c.max_infrastructure_failures {
                db.pause(true)?;
            }
        }
        Failure::Cancelled => {}
    }
    db.save(s, "stage_failed", now())
}
fn tick(
    root: &Path,
    db: &mut Store,
    c: &Config,
    agent: &dyn AgentExecutor,
    stop: &Arc<AtomicBool>,
) -> Result<()> {
    if db.paused()? || stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let mut s = db.load()?;
    if s.next_at > now() {
        return Ok(());
    }
    let run_id = format!(
        "{}-{}",
        now(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.subsec_nanos()
    );
    let dir = root.join(".harness/runs").join(&run_id);
    fs::create_dir_all(&dir)?;
    db.start_run(&run_id, &s, &dir.to_string_lossy(), now())?;
    println!(
        "{} stage={} task={:?} run={run_id}",
        now(),
        s.phase,
        s.current.map(|i| &s.tasks[i].id)
    );
    if s.phase == "verify" {
        let result = executor::checks(root, c, db, stop, true);
        let _ = fs::copy(root.join(".harness/checks.log"), dir.join("checks.log"));
        match result {
            Ok(Some(true)) => {
                s.phase = "review".into();
                s.last_summary = "Configured checks passed; independent review is next.".into();
                db.save(&s, "checks_passed", now())?;
                db.finish_run(&run_id, "success", now())?;
            }
            Ok(Some(false)) => {
                s.task_failed(
                    format!(
                        "Verification failed. Inspect .harness/checks.log.\n{}",
                        executor::tail(&root.join(".harness/checks.log"))
                            .chars()
                            .rev()
                            .take(6000)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect::<String>()
                    ),
                    c.max_task_attempts,
                );
                s.last_summary = "Verification failed; Task not completed.".into();
                db.save(&s, "checks_failed", now())?;
                db.finish_run(&run_id, "failed", now())?;
            }
            Ok(None) => {
                db.finish_run(&run_id, "interrupted", now())?;
            }
            Err(e) => {
                failure(db, &mut s, c, Failure::Transient, e.to_string())?;
                db.finish_run(&run_id, "failed", now())?;
            }
        }
        return Ok(());
    }
    let outcome = agent
        .execute(root, c, &s, &dir, db, stop)
        .unwrap_or_else(|e| Outcome::Failed(Failure::Transient, format!("{e:#}")));
    match outcome {
        Outcome::Report(report) => {
            if let Err(e) = s.validate_report(&report) {
                failure(db, &mut s, c, Failure::Transient, e.to_string())?;
                db.finish_run(&run_id, "invalid_report", now())?;
            } else {
                s.apply(report, now(), c.idle_seconds, c.max_task_attempts)?;
                db.save(&s, "stage_completed", now())?;
                db.finish_run(&run_id, "success", now())?;
            }
        }
        Outcome::Failed(kind, message) => {
            let status = if kind == Failure::Cancelled {
                "interrupted"
            } else {
                "failed"
            };
            failure(db, &mut s, c, kind, message)?;
            db.finish_run(&run_id, status, now())?;
        }
    }
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let action = args.get(1).map(String::as_str).unwrap_or("status");
    let root = PathBuf::from(
        args.get(2)
            .context("usage: harnessd <run|once|status|pause|resume|check> <project-root>")?,
    )
    .canonicalize()?;
    let mut db = Store::open(&root)?;
    if action == "status" {
        let s = db.load()?;
        let runs:Vec<serde_json::Value>=db.conn.prepare("SELECT id,task_id,phase,status,artifact_dir FROM runs ORDER BY started_at DESC,rowid DESC LIMIT 5")?
            .query_map([],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"task_id":r.get::<_,Option<String>>(1)?,"phase":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"artifacts":r.get::<_,String>(4)?})))?
            .collect::<std::result::Result<_,_>>()?;
        println!(
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({"paused":db.paused()?,"state":s,"recent_runs":runs})
            )?
        );
        return Ok(());
    }
    if action == "pause" {
        db.pause(true)?;
        println!("Paused. An active process will stop within one second; Task is retained.");
        return Ok(());
    }
    if action == "resume" {
        // Pause first so a running worker cannot race checkpoint reset.
        db.pause(true)?;
        let start = std::time::Instant::now();
        let lease = loop {
            match acquire(&root) {
                Ok(lease) => break lease,
                Err(e) if start.elapsed().as_secs() >= 5 => return Err(e),
                Err(_) => thread::sleep(Duration::from_millis(250)),
            }
        };
        let mut s = db.load()?;
        s.next_at = 0;
        s.infrastructure_failures = 0;
        s.quota_failures = 0;
        db.save(&s, "operator_resumed", now())?;
        db.pause(false)?;
        drop(lease);
        println!("Resumed.");
        return Ok(());
    }
    let c = Config::load(&root)?;
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    if action == "check" {
        // Standalone checks deliberately don't acquire the runner lease: the implementing agent may invoke them.
        if executor::checks(&root, &c, &db, &stop, false)? != Some(true) {
            bail!("checks failed/interrupted; see .harness/checks.log");
        }
        println!("All configured checks passed.");
        return Ok(());
    }
    if !["run", "once"].contains(&action) {
        bail!("unknown action: {action}");
    }
    let _daemon = acquire_named(&root, "daemon.lock")?;
    // Acquire per stage, allowing resume to reset a paused daemon without killing it.
    loop {
        if !db.paused()? {
            let lease = acquire(&root)?;
            db.recover(now())?;
            tick(&root, &mut db, &c, &Codex, &stop)?;
            drop(lease);
        }
        if action == "once" || stop.load(Ordering::SeqCst) {
            break;
        }
        for _ in 0..c.poll_seconds {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
    }
    Ok(())
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use domain::{ProposedTask, Report};
    struct Fake {
        status: &'static str,
    }
    impl AgentExecutor for Fake {
        fn execute(
            &self,
            _: &Path,
            _: &Config,
            s: &State,
            _: &Path,
            _: &Store,
            _: &Arc<AtomicBool>,
        ) -> Result<Outcome> {
            Ok(Outcome::Report(Report {
                status: self.status.into(),
                summary: "evidence checked".into(),
                evidence: vec!["test output".into()],
                research: vec!["https://example.org/docs".into()],
                lessons: vec!["check restart behavior".into()],
                tasks: if s.phase == "meeting" {
                    vec![ProposedTask {
                        title: "one".into(),
                        owner: "Rust Developer".into(),
                        acceptance: "tests pass".into(),
                    }]
                } else {
                    vec![]
                },
            }))
        }
    }
    fn config() -> Config {
        serde_json::from_str(include_str!("../../../harness/config.json")).unwrap()
    }
    #[cfg(unix)]
    #[test]
    fn supervisor_lease_survives_in_child() {
        let d = tempfile::tempdir().unwrap();
        let _db = Store::open(d.path()).unwrap();
        let lease = acquire(d.path()).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        drop(lease);
        let still_locked = acquire(d.path()).is_err();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(still_locked);
        assert!(acquire(d.path()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn operator_can_check_while_paused() {
        let d = tempfile::tempdir().unwrap();
        let db = Store::open(d.path()).unwrap();
        db.pause(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut c = config();
        c.checks = vec![vec!["sh".into(), "-c".into(), "exit 0".into()]];
        assert_eq!(
            executor::checks(d.path(), &c, &db, &stop, false).unwrap(),
            Some(true)
        );
        assert!(db.paused().unwrap());
        assert_eq!(
            executor::checks(d.path(), &c, &db, &stop, true).unwrap(),
            None
        );
    }
    #[test]
    fn quota_keeps_same_task_and_persists_cooldown() {
        let d = tempfile::tempdir().unwrap();
        let mut db = Store::open(d.path()).unwrap();
        let mut s = db.load().unwrap();
        failure(&mut db, &mut s, &config(), Failure::Quota, "limit".into()).unwrap();
        let loaded = db.load().unwrap();
        assert_eq!(loaded.phase, "meeting");
        assert!(loaded.next_at > now());
        assert!(!db.paused().unwrap());
    }
    #[test]
    fn repeated_infrastructure_failure_pauses() {
        let d = tempfile::tempdir().unwrap();
        let mut db = Store::open(d.path()).unwrap();
        let mut s = db.load().unwrap();
        for _ in 0..3 {
            failure(
                &mut db,
                &mut s,
                &config(),
                Failure::Transient,
                "bad output".into(),
            )
            .unwrap();
        }
        assert!(db.paused().unwrap());
        assert_eq!(db.load().unwrap().phase, "meeting");
    }
    #[test]
    fn duplicate_runner_rejected() {
        let d = tempfile::tempdir().unwrap();
        let _db = Store::open(d.path()).unwrap();
        let lease = acquire(d.path()).unwrap();
        assert!(acquire(d.path()).is_err());
        drop(lease);
        assert!(acquire(d.path()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn full_cycle_with_real_verification_and_restart() {
        let d = tempfile::tempdir().unwrap();
        let mut db = Store::open(d.path()).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut c = config();
        c.checks = vec![vec!["sh".into(), "-c".into(), "exit 0".into()]];
        let fake = Fake { status: "success" };
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        assert_eq!(db.load().unwrap().phase, "verify");
        drop(db);
        let mut db = Store::open(d.path()).unwrap();
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        assert_eq!(db.load().unwrap().phase, "review");
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        assert_eq!(db.load().unwrap().tasks[0].status, "done");
    }
    #[cfg(unix)]
    #[test]
    fn failing_check_cannot_reach_review() {
        let d = tempfile::tempdir().unwrap();
        let mut db = Store::open(d.path()).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut c = config();
        c.checks = vec![vec!["sh".into(), "-c".into(), "exit 1".into()]];
        let fake = Fake { status: "success" };
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        tick(d.path(), &mut db, &c, &fake, &stop).unwrap();
        let s = db.load().unwrap();
        assert_eq!(s.phase, "implement");
        assert_eq!(s.tasks[0].attempts, 1);
    }
}
