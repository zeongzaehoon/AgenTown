import os
from pathlib import Path
import pytest
from installed_package import prepare_installed


@pytest.fixture(scope='session')
def installed_package(tmp_path_factory):
    base = tmp_path_factory.mktemp('installed-package')
    evidence = Path(os.environ.get('LLM_ENGINE_BROWSER_EVIDENCE', os.environ.get('LLM_ENGINE_PACKAGE_EVIDENCE', str(base / 'evidence')))) / 'package'
    return prepare_installed(base, evidence)
