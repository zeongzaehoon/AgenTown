import importlib.util
from pathlib import Path
import plistlib
import unittest

spec = importlib.util.spec_from_file_location('cli', Path(__file__).resolve().parents[1] / 'cli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class LaunchAgentTests(unittest.TestCase):
    def test_paths_with_spaces_are_separate_arguments(self):
        root = Path('/tmp/Project With Spaces')
        binary = root / '.harness/bin/harnessd'
        definition = cli.service_definition(binary, root, 'test.harness', {'PATH': '/usr/bin:/custom/bin'})
        parsed = plistlib.loads(plistlib.dumps(definition))
        self.assertEqual(parsed['ProgramArguments'], [str(binary), 'run', str(root)])
        self.assertEqual(parsed['WorkingDirectory'], str(root))
        self.assertTrue(parsed['KeepAlive'])
        self.assertTrue(parsed['RunAtLoad'])
        self.assertEqual(parsed['EnvironmentVariables'], {'PATH': '/usr/bin:/custom/bin'})

    def test_service_does_not_copy_secret_environment(self):
        definition = cli.service_definition(Path('/b'), Path('/r'), 'test', {'PATH': '/bin', 'API_KEY': 'secret'})
        self.assertNotIn('API_KEY', definition['EnvironmentVariables'])


if __name__ == '__main__':
    unittest.main()
