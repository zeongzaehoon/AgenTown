use agentown_desktop::{Admission, authenticated_ready};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn duplicate_admission_and_release() {
    let path = std::env::temp_dir().join(format!(
        "agentown-lock-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let first = Admission::acquire(&path).unwrap();
    assert!(Admission::acquire(&path).is_err());
    drop(first);
    drop(Admission::acquire(&path).unwrap());
    std::fs::remove_file(path).unwrap();
}

fn readiness(body: &'static str) -> bool {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        // TCP reads may stop anywhere, including before the authentication header.
        // Read one byte at a time to exercise assembly across partial reads.
        while !request.ends_with(b"\r\n\r\n") {
            assert!(
                request.len() < 2048,
                "request headers exceeded fixture limit"
            );
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            request.extend_from_slice(&byte);
        }
        let request = String::from_utf8(request).unwrap();
        assert!(request.contains("X-AgenTown-Desktop: private-request-token\r\n"));
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let result = authenticated_ready(port, "private-request-token", "private-test-identity");
    server.join().unwrap();
    result
}

#[test]
fn readiness_requires_exact_launch_identity() {
    assert!(readiness(
        r#"{"ready":true,"identity":"private-test-identity"}"#
    ));
    assert!(!readiness(r#"{"ready":true,"identity":"another-process"}"#));
    assert!(!readiness(
        r#"{"ready":false,"identity":"private-test-identity"}"#
    ));
    assert!(!readiness("not json"));
}

#[test]
fn occupied_endpoint_cannot_impersonate_child() {
    assert!(!readiness(r#"{"status":"ok"}"#));
    // An endpoint can reflect the request token but cannot know the private response identity.
    assert!(!readiness(
        r#"{"ready":true,"identity":"private-request-token"}"#
    ));
}

#[cfg(unix)]
mod processes {
    use super::*;
    use agentown_desktop::{Paths, Service};
    use std::{
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        time::{Duration, Instant},
    };

    struct Fixture {
        root: PathBuf,
        paths: Paths,
    }
    impl Fixture {
        fn new(script: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "agentown-service-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(root.join("python/bin")).unwrap();
            let exe = root.join("python/bin/python3");
            std::fs::write(&exe, format!("#!/bin/sh\nread identity\n{script}\n")).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
            let paths =
                Paths::create(root.join("data"), root.join("config"), root.join("logs")).unwrap();
            Self { root, paths }
        }
        fn launch(&self) -> Service {
            Service::launch(
                &self.root,
                &self.paths,
                agentown_desktop::endpoint().unwrap(),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn readiness_timeout_is_bounded() {
        let fixture = Fixture::new("read shutdown");
        let mut service = fixture.launch();
        let start = Instant::now();
        assert!(service.wait_ready(Duration::from_millis(100)).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn unexpected_exit_is_detected() {
        let fixture = Fixture::new("exit 7");
        let mut service = fixture.launch();
        assert!(service.wait_ready(Duration::from_secs(1)).is_err());
        assert!(!service.alive());
    }

    #[test]
    fn eof_shuts_down_gracefully_and_preserves_data() {
        let fixture = Fixture::new("read shutdown\nprintf stopped > stopped");
        std::fs::write(
            fixture.paths.data.join("agentown.sqlite3"),
            b"preserve existing database",
        )
        .unwrap();
        let mut service = fixture.launch();
        service.shutdown();
        assert!(!service.alive());
        assert!(fixture.paths.data.join("stopped").exists());
        assert_eq!(
            std::fs::read(fixture.paths.data.join("agentown.sqlite3")).unwrap(),
            b"preserve existing database"
        );
        // Idempotent explicit shutdown and Drop must not signal a recycled PID.
        service.shutdown();
    }

    #[test]
    fn forced_shutdown_cleans_descendants() {
        let fixture = Fixture::new(
            "(sleep 1; printf leaked > leaked) &\nprintf started > started\nwhile :; do sleep 10; done",
        );
        let mut service = fixture.launch();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !fixture.paths.data.join("started").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        service.shutdown_with_budget(Duration::from_millis(50));
        assert!(!service.alive());
        std::thread::sleep(Duration::from_millis(1100));
        assert!(!fixture.paths.data.join("leaked").exists());
    }
}
