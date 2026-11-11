# AgenTown Python package

Python 3.13 API, CLI, MCP server and local web server backed by the shared Rust Core. The installed wheel includes the compiled bindings and React production assets.

From the repository root, build the frontend with `npm --prefix frontend ci` and `npm --prefix frontend run build`, then install with `uv sync --directory python --locked`. Run `uv run --directory python --locked agentown-web --help`.

Product documentation is in the repository README and docs directory. Source distributions must include the sibling Rust workspace; wheel users do not need Node or Rust.
