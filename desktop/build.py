#!/usr/bin/env python3
"""Build an unsigned native shell and a relocatable, self-contained service.

Developer tools only: Python 3.13, uv, Node/npm, Rust/cargo-tauri and OS Tauri prerequisites.
Never run this at application startup.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
BUILD = DESKTOP / "build"
RESOURCES = DESKTOP / "resources"


def run(*args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def managed_runtime(managed):
    # uv also creates a minor-version alias pointing at the installed runtime.
    # Select physical distributions only; copying an alias as a second runtime
    # would reject a successful installation.
    candidates = [path for path in managed.glob("cpython-3.13*")
                  if path.is_dir() and not path.is_symlink()]
    if len(candidates) != 1:
        raise SystemExit("Expected one managed Python 3.13 runtime; remove desktop/build/managed and retry.")
    return candidates[0]


def install_service(interpreter, requirements, wheel):
    # uv marks its standalone distributions EXTERNALLY-MANAGED. Only opt in
    # for our disposable copied runtime, never the build host's interpreter.
    runtime = (RESOURCES / "python").resolve()
    if not interpreter.resolve().is_relative_to(runtime):
        raise SystemExit("Refusing to install service packages outside the copied desktop runtime.")
    run("uv", "pip", "install", "--python", interpreter, "--no-managed-python",
        "--break-system-packages", "--requirements", requirements, wheel)


def main():
    if sys.version_info[:2] != (3, 13):
        raise SystemExit("Run the desktop build using Python 3.13.")
    for tool in ("uv", "npm", "cargo"):
        if not shutil.which(tool):
            raise SystemExit(f"Install the developer build tool {tool} before building.")
    # This is a separate Cargo workspace: the product Core's test command does
    # not cover desktop admission, readiness or child cleanup. Make these a
    # required part of the documented desktop build, before assembling assets.
    run("cargo", "test", "--manifest-path", DESKTOP / "Cargo.toml",
        "--no-default-features")
    BUILD.mkdir(exist_ok=True)
    run("npm", "ci", cwd=ROOT / "frontend")
    run("npm", "run", "build", cwd=ROOT / "frontend")
    run("uv", "build", "--wheel", "--out-dir", BUILD / "wheels", ROOT / "python")
    # uv downloads the platform-specific python-build-standalone distribution.
    # Copy the complete distribution rather than a venv referencing the checkout.
    managed = BUILD / "managed"
    run("uv", "python", "install", "3.13", "--install-dir", managed,
        "--no-bin", "--no-registry")
    runtime = managed_runtime(managed)
    if (RESOURCES / "python").exists():
        shutil.rmtree(RESOURCES / "python")
    shutil.copytree(runtime, RESOURCES / "python", symlinks=False)
    interpreter = RESOURCES / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    wheels = list((BUILD / "wheels").glob("agentown-*.whl"))
    if len(wheels) != 1:
        raise SystemExit("Expected one product wheel; remove desktop/build/wheels and retry.")
    requirements = BUILD / "requirements.txt"
    run("uv", "export", "--project", ROOT / "python", "--frozen", "--no-dev",
        "--no-emit-project", "--format", "requirements-txt", "--output-file", requirements)
    install_service(interpreter, requirements, wheels[0])
    # Validate the relocated runtime independently of developer import paths.
    run(interpreter, "-I", "-c", "import llm_engine._native, llm_engine.desktop; from importlib.resources import files; assert files('llm_engine').joinpath('static/index.html').is_file()", cwd=BUILD)
    # Exercise the assembled service outside the checkout with no developer
    # executables on PATH, before embedding it in the native distribution.
    run(sys.executable, DESKTOP / "check_runtime.py", RESOURCES)
    if os.name == "nt":
        run("cargo", "tauri", "build", "--no-bundle", cwd=DESKTOP)
        # Windows resource_dir is the executable directory for an unbundled app.
        shutil.copytree(RESOURCES, DESKTOP / "target/release/service", dirs_exist_ok=True)
        print("Desktop executable: desktop/target/release/agentown-desktop.exe (keep service/ beside it)")
    else:
        run("cargo", "tauri", "build", "--bundles", "app", cwd=DESKTOP)
        print("Unsigned desktop build: desktop/target/release/bundle/")
    # Tauri has copied the service into the assembled artifact. Remove staging
    # inputs and generated schemas so a successful build leaves the source
    # fingerprint unchanged; the retained bundle remains independently usable.
    shutil.rmtree(RESOURCES / "python")
    shutil.rmtree(DESKTOP / "gen", ignore_errors=True)


if __name__ == "__main__":
    main()
