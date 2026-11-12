"""Typed MCP adapter. Rust owns admission, persistence and domain validation."""
import argparse
from pathlib import Path
import sys
from typing import Annotated, Literal
from uuid import UUID

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import BaseModel, ConfigDict, Field

from .execution import configured_provider, finish_text, record
from .providers import runtime_secrets

from . import _native


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Agent(Record):
    id: UUID
    name: str


class Task(Record):
    id: UUID
    title: str
    status: Literal["pending", "in_progress", "blocked", "cancelled"]
    assignees: list[UUID]


class Agents(Record):
    agents: list[Agent]


class Tasks(Record):
    tasks: list[Task]


def agent(row):
    return Agent(id=row[0], name=row[1])


def task(row):
    return Task(id=row[0], title=row[1], status=row[2], assignees=row[3])


class Execution(Record):
    schema_version: Literal[1] = 1
    run_id: UUID
    input: str
    provider: str
    model: str
    deadline_unix_ms: int
    output: str | None
    error: str | None
    quality: Literal["unverified"] = "unverified"


class Skill(Record):
    id: UUID
    name: str
    enabled: bool


class Skills(Record):
    schema_version: Literal[1] = 1
    skills: list[Skill]


class Hook(Record):
    id: UUID
    name: str
    enabled: bool
    target_kind: Literal["agent", "team"]
    target_id: UUID
    event: Literal["task_created", "run_completed", "run_failed"]
    skill_id: UUID


class Hooks(Record):
    schema_version: Literal[1] = 1
    hooks: list[Hook]


class LoopPolicy(Record):
    id: UUID
    name: str
    enabled: bool
    task_id: UUID
    max_iterations: int
    interval_seconds: int


class Loops(Record):
    schema_version: Literal[1] = 1
    loops: list[LoopPolicy]


class LoopPreview(Record):
    schema_version: Literal[1] = 1
    preview_id: str
    policy_id: UUID
    policy_name: str
    policy_enabled: Literal[True]
    task_id: UUID
    agent_id: UUID
    input: str
    max_iterations: int
    interval_seconds: int
    expected_runs: int
    created_at: int


class LoopSession(Record):
    schema_version: Literal[1] = 1
    session_id: UUID
    preview: LoopPreview
    state: Literal["active", "stopped", "restarted", "stale", "failed", "expired", "complete"]
    provider: str
    model: str
    started_at: int
    expires_at: int
    admitted: int
    next_at: int


class LoopAttempt(Record):
    schema_version: Literal[1] = 1
    session_id: UUID
    run_id: UUID
    ordinal: int
    admitted_at: int
    execution: Execution


class LoopInspection(Record):
    schema_version: Literal[1] = 1
    sessions: list[LoopSession]
    attempts: list[LoopAttempt]


class HookProvenance(Record):
    schema_version: Literal[1] = 1
    run_id: UUID
    preview_id: str
    task_id: UUID
    hook_id: UUID
    hook_name: str
    hook_enabled: Literal[True]
    target_kind: Literal["agent"]
    agent_id: UUID
    event: Literal["run_completed", "run_failed"]
    source_run_id: UUID
    source_outcome: Literal["reported_success", "failure"]
    skill_id: UUID
    skill_name: str
    skill_enabled: Literal[True]
    instructions: str
    input: str
    admitted_at: int


class HookPreview(Record):
    schema_version: Literal[1] = 1
    preview_id: str
    task_id: UUID
    hook_id: UUID
    hook_name: str
    hook_enabled: Literal[True]
    target_kind: Literal["agent"]
    agent_id: UUID
    event: Literal["run_completed", "run_failed"]
    source_run_id: UUID
    source_outcome: Literal["reported_success", "failure"]
    skill_id: UUID
    skill_name: str
    skill_enabled: Literal[True]
    instructions: str
    input: str
    expected_runs: int


class SkillPreview(Record):
    schema_version: Literal[1] = 1
    preview_id: str
    task_id: UUID
    skill_id: UUID
    input: str
    expected_runs: int


class SkillProvenance(Record):
    schema_version: Literal[1] = 1
    run_id: UUID
    preview_id: str
    skill_id: UUID
    skill_name: str
    instructions: str
    input: str
    admitted_at: int


class Run(Record):
    id: UUID
    task_id: UUID
    stage: str
    reporting_source: str
    declared_source: str | None = None
    started_at: int
    ended_at: int | None
    state: Literal["active", "finished"]
    outcome: str | None
    participants: list[UUID]
    execution: Execution | None
    skill: SkillProvenance | None = None
    hook: HookProvenance | None = None


class WorkHistory(Record):
    schema_version: Literal[1] = 1
    task: Task
    attempts: list[Run]


class EmployeeCreated(Record):
    schema_version: Literal[1] = 1
    employee: Agent


class WorkSaved(Record):
    schema_version: Literal[1] = 1
    task: Task


def create_server(database: str, *, provider_factory=None, auth=None) -> FastMCP:
    # The client cannot select a different database through tool arguments.
    database = str(Path(database).absolute())
    _native.query_agents(database)  # validate the entire store before serving
    server = FastMCP("AgenTown", version="0.2.0", mask_error_details=True, auth=auth)
    annotations = {"readOnlyHint": True, "destructiveHint": False,
                   "idempotentHint": True, "openWorldHint": False}

    provider_factory = provider_factory or configured_provider
    mutations = {"readOnlyHint": False, "destructiveHint": False,
                 "idempotentHint": False, "openWorldHint": False}
    execution_annotations = {**mutations, "openWorldHint": True}

    def safe_text(*values):
        if any(secret in value for secret in runtime_secrets() for value in values):
            raise ToolError("Remove configured credentials from tool arguments.")

    def query(function, *args):
        try:
            return function(database, *args)
        except (ValueError, OSError, KeyError) as exc:
            # Do not echo database paths, user input or provider exception messages.
            message = str(exc).lower()
            category = next((word for word in ("schema", "invalid", "unknown", "stale",
                "consent", "active", "duplicate", "assigned") if word in message), "storage")
            raise ToolError(f"Operation rejected ({category}); inspect work history and configuration.") from None

    @server.tool(annotations=annotations)
    def list_agents() -> Agents:
        """List registered agents in stable ID order."""
        return Agents(agents=[agent(row) for row in query(_native.query_agents)])

    @server.tool(annotations=annotations)
    def get_agent(agent_id: str) -> Agent:
        """Inspect one agent by its stable UUID."""
        return agent(query(_native.query_agent, agent_id))

    @server.tool(annotations=annotations)
    def list_tasks() -> Tasks:
        """List Tasks with their assigned agent IDs in stable ID order."""
        return Tasks(tasks=[task(row) for row in query(_native.query_tasks)])

    @server.tool(annotations=annotations)
    def get_task(task_id: str) -> Task:
        """Inspect one Task and its assigned agent IDs by stable UUID."""
        return task(query(_native.query_task, task_id))

    @server.tool(annotations=annotations)
    def list_skills_v1() -> Skills:
        """List saved Skill IDs, names and enabled configuration; does not execute."""
        return Skills(skills=[Skill(id=row["id"], name=row["name"], enabled=row["enabled"])
                              for row in query(_native.list_skills)])

    @server.tool(annotations=annotations)
    def list_hooks_v1() -> Hooks:
        """List saved Hook configuration, including disabled Hooks; does not execute."""
        return Hooks(hooks=[Hook(**row) for row in query(_native.list_hooks)])

    @server.tool(annotations=annotations)
    def list_loops_v1() -> Loops:
        """List saved Loop policies, including disabled policies; does not activate them."""
        return Loops(loops=[LoopPolicy(**row) for row in query(_native.list_loops)])

    @server.tool(annotations=annotations)
    def inspect_loop_sessions_v1() -> LoopInspection:
        """Read recorded sessions, immutable previews and linked results without recovery.

        Does not initialize an execution owner, create previews or authorize dispatch.
        Active owners may continue writing between these native read queries.
        """
        sessions = query(_native.loop_sessions)
        session_ids = {row["session_id"] for row in sessions}
        links = [row for row in query(_native.loop_attempts)
                 if row["session_id"] in session_ids]
        attempts = [LoopAttempt(**row, execution=Execution(**record(
            query(_native.show_execution_read_only, row["run_id"]))))
            for row in links]
        return LoopInspection(sessions=[LoopSession(**row) for row in sessions],
                              attempts=attempts)

    @server.tool(annotations=mutations)
    def preview_skill_work_v1(task_id: str, skill_id: str) -> SkillPreview:
        """Preview Rust-composed saved work and one enabled Skill without provider I/O.

        Persists an opaque single-use consent preview. Show input to the user before
        explicitly executing; previewing alone never authorizes provider dispatch.
        """
        safe_text(task_id, skill_id)
        return SkillPreview(**query(_native.preview_skill, task_id, skill_id, runtime_secrets()))

    @server.tool(annotations=execution_annotations)
    async def execute_skill_work_v1(
        task_id: str, preview_id: str,
        provider: Literal["anthropic", "openai", "bedrock", "xai"], model: str,
        declared_source: Annotated[str, Field(min_length=1, max_length=80)],
        expected_runs: Annotated[int, Field(ge=0)],
    ) -> Execution:
        """Explicitly authorize one preview. COSTLY: may charge the configured provider.

        Non-idempotent. Every retry needs a fresh preview and explicit user consent
        to its composed input and expected_runs. Caller metadata is untrusted;
        credentials come only from server configuration. No client instructions.
        """
        safe_text(task_id, preview_id, model, declared_source)
        try:
            adapter = provider_factory(model, provider)
        except Exception:
            raise ToolError("Provider configuration unavailable; configure the server environment.") from None
        row = query(_native.start_skill_execution, task_id, preview_id, provider,
                    model, expected_runs, runtime_secrets(), declared_source)
        try:
            return Execution(**await finish_text(database, row, adapter))
        except Exception:
            raise ToolError("Execution could not be finalized; inspect persisted history before retrying.") from None

    @server.tool(annotations=mutations)
    def preview_hook_work_v1(task_id: str, hook_id: str) -> HookPreview:
        """Preview Rust-composed saved work and one eligible employee Hook against the latest terminal attempt without provider I/O.

        Persists an opaque single-use consent preview. Show input to the user before
        explicitly executing; previewing alone never authorizes provider dispatch.
        """
        safe_text(task_id, hook_id)
        return HookPreview(**query(_native.preview_hook, task_id, hook_id, runtime_secrets()))

    @server.tool(annotations=execution_annotations)
    async def execute_hook_work_v1(
        task_id: str, preview_id: str,
        provider: Literal["anthropic", "openai", "bedrock", "xai"], model: str,
        declared_source: Annotated[str, Field(min_length=1, max_length=80)],
        expected_runs: Annotated[int, Field(ge=0)],
    ) -> Execution:
        """Explicitly authorize one preview. COSTLY: may charge the configured provider.

        Non-idempotent. Every retry needs a fresh preview and explicit user consent
        to its composed input and expected_runs. Caller metadata is untrusted;
        credentials come only from server configuration. No client instructions.
        Does not activate automatic Hook dispatch or Loops.
        """
        safe_text(task_id, preview_id, model, declared_source)
        try:
            adapter = provider_factory(model, provider)
        except Exception:
            raise ToolError("Provider configuration unavailable; configure the server environment.") from None
        row = query(_native.start_hook_execution, task_id, preview_id, provider,
                    model, expected_runs, runtime_secrets(), declared_source)
        try:
            return Execution(**await finish_text(database, row, adapter))
        except Exception:
            raise ToolError("Execution could not be finalized; inspect persisted history before retrying.") from None

    @server.tool(annotations=mutations)
    def create_employee_v1(name: str) -> EmployeeCreated:
        """Create an employee. Repeating this mutation creates another employee."""
        safe_text(name)
        return EmployeeCreated(employee=agent(query(_native.create_agent, name)))

    @server.tool(annotations=mutations)
    def save_text_work_v1(employee_id: str, text: str) -> WorkSaved:
        """Save text and assign one employee atomically; does not execute it."""
        safe_text(employee_id, text)
        return WorkSaved(task=task(query(_native.create_assigned_work, text, employee_id)))

    @server.tool(annotations=execution_annotations)
    async def execute_text_work_v1(
        task_id: str, provider: Literal["anthropic", "openai", "bedrock", "xai"],
        model: str, declared_source: Annotated[str, Field(min_length=1, max_length=80)],
        expected_runs: Annotated[int, Field(ge=0)], resubmission_consent: bool = False,
    ) -> Execution:
        """Explicitly execute saved work. COSTLY: may charge the configured provider.

        Non-idempotent: a retry creates a new Run under the same Task. Read history
        first and supply its attempt count. Every resubmission requires explicit
        user consent. declared_source is untrusted integration metadata, never
        authenticated identity. Credentials come only from server configuration.
        """
        safe_text(task_id, model, declared_source)
        if len(declared_source.encode("utf-8")) > 80:
            raise ToolError("Operation rejected (invalid); declared source must fit 80 UTF-8 bytes.")
        safe_text(query(_native.query_task, task_id)[1])
        try:
            adapter = provider_factory(model, provider)
        except Exception:
            raise ToolError("Provider configuration unavailable; configure the server environment.") from None
        row = query(_native.start_mcp_execution, task_id, provider, model,
                    expected_runs, resubmission_consent, declared_source)
        try:
            return Execution(**await finish_text(database, row, adapter))
        except Exception:
            raise ToolError("Execution could not be finalized; inspect persisted history before retrying.") from None

    @server.tool(annotations={**mutations, "idempotentHint": True})
    def get_work_history_v1(task_id: str) -> WorkHistory:
        """Inspect attempts/results and recover expired leases; quality stays unverified."""
        # Validate the ID through the existing read path, then obtain one atomic
        # snapshot. Rust also finalizes expired leases in this operation.
        task_id = query(_native.query_task, task_id)[0]
        _, tasks, executions = query(_native.history_snapshot)
        # Sources are immutable and retained. Reading after the snapshot supplies
        # metadata for every included Run without adding later attempts to it.
        sources = dict(query(_native.execution_sources))
        provenance = {row["run_id"]: SkillProvenance(**row)
                      for row in query(_native.skill_provenance)}
        hooks = {row["run_id"]: HookProvenance(**row)
                 for row in query(_native.hook_provenance)}
        results = {row[0]: Execution(**record(row)) for row in executions}
        saved = next(((work, runs) for work, runs in tasks if work[0] == task_id), None)
        if saved is None:
            raise ToolError("Operation rejected (unknown); inspect work history.")
        work = task(saved[0])
        attempts = []
        for row in sorted(saved[1], key=lambda row: (row[4], row[0])):
            attempts.append(Run(**dict(zip(("id", "task_id", "stage", "reporting_source",
                "started_at", "ended_at", "state", "outcome", "participants"), row, strict=True)),
                execution=results.get(row[0]), declared_source=sources.get(row[0]),
                skill=provenance.get(row[0]), hook=hooks.get(row[0])))
        return WorkHistory(task=work, attempts=attempts)

    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="Create, execute and inspect AgenTown work through MCP stdio.")
    parser.add_argument("--database", required=True, metavar="PATH",
                        help="existing product SQLite database")
    args = parser.parse_args(argv)
    try:
        server = create_server(args.database)
    except ValueError:
        print("Error: cannot open a valid product database.", file=sys.stderr)
        return 1
    server.run(transport="stdio", show_banner=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
