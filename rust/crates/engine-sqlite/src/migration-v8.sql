-- A preview is a bounded employee-Hook consent snapshot, never an execution.
CREATE TABLE hook_previews (
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
CREATE TABLE hook_provenance (
 run_id TEXT PRIMARY KEY REFERENCES executions(run_id),
 preview_id TEXT NOT NULL UNIQUE REFERENCES hook_previews(id),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 skill_id TEXT NOT NULL REFERENCES skills(id),
 skill_name TEXT NOT NULL,
 instructions TEXT NOT NULL,
 input TEXT NOT NULL,
 admitted_at INTEGER NOT NULL
);
CREATE TRIGGER hook_provenance_immutable BEFORE UPDATE ON hook_provenance
BEGIN SELECT RAISE(ABORT, 'immutable hook provenance'); END;
CREATE TRIGGER hook_provenance_retained BEFORE DELETE ON hook_provenance
BEGIN SELECT RAISE(ABORT, 'retained hook provenance'); END;
-- Invalidate even when a configuration is changed and subsequently restored.
CREATE TRIGGER hook_preview_skill_configuration AFTER UPDATE ON skills
BEGIN UPDATE hook_previews SET invalidated=1 WHERE skill_id=NEW.id AND consumed_run IS NULL; END;
CREATE TRIGGER hook_preview_work AFTER UPDATE OF title ON tasks WHEN OLD.title != NEW.title
BEGIN UPDATE hook_previews SET invalidated=1 WHERE task_id=NEW.id AND consumed_run IS NULL; END;
CREATE TRIGGER hook_preview_assignment_added AFTER INSERT ON assignments
BEGIN UPDATE hook_previews SET invalidated=1 WHERE task_id=NEW.task_id AND consumed_run IS NULL; END;
CREATE TRIGGER hook_preview_assignment_removed AFTER DELETE ON assignments
BEGIN UPDATE hook_previews SET invalidated=1 WHERE task_id=OLD.task_id AND consumed_run IS NULL; END;

CREATE TABLE hook_context (
 preview_id TEXT PRIMARY KEY NOT NULL REFERENCES hook_previews(id),
 hook_id TEXT NOT NULL REFERENCES hooks(id),
 hook_name TEXT NOT NULL,
 event TEXT NOT NULL CHECK(event IN ('run_completed','run_failed')),
 source_run_id TEXT NOT NULL REFERENCES runs(id),
 source_outcome TEXT NOT NULL CHECK(source_outcome IN ('reported_success','failure'))
);
CREATE TRIGGER hook_context_immutable BEFORE UPDATE ON hook_context BEGIN SELECT RAISE(ABORT,'immutable hook context'); END;
CREATE TRIGGER hook_context_retained BEFORE DELETE ON hook_context BEGIN SELECT RAISE(ABORT,'retained hook context'); END;
CREATE TRIGGER hook_preview_configuration AFTER UPDATE ON hooks
BEGIN UPDATE hook_previews SET invalidated=1 WHERE id IN (SELECT preview_id FROM hook_context WHERE hook_id=NEW.id) AND consumed_run IS NULL; END;
-- Consent contents are immutable; only invalidation and one-time consumption change.
CREATE TRIGGER hook_preview_snapshot_immutable BEFORE UPDATE ON hook_previews
WHEN NEW.id != OLD.id OR NEW.task_id != OLD.task_id OR NEW.skill_id != OLD.skill_id
 OR NEW.agent_id != OLD.agent_id OR NEW.work_text != OLD.work_text
 OR NEW.skill_name != OLD.skill_name OR NEW.instructions != OLD.instructions
 OR NEW.input != OLD.input OR NEW.expected_runs != OLD.expected_runs
 OR NEW.created_at != OLD.created_at OR NEW.invalidated < OLD.invalidated
 OR (OLD.consumed_run IS NOT NULL AND NEW.consumed_run IS NOT OLD.consumed_run)
BEGIN SELECT RAISE(ABORT,'immutable hook preview snapshot'); END;
