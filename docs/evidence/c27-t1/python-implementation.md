# C27-T1 Python implementation handoff

This invocation changed the HTTP adapter, deterministic acceptance fixtures and
runnable API documentation only. No other agents were invoked in this workspace.
No real provider requests were made. Real-provider validation is skipped, not
passed. Browser and consolidated verification remain pending.

Local check: `python3 -m py_compile python/src/llm_engine/web.py
python/tests/test_skill_execution.py` passed. The available interpreter lacks
pytest, Starlette, HTTPX and an installed llm_engine module; no fixture execution
is claimed. Stage instructions prohibit installing dependencies or rebuilding
bindings in this isolated worker.

## Native interface for integration

The Python adapter expects these native functions (all durable validation and
composition belong in Rust):

- `preview_skill(database, task_id, skill_id, secrets)` returns a dict
  with schema_version=1, preview_id, task_id, skill_id, input, expected_runs.
- `start_skill_execution(database, task_id, preview_id, provider, model,
  expected_runs, secrets)` returns the existing seven-field execution tuple.
- `skill_provenance(database)` returns immutable provenance dicts keyed by each
  entry’s run_id (including skill_id and instructions). The adapter indexes the
  list for history and selects the admitted Run for the execution response.

`secrets` is a transient tuple of configured secret values, never provenance.
Validation/stale/duplicate failures must raise ValueError or KeyError without
side effects; unavailable storage raises OSError. Python exposes safe messages,
not native error text. Integration reconciled these binding names and fields with the merged Rust
exports. Consolidated native and HTTP fixture execution remains a supervisor gate.

## Deterministic evidence pending execution

`python/tests/test_skill_execution.py` contains real-native HTTP fixtures for:
exact input and zero-call preview; success and provider failure with two persisted
attempts after explicit fresh-preview retry; consumed-preview rejection even if
the caller increments expected_runs; changed enabled state rejection; concurrent
duplicate submission with a blocked provider; restart provenance retention after
Skill editing; configured-secret rejection in legacy work/instructions; persisted
redacted provider output; malformed-preview rejection before native calls.

Run this file with existing web and configuration tests after native integration.
Do not treat this inventory as a passing test log.
