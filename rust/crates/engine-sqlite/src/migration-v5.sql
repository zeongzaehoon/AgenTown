-- Declared caller metadata is untrusted, never an authenticated identity.
-- Legacy and non-MCP executions have no declared source (no invented identity).
CREATE TABLE execution_sources (
 run_id TEXT PRIMARY KEY REFERENCES executions(run_id) ON DELETE RESTRICT,
 declared_source TEXT NOT NULL CHECK(length(trim(declared_source)) BETWEEN 1 AND 80)
);
CREATE TRIGGER execution_source_immutable BEFORE UPDATE ON execution_sources
BEGIN SELECT RAISE(ABORT, 'immutable declared source'); END;
CREATE TRIGGER execution_source_retained BEFORE DELETE ON execution_sources
BEGIN SELECT RAISE(ABORT, 'retained declared source'); END;
