CREATE TABLE agents (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0)
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'blocked', 'cancelled'))
);
CREATE TABLE assignments (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (task_id, agent_id)
);
CREATE INDEX assignments_by_agent ON assignments(agent_id);
