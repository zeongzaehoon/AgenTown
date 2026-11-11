"""Build assembly regressions; requires no downloads or native compilation."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop_build", Path(__file__).parents[1] / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class RuntimeSelectionTests(unittest.TestCase):
    def test_uv_minor_alias_is_not_a_second_distribution(self):
        with tempfile.TemporaryDirectory() as temporary:
            managed = Path(temporary)
            runtime = managed / "cpython-3.13.12-macos-aarch64-none"
            runtime.mkdir()
            (managed / "cpython-3.13-macos-aarch64-none").symlink_to(runtime, target_is_directory=True)
            self.assertEqual(build.managed_runtime(managed), runtime)

    def test_ambiguous_or_missing_distributions_fail_before_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            managed = Path(temporary)
            with self.assertRaises(SystemExit):
                build.managed_runtime(managed)
            for patch in (11, 12):
                (managed / f"cpython-3.13.{patch}-macos-aarch64-none").mkdir()
            with self.assertRaises(SystemExit):
                build.managed_runtime(managed)


class ServiceInstallTests(unittest.TestCase):
    def test_managed_copy_install_explicitly_allows_package_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            resources = Path(temporary) / "resources"
            interpreter = resources / "python/bin/python3"
            with patch.object(build, "RESOURCES", resources), patch.object(build, "run") as run:
                build.install_service(interpreter, "requirements.txt", "agentown.whl")
            run.assert_called_once_with(
                "uv", "pip", "install", "--python", interpreter,
                "--no-managed-python", "--break-system-packages",
                "--requirements", "requirements.txt", "agentown.whl")

    def test_external_interpreter_and_escaping_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            resources = root / "resources"
            runtime = resources / "python/bin"
            runtime.mkdir(parents=True)
            external = root / "host-python"
            external.touch()
            alias = runtime / "python3"
            alias.symlink_to(external)
            with patch.object(build, "RESOURCES", resources), patch.object(build, "run") as run:
                for interpreter in (external, alias):
                    with self.assertRaises(SystemExit):
                        build.install_service(interpreter, "requirements.txt", "agentown.whl")
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
