CREATE TABLE executions (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
 input TEXT NOT NULL CHECK(length(trim(input)) > 0),
 provider TEXT NOT NULL CHECK(length(trim(provider)) > 0),
 model TEXT NOT NULL CHECK(length(trim(model)) > 0),
 deadline INTEGER NOT NULL,
 output TEXT,
 error TEXT,
 CHECK(output IS NULL OR (length(trim(output)) > 0 AND error IS NULL))
);
CREATE TRIGGER execution_immutable BEFORE UPDATE ON executions
WHEN OLD.run_id != NEW.run_id OR OLD.input != NEW.input OR OLD.provider != NEW.provider
 OR OLD.model != NEW.model OR OLD.deadline != NEW.deadline
 OR OLD.output IS NOT NULL OR OLD.error IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'immutable execution'); END;
CREATE TRIGGER execution_retained BEFORE DELETE ON executions
BEGIN SELECT RAISE(ABORT, 'retained execution'); END;
