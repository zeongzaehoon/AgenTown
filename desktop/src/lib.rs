//! Owned loopback service. Never forward child output or include private identity in errors.
use fs2::FileExt;
use rand::RngCore;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub const STARTUP: Duration = Duration::from_secs(20);
pub const SHUTDOWN: Duration = Duration::from_secs(5);
pub struct Admission(File);
impl Admission {
    pub fn acquire(path: &Path) -> Result<Self, &'static str> {
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|_| "Cannot access the app lock. Check data-folder permissions.")?;
        f.try_lock_exclusive()
            .map_err(|_| "AgenTown is already running. Switch to its existing window.")?;
        Ok(Self(f))
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub struct Paths {
    pub data: PathBuf,
    pub config: PathBuf,
    pub logs: PathBuf,
}
impl Paths {
    pub fn create(data: PathBuf, config: PathBuf, logs: PathBuf) -> Result<Self, &'static str> {
        for p in [&data, &config, &logs] {
            fs::create_dir_all(p).map_err(|_| "Cannot create AgenTown folders. Check available disk space and folder permissions.")?;
        }
        Ok(Self { data, config, logs })
    }
}

pub fn endpoint() -> Result<u16, &'static str> {
    let socket = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "Cannot reserve a local endpoint. Check firewall and loopback settings.")?;
    Ok(socket
        .local_addr()
        .map_err(|_| "Cannot inspect the local endpoint.")?
        .port())
}

pub struct Service {
    child: Child,
    pub port: u16,
    identity: String,
    token: String,
    stopped: bool,
    #[cfg(windows)]
    job: Job,
}
impl Service {
    pub fn launch(runtime: &Path, paths: &Paths, port: u16) -> Result<Self, &'static str> {
        let executable = runtime.join(if cfg!(windows) {
            "python/python.exe"
        } else {
            "python/bin/python3"
        });
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let identity: String = random.iter().map(|b| format!("{b:02x}")).collect();
        rand::rng().fill_bytes(&mut random);
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let mut command = Command::new(executable);
        command
            .args(["-I", "-m", "llm_engine.desktop", "--database"])
            .arg(paths.data.join("agentown.sqlite3"))
            .args(["--port", &port.to_string()])
            .current_dir(&paths.data)
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000 | 0x00000004);
        }
        let child = command.spawn().map_err(|_| "The bundled service cannot start. Rebuild or reinstall AgenTown for this computer.")?;
        #[cfg(windows)]
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let mut service = Self {
            child,
            port,
            identity,
            token,
            stopped: false,
            #[cfg(windows)]
            job,
        };
        writeln!(
            service
                .child
                .stdin
                .as_mut()
                .ok_or("The service startup pipe is unavailable.")?,
            "{}",
            serde_json::json!({"identity": service.identity, "token": service.token})
        )
        .map_err(|_| "The service exited during startup. Reinstall the bundled runtime.")?;
        Ok(service)
    }
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    pub fn wait_ready(&mut self, timeout: Duration) -> Result<(), &'static str> {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.alive() {
                return Err(
                    "The service exited before startup completed. Check the runtime installation and data-folder permissions.",
                );
            }
            if authenticated_ready(self.port, &self.token, &self.identity) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(
                    "The service did not become ready. Another program may occupy its endpoint; close AgenTown and try again.",
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    pub fn shutdown(&mut self) {
        self.shutdown_with_budget(SHUTDOWN);
    }
    pub fn shutdown_with_budget(&mut self, budget: Duration) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        // Closing the private parent pipe asks Python to stop gracefully.
        drop(self.child.stdin.take());
        let deadline = Instant::now() + budget;
        while self.alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        self.force_tree();
        let _ = self.child.wait();
    }
    fn force_tree(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        self.job.terminate();
        let _ = self.child.kill();
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn authenticated_ready(port: u16, token: &str, identity: &str) -> bool {
    let Ok(mut stream) =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(150))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(150)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
    if write!(stream, "GET /_desktop/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-AgenTown-Desktop: {token}\r\nConnection: close\r\n\r\n").is_err() { return false; }
    // A peer that trickles bytes must not extend the outer startup deadline.
    let deadline = Instant::now() + Duration::from_millis(150);
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || bytes.len() >= 8192 {
            return false;
        }
        let _ = stream.set_read_timeout(Some(remaining));
        let mut buffer = [0; 1024];
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => bytes.extend_from_slice(&buffer[..size]),
            Err(_) => return false,
        }
    }
    let Ok(response) = String::from_utf8(bytes) else {
        return false;
    };
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers.starts_with("HTTP/1.1 200 ") && !headers.starts_with("HTTP/1.0 200 ") {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value["identity"].as_str() == Some(identity) && value["ready"].as_bool() == Some(true)
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
// The owned job handle may move with Service into the shell's monitor thread.
// Windows job handles are process-wide; ownership and CloseHandle remain unique.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> Result<Self, &'static str> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = Self(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
            if job.0.is_null() {
                return Err("Cannot create the service containment job.");
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job.0, child.as_raw_handle() as _) == 0
            {
                return Err(
                    "Cannot contain the service process. Check desktop process permissions.",
                );
            }
            // Resume only after containment; NtResumeProcess avoids leaking a primary thread handle.
            #[link(name = "ntdll")]
            unsafe extern "system" {
                fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
            }
            if NtResumeProcess(child.as_raw_handle() as _) < 0 {
                return Err("Cannot resume the contained service.");
            }
            Ok(job)
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
