-- A preview is a bounded single-Skill consent snapshot, never an execution.
CREATE TABLE skill_previews (
 id TEXT PRIMARY KEY NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 skill_id TEXT NOT NULL REFERENCES skills(id),
 agent_id TEXT NOT NULL REFERENCES agents(id),
 work_text TEXT NOT NULL,
 skill_name TEXT NOT NULL,
 instructions TEXT NOT NULL,
 input TEXT NOT NULL,
 expected_runs INTEGER NOT NULL CHECK(expected_runs >= 0),
 created_at INTEGER NOT NULL,
 invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1)),
 consumed_run TEXT UNIQUE REFERENCES executions(run_id)
);
CREATE TABLE skill_provenance (
 run_id TEXT PRIMARY KEY REFERENCES executions(run_id),
 preview_id TEXT NOT NULL UNIQUE REFERENCES skill_previews(id),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 skill_id TEXT NOT NULL REFERENCES skills(id),
 skill_name TEXT NOT NULL,
 instructions TEXT NOT NULL,
 input TEXT NOT NULL,
 admitted_at INTEGER NOT NULL
);
CREATE TRIGGER skill_provenance_immutable BEFORE UPDATE ON skill_provenance
BEGIN SELECT RAISE(ABORT, 'immutable skill provenance'); END;
CREATE TRIGGER skill_provenance_retained BEFORE DELETE ON skill_provenance
BEGIN SELECT RAISE(ABORT, 'retained skill provenance'); END;
-- Invalidate even when a configuration is changed and subsequently restored.
CREATE TRIGGER skill_preview_configuration AFTER UPDATE ON skills
BEGIN UPDATE skill_previews SET invalidated=1 WHERE skill_id=NEW.id AND consumed_run IS NULL; END;
CREATE TRIGGER skill_preview_work AFTER UPDATE OF title ON tasks WHEN OLD.title != NEW.title
BEGIN UPDATE skill_previews SET invalidated=1 WHERE task_id=NEW.id AND consumed_run IS NULL; END;
CREATE TRIGGER skill_preview_assignment_added AFTER INSERT ON assignments
BEGIN UPDATE skill_previews SET invalidated=1 WHERE task_id=NEW.task_id AND consumed_run IS NULL; END;
CREATE TRIGGER skill_preview_assignment_removed AFTER DELETE ON assignments
BEGIN UPDATE skill_previews SET invalidated=1 WHERE task_id=OLD.task_id AND consumed_run IS NULL; END;
