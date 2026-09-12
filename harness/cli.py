#!/usr/bin/env python3
"""User interface for the Rust development harness (Python 3.9+)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.harness'
BINARY = RUNTIME / 'bin' / ('harnessd.exe' if os.name == 'nt' else 'harnessd')
LABEL = 'local.llm-engine.' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]


def environment():
    env = os.environ.copy()
    env['PATH'] = str(Path.home() / '.cargo' / 'bin') + os.pathsep + env.get('PATH', '')
    return env


def core(action, capture=False):
    if not BINARY.exists():
        raise RuntimeError('Run python3 harness/cli.py build first.')
    return subprocess.run([str(BINARY), action, str(ROOT)], env=environment(),
                          check=True, text=True, capture_output=capture)


def service_definition(binary, root, label, env):
    return {
        'Label': label,
        'ProgramArguments': [str(binary), 'run', str(root)],
        'WorkingDirectory': str(root),
        'EnvironmentVariables': {'PATH': env['PATH']},
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 30,
        'ExitTimeOut': 10,
        'StandardOutPath': str(root / '.harness' / 'service.log'),
        'StandardErrorPath': str(root / '.harness' / 'service.error.log'),
        'ProcessType': 'Background',
    }


def launchctl(*args, check=True):
    return subprocess.run(['launchctl', *args], check=check, capture_output=True, text=True)


def mac_service(action):
    if sys.platform != 'darwin':
        raise RuntimeError('Login service installation currently supports macOS. Use run on other systems.')
    plist = Path.home() / 'Library' / 'LaunchAgents' / (LABEL + '.plist')
    target = 'gui/' + str(os.getuid())
    loaded = launchctl('print', target + '/' + LABEL, check=False).returncode == 0
    if action == 'start':
        if not BINARY.exists():
            raise RuntimeError('Run build first.')
        if loaded:
            state = json.loads(core('status', capture=True).stdout)
            if state['paused']:
                core('resume')
            print('Login service is already installed and running: ' + LABEL)
            return
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_bytes(plistlib.dumps(service_definition(BINARY, ROOT, LABEL, environment())))
        core('resume')
        result = launchctl('bootstrap', target, str(plist), check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'launchctl bootstrap failed')
        print('Started; automatically runs after login: ' + LABEL)
    elif action == 'stop':
        core('pause')
        if loaded:
            result = launchctl('bootout', target + '/' + LABEL, check=False)
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or 'launchctl bootout failed')
        if plist.exists():
            plist.unlink()
        print('Stopped and removed login autostart. Task history retained.')
    else:
        print(json.dumps({'label': LABEL, 'loaded': loaded, 'plist': str(plist)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['build', 'run', 'once', 'status', 'pause', 'resume', 'check', 'start', 'stop', 'service-status'])
    action = parser.parse_args().action
    if action == 'build':
        cargo = shutil.which('cargo', path=environment()['PATH'])
        if not cargo:
            raise RuntimeError('Rust is required: https://rust-lang.org/tools/install/')
        subprocess.run([cargo, 'build', '--workspace', '--release', '--locked'], cwd=ROOT, env=environment(), check=True)
        BINARY.parent.mkdir(parents=True, exist_ok=True)
        source = ROOT / 'target' / 'release' / BINARY.name
        temporary = BINARY.with_suffix('.new')
        shutil.copy2(source, temporary)
        temporary.replace(BINARY)
        print('Installed runtime: ' + str(BINARY))
    elif action in ('start', 'stop', 'service-status'):
        mac_service(action)
    else:
        core(action)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
