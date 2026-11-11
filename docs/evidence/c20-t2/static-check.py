"""Dependency-free check; run from repository root with Python 3.13."""
import ast
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import tomllib

source = Path('python/tests/test_mcp_config.py')
tree = ast.parse(source.read_text(encoding='utf-8'), filename=str(source))
# Exercise the test's actual loader without importing unavailable pytest/MCP.
loader = next(node for node in tree.body
              if isinstance(node, ast.FunctionDef) and node.name == 'load_config')
namespace = dict(Path=Path, PurePosixPath=PurePosixPath,
                 PureWindowsPath=PureWindowsPath, json=json, tomllib=tomllib,
                 ARTIFACTS=Path('docs/mcp-config'))
exec(compile(ast.Module(body=[loader], type_ignores=[]), str(source), 'exec'), namespace)
paths = sorted(Path('docs/mcp-config').iterdir())
assert len(paths) == 4
for path in paths:
    namespace['load_config'](path.name)
    print(f'PASS {path}: parsed; stdio shape and absolute paths valid')
print(f'PASS {source}: AST parsed and actual artifact loader exercised')
