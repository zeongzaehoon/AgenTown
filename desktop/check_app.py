#!/usr/bin/env python3
"""Exercise the copied macOS app, rendered workspace, and restart persistence."""

from pathlib import Path
import http.client
import json
import os
import signal
import shlex
import subprocess
import sys
import tempfile
import time


def children(pid: int) -> list[int]:
    result = subprocess.run(
        ["/usr/bin/pgrep", "-P", str(pid)], capture_output=True, text=True
    )
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not inspect the desktop process tree")
    return [int(value) for value in result.stdout.split()]


def wait_until(predicate, timeout: float, message: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError(message)


def child_port(pid: int) -> int:
    command = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "command="],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    arguments = shlex.split(command)
    return int(arguments[arguments.index("--port") + 1])


def api(port: int, method: str, path: str, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    headers = {"Origin": f"http://127.0.0.1:{port}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    content = response.read()
    connection.close()
    if response.status >= 300:
        raise RuntimeError(f"Desktop API {method} {path} returned {response.status}")
    return json.loads(content) if content else None


def ready_state(port: int):
    try:
        return api(port, "POST", "/api/state", {})
    except (ConnectionError, OSError, RuntimeError):
        return None


def stop(process: subprocess.Popen, owned: list[int]) -> None:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def surviving() -> list[int]:
        return [pid for pid in owned if subprocess.run(
            ["/bin/kill", "-0", str(pid)], capture_output=True
        ).returncode == 0]

    deadline = time.monotonic() + 10
    survivors = surviving()
    while survivors and time.monotonic() < deadline:
        time.sleep(0.1)
        survivors = surviving()
    if survivors:
        raise RuntimeError(f"Owned service survived native app shutdown: {survivors}")


def launch(executable: Path, root: Path, environment: dict[str, str]):
    process = subprocess.Popen(
        [str(executable)], cwd=root, env=environment, stdin=subprocess.DEVNULL,
    )
    owned = wait_until(
        lambda: children(process.pid) if process.poll() is None else [],
        30, "Assembled app did not spawn its owned service",
    )
    if process.poll() is not None:
        raise RuntimeError("Assembled app exited during startup")
    port = wait_until(
        lambda: child_port(owned[0]), 10,
        "Assembled service did not publish its loopback port",
    )
    wait_until(
        lambda: ready_state(port), 20,
        "Assembled workspace API did not become ready",
    )
    return process, owned, port


def main() -> None:
    if sys.platform != "darwin":
        raise SystemExit("The assembled .app smoke check must run on macOS")
    source = Path(sys.argv[1] if len(sys.argv) > 1 else
                  "desktop/target/release/bundle/macos/AgenTown.app").resolve()
    executable_name = "agentown-desktop"
    if not source.is_dir():
        raise SystemExit(f"Assembled app not found: {source}")

    with tempfile.TemporaryDirectory(prefix="agentown-app-", dir="/private/tmp") as temporary:
        root = Path(temporary)
        copied = root / "AgenTown.app"
        # ditto preserves the bundle metadata and extended attributes that a
        # plain recursive copy can invalidate on macOS.
        subprocess.run(["/usr/bin/ditto", str(source), str(copied)], check=True)
        executable = copied / "Contents/MacOS" / executable_name
        empty_path = root / "empty-path"
        empty_path.mkdir()
        # Preserve the graphical login/session variables required by AppKit,
        # while proving no developer executable can be resolved from PATH.
        environment = os.environ.copy()
        environment["PATH"] = str(empty_path)
        fixed_home = root / "home"
        fixed_home.mkdir()
        environment["CFFIXED_USER_HOME"] = str(fixed_home)

        process, owned, port = launch(executable, root, environment)
        try:
            swift = subprocess.run(
                ["/usr/bin/xcrun", "--find", "swift"], check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            window = None
            for _ in range(30):
                observed = subprocess.run(
                    [swift, str(Path(__file__).with_name("check_window.swift")),
                     str(process.pid)], capture_output=True, text=True,
                )
                if observed.returncode == 0:
                    window = observed.stdout
                    break
                time.sleep(0.1)
            if window is None:
                raise RuntimeError("Native workspace window was not observed")
            print(window, end="")
            rendered = wait_until(
                lambda: (api(port, "GET", "/_desktop/rendered") or {}).get("rendered"),
                20, "React workspace did not publish its rendered DOM signal",
            )
            print(f"rendered-react-workspace={str(bool(rendered)).lower()}")
            saved = api(port, "POST", "/api/employees",
                        {"name": "Desktop restart evidence"})
            employee_id = saved["id"]
            print(f"assembled-app-ready shell={process.pid} owned-service={owned[0]}")
        finally:
            stop(process, owned)

        process, owned, port = launch(executable, root, environment)
        try:
            state = api(port, "POST", "/api/state", {})
            employees = state.get("employees", [])
            if not any(employee.get("id") == employee_id for employee in employees):
                raise RuntimeError("Saved desktop record was not retained after app restart")
            print(f"assembled-app-restart-persistence=true employee-id={employee_id}")
        finally:
            stop(process, owned)
        print("assembled-app-clean-shutdown=true copied-outside-checkout=true empty-path=true")


if __name__ == "__main__":
    main()
