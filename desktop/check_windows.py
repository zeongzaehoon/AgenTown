"""Windows packaged-shell smoke check; run in a disposable Windows user account.

Uses that account's normal Tauri data folders. Saves a uniquely named employee.
No provider calls and no deletion of user data. Requires an interactive desktop.
"""
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from check_app import api, ready_state, wait_until


def powershell(script):
    executable = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    return subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-Command", script],
                          check=True, capture_output=True, text=True).stdout.strip()


def child(shell, executable):
    rows = json.loads(powershell(
        f"ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId={shell.pid}' | Select-Object ProcessId,ExecutablePath,CommandLine)"))
    expected = ntpath.normcase(ntpath.normpath(str(executable)))
    services = [row for row in rows
                if ntpath.normcase(ntpath.normpath(row.get("ExecutablePath") or "")) == expected
                and re.search(r'\s-I\s+-m\s+llm_engine\.desktop\s+--database\s+', row.get("CommandLine") or "")
                and re.search(r'\s--port\s+\d+\s*$', row.get("CommandLine") or "")]
    return services[0] if len(services) == 1 else None


def alive(pid):
    return powershell(f"[bool](Get-Process -Id {pid} -ErrorAction SilentlyContinue)") == "True"


def launch(exe, root, environment):
    shell = subprocess.Popen([str(exe)], cwd=root, env=environment)
    try:
        owned = wait_until(lambda: child(shell, exe.parent / "service/python/python.exe") if shell.poll() is None else None,
                           30, "Shell did not start owned service")
        match = re.search(r'--port\s+(\d+)', owned["CommandLine"])
        if not match:
            raise RuntimeError("Owned service port missing")
        port = int(match[1])
        wait_until(lambda: ready_state(port), 30, "Packaged workspace API not ready")
        wait_until(lambda: (api(port, "GET", "/_desktop/rendered") or {}).get("rendered"),
                   30, "Packaged React workspace did not render")
        return shell, owned["ProcessId"], port
    except BaseException:
        shell.kill()
        shell.wait()
        raise


def stop(shell, owned):
    try:
        result = powershell(f"(Get-Process -Id {shell.pid}).CloseMainWindow()")
        if result != "True":
            raise RuntimeError("Could not close native workspace window")
        if shell.wait(timeout=15) != 0:
            raise RuntimeError("Native shell did not exit cleanly")
        wait_until(lambda: not alive(owned), 10, "Owned service survived shutdown")
    finally:
        if shell.poll() is None:
            shell.kill()
            shell.wait()


def main():
    if sys.platform != "win32":
        raise SystemExit("Requires Windows; macOS is not Windows evidence")
    source = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="AgenTown space & é ") as temporary:
        root = Path(temporary)
        app = root / "installed copy"
        app.mkdir()
        for filename in ("agentown-desktop.exe", "launch-agentown.bat"):
            shutil.copy2(source / filename, app / filename)
        shutil.copytree(source / "service", app / "service")
        empty = root / "empty-path"
        empty.mkdir()
        environment = os.environ.copy()
        environment["PATH"] = str(empty)
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        name = "Windows restart " + uuid.uuid4().hex
        shell, owned, port = launch(app / "agentown-desktop.exe", root, environment)
        try:
            employee = api(port, "POST", "/api/employees", {"name": name})
            work = api(port, "POST", "/api/work", {"employee": employee["id"], "input": name})
        finally:
            stop(shell, owned)
        shell, owned, port = launch(app / "agentown-desktop.exe", root, environment)
        try:
            state = api(port, "POST", "/api/state", {})
            assert any(row["id"] == employee["id"] and row["name"] == name for row in state["employees"])
            assert any(row["id"] == work["id"] and row["input"] == name for row in state["work"])
        finally:
            stop(shell, owned)
        print("Windows packaged shell: rendered React, empty PATH, spaced Unicode path, employee/work restart persistence and clean owned shutdown passed")


if __name__ == "__main__":
    main()
