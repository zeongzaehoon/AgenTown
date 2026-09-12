use crate::{
    domain::{Report, State},
    store::Store,
    Config,
};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq)]
pub enum Failure {
    Quota,
    Auth,
    Transient,
    Cancelled,
}
pub enum Outcome {
    Report(Report),
    Failed(Failure, String),
}
pub trait AgentExecutor {
    fn execute(
        &self,
        root: &Path,
        config: &Config,
        state: &State,
        dir: &Path,
        store: &Store,
        stop: &Arc<AtomicBool>,
    ) -> Result<Outcome>;
}
pub struct Codex;

pub fn tail(path: &Path) -> String {
    (|| -> Result<String> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        file.seek(SeekFrom::Start(len.saturating_sub(524288)))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })()
    .unwrap_or_default()
}
pub fn classify(text: &str) -> Failure {
    let t = text.to_lowercase();
    if [
        "usage_limit_reached",
        "usage limit",
        "rate_limit",
        "rate limit",
        "quota exceeded",
        "too many requests",
        "429",
    ]
    .iter()
    .any(|x| t.contains(x))
    {
        Failure::Quota
    } else if [
        "401",
        "unauthorized",
        "not logged in",
        "authentication",
        "refresh token",
        "login required",
    ]
    .iter()
    .any(|x| t.contains(x))
    {
        Failure::Auth
    } else {
        Failure::Transient
    }
}

pub struct Control<'a> {
    pub store: &'a Store,
    pub stop: &'a Arc<AtomicBool>,
    pub honor_pause: bool,
}

// All children share a process group so cancellation also stops shell grandchildren.
pub fn run_command(
    mut cmd: Command,
    input: Option<&str>,
    log: &Path,
    err: &Path,
    timeout: u64,
    control: Control<'_>,
) -> Result<Option<i32>> {
    let out = OpenOptions::new().create(true).append(true).open(log)?;
    let stderr = OpenOptions::new().create(true).append(true).open(err)?;
    cmd.stdout(Stdio::from(out)).stderr(Stdio::from(stderr));
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().context("cannot start command")?;
    if let Some(input) = input {
        if let Err(error) = child.stdin.take().unwrap().write_all(input.as_bytes()) {
            terminate(&mut child);
            return Err(error.into());
        }
    }
    let start = Instant::now();
    loop {
        let paused = match control.store.paused() {
            Ok(x) => x,
            Err(e) => {
                terminate(&mut child);
                return Err(e);
            }
        };
        if control.stop.load(Ordering::SeqCst) || (control.honor_pause && paused) {
            terminate(&mut child);
            return Ok(None);
        }
        if let Some(status) = child.try_wait()? {
            terminate(&mut child);
            return Ok(Some(status.code().unwrap_or(-1)));
        }
        if start.elapsed().as_secs() >= timeout {
            terminate(&mut child);
            return Ok(Some(124));
        }
        thread::sleep(Duration::from_millis(250));
    }
}
fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl AgentExecutor for Codex {
    fn execute(
        &self,
        root: &Path,
        config: &Config,
        state: &State,
        dir: &Path,
        store: &Store,
        stop: &Arc<AtomicBool>,
    ) -> Result<Outcome> {
        let current = state.current.map(|i| &state.tasks[i]);
        let recent: Vec<_> = state.tasks.iter().rev().take(12).collect();
        let prompt=format!("You are operating the LLM Engine autonomous development harness.\n\
Read AGENTS.md, PLAN.md, rules/autonomy.md, harness/roles.md, and .agents/skills/task-cycle/SKILL.md.\n\
Execute ONLY the '{}' stage. Role perspectives are advisory; do not claim multiple agents ran.\n\
Research authoritative sources before deciding; record real URLs and findings.\n\
Meeting: inspect current code and recent results; return 1..3 ordered useful Tasks.\n\
Implement: complete only the current Task, preserving partial/user changes; run relevant checks.\n\
Review: inspect actual files and acceptance criteria independently; do not edit files. Check logs are in .harness/checks.log.\n\
Do not edit .harness, PLAN.md, harness/config.json, service settings, or installed runtime.\n\
Return success, blocked, or (meeting only) complete using the supplied JSON schema. Non-meeting tasks array must be empty.\n\
Give concrete evidence; never fabricate research, test results, or success.\n\
Current task: {}\nRecent tasks: {}\nLast result: {}\nRecent lessons: {}\n",
            state.phase,serde_json::to_string(&current)?,serde_json::to_string(&recent)?,state.last_summary,serde_json::to_string(&state.lessons)?);
        fs::write(dir.join("prompt.txt"), &prompt)?;
        let mut cmd = Command::new(&config.codex_command);
        cmd.current_dir(root)
            .args([
                "exec",
                "--ignore-user-config",
                "--skip-git-repo-check",
                "--json",
                "--color",
                "never",
            ])
            .args([
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "web_search=\"live\"",
            ])
            .args([
                "--sandbox",
                if state.phase == "implement" {
                    "workspace-write"
                } else {
                    "read-only"
                },
            ])
            .arg("--output-schema")
            .arg(root.join("harness/report.schema.json"))
            .arg("--output-last-message")
            .arg(dir.join("report.json"));
        if let Some(model) = &config.model {
            cmd.args(["--model", model]);
        }
        cmd.arg("-");
        let status = run_command(
            cmd,
            Some(&prompt),
            &dir.join("events.jsonl"),
            &dir.join("stderr.log"),
            config.stage_timeout_seconds,
            Control {
                store,
                stop,
                honor_pause: true,
            },
        )?;
        if status.is_none() {
            return Ok(Outcome::Failed(
                Failure::Cancelled,
                "operator interrupted stage".into(),
            ));
        }
        if status == Some(0) {
            let body = tail(&dir.join("report.json"));
            match serde_json::from_str::<Report>(&body) {
                Ok(report) => return Ok(Outcome::Report(report)),
                Err(e) => {
                    return Ok(Outcome::Failed(
                        Failure::Transient,
                        format!("invalid structured report: {e}"),
                    ))
                }
            }
        }
        let events = tail(&dir.join("events.jsonl"));
        let errors: Vec<_> = events
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|v| v["type"] == "error" || v["type"] == "turn.failed")
            .collect();
        let message = format!(
            "exit={status:?}; {}\n{}",
            serde_json::to_string(&errors)?,
            tail(&dir.join("stderr.log"))
        );
        Ok(Outcome::Failed(classify(&message), message))
    }
}

pub fn checks(
    root: &Path,
    config: &Config,
    store: &Store,
    stop: &Arc<AtomicBool>,
    honor_pause: bool,
) -> Result<Option<bool>> {
    let log = root.join(".harness/checks.log");
    fs::write(&log, "")?;
    for args in &config.checks {
        let mut f = OpenOptions::new().append(true).open(&log)?;
        writeln!(f, "\n$ {}", args.join(" "))?;
        let mut cmd = Command::new(&args[0]);
        cmd.args(&args[1..]).current_dir(root);
        let status = run_command(
            cmd,
            None,
            &log,
            &log,
            config.stage_timeout_seconds,
            Control {
                store,
                stop,
                honor_pause,
            },
        )?;
        if status.is_none() {
            return Ok(None);
        }
        if status != Some(0) {
            return Ok(Some(false));
        }
    }
    Ok(Some(true))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classify_limits_separately() {
        assert_eq!(classify("usage_limit_reached"), Failure::Quota);
        assert_eq!(classify("401 Unauthorized"), Failure::Auth);
        assert_eq!(classify("connection reset"), Failure::Transient);
    }
    #[cfg(unix)]
    #[test]
    fn timeout_and_pause_stop_process() {
        let d = tempfile::tempdir().unwrap();
        let db = Store::open(d.path()).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 20"]);
        let start = Instant::now();
        assert_eq!(
            run_command(
                cmd,
                None,
                &d.path().join("o"),
                &d.path().join("e"),
                1,
                Control {
                    store: &db,
                    stop: &stop,
                    honor_pause: true
                }
            )
            .unwrap(),
            Some(124)
        );
        assert!(start.elapsed().as_secs() < 4);
        db.pause(true).unwrap();
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 20"]);
        assert_eq!(
            run_command(
                cmd,
                None,
                &d.path().join("o"),
                &d.path().join("e"),
                10,
                Control {
                    store: &db,
                    stop: &stop,
                    honor_pause: true
                }
            )
            .unwrap(),
            None
        );
    }
}
