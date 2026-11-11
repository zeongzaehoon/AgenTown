#!/usr/bin/env python3
"""Check copied macOS bundle process ownership, not workspace acceptance.

This deliberately does not claim service readiness or rendered React content.
Follow docs/desktop.md for the required graphical workspace/restart acceptance.
"""

from pathlib import Path
import os
import signal
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
        process = subprocess.Popen(
            [str(executable)], cwd=root, env=environment,
            stdin=subprocess.DEVNULL,
        )
        owned: list[int] = []
        try:
            owned = wait_until(
                lambda: children(process.pid) if process.poll() is None else [],
                30, "Assembled app did not spawn a child process",
            )
            if process.poll() is not None:
                raise RuntimeError("Assembled app exited during the process ownership check")
            swift = subprocess.run(
                ["/usr/bin/xcrun", "--find", "swift"], check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            subprocess.run(
                [swift, str(Path(__file__).with_name("check_window.swift")),
                 str(process.pid)], check=True,
            )
            print(f"assembled-app-ready shell={process.pid} owned-service={owned[0]}")
        finally:
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
        print("assembled-app-clean-shutdown=true copied-outside-checkout=true empty-path=true")


if __name__ == "__main__":
    main()
