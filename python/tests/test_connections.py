"""Presentation mirrors published artifacts, without discovering local clients."""
import json
from pathlib import Path
import tomllib
import builtins
import pytest

from llm_engine.connections import connection_setup, generate_configuration, detect_capabilities


def test_setup_matches_published_contract_and_is_fresh():
    setup = connection_setup()
    assert setup['schema_version'] == setup['workflow_version'] == 1
    root = Path(__file__).parents[2] / 'docs' / 'mcp-config'
    for client in setup['clients']:
        assert client['readiness'] == 'unknown'
        for platform in client['platforms']:
            codex = client['id'] == 'codex'
            parse = tomllib.loads if codex else json.loads
            suffix = 'toml' if codex else 'json'
            artifact = root / f"{client['id']}-{platform['id']}.{suffix}"
            assert parse(platform['configuration']) == parse(artifact.read_text())
    setup['clients'].clear()
    assert len(connection_setup()['clients']) == 4
    assert 'fresh explicit consent' in setup['consent']
    assert 'do not establish' in setup['evidence']


@pytest.mark.parametrize("platform,executable,database", [
    ("macos", "/Company Space/bin/agentown-mcp", "/Company Space/data.sqlite"),
    ("windows", r"C:\Company Space\agentown-mcp.exe", r"C:\Company Space\data.sqlite")])
@pytest.mark.parametrize("client", ["claude-desktop", "cursor"])
def test_explicit_path_generation(client, platform, executable, database):
    entry = json.loads(generate_configuration(client, platform, executable, database))["mcpServers"]["agentown"]
    assert entry.pop("type", "stdio") == "stdio"
    assert entry == {"command": executable, "args": ["--database", database]}
    for bad in ("relative", "", "bad\npath"):
        with pytest.raises(ValueError):
            generate_configuration(client, platform, bad, database)
        with pytest.raises(ValueError):
            generate_configuration(client, platform, executable, bad)


def test_detection_does_not_open_files_or_launch_clients(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Detection must not open files")
    monkeypatch.setattr(builtins, "open", forbidden)
    monkeypatch.setattr(Path, "open", forbidden)
    monkeypatch.setattr("llm_engine.connections.shutil.which", lambda name: "/bin/cursor")
    monkeypatch.setattr(Path, "is_dir", lambda path: False)
    detected = detect_capabilities()["clients"]
    assert detected[1]["detected"] is True
    assert all(c["configuration"] == "unknown" and c["protocol_connection"] == c["client_exercise"] == "unverified" for c in detected)


@pytest.mark.parametrize('folder', ['Company Space', 'Company 😀'])
def test_packaged_runtime_artifacts_preserve_paths_and_truthful_states(tmp_path, monkeypatch, folder):
    import sys
    executable = str(tmp_path / folder / 'Installed App' / 'python')
    database = str(tmp_path / folder / 'User Data' / 'company.sqlite')
    monkeypatch.setattr(sys, 'executable', executable)
    setup = connection_setup(database)
    assert [c['id'] for c in setup['clients']] == ['codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt']
    for client in setup['clients']:
        assert client['status']['configured'] == 'unknown'
        assert client['status']['connected'] == client['status']['exercised'] == 'unverified'
        platform, = client['platforms']
        assert platform['filename']
        if client['id'] == 'chatgpt':
            assert 'PKCE' in platform['configuration']
            assert 'prerequisites unmet' in platform['destination']
            assert database in platform['configuration']
            continue
        parsed = (tomllib.loads(platform['configuration'])['mcp_servers'] if client['id'] == 'codex'
                  else json.loads(platform['configuration'])['mcpServers'])['agentown']
        assert parsed['command'] == executable
        assert parsed['args'] == ['-I', '-m', 'llm_engine.mcp_server', '--database', database]
        assert Path(platform['destination']).is_absolute()
    assert not Path(database).exists()
