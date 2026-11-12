"""Explicit, single-workspace authenticated Streamable HTTP entry point."""
import argparse
import ipaddress
import math
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

from fastmcp.server.auth import RemoteAuthProvider
from fastmcp.server.auth.providers.jwt import JWTVerifier
from pydantic import AnyHttpUrl
import uvicorn

from .mcp_server import create_server


class ExpiringJWTVerifier(JWTVerifier):
    """Also require an expiry; tokens without a lifetime are never admitted."""

    async def verify_token(self, token):
        access = await super().verify_token(token)
        if access is None or access.expires_at is None or access.expires_at <= time.time():
            return None
        # FastMCP verifies the signature but does not enforce not-before.
        # Inspect only its already authenticated claims, never unverified input.
        nbf = access.claims.get("nbf")
        if nbf is not None and (isinstance(nbf, bool)
                or not isinstance(nbf, (int, float))
                or not math.isfinite(nbf) or nbf > time.time()):
            return None
        return access


def validate_endpoint(host, base_url, allow_public=False):
    # Literal addresses avoid hostname resolution changes between validation/bind.
    address = ipaddress.ip_address(host)
    url = urlsplit(base_url)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username
            or url.password or url.query or url.fragment or url.path not in {"", "/"}):
        raise ValueError("base URL must be an HTTP(S) origin")
    local_url = url.hostname in {"127.0.0.1", "::1", "localhost"}
    if not allow_public and (not address.is_loopback or not local_url):
        raise ValueError("public exposure requires --allow-public")
    if (not address.is_loopback or not local_url) and url.scheme != "https":
        raise ValueError("public exposure requires an HTTPS base URL")


def create_remote_app(database, *, public_key, issuer, base_url, provider_factory=None):
    if not issuer or not base_url:
        raise ValueError("issuer and base URL are required")
    audience = base_url.rstrip("/") + "/mcp"
    verifier = ExpiringJWTVerifier(public_key=public_key, algorithm="RS256",
        issuer=issuer, audience=audience, required_scopes=["agentown:workspace"])
    auth = RemoteAuthProvider(token_verifier=verifier,
        authorization_servers=[AnyHttpUrl(issuer)], base_url=base_url.rstrip("/"))
    return create_server(database, auth=auth, provider_factory=provider_factory).http_app(
        path="/mcp", transport="streamable-http", stateless_http=True, json_response=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="existing fixed product database")
    parser.add_argument("--public-key", required=True, help="RSA public PEM file, never a private key")
    parser.add_argument("--issuer", required=True, help="trusted OAuth issuer URL")
    parser.add_argument("--base-url", default="http://127.0.0.1:8766")
    parser.add_argument("--host", default="127.0.0.1", help="literal bind address")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--allow-public", action="store_true")
    args = parser.parse_args(argv)
    try:
        validate_endpoint(args.host, args.base_url, args.allow_public)
        issuer = urlsplit(args.issuer)
        if issuer.scheme != "https" or not issuer.hostname or issuer.username or issuer.password:
            raise ValueError("issuer must use HTTPS")
        database = Path(args.database)
        if not database.is_absolute() or not database.is_file():
            raise ValueError("select an existing absolute database path")
        key = Path(args.public_key).read_text(encoding="utf-8")
        if not key.startswith("-----BEGIN PUBLIC KEY-----"):
            raise ValueError("select an RSA public key")
        app = create_remote_app(str(database.resolve()), public_key=key,
            issuer=args.issuer, base_url=args.base_url)
    except (ValueError, OSError):
        print("Error: invalid remote MCP configuration; check database, public key and URLs.", file=sys.stderr)
        return 1
    uvicorn.run(app, host=args.host, port=args.port, proxy_headers=False,
                access_log=False, timeout_graceful_shutdown=10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
