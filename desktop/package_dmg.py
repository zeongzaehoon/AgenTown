#!/usr/bin/env python3
"""Package an already assembled macOS app without signing or publishing it."""
from pathlib import Path
import hashlib
import platform
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "darwin":
        raise SystemExit("DMG packaging requires macOS")
    desktop = Path(__file__).resolve().parent
    app = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else desktop / "target/release/bundle/macos/AgenTown.app"
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else desktop / f"target/release/bundle/dmg/AgenTown-unsigned-{platform.machine()}.dmg"
    if not (app / "Contents/Resources/service/python/bin/python3").is_file():
        raise SystemExit("Build the complete app with bundled service before packaging")
    output.parent.mkdir(parents=True, exist_ok=True)
    # The target directory contains generated artifacts. Make the documented
    # command repeatable by replacing only this exact architecture-specific DMG.
    with tempfile.TemporaryDirectory(prefix="agentown-dmg-") as temporary:
        staging = Path(temporary)
        subprocess.run(["/usr/bin/ditto", str(app), str(staging / "AgenTown.app")], check=True)
        (staging / "Applications").symlink_to("/Applications", target_is_directory=True)
        subprocess.run(["/usr/bin/hdiutil", "create", "-volname", "AgenTown",
                        "-srcfolder", str(staging), "-fs", "HFS+", "-format", "UDZO",
                        "-ov", str(output)], check=True)
    subprocess.run(["/usr/bin/hdiutil", "verify", str(output)], check=True)
    with output.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    print(f"artifact={output} sha256={digest} platform={platform.platform()} architecture={platform.machine()}")


if __name__ == "__main__":
    main()
