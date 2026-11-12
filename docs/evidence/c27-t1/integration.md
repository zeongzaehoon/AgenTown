# C27-T1 integration

Read both implementation reports from run `1794457391-196783000`, workers 1
and 2, and inspected the actual merged Rust bindings, SQLite admission and
migration, Python HTTP routes, provider completion adapter and API fixtures.
No agents were invoked during integration.

Reconciled the Python adapter with the exported `preview_skill` and
`skill_provenance` bindings. History indexes immutable provenance by Run ID;
the explicit execution response selects the newly admitted Run. Updated the
malformed-request monkeypatch and Python handoff contract to use those names.
Rust admission continues to return the existing seven-field execution tuple,
which is forwarded unchanged to `finish_text`.

Checks in this invocation:

- Python syntax compilation of web.py and test_skill_execution.py passed.
- Extracted actual HTTP route functions passed a dependency-free smoke check
  with stub native/provider objects: preview argument forwarding without provider
  calls, exact admission tuple forwarding, execution response provenance and
  history provenance. This does not establish native or HTTP fixture success.
- `cargo fmt --check` passed.

The available interpreter lacks pytest, Starlette, HTTPX and installed product
bindings. No dependency installation, native rebuild or full suite was performed
in this integration stage. Consolidated Rust/native/HTTP checks and browser
validation remain pending supervisor verification. Real provider calls were
skipped, not passed. Existing member fixture inventories are pending execution,
not acceptance evidence.

## Integration repair after migration verification failure

This invocation read the existing worker-1 and worker-2 reports from run
`1794457391-196783000` and inspected the merged HTTP/native argument and return
contracts, SQLite admission, and documented HTTP steps. No agents were invoked.

The two legacy migration fixtures in `engine-sqlite/src/execution.rs` reconstructed
v3/v4 from a current database but left v7 Skill tables and triggers behind.
Updated only their teardown SQL to remove v7 provenance/previews and triggers
attached to the older tasks/assignments/skills tables before dropping v6 tables.
Production migration and acceptance assertions remain unchanged.

Checks performed in this invocation:

- `cargo fmt --check` from `rust/` passed.
- Dependency-free Python SQLite replay using the actual fixture teardown SQL and
  repository schema/migrations passed for both v3 and v4 with foreign keys enabled.
  The v3 replay also verified injected DDL conflict rollback before successful
  upgrade. This checks SQL behavior, not compiled Rust behavior.
- `cargo test --offline -p llm-engine-sqlite migration_` could not start because
  the available offline dependency cache lacks `uuid`. No Rust test pass claimed.

No full suites, native rebuild, browser validation or real provider calls ran.
Consolidated verification remains pending; real provider validation is skipped.
