"""Private desktop service adapter. See python/DESKTOP.md for the owner protocol."""

import argparse
import hmac
import json
import re
import socket
import sys
import threading

from starlette.responses import JSONResponse

from . import _native
from .web import ASSETS, LocalBoundary, create_app
from .providers import PROVIDERS

READY_PATH = "/_desktop/ready"
RENDERED_PATH = "/_desktop/rendered"


class DesktopReadiness:
    def __init__(self, app, token, identity):
        self.app = app
        self.authorization = token.encode("ascii")
        self.identity = identity
        self.rendered = False

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == RENDERED_PATH:
            if scope["method"] == "POST":
                self.rendered = True
                response = JSONResponse({"rendered": True})
            elif scope["method"] == "GET":
                response = JSONResponse({"rendered": self.rendered})
            else:
                response = JSONResponse({"error": "Method not allowed."}, 405)
            return await response(scope, receive, send)
        if scope["path"] != READY_PATH:
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        if (scope["method"] != "GET" or
                not hmac.compare_digest(headers.get(b"x-agentown-desktop", b""), self.authorization)):
            response = JSONResponse({"error": "Desktop authentication required."}, 403)
        else:
            response = JSONResponse({"ready": True, "identity": self.identity})
        await response(scope, receive, send)


def create_desktop_app(database, token, identity, *, port, model=None, provider_name="anthropic"):
    app = create_app(database, model, port=port, provider_name=provider_name)
    # Readiness goes through the same Host and response-header boundary as the UI.
    return LocalBoundary(DesktopReadiness(app, token, identity), f"http://127.0.0.1:{port}")


def read_token(stream):
    line = stream.readline(256)
    if not line.endswith("\n"):
        raise ValueError("invalid owner identity")
    try:
        values = json.loads(line)
        token, identity = values["token"], values["identity"]
        if (set(values) != {"token", "identity"} or token == identity or
                not all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
                        for value in (token, identity))):
            raise ValueError("invalid owner identity")
    except (KeyError, TypeError, ValueError):
        raise ValueError("invalid owner identity") from None
    return token, identity


def watch_owner(stream, server):
    # Rust retains the write end for the entire session. EOF also detects a crash.
    # Any further input is an explicit shutdown request; no commands are executed.
    stream.read(1)
    server.should_exit = True


def main(argv=None):
    parser = argparse.ArgumentParser(description="AgenTown desktop-owned loopback service")
    parser.add_argument("--database", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--model")
    parser.add_argument("--provider", default="anthropic", choices=PROVIDERS)
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    try:
        token, identity = read_token(sys.stdin)
        if not (ASSETS / "index.html").is_file():
            print("Desktop resources are missing. Rebuild or reinstall AgenTown.", file=sys.stderr)
            return 2
        # Exercise the real database before advertising readiness, without mutations
        # outside the native product interface. Existing records survive restart.
        _native.history_snapshot(args.database)
    except Exception:
        print("Cannot initialize desktop service. Check application data access and reinstall if needed.", file=sys.stderr)
        return 2

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Never reuse an occupied endpoint, including on Windows.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", args.port))
        listener.listen(128)
        import uvicorn
        config = uvicorn.Config(
            create_desktop_app(args.database, token, identity, port=args.port, model=args.model,
                               provider_name=args.provider),
            host="127.0.0.1", port=args.port, proxy_headers=False, access_log=False,
            timeout_graceful_shutdown=3,
            # Do not allow framework exception logs to echo request credentials.
            log_config={"version": 1, "disable_existing_loggers": False,
                        "handlers": {"discard": {"class": "logging.NullHandler"}},
                        "loggers": {name: {"handlers": ["discard"], "propagate": False}
                                    for name in ("uvicorn", "uvicorn.error", "uvicorn.access")}},
        )
        server = uvicorn.Server(config)
        threading.Thread(target=watch_owner, args=(sys.stdin, server), daemon=True).start()
        server.run(sockets=[listener])
        if not server.started:
            print("Desktop service could not start. Restart AgenTown or reinstall its resources.", file=sys.stderr)
            return 4
        return 0
    except OSError:
        print("Desktop endpoint is unavailable. Close the conflicting application and retry.", file=sys.stderr)
        return 3
    except Exception:
        print("Desktop service stopped unexpectedly. Restart AgenTown or reinstall its resources.", file=sys.stderr)
        return 4
    finally:
        listener.close()


if __name__ == "__main__":
    sys.exit(main())
