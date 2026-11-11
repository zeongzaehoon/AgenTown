"""Build a fresh wheel and run it outside the checkout, shared by product gates."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def prepare_installed(base, evidence):
    base.mkdir(parents=True, exist_ok=True)
    evidence.mkdir(parents=True, exist_ok=True)
    def run(args):
        with (evidence / 'package-subprocess.txt').open('a') as log:
            log.write(f'COMMAND {args!r}\n'); log.flush()
            subprocess.run([str(a) for a in args], cwd=ROOT / "python", stdout=log,
                           stderr=subprocess.STDOUT, check=True, timeout=300)
    wheels = base / 'wheels'
    run([sys.executable, '-m', 'maturin', 'build', '--locked', '--out', wheels, '-i', sys.executable])
    wheel, = wheels.glob('*.whl')
    assets = ROOT / 'python/src/llm_engine/static'
    assert (assets / 'index.html').is_file(), 'Run npm run build before packaging'
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert not any('.harness/' in n or '.agents/' in n or 'node_modules/' in n for n in names)
        for asset in assets.rglob('*'):
            if asset.is_file():
                assert archive.read('llm_engine/static/' + asset.relative_to(assets).as_posix()) == asset.read_bytes()
        (evidence / 'wheel-contents.json').write_text(json.dumps(names, indent=2))
    requirements = base / 'requirements.txt'
    run(['uv', 'export', '--locked', '--no-dev', '--no-emit-project', '--output-file', requirements])
    environment = base / 'venv'
    run(['uv', 'venv', '--python', sys.executable, environment])
    scripts = environment / ('Scripts' if os.name == 'nt' else 'bin')
    python = scripts / ('python.exe' if os.name == 'nt' else 'python')
    run(['uv', 'pip', 'install', '--python', python, '--require-hashes', '-r', requirements])
    run(['uv', 'pip', 'install', '--python', python, '--no-deps', wheel])
    run(['uv', 'pip', 'check', '--python', python])
    shutil.copy2(wheel, evidence / wheel.name)
    shutil.copy2(requirements, evidence / 'requirements.txt')
    files = [p for folder in ('python/src', 'python/tests', 'rust/crates', 'frontend/src') for p in (ROOT / folder).rglob('*')
             if p.is_file() and p.suffix in ('.py', '.rs', '.toml', '.html', '.css', '.ts', '.tsx', '.js')]
    files += [ROOT / name for name in ('rust/Cargo.lock', 'rust/Cargo.toml', 'python/uv.lock', 'python/pyproject.toml', 'frontend/package.json', 'frontend/package-lock.json', 'frontend/vite.config.ts', 'frontend/tsconfig.json')]
    manifest = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
    manifest['wheel:' + wheel.name] = hashlib.sha256(wheel.read_bytes()).hexdigest()
    (evidence / 'source-wheel-sha256.json').write_text(json.dumps(manifest, indent=2))
    runtime = base / 'runtime'
    runtime.mkdir()
    shutil.copy2(ROOT / 'python/tests/web_browser_server.py', runtime / 'server.py')
    env = os.environ.copy()
    for key in ('PYTHONPATH', 'PYTHONHOME', 'ANTHROPIC_API_KEY'):
        env.pop(key, None)
    env['PATH'] = str(scripts)  # No Node, Cargo, checkout or harness tools at runtime.
    probe = subprocess.run([str(python), '-I', '-c', 'import llm_engine, shutil; print(llm_engine.__file__); assert shutil.which("node") is None'],
                           cwd=runtime, env=env, text=True, capture_output=True, check=True)
    assert str(environment.resolve()) in probe.stdout
    (evidence / 'runtime.json').write_text(json.dumps({'platform': platform.platform(), 'import': probe.stdout, 'cwd': str(runtime)}, indent=2))
    return python, runtime, env
