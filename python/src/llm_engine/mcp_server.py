"""Read-only MCP interface. Storage and domain validation remain in Rust."""
import argparse
from pathlib import Path
import sys
from typing import Literal
from uuid import UUID

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import BaseModel, ConfigDict

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


def create_server(database: str) -> FastMCP:
    # Resolve once; every tool opens this same path read-only and sees fresh commits.
    database = str(Path(database).absolute())
    _native.query_agents(database)  # validate the entire store before serving
    server = FastMCP("AgenTown", version="0.1.0", mask_error_details=True)
    annotations = {"readOnlyHint": True, "destructiveHint": False,
                   "idempotentHint": True, "openWorldHint": False}

    def query(function, *args):
        try:
            return function(database, *args)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc

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

    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="Inspect AgenTown through MCP stdio.")
    parser.add_argument("--database", required=True, metavar="PATH",
                        help="existing product SQLite database (read-only)")
    args = parser.parse_args(argv)
    try:
        server = create_server(args.database)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    server.run(transport="stdio", show_banner=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
