"""Loopback presentation adapter. Rust owns all durable state and admission.

Manual execution stays in its HTTP request. Loop workers perform provider I/O
only after Rust admission; they never resume or retry after service restart.
"""
import argparse
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path

from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route, Mount
from starlette.staticfiles import StaticFiles

from . import _native
from .execution import configured_provider, finish_text, record
from .providers import PROVIDERS, runtime_secrets, redact

ASSETS = Path(__file__).with_name("static")


class RequestTooLarge(ValueError):
    pass


class LocalBoundary:
    def __init__(self, app, origin):
        self.app, self.origin = app, origin
        self.host = origin.removeprefix("http://")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        if headers.get(b"host", b"").decode() != self.host:
            return await JSONResponse({"error": "Open the documented loopback URL."}, 403)(scope, receive, send)
        if scope["method"] not in ("GET", "HEAD") and (
            headers.get(b"origin", b"").decode() != self.origin
            or headers.get(b"content-type", b"").decode().split(";")[0] != "application/json"
            or headers.get(b"sec-fetch-site", b"same-origin") != b"same-origin"
        ):
            return await JSONResponse({"error": "Same-origin JSON requests required."}, 403)(scope, receive, send)

        async def secured(message):
            if message["type"] == "http.response.start":
                message["headers"] += [
                    (b"content-security-policy", b"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"cache-control", b"no-store"),
                ]
            await send(message)
        await self.app(scope, receive, secured)


def create_app(database, model=None, *, port=8765, provider=None, provider_name="anthropic", execution_port=None):
    database = str(database)
    # Injection is for tests only. The CLI uses the selected configured provider.
    configuration = None
    if provider is None:
        try:
            provider = configured_provider(model, provider_name)
        except ValueError as exc:
            configuration = str(exc) + " Then restart this server."
    secrets = runtime_secrets()
    from .loop_execution import LoopControlError, LoopService
    loops = LoopService(database, provider, model)
    from .connection_diagnostic import ConnectionDiagnostic
    diagnostic = ConnectionDiagnostic(database)
    from .application.inspect_selected_work import InspectSelectedWork
    inspect_selected_work = InspectSelectedWork(diagnostic)
    from .application.execute_selected_work import ExecuteSelectedWork, SelectedWorkExecutionRequest
    from .local_mcp_execution import LocalMcpExecution
    local_execution = execution_port if execution_port is not None else LocalMcpExecution(
        database, provider_name, model, configured=configuration is None)
    execute_selected_work = ExecuteSelectedWork(local_execution)

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await diagnostic.close()
            if execution_port is None:
                await local_execution.close()
            await loops.close()

    def response(value, status=200):
        # Never echo the configured credential, even through legacy stored text.
        def redact_value(item):
            if isinstance(item, str):
                return redact(item, secrets)
            if isinstance(item, list):
                return [redact_value(entry) for entry in item]
            if isinstance(item, dict):
                return {key: redact_value(entry) for key, entry in item.items()}
            return item
        return JSONResponse(redact_value(value), status)

    async def body(request):
        chunks = bytearray()
        async for chunk in request.stream():
            chunks.extend(chunk)
            if len(chunks) > 120_000:
                raise RequestTooLarge("oversize")
        data = json.loads(chunks)
        def contains_secret(item):
            if isinstance(item, str):
                return any(secret in item for secret in secrets)
            if isinstance(item, dict):
                return any(contains_secret(entry) for entry in item.values())
            if isinstance(item, list):
                return any(contains_secret(entry) for entry in item)
            return False
        if not isinstance(data, dict) or contains_secret(data):
            raise ValueError("invalid body")
        return data

    async def home(request):
        if not (ASSETS / "index.html").is_file():
            return JSONResponse({"error": "Frontend assets are missing. Run npm ci and npm run build before the native build, then restart."}, 503)
        return FileResponse(ASSETS / "index.html")

    async def connections(request):
        from .connections import connection_setup
        return response(connection_setup(database))

    async def connection_inspect_work(request):
        try:
            data = await body(request)
            if set(data) != {"task_id"}:
                raise ValueError("Only task_id is accepted")
            return response(await inspect_selected_work.execute(data["task_id"]))
        except RequestTooLarge:
            return response({"error": "Inspection request exceeds 120,000 bytes."}, 413)
        except (ValueError, TypeError, UnicodeError):
            return response({"error": "Send only task_id as a canonical Task UUID."}, 400)

    async def connection_execute_work(request):
        try:
            data = await body(request)
            if set(data) != {"task_id", "expected_runs", "resubmission_consent"}:
                raise ValueError("Unexpected execution fields")
            selected = SelectedWorkExecutionRequest(**data)
        except RequestTooLarge:
            return response({"error": "Execution request exceeds 120,000 bytes."}, 413)
        except (ValueError, TypeError, UnicodeError):
            return response({"error": "Send canonical task_id, nonnegative integer expected_runs and boolean resubmission_consent only."}, 400)
        return response(await execute_selected_work.execute(selected))

    async def connection_shared_data(request):
        return await connection_diagnostic(request, shared_data=True)

    async def connection_diagnostic(request, shared_data=False):
        try:
            if await body(request) != {}:
                raise ValueError("empty body required")
        except RequestTooLarge:
            return response({"error": "Diagnostic request exceeds 120,000 bytes."}, 413)
        except (ValueError, UnicodeError):
            return response({"error": "Send an empty JSON object; the installed command and database are fixed."}, 400)
        return response(await diagnostic.run_shared_data() if shared_data else await diagnostic.run())

    async def state(request):
        try:
            agents, tasks, executions = _native.history_snapshot(database)
            # Read after recovery so every included Run can have caller metadata.
            sources = dict(_native.execution_sources(database))
            results = {row[0]: record(row) for row in executions}
            skill_provenance = {item["run_id"]: item for item in _native.skill_provenance(database)}
            hook_provenance = {item["run_id"]: item for item in _native.hook_provenance(database)}
            employees = [dict(zip(("id", "name"), a)) for a in agents]
            work = []
            for task, runs in tasks:
                item = dict(zip(("id", "input", "status", "assignees"), task))
                attempts = []
                for run in runs:
                    attempt = {"id": run[0], "state": run[6], "outcome": run[7], "started": run[4], "ended": run[5], "participants": run[8], "declared_source": sources.get(run[0])}
                    # CLI reporters may use the same stage without an execution.
                    if run[0] in results:
                        attempt.update(results[run[0]])
                        provenance = skill_provenance.get(run[0])
                        if provenance is not None:
                            attempt["skill"] = provenance
                        hook = hook_provenance.get(run[0])
                        if hook is not None:
                            attempt["hook"] = hook
                    attempts.append(attempt)
                item["attempts"] = sorted(attempts, key=lambda a: (a["started"], a["id"]))
                work.append(item)
            return response({"employees": employees, "work": work, "configuration": configuration,
                             "provider": provider.name if provider else provider_name, "model": model})
        except (ValueError, OSError):
            return response({"error": "Cannot read work history. Check the database path, permissions and compatibility, then restart."}, 503)

    async def employee(request):
        try:
            data = await body(request)
            name = data["name"]
            if not isinstance(name, str) or len(name) > 200:
                raise ValueError("name")
            row = _native.create_agent(database, name)
            return response({"id": row[0]}, 201)
        except (ValueError, KeyError, TypeError):
            return response({"error": "Employee could not be saved. Enter a name (1–200 characters) and check database access."}, 400)

    def team_record(row):
        return dict(zip(("id", "name", "members"), row))

    async def teams(request):
        if request.method == "GET":
            try:
                return response({"teams": [team_record(row) for row in _native.list_teams(database)]})
            except (ValueError, OSError):
                return response({"error": "Cannot read teams. Check database access and compatibility."}, 503)
        try:
            data = await body(request)
            name = data["name"]
            if not isinstance(name, str) or not 1 <= len(name) <= 200:
                raise ValueError("name")
            return response(team_record(_native.create_team(database, name)), 201)
        except RequestTooLarge:
            return response({"error": "Team request exceeds 120,000 bytes."}, 413)
        except (ValueError, KeyError, TypeError, UnicodeError):
            return response({"error": "Team could not be saved. Enter a nonblank name (1–200 characters) and check database access."}, 400)
        except OSError:
            return response({"error": "Team could not be saved. Check database access."}, 503)

    async def team_members(request):
        try:
            data = await body(request)
            members = data["members"]
            if (not isinstance(members, list) or not 1 <= len(members) <= 100
                    or any(not isinstance(member, str) or not 1 <= len(member) <= 100 for member in members)
                    or len(request.path_params["team"]) > 100):
                raise ValueError("members")
            # Rust validates identity, duplicates and existence in one transaction.
            row = _native.add_team_members(database, request.path_params["team"], members)
            return response(team_record(row))
        except RequestTooLarge:
            return response({"error": "Team request exceeds 120,000 bytes."}, 413)
        except (ValueError, KeyError, TypeError, UnicodeError):
            return response({"error": "Members could not be added. Select an existing team and 1–100 distinct existing employee IDs, excluding current members. Check database access."}, 400)
        except OSError:
            return response({"error": "Members could not be added. Check database access."}, 503)

    async def work(request):
        try:
            data = await body(request)
            row = _native.create_assigned_work(database, data["input"], data["employee"])
            return response({"id": row[0]}, 201)
        except RequestTooLarge:
            return response({"code": "request_too_large", "error": "The serialized request exceeds 120,000 bytes after text escaping. Shorten it or split it into separate requests; your draft is unchanged."}, 413)
        except ValueError as error:
            # Only classify the native validation message; never expose raw errors.
            if str(error) == "provide work text of 1 to 100000 UTF-8 bytes":
                return response({"code": "invalid_work_text", "error": "Enter nonblank text of at most 100,000 UTF-8 bytes. Shorten or split oversized text; your draft is unchanged."}, 400)
            return response({"error": "Work could not be saved. Check the selected employee and database path, permissions and compatibility. Your draft is unchanged."}, 400)
        except (KeyError, TypeError, UnicodeError):
            return response({"error": "Work could not be saved. Select an existing employee and provide valid text. Your draft is unchanged."}, 400)
        except OSError:
            return response({"error": "Work could not be saved. Check database access. Your draft is unchanged."}, 503)

    async def skill_preview(request):
        try:
            data = await body(request)
            if (data.keys() != {"skill_id"} or type(data["skill_id"]) is not str
                    or not 1 <= len(data["skill_id"]) <= 100):
                raise ValueError("skill")
            # Rust reads saved work and enabled instructions, rejects secrets before
            # persistence, and owns composition. No provider/configuration required.
            return response(_native.preview_skill(
                database, request.path_params["task"], data["skill_id"], runtime_secrets()))
        except RequestTooLarge:
            return response({"error": "Preview request exceeds 120,000 bytes."}, 413)
        except (ValueError, KeyError, TypeError, OverflowError, UnicodeError):
            return response({"error": "Preview unavailable. Select saved work with one employee and one enabled Skill. Remove configured credentials from work and instructions."}, 409)
        except OSError:
            return response({"error": "Preview storage unavailable. Check database access and compatibility."}, 503)

    async def hook_preview(request):
        try:
            data = await body(request)
            if (data.keys() != {"hook_id"} or type(data["hook_id"]) is not str
                    or not 1 <= len(data["hook_id"]) <= 100):
                raise ValueError("hook")
            return response(_native.preview_hook(
                database, request.path_params["task"], data["hook_id"], runtime_secrets()))
        except RequestTooLarge:
            return response({"error": "Preview request exceeds 120,000 bytes."}, 413)
        except (ValueError, KeyError, TypeError, OverflowError, UnicodeError):
            return response({"error": "Hook preview unavailable. Select an enabled employee Hook and Skill matching the latest saved terminal attempt and assigned employee. Team targets and task-created dispatch are unsupported. Remove configured credentials from work and instructions."}, 409)
        except OSError:
            return response({"error": "Preview storage unavailable. Check database access and compatibility."}, 503)

    async def execute(request):
        if configuration:
            return response({"error": configuration}, 409)
        try:
            data = await body(request)
            count = data["expected_runs"]
            if type(count) is not int or count < 0:
                raise ValueError("count")
            if "hook_preview_id" in data:
                if (data.keys() != {"expected_runs", "hook_preview_id"}
                        or type(data["hook_preview_id"]) is not str
                        or not 1 <= len(data["hook_preview_id"]) <= 100):
                    raise ValueError("hook preview")
                row = _native.start_hook_execution(
                    database, request.path_params["task"], data["hook_preview_id"],
                    provider.name, model, count, runtime_secrets())
            elif "preview_id" in data:
                if (data.keys() != {"expected_runs", "preview_id"}
                        or type(data["preview_id"]) is not str
                        or not 1 <= len(data["preview_id"]) <= 100):
                    raise ValueError("preview")
                row = _native.start_skill_execution(
                    database, request.path_params["task"], data["preview_id"],
                    provider.name, model, count, runtime_secrets())
            else:
                if data.keys() != {"expected_runs"}:
                    raise ValueError("fields")
                row = _native.start_web_execution(database, request.path_params["task"], provider.name, model, count)
        except (ValueError, KeyError, TypeError, OverflowError, UnicodeError):
            return response({"error": "Execution was not started. Refresh history: work may already be running or changed. Select work with one employee and retry explicitly."}, 409)
        except OSError:
            return response({"error": "Execution storage unavailable. Refresh history before deciding to retry."}, 503)
        try:
            result = await finish_text(database, row, provider)
            if "preview_id" in data:
                result["skill"] = next(item for item in _native.skill_provenance(database)
                                       if item["run_id"] == row[0])
            if "hook_preview_id" in data:
                result["hook"] = next((item for item in _native.hook_provenance(database)
                                       if item["run_id"] == row[0]), None)
                if result["hook"] is None:
                    raise ValueError("missing Hook provenance")
            return response(result)
        except (ValueError, OSError):
            return response({"error": "The response could not be saved or the attempt expired. Refresh history before deciding to retry."}, 409)

    async def loop_api(request):
        try:
            action = request.path_params.get("action")
            if request.method == "GET":
                return response(loops.inspect())
            data = await body(request)
            if action == "preview":
                if data.keys() != {"policy_id"} or type(data["policy_id"]) is not str:
                    raise ValueError("policy")
                return response(_native.preview_loop(database, data["policy_id"], runtime_secrets()))
            if action == "start":
                if configuration or provider is None or not model or not model.strip():
                    return response({"error": configuration or "Configure a provider and explicit model before activation."}, 409)
                if (data.keys() != {"preview_id", "expected_runs"}
                        or type(data["preview_id"]) is not str
                        or type(data["expected_runs"]) is not int or data["expected_runs"] < 0):
                    raise ValueError("start")
                return response(loops.start(data["preview_id"], data["expected_runs"]), 201)
            if action == "stop" and data.keys() == {"session_id"} and type(data["session_id"]) is str:
                session = loops.stop(data["session_id"])
                return response({**session, "cancellation": "Local cancellation requested; remote completion may remain unknown."})
            raise ValueError("action")
        except LoopControlError as exc:
            return response({'error': str(exc), 'control': exc.control},
                            503 if exc.control['state'] == 'storage_failure' else 409)
        except RequestTooLarge:
            return response({"error": "Loop request exceeds 120,000 bytes."}, 413)
        except (ValueError, KeyError, TypeError, OverflowError, UnicodeError):
            return response({"error": "Loop request rejected. Refresh sessions and explicitly preview/start again; check saved work, enabled policy and request fields."}, 409)
        except OSError:
            return response({"error": "Loop storage unavailable. Check database access before explicitly retrying.",
                             "control": {"state": "storage_failure", "can_control": False,
                                         "message": "Check database and lock-file access before explicitly retrying."}}, 503)

    from .configuration import routes as configuration_routes

    app = Starlette(lifespan=lifespan, routes=configuration_routes(database, body, response) + [Route("/", home), Route("/api/state", state, methods=["POST"]),
        Route("/api/loops/v1", loop_api, methods=["GET"]),
        Route("/api/loops/v1/{action}", loop_api, methods=["POST"]),
        Route("/api/connections/v1", connections, methods=["POST"]),
        Route("/api/connections/v1/execute-work", connection_execute_work, methods=["POST"]),
        Route("/api/connections/v1/inspect-work", connection_inspect_work, methods=["POST"]),
        Route("/api/connections/v1/shared-data", connection_shared_data, methods=["POST"]),
        Route("/api/connections/v1/diagnostic", connection_diagnostic, methods=["POST"]),
        Route("/api/employees", employee, methods=["POST"]),
        Route("/api/teams", teams, methods=["GET", "POST"]),
        Route("/api/teams/{team}/members", team_members, methods=["POST"]),
        Route("/api/work", work, methods=["POST"]),
        Route("/api/work/{task}/hook-preview", hook_preview, methods=["POST"]),
        Route("/api/work/{task}/skill-preview", skill_preview, methods=["POST"]),
        Route("/api/work/{task}/execute", execute, methods=["POST"]),
        Mount("/static", StaticFiles(directory=ASSETS, check_dir=False))])
    return LocalBoundary(app, f"http://127.0.0.1:{port}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Open the local AgenTown employee and text-work screen.")
    parser.add_argument("--database", required=True, help="explicit SQLite file; parent must exist")
    parser.add_argument("--model", help="Provider model ID or Bedrock inference profile ID")
    parser.add_argument("--provider", choices=PROVIDERS, default="anthropic")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    import uvicorn
    print(f"Open AgenTown at http://127.0.0.1:{args.port} — results remain unverified.")
    uvicorn.run(create_app(args.database, args.model, port=args.port, provider_name=args.provider), host="127.0.0.1",
                port=args.port, proxy_headers=False, access_log=False, timeout_graceful_shutdown=70)


if __name__ == "__main__":
    main()
