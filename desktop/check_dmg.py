#!/usr/bin/env python3
"""Mount the actual DMG and exercise an isolated installed copy in a macOS login."""
from pathlib import Path
import hashlib
import platform
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "darwin" or len(sys.argv) != 2:
        raise SystemExit("Usage on macOS: python3.13 desktop/check_dmg.py /absolute/path/to/image.dmg")
    artifact = Path(sys.argv[1]).resolve(strict=True)
    with artifact.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    print(f"artifact={artifact} sha256={digest} platform={platform.platform()} architecture={platform.machine()}", flush=True)
    with tempfile.TemporaryDirectory(prefix="agentown-mount-", dir="/private/tmp") as temporary:
        mount = Path(temporary) / "volume"
        mount.mkdir()
        subprocess.run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse",
                        "-mountpoint", str(mount), str(artifact)], check=True)
        try:
            subprocess.run([sys.executable, str(Path(__file__).with_name("check_app.py")),
                            str(mount / "AgenTown.app"), "--delivery"], check=True)
        finally:
            subprocess.run(["/usr/bin/hdiutil", "detach", str(mount)], check=True)
    print("DMG mount/install/restart/reinstall/recovery/cleanup passed; real LLM calls skipped", flush=True)


if __name__ == "__main__":
    main()
