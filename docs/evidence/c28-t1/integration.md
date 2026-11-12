# C28-T1 integration invocation

Inspected the merged Hook persistence/admission implementation, PyO3 exports,
HTTP preview/execute/history adapters, deterministic acceptance fixtures and
`ai-developer.md` member handoff. No member report paths were supplied in Task
feedback; the available repository handoff was reused. No agents were invoked.
No new provider uncertainty or SDK change required external research.

The HTTP adapter and native exports agree on `preview_hook`,
`start_hook_execution`, and `hook_provenance`, including preview IDs, expected
attempt counts, execution tuples and run-indexed provenance. Admission precedes
provider I/O and uses the existing execution completion boundary. The separate
C28-T2 work-screen implementation remains outside this Task.

Fixed only the two legacy migration fixtures in
`rust/crates/engine-sqlite/src/execution.rs`: remove v8 Hook tables and triggers
attached to retained tables before reconstructing v3/v4 databases. Previously,
the retained Hook objects caused the v8 migration to fail with “table
hook_previews already exists”. Production migrations were unchanged.

Checks during this invocation:

- Python AST parsing passed for `web.py` and `test_hook_execution.py`.
- A direct SQLite check executed all product schema migrations, each corrected
  fixture teardown, and its migrations back to v8. Both v3/v4 paths passed;
  `foreign_key_check` returned no violations. This checks SQL reconstruction,
  not the full Rust rollback/preservation assertions.
- The scoped offline Rust command `cargo test --offline --manifest-path
  rust/Cargo.toml -p llm-engine-sqlite migration_ --lib` could not resolve `uuid`
  from the local dependency cache. No Rust tests passed in this invocation.
  No dependencies were installed or native bindings rebuilt.

Consolidated native/Python checks and browser validation remain pending the
supervisor handoff. Live provider calls were skipped under user policy, not
passed. Provider success remains quality-unverified. This integration report
requests verification and does not complete or approve the Task.
