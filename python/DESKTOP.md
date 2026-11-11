# Desktop service integration contract (v1)

The shell launches the bundled runtime directly:

```text
<resource-runtime-python> -I -m llm_engine.desktop --database <absolute-database-file> --port <1024..65535>
```

`--model` and `--provider` are optional existing product provider settings. The
shell owns platform directories, endpoint selection, single-instance admission,
process-tree containment, readiness deadline and hard termination. This module
never imports the checkout, `.agents`, `.harness`, Node, or a system Python.
The installed product wheel must include built static assets and native bindings;
the runtime must include all locked product dependencies. The shell supplies the
same stable database path on every launch. Data is never deleted by this adapter.

Immediately after spawning, write one JSON line with two independently random
32-byte lowercase hex strings: `{"token":"<request token>","identity":"<response identity>"}`.
Flush and keep the private stdin pipe open until shutdown. Neither secret appears
in arguments, environment, files or logs. The response identity must differ from
the request token. No other process should inherit the pipe's write end.

Poll `GET http://127.0.0.1:<port>/_desktop/ready` with
`X-AgenTown-Desktop: <request token>`. Require HTTP 200 and JSON
`{"ready":true,"identity":"<response identity>"}`. An occupied listener sees only
the request token and cannot know the independent response identity. Never open
the webview until both fields match. Bound startup and terminate on failure.
The readiness endpoint runs inside the exact Host boundary; normal same-origin
JSON mutation protections and no-store/security headers remain intact. Ordinary
`agentown-web` does not expose desktop readiness.

The service validates database access and bundled index availability before
listening. It exclusively binds IPv4 `127.0.0.1`, with no endpoint reuse and no
proxy-header trust. Exit codes: 2 initialization/resources/handshake failure,
3 occupied/unavailable endpoint, 4 unexpected service failure, 0 normal shutdown.
Errors give fixed actionable messages and omit raw exceptions and identities.
Framework request/error logging is suppressed to avoid credential disclosure.
If the server returns without completing startup, it also emits an actionable
restart/reinstall message and exits with code 4; the listener is always closed.

Close stdin (EOF), or write one additional byte, to request shutdown. EOF also
handles owner death. Uvicorn allows three seconds for in-flight requests. The shell
must impose its own outer shutdown deadline (five seconds), then kill
and reap its contained process tree. OS signals may also request Uvicorn shutdown.
Unexpected exits must be surfaced by the shell; do not silently restart or replay
work. An interrupted provider run retains existing product recovery semantics.

Focused tests: `tests/test_desktop.py` covers private identity, wrong Host/origin,
redaction, owner EOF and persisted records with a new identity. Installed tests in
`tests/test_installed_desktop.py` exercise actual packaged service startup,
authenticated readiness, built React asset responses, endpoint conflict, explicit
shutdown-byte and EOF shutdown, and restart persistence. Missing packaged assets
are rejected before database initialization. These installed-wheel checks do not
establish standalone-runtime relocation or a successful Tauri webview launch;
the assembled application's validation must cover those separately.
Rust lifecycle tests own duplicate application admission, wrong readiness identity,
readiness deadline, unexpected death and forced descendant cleanup. Real provider
calls remain skipped.
