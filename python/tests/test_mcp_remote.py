"""Real ASGI MCP protocol/authentication and Rust store; no external issuer/provider."""
import base64
import json
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
import pytest
from starlette.testclient import TestClient

from llm_engine.mcp_remote import create_remote_app, main, validate_endpoint
from mcp_fixture_server import FixtureProvider
from test_cli import cli

ISSUER = "https://issuer.example.test"
BASE = "http://127.0.0.1:8766"


def signing_key_fixture():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_bytes(serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo).decode()

    def token(**changes):
        claims = {"iss": ISSUER, "aud": BASE + "/mcp", "sub": "operator",
                  "client_id": "fixture", "exp": int(time.time()) + 300,
                  "scope": "agentown:workspace"}
        claims.update(changes)
        claims = {k: v for k, v in claims.items() if v is not None}
        def encode(data):
            return base64.urlsafe_b64encode(data).rstrip(b"=")
        unsigned = b".".join(encode(json.dumps(x).encode()) for x in
                             ({"alg": "RS256", "typ": "JWT"}, claims))
        signature = key.sign(unsigned, padding.PKCS1v15(), hashes.SHA256())
        return (unsigned + b"." + encode(signature)).decode()
    return public, token


def test_authenticated_workflow_and_isolation(cli, tmp_path, signing):
    cli("agent", "list")
    database = tmp_path / "product.sqlite"
    isolated = tmp_path / "other.sqlite"
    # A second valid store is initialized independently, never chosen by a tool.
    isolated.write_bytes(database.read_bytes())
    original = isolated.read_bytes()
    public, token = signing
    app = create_remote_app(str(database), public_key=public, issuer=ISSUER,
        base_url=BASE, provider_factory=lambda model, provider: FixtureProvider())
    with TestClient(app) as client:
        def rpc(method, params=None, bearer=None):
            headers = {"Accept": "application/json, text/event-stream"}
            if bearer:
                headers["Authorization"] = "Bearer " + bearer
            return client.post("/mcp", headers=headers, json={"jsonrpc": "2.0",
                "id": 1, "method": method, "params": params or {}})

        before = database.read_bytes()
        for invalid in (None, "invalid", token(exp=1), token(exp=None),
                        token(iss="https://wrong.test"), token(aud="other"),
                        token(scope="other"), token(nbf=int(time.time()) + 600),
                        token(nbf="invalid"), token(nbf=True)):
            response = rpc("tools/call", {"name": "create_employee_v1",
                "arguments": {"name": "Unauthorized"}}, invalid)
            assert response.status_code in (401, 403)
        # A token signed by another key is rejected even with valid claims.
        _, foreign_token = signing_key_fixture()
        assert rpc("tools/list", bearer=foreign_token()).status_code == 401
        assert database.read_bytes() == before
        valid = token(nbf=int(time.time()) - 60)
        init = rpc("initialize", {"protocolVersion": "2025-06-18",
            "capabilities": {}, "clientInfo": {"name": "fixture", "version": "1"}}, valid)
        assert init.status_code == 200
        assert init.json()["result"]["serverInfo"]["name"] == "AgenTown"
        tools = rpc("tools/list", bearer=valid).json()["result"]["tools"]
        assert len(tools) == 19
        assert {'preview_loop_v1', 'start_loop_v1', 'stop_loop_v1'} <= {
            tool['name'] for tool in tools}
        for tool in tools:
            assert "database" not in tool["inputSchema"].get("properties", {})
        metadata = client.get("/.well-known/oauth-protected-resource/mcp")
        assert metadata.status_code == 200
        assert metadata.json()["authorization_servers"] == [ISSUER + "/"] or metadata.json()["authorization_servers"] == [ISSUER]
        assert metadata.json()["resource"] == BASE + "/mcp"

        def call(name, arguments):
            response = rpc("tools/call", {"name": name, "arguments": arguments}, valid)
            assert response.status_code == 200
            return response.json()["result"]
        employee = call("create_employee_v1", {"name": "Writer"})["structuredContent"]["employee"]
        work = call("save_text_work_v1", {"employee_id": employee["id"], "text": "Draft"})["structuredContent"]["task"]
        args = {"task_id": work["id"], "provider": "anthropic", "model": "fixture",
                "declared_source": "http-fixture", "expected_runs": 0}
        assert call("execute_text_work_v1", args)["structuredContent"]["output"] == "Fixture result: Draft"
        assert call("execute_text_work_v1", args)["isError"]
        args["expected_runs"] = 1
        assert call("execute_text_work_v1", args)["isError"]
        args["resubmission_consent"] = True
        assert not call("execute_text_work_v1", args).get("isError")
        history = call("get_work_history_v1", {"task_id": work["id"]})["structuredContent"]
        assert len(history["attempts"]) == 2
    # TestClient context drives HTTP transport lifespan startup and shutdown.
    assert isolated.read_bytes() == original


@pytest.fixture
def signing():
    return signing_key_fixture()


@pytest.mark.parametrize("host,url,allow", [
    ("0.0.0.0", BASE, False), ("127.0.0.1", "https://public.example", False),
    ("0.0.0.0", "http://public.example", True),
    ("127.0.0.1", "https://user:password@public.example", True),
])
def test_unsafe_binding_rejected(host, url, allow):
    with pytest.raises(ValueError):
        validate_endpoint(host, url, allow)


def test_explicit_binding_and_failed_startup(tmp_path):
    validate_endpoint("127.0.0.1", BASE)
    validate_endpoint("0.0.0.0", "https://public.example", True)
    assert main(["--database", str(tmp_path / "missing"), "--public-key",
                 str(tmp_path / "missing.pem"), "--issuer", ISSUER]) == 1
