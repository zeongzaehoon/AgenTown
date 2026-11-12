"""Portable config checks and Windows-only executable launcher argument check."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP))
import check_windows


class ServiceDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.executable = r"C:\AgenTown space & é\service\python\python.exe"
        self.service = {"ProcessId": 42, "ExecutablePath": self.executable.upper(),
                        "CommandLine": f'"{self.executable}" -I -m llm_engine.desktop --database "C:\\data space\\agentown.sqlite3" --port 12345'}

    def discover(self, rows):
        with patch.object(check_windows, "powershell", return_value=json.dumps(rows)):
            return check_windows.child(SimpleNamespace(pid=10), self.executable)

    def test_service_is_found_alongside_browser_and_unrelated_python(self):
        browser = {"ProcessId": 43, "ExecutablePath": r"C:\WebView2\msedgewebview2.exe", "CommandLine": "browser --port 12345"}
        unrelated = dict(self.service, ProcessId=44, CommandLine="python.exe -m other --port 12345")
        other_runtime = dict(self.service, ProcessId=45, ExecutablePath=r"C:\developer\python.exe")
        self.assertEqual(self.discover([browser, unrelated, other_runtime, self.service]), self.service)

    def test_missing_inaccessible_or_ambiguous_service_is_not_selected(self):
        for rows in ([], [{"ExecutablePath": None, "CommandLine": None}],
                     [dict(self.service, CommandLine="python.exe -I -m llm_engine.desktop --database db")],
                     [self.service, dict(self.service, ProcessId=46)]):
            with self.subTest(rows=rows):
                self.assertIsNone(self.discover(rows))


class WindowsDeliveryTests(unittest.TestCase):
    def test_installer_contract(self):
        config = json.loads((DESKTOP / "tauri.windows.conf.json").read_text())
        bundle = config["bundle"]
        self.assertEqual(bundle["targets"], ["nsis"])
        self.assertEqual(bundle["windows"]["nsis"]["installMode"], "currentUser")
        self.assertEqual(bundle["windows"]["webviewInstallMode"]["type"], "embedBootstrapper")
        self.assertEqual(bundle["resources"]["resources/"], "service/")
        self.assertEqual(bundle["resources"]["launch-agentown.bat"], "launch-agentown.bat")

    @unittest.skipUnless(os.name == "nt", "Requires real cmd.exe argument parsing")
    def test_batch_forwards_quoted_arguments_without_delayed_expansion(self):
        with tempfile.TemporaryDirectory(prefix="AgenTown space & é ! ") as temporary:
            root = Path(temporary)
            shutil.copy2(DESKTOP / "launch-agentown.bat", root)
            source = root / "capture.rs"
            source.write_text('fn main() { let args: Vec<String> = std::env::args().skip(1).collect(); std::fs::write(std::env::current_exe().unwrap().with_extension("args"), args.join("\\n")).unwrap(); std::process::exit(7); }')
            subprocess.run(["rustc", str(source), "-o", str(root / "agentown-desktop.exe")], check=True)
            command = f'""{root / "launch-agentown.bat"}" "two words" "a&b" "bang!value" "é""'
            result = subprocess.run([os.environ["COMSPEC"], "/d", "/v:off", "/s", "/c", command], cwd=root.parent)
            self.assertEqual(result.returncode, 7)
            self.assertEqual((root / "agentown-desktop.args").read_text(encoding="utf-8"), "two words\na&b\nbang!value\né")


if __name__ == "__main__":
    unittest.main()
