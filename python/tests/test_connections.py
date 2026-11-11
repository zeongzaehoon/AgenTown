"""Presentation mirrors published artifacts, without discovering local clients."""
import json
from pathlib import Path
import tomllib

from llm_engine.connections import connection_setup


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
    assert len(connection_setup()['clients']) == 2
    assert 'fresh explicit consent' in setup['consent']
    assert 'do not establish' in setup['evidence']
