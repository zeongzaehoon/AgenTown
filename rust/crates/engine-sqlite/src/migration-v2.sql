CREATE TABLE teams (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0)
);
CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (team_id, agent_id)
);
CREATE INDEX team_members_by_agent ON team_members(agent_id);
