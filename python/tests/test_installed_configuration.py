"""Documented configuration demo through the installed command, without a browser."""
import json
import os
from pathlib import Path
import subprocess


def test_installed_configuration_restart(tmp_path, installed_package):
    python, runtime, env = installed_package
    evidence = Path(os.environ.get('LLM_ENGINE_PACKAGE_EVIDENCE', str(tmp_path / 'evidence')))
    script = Path(__file__).resolve().parents[2] / 'docs' / 'configuration_demo.py'
    subprocess.run([str(python), '-I', str(script), '--evidence', str(evidence)],
                   cwd=runtime, env=env, check=True, timeout=90)
    result = json.loads((evidence / 'configuration-restart.json').read_text())
    assert len(result['commands']) == 2
    assert result['before_restart'] == result['after_restart'] == result['new_python_process']
    assert len(result['after_restart']) == 3
    assert all(row['enabled'] for row in result['after_restart'].values())
    assert result['runs'] == []
