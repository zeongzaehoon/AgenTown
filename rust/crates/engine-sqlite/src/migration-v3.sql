CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    stage TEXT NOT NULL CHECK(length(trim(stage)) > 0),
    reporting_source TEXT NOT NULL CHECK(length(trim(reporting_source)) > 0),
    started_at INTEGER NOT NULL CHECK(started_at BETWEEN 0 AND 253402300799999),
    outcome TEXT CHECK(outcome IN ('reported_success', 'failure', 'interruption')),
    ended_at INTEGER,
    CHECK((outcome IS NULL AND ended_at IS NULL) OR
          (outcome IS NOT NULL AND ended_at IS NOT NULL AND ended_at BETWEEN started_at AND 253402300799999))
);
CREATE INDEX runs_by_task ON runs(task_id);
CREATE UNIQUE INDEX one_active_run_per_task ON runs(task_id) WHERE outcome IS NULL;
CREATE TABLE run_participants (
    run_id TEXT NOT NULL REFERENCES runs(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (run_id, agent_id)
);
CREATE INDEX run_participants_by_agent ON run_participants(agent_id);
CREATE TRIGGER retain_runs BEFORE DELETE ON runs BEGIN
    SELECT RAISE(ABORT, 'Run history cannot be deleted');
END;
CREATE TRIGGER preserve_runs BEFORE UPDATE ON runs
WHEN OLD.outcome IS NOT NULL OR NEW.id != OLD.id OR NEW.task_id != OLD.task_id
 OR NEW.stage != OLD.stage OR NEW.reporting_source != OLD.reporting_source
 OR NEW.started_at != OLD.started_at
BEGIN
    SELECT RAISE(ABORT, 'Run history cannot be rewritten');
END;
CREATE TRIGGER retain_participants BEFORE DELETE ON run_participants BEGIN
    SELECT RAISE(ABORT, 'Run participants cannot be deleted');
END;
CREATE TRIGGER preserve_participants BEFORE UPDATE ON run_participants BEGIN
    SELECT RAISE(ABORT, 'Run participants cannot be rewritten');
END;
