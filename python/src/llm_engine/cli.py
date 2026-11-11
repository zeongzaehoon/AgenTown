"""Argument parsing and presentation only; Rust validates and persists commands."""
import argparse
import json
import sys

from . import _native
from .providers import PROVIDERS, runtime_secrets


def parser():
    root = argparse.ArgumentParser(
        description="AgenTown — create agents and teams and assign persistent Tasks.")
    root.add_argument("--database", required=True, metavar="PATH",
                      help="product SQLite database; parent directory must exist")
    root.add_argument("--json", action="store_true", help="print JSON for scripts")
    entities = root.add_subparsers(dest="entity", required=True)
    for entity in ("agent", "task", "team"):
        actions = entities.add_parser(entity, help=f"manage {entity}s").add_subparsers(
            dest="action", required=True)
        create = actions.add_parser("create", help=f"create a {entity}")
        create.add_argument("title" if entity == "task" else "name")
        actions.add_parser("list", help=f"list {entity}s in ID order")
        if entity == "task":
            show = actions.add_parser("show", help="show a Task and its assignees")
            show.add_argument("task_id")
            assign = actions.add_parser(
                "assign", help="assign agents atomically; duplicates are errors",
                description="Assign agents atomically; duplicates are errors and roll back the batch.")
            assign.add_argument("task_id")
            assign.add_argument("agent_ids", nargs="+", help="one or more agent IDs")
        if entity == "team":
            show = actions.add_parser("show", help="show a team and its members")
            show.add_argument("team_id")
            add = actions.add_parser("add-members", help="add agents atomically",
                description="Add one or more existing agents atomically; duplicate membership rolls back the batch.")
            add.add_argument("team_id")
            add.add_argument("agent_ids", nargs="+", help="one or more agent IDs")
            assign = actions.add_parser("assign", help="copy current members to a Task",
                description="Copy current members to a Task atomically. Empty teams or already assigned members reject the whole batch. Later membership changes leave earlier assignments unchanged.")
            assign.add_argument("team_id")
            assign.add_argument("task_id")
    notice = "Recorded attempts only: commands do not execute agents, verify results or complete Tasks."
    runs = entities.add_parser("run", help="record attempts and inspect retry history",
                               description=notice).add_subparsers(dest="action", required=True)
    start = runs.add_parser("start", help="record an active attempt", description=notice)
    start.add_argument("task_id")
    start.add_argument("--stage", required=True, help="nonempty stage being reported")
    start.add_argument("--reporting-source", required=True, help="explicit reporter label; not authenticated")
    start.add_argument("--participants", nargs="+", required=True, help="selected current Task assignee IDs")
    finish = runs.add_parser("finish", help="record a terminal outcome", description=notice)
    finish.add_argument("run_id")
    finish.add_argument("--outcome", required=True,
                        choices=("reported_success", "failure", "interruption"))
    listing = runs.add_parser("list", help="list a Task's attempts in ID order", description=notice)
    listing.add_argument("task_id")
    show = runs.add_parser("show", help="show a recorded attempt", description=notice)
    show.add_argument("run_id")
    work = entities.add_parser("work", help="execute text work; results remain unverified").add_subparsers(dest="action", required=True)
    submit = work.add_parser("execute", help="execute once; repeating explicitly creates a new Run")
    submit.add_argument("task_id")
    submit.add_argument("--agent", required=True, help="one existing Task assignee")
    submit.add_argument("--input-file", required=True, help="UTF-8 text file")
    submit.add_argument("--model", required=True, help="explicit provider model ID or Bedrock inference profile ID")
    submit.add_argument("--provider", choices=PROVIDERS, default="anthropic")
    inspect = work.add_parser("show", help="inspect result and recover expired attempt")
    inspect.add_argument("run_id")
    work.add_parser("recover", help="interrupt expired attempts without resending")
    return root


def execute(args):
    if args.entity == "work":
        import asyncio
        from pathlib import Path
        from .execution import configured_provider, execute_text, record
        if args.action == "recover":
            _native.recover_executions(args.database)
            return {"recovery": "expired attempts interrupted; no work resent"}
        if args.action == "show":
            result = record(_native.show_execution(args.database, args.run_id))
        else:
            provider = configured_provider(args.model, args.provider)
            text = Path(args.input_file).read_text(encoding="utf-8")
            if any(secret in text or secret in args.model for secret in runtime_secrets()):
                raise ValueError("Remove configured credentials from the input and model.")
            result = asyncio.run(execute_text(args.database, args.task_id, args.agent,
                                             text, args.model, provider))
        result["run"] = dict(zip(("id", "task_id", "stage", "reporting_source", "started_at_unix_ms",
                                 "ended_at_unix_ms", "state", "outcome", "participants"),
                                _native.show_run(args.database, result["run_id"]), strict=True))
        return result
    if args.entity == "run":
        keys = ("id", "task_id", "stage", "reporting_source", "started_at_unix_ms",
                "ended_at_unix_ms", "state", "outcome", "participants")
        if args.action == "start":
            result = _native.start_run(args.database, args.task_id, args.stage,
                                       args.reporting_source, args.participants)
        elif args.action == "finish":
            result = _native.finish_run(args.database, args.run_id, args.outcome)
        elif args.action == "list":
            result = _native.list_runs(args.database, args.task_id)
        else:
            result = _native.show_run(args.database, args.run_id)
    elif args.entity == "agent":
        keys = ("id", "name")
        result = (_native.create_agent(args.database, args.name) if args.action == "create"
                  else _native.list_agents(args.database))
    elif args.entity == "team":
        keys = ("id", "name", "members")
        if args.action == "create":
            result = _native.create_team(args.database, args.name)
        elif args.action == "list":
            result = _native.list_teams(args.database)
        elif args.action == "show":
            result = _native.show_team(args.database, args.team_id)
        elif args.action == "add-members":
            result = _native.add_team_members(args.database, args.team_id, args.agent_ids)
        else:
            keys = ("id", "title", "status", "assignees")
            result = _native.assign_team(args.database, args.team_id, args.task_id)
    else:
        keys = ("id", "title", "status", "assignees")
        if args.action == "create":
            result = _native.create_task(args.database, args.title)
        elif args.action == "list":
            result = _native.list_tasks(args.database)
        elif args.action == "show":
            result = _native.show_task(args.database, args.task_id)
        else:
            result = _native.assign_task(args.database, args.task_id, args.agent_ids)
    if args.action == "list":
        return [dict(zip(keys, row, strict=True)) for row in result]
    return dict(zip(keys, result, strict=True))


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        result = execute(args)
    except (ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    if args.entity == "work":
        print(json.dumps(result, ensure_ascii=False, indent=None if args.json else 2))
        return 1 if result.get("error") else 0
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        rows = result if isinstance(result, list) else [result]
        if not rows:
            print(f"No {args.entity}s yet.")
        for row in rows:
            if args.entity == "run":
                print(f"{row['id']}  Recorded attempt: {row['stage']}")
                print(f"  Task: {row['task_id']}")
                print(f"  State: {row['state']}; outcome: {row['outcome'] or 'not reported'}")
                print(f"  Reporting source: {row['reporting_source']}")
                print(f"  Participants: {', '.join(row['participants'])}")
                print(f"  Started (UTC Unix ms): {row['started_at_unix_ms']}")
                print(f"  Ended (UTC Unix ms): {row['ended_at_unix_ms'] if row['ended_at_unix_ms'] is not None else 'not finished'}")
                continue
            print(f"{row['id']}  {row.get('name', row.get('title'))}")
            if "members" in row:
                print(f"  Members: {', '.join(row['members']) or 'none'}")
            if "status" in row:
                print(f"  Status: {row['status']}")
                print(f"  Assignees: {', '.join(row['assignees']) or 'none'}")
    return 0
