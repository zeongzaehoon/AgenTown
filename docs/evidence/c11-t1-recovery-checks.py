import json, os, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[2]
prefix = root / "docs/evidence/c11-t1-recovery"
env = dict(os.environ, LLM_ENGINE_PACKAGE_EVIDENCE=str(prefix) + "-installed")
commands = [
("frontend", ["npm", "--prefix", "frontend", "test"]),
("build", ["npm", "--prefix", "frontend", "run", "build"]),
("cargo", ["cargo", "test", "--manifest-path", "rust/Cargo.toml", "--workspace", "--locked"]),
("native", ["uv", "run", "--directory", "python", "--locked", "maturin", "develop", "--locked"]),
("pytest", ["uv", "run", "--directory", "python", "--locked", "python", "-m", "pytest"]),
("harness", ["python3", ".harness/cli.py", "check"]),
]
results = []
for name, command in commands:
    with Path(str(prefix) + "-" + name + ".txt").open("w") as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    results.append(dict(check=name, command=command, exit_code=result.returncode))
    Path(str(prefix) + "-checks.json").write_text(json.dumps(results, indent=2))
    print(name, result.returncode, flush=True)
    if name == "native" and result.returncode:
        break
