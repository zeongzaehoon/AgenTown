"""Build-time smoke check of relocated service resources; no provider calls."""

import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time


def request(port, path, payload=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        connection.request("GET" if payload is None else "POST", path,
                           None if payload is None else json.dumps(payload),
                           headers or {})
        response = connection.getresponse()
        body = response.read()
        if response.status not in (200, 201):
            raise RuntimeError(f"Relocated service rejected {path}: HTTP {response.status}")
        return body
    finally:
        connection.close()


def check(resources):
    with tempfile.TemporaryDirectory(prefix="agentown-relocated-") as temporary:
        root = Path(temporary)
        shutil.copytree(resources, root / "service", symlinks=False)
        empty_path = root / "empty-path"
        empty_path.mkdir()
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() not in {"PATH", "PYTHONPATH", "PYTHONHOME"}
                       and not key.upper().endswith(("API_KEY", "ACCESS_TOKEN", "SECRET"))}
        environment["PATH"] = str(empty_path)
        interpreter = root / "service/python" / ("python.exe" if os.name == "nt" else "bin/python3")
        saved_id = None
        for attempt in range(2):
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            token, identity = secrets.token_hex(32), secrets.token_hex(32)
            child = subprocess.Popen(
                [str(interpreter), "-I", "-m", "llm_engine.desktop", "--database",
                 str(root / "agentown.sqlite3"), "--port", str(port)],
                cwd=root, env=environment, stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
            try:
                child.stdin.write(json.dumps({"token": token, "identity": identity}) + "\n")
                child.stdin.flush()
                deadline = time.monotonic() + 20
                while True:
                    if child.poll() is not None:
                        raise RuntimeError("Relocated service exited before readiness; check bundled dependencies.")
                    try:
                        ready = json.loads(request(port, "/_desktop/ready", headers={"X-AgenTown-Desktop": token}))
                        if ready != {"ready": True, "identity": identity}:
                            raise RuntimeError("Relocated service identity did not match.")
                        break
                    except (OSError, http.client.HTTPException):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Relocated service readiness timed out.") from None
                        time.sleep(0.05)
                html = request(port, "/").decode()
                # Fetch the built entry module too, rather than accepting an HTML placeholder.
                import re
                scripts = re.findall(r'<script[^>]+src="([^"]+)"', html)
                if not scripts:
                    raise RuntimeError("Bundled React entry module is missing.")
                for script in scripts:
                    if not script.startswith("/static/assets/") or not request(port, script):
                        raise RuntimeError("Bundled React asset is missing.")
                headers = {"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"}
                if attempt == 0:
                    saved_id = json.loads(request(port, "/api/employees", {"name": "Relocated runtime check"}, headers))["id"]
                else:
                    state = json.loads(request(port, "/api/state", {}, headers))
                    if not any(row["id"] == saved_id for row in state["employees"]):
                        raise RuntimeError("Relocated service lost the saved employee after restart.")
                child.stdin.close()
                if child.wait(timeout=5) != 0:
                    raise RuntimeError("Relocated service did not shut down cleanly.")
            finally:
                if child.stdin and not child.stdin.closed:
                    child.stdin.close()
                if child.poll() is None:
                    child.kill()
                child.wait()
        print("Relocated runtime: empty PATH, authenticated readiness, React assets, persisted employee ID, restart and EOF shutdown passed.", flush=True)


if __name__ == "__main__":
    import sys
    check(Path(sys.argv[1]).resolve())
