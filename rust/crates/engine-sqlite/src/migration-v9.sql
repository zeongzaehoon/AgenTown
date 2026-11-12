-- Loop consent and runtime ownership are separate from enabled configuration.
CREATE TABLE loop_previews (
 id TEXT PRIMARY KEY NOT NULL,
 policy_id TEXT NOT NULL REFERENCES loop_policies(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 agent_id TEXT NOT NULL REFERENCES agents(id),
 policy_name TEXT NOT NULL, input TEXT NOT NULL,
 max_iterations INTEGER NOT NULL CHECK(max_iterations BETWEEN 1 AND 100),
 interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 60 AND 86400),
 expected_runs INTEGER NOT NULL CHECK(expected_runs >= 0),
 created_at INTEGER NOT NULL,
 invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1))
);
CREATE TABLE loop_sessions (
 id TEXT PRIMARY KEY NOT NULL,
 preview_id TEXT NOT NULL UNIQUE REFERENCES loop_previews(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 runtime_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','stopped','complete','failed','expired','restarted','stale')),
 started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted BETWEEN 0 AND 100),
 next_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX loop_one_active_task ON loop_sessions(task_id) WHERE state='active';
CREATE TABLE loop_attempts (
 run_id TEXT PRIMARY KEY NOT NULL REFERENCES executions(run_id),
 session_id TEXT NOT NULL REFERENCES loop_sessions(id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 100),
 admitted_at INTEGER NOT NULL,
 UNIQUE(session_id,ordinal)
);
CREATE TRIGGER loop_attempt_immutable BEFORE UPDATE ON loop_attempts BEGIN SELECT RAISE(ABORT,'immutable loop attempt'); END;
CREATE TRIGGER loop_attempt_retained BEFORE DELETE ON loop_attempts BEGIN SELECT RAISE(ABORT,'retained loop attempt'); END;
CREATE TRIGGER loop_session_retained BEFORE DELETE ON loop_sessions BEGIN SELECT RAISE(ABORT,'retained loop session'); END;
CREATE TRIGGER loop_session_snapshot BEFORE UPDATE ON loop_sessions
WHEN NEW.id != OLD.id OR NEW.preview_id != OLD.preview_id OR NEW.task_id != OLD.task_id
 OR NEW.runtime_id != OLD.runtime_id OR NEW.provider != OLD.provider OR NEW.model != OLD.model
 OR NEW.started_at != OLD.started_at OR NEW.expires_at != OLD.expires_at
 OR NEW.admitted < OLD.admitted OR NEW.next_at < OLD.next_at
 OR (OLD.state != 'active' AND NEW.state != OLD.state)
BEGIN SELECT RAISE(ABORT,'immutable loop session snapshot'); END;
CREATE TRIGGER loop_preview_retained BEFORE DELETE ON loop_previews BEGIN SELECT RAISE(ABORT,'retained loop preview'); END;
CREATE TRIGGER loop_preview_snapshot BEFORE UPDATE ON loop_previews
WHEN NEW.id != OLD.id OR NEW.policy_id != OLD.policy_id OR NEW.task_id != OLD.task_id
 OR NEW.agent_id != OLD.agent_id OR NEW.policy_name != OLD.policy_name OR NEW.input != OLD.input
 OR NEW.max_iterations != OLD.max_iterations OR NEW.interval_seconds != OLD.interval_seconds
 OR NEW.expected_runs != OLD.expected_runs OR NEW.created_at != OLD.created_at OR NEW.invalidated < OLD.invalidated
BEGIN SELECT RAISE(ABORT,'immutable loop preview'); END;
CREATE TRIGGER loop_preview_policy AFTER UPDATE ON loop_policies
BEGIN UPDATE loop_previews SET invalidated=1 WHERE policy_id=NEW.id; END;
CREATE TRIGGER loop_preview_work AFTER UPDATE OF title ON tasks WHEN OLD.title != NEW.title
BEGIN UPDATE loop_previews SET invalidated=1 WHERE task_id=NEW.id; END;
CREATE TRIGGER loop_preview_assignment_added AFTER INSERT ON assignments
BEGIN UPDATE loop_previews SET invalidated=1 WHERE task_id=NEW.task_id; END;
CREATE TRIGGER loop_preview_assignment_removed AFTER DELETE ON assignments
BEGIN UPDATE loop_previews SET invalidated=1 WHERE task_id=OLD.task_id; END;
