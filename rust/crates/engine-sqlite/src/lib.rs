//! SQLite adapter for the product Core, independent of development tooling.
use llm_engine_core::{
    Core, DomainError, RunOutcome, RunState, TaskStatus,
    persistence::{InvalidSnapshot, Persistence, RunRecord, Snapshot},
};
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use std::{collections::BTreeSet, error::Error, fmt, path::Path, time::Duration};

const APPLICATION_ID: i32 = 0x4c4c4d45; // LLME
const SCHEMA_VERSION: i32 = 6;
mod configuration;
mod execution;
pub use execution::Execution;

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    Domain(DomainError),
    InvalidData(String),
    UnsupportedVersion(i32),
    ForeignDatabase,
    UnsupportedProvenance,
}
impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "database error: {e}"),
            Self::Domain(e) => e.fmt(f),
            Self::InvalidData(e) => write!(f, "invalid stored data: {e}"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported product schema version: {v}"),
            Self::UnsupportedProvenance => {
                write!(f, "schema v6 cannot persist Artifact or Evidence records")
            }
            Self::ForeignDatabase => write!(f, "database is not an AgenTown product database"),
        }
    }
}
impl Error for StorageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(e) => Some(e),
            Self::Domain(e) => Some(e),
            _ => None,
        }
    }
}
impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}
impl From<DomainError> for StorageError {
    fn from(e: DomainError) -> Self {
        Self::Domain(e)
    }
}
impl From<InvalidSnapshot> for StorageError {
    fn from(e: InvalidSnapshot) -> Self {
        Self::InvalidData(e.to_string())
    }
}

pub struct SqliteStore {
    connection: Connection,
}

/// Inspection of an existing product database. No initialization or mutation API.
pub struct ReadOnlyStore {
    connection: Connection,
}

impl ReadOnlyStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let enabled: bool = connection.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
        if !enabled {
            return Err(StorageError::InvalidData("foreign keys unavailable".into()));
        }
        let mut store = Self { connection };
        store.read()?;
        Ok(store)
    }

    /// Fresh, validated, owned snapshot; modifying it cannot persist changes.
    pub fn read(&mut self) -> Result<Core, StorageError> {
        let tx = self.connection.transaction()?;
        check_version(&tx)?;
        let core = load(&tx)?;
        tx.commit()?;
        Ok(core)
    }
}

impl SqliteStore {
    /// Caller supplies a dedicated product path; parent directories must exist.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let enabled: bool = connection.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
        if !enabled {
            return Err(StorageError::InvalidData("foreign keys unavailable".into()));
        }
        // No persistent writes before the version/ownership check, even for foreign files.
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i32 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let application: i32 = tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
        if !matches!(version, 0 | 1 | 2 | 3 | 4 | 5 | SCHEMA_VERSION) {
            return Err(StorageError::UnsupportedVersion(version));
        }
        if version == 0 {
            let objects: i64 = tx.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )?;
            if application != 0 || objects != 0 {
                return Err(StorageError::ForeignDatabase);
            }
            tx.execute_batch(include_str!("schema.sql"))?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", 1)?;
        } else if application != APPLICATION_ID {
            return Err(StorageError::ForeignDatabase);
        }
        // Validate each old schema before migration; commit all DDL and versions together.
        load(&tx)?;
        if version == 0 || version == 1 {
            tx.execute_batch(include_str!("migration-v2.sql"))?;
            tx.pragma_update(None, "user_version", 2)?;
            load(&tx)?;
        }
        if version < 3 {
            tx.execute_batch(include_str!("migration-v3.sql"))?;
            tx.pragma_update(None, "user_version", 3)?;
            load(&tx)?;
        }
        if version < 4 {
            tx.execute_batch(include_str!("migration-v4.sql"))?;
            tx.pragma_update(None, "user_version", 4)?;
        }
        if version < 5 {
            tx.execute_batch(include_str!("migration-v5.sql"))?;
            tx.pragma_update(None, "user_version", 5)?;
            load(&tx)?;
        }
        if version < 6 {
            tx.execute_batch(include_str!("migration-v6.sql"))?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            load(&tx)?;
        }
        tx.commit()?;
        Ok(Self { connection })
    }

    fn transact_before_commit<T>(
        &mut self,
        command: impl FnOnce(&mut Core) -> Result<T, DomainError>,
        before_commit: impl FnOnce(&Connection) -> Result<(), StorageError>,
    ) -> Result<T, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_version(&tx)?;
        let before = load(&tx)?;
        let mut core = before.clone();
        let result = command(&mut core)?;
        persist_changes(&tx, &before, &core)?;
        before_commit(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}
impl Persistence for SqliteStore {
    type Error = StorageError;
    fn read(&mut self) -> Result<Core, StorageError> {
        let tx = self.connection.transaction()?;
        check_version(&tx)?;
        let core = load(&tx)?;
        tx.commit()?;
        Ok(core)
    }
    fn transact<T>(
        &mut self,
        command: impl FnOnce(&mut Core) -> Result<T, DomainError>,
    ) -> Result<T, StorageError> {
        self.transact_before_commit(command, |_| Ok(()))
    }
}
// Compare final validated states, not individual commands: net no-ops issue no DML.
// The port accepts &mut Core (including replacement with a restored Core), so
// handle removals as well as the current create/assign/transition commands.
fn persist_changes(tx: &Connection, before: &Core, after: &Core) -> Result<(), StorageError> {
    persist_execution_changes(tx, before, after, false)
}
fn persist_execution_changes(
    tx: &Connection,
    before: &Core,
    after: &Core,
    execution_command: bool,
) -> Result<(), StorageError> {
    if after.artifacts().len() != 0 || after.evidence_records().len() != 0 {
        return Err(StorageError::UnsupportedProvenance);
    }
    let mut statement = tx.prepare("SELECT run_id FROM executions")?;
    for id in statement.query_map([], |r| r.get::<_, String>(0))? {
        let id = parse_id(id?)?;
        if !execution_command && before.run(id)? != after.run(id)? {
            return Err(StorageError::InvalidData(
                "use execution commands to finalize this Run".into(),
            ));
        }
    }
    // A closure can replace Core using restore; domain encapsulation alone is insufficient.
    for old in before.runs() {
        let new = after
            .run(old.id())
            .map_err(|_| StorageError::InvalidData("Run history cannot be deleted".into()))?;
        if old.task() != new.task()
            || old.stage() != new.stage()
            || old.reporting_source() != new.reporting_source()
            || old.started_at() != new.started_at()
            || !old.participants().eq(new.participants())
            || (old.state() != RunState::Active && old != new)
        {
            return Err(StorageError::InvalidData(
                "Run history cannot be rewritten".into(),
            ));
        }
    }
    let assignments = |core: &Core| -> BTreeSet<_> {
        core.tasks()
            .flat_map(|task| task.assignees().map(move |agent| (task.id(), agent)))
            .collect()
    };
    let memberships = |core: &Core| -> BTreeSet<_> {
        core.teams()
            .flat_map(|team| team.members().map(move |agent| (team.id(), agent)))
            .collect()
    };
    let old_members = memberships(before);
    let new_members = memberships(after);
    for (team, agent) in old_members.difference(&new_members) {
        tx.execute(
            "DELETE FROM team_members WHERE team_id=?1 AND agent_id=?2",
            params![team.to_string(), agent.to_string()],
        )?;
    }
    for team in before.teams() {
        if after.team(team.id()).is_err() {
            tx.execute("DELETE FROM teams WHERE id=?1", [team.id().to_string()])?;
        }
    }
    let old_pairs = assignments(before);
    let new_pairs = assignments(after);
    for (task, agent) in old_pairs.difference(&new_pairs) {
        tx.execute(
            "DELETE FROM assignments WHERE task_id=?1 AND agent_id=?2",
            params![task.to_string(), agent.to_string()],
        )?;
    }
    for task in before.tasks() {
        if after.task(task.id()).is_err() {
            tx.execute("DELETE FROM tasks WHERE id=?1", [task.id().to_string()])?;
        }
    }
    for agent in before.agents() {
        if after.agent(agent.id()).is_err() {
            tx.execute("DELETE FROM agents WHERE id=?1", [agent.id().to_string()])?;
        }
    }
    for agent in after.agents() {
        match before.agent(agent.id()) {
            Err(_) => {
                tx.execute(
                    "INSERT INTO agents(id, name) VALUES (?1, ?2)",
                    params![agent.id().to_string(), agent.name()],
                )?;
            }
            Ok(old) if old.name() != agent.name() => {
                tx.execute(
                    "UPDATE agents SET name=?2 WHERE id=?1",
                    params![agent.id().to_string(), agent.name()],
                )?;
            }
            Ok(_) => {}
        }
    }
    for task in after.tasks() {
        let status = match task.status() {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Cancelled => "cancelled",
        };
        match before.task(task.id()) {
            Err(_) => {
                tx.execute(
                    "INSERT INTO tasks(id, title, status) VALUES (?1, ?2, ?3)",
                    params![task.id().to_string(), task.title(), status],
                )?;
            }
            Ok(old) if old.title() != task.title() || old.status() != task.status() => {
                tx.execute(
                    "UPDATE tasks SET title=?2, status=?3 WHERE id=?1",
                    params![task.id().to_string(), task.title(), status],
                )?;
            }
            Ok(_) => {}
        }
    }
    for team in after.teams() {
        match before.team(team.id()) {
            Err(_) => {
                tx.execute(
                    "INSERT INTO teams(id, name) VALUES (?1, ?2)",
                    params![team.id().to_string(), team.name()],
                )?;
            }
            Ok(old) if old.name() != team.name() => {
                tx.execute(
                    "UPDATE teams SET name=?2 WHERE id=?1",
                    params![team.id().to_string(), team.name()],
                )?;
            }
            Ok(_) => {}
        }
    }
    for (team, agent) in new_members.difference(&old_members) {
        tx.execute(
            "INSERT INTO team_members(team_id, agent_id) VALUES (?1, ?2)",
            params![team.to_string(), agent.to_string()],
        )?;
    }
    for (task, agent) in new_pairs.difference(&old_pairs) {
        tx.execute(
            "INSERT INTO assignments(task_id, agent_id) VALUES (?1, ?2)",
            params![task.to_string(), agent.to_string()],
        )?;
    }
    configuration::persist(tx, before, after)?;
    // Finalize retained active Runs before inserting retries (the partial index is immediate).
    for run in after.runs() {
        if let Ok(old) = before.run(run.id()) {
            if old.state() != run.state() {
                let (outcome, end) = terminal_columns(run.state());
                tx.execute(
                    "UPDATE runs SET outcome=?2, ended_at=?3 WHERE id=?1",
                    params![run.id().to_string(), outcome, end],
                )?;
            }
        }
    }
    for run in after.runs() {
        if before.run(run.id()).is_err() {
            let (outcome, end) = terminal_columns(run.state());
            tx.execute("INSERT INTO runs(id, task_id, stage, reporting_source, started_at, outcome, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![run.id().to_string(), run.task().to_string(), run.stage(), run.reporting_source(), run.started_at().unix_millis(), outcome, end])?;
            for agent in run.participants() {
                tx.execute(
                    "INSERT INTO run_participants(run_id, agent_id) VALUES (?1, ?2)",
                    params![run.id().to_string(), agent.to_string()],
                )?;
            }
        }
    }
    Ok(())
}

fn terminal_columns(state: RunState) -> (Option<&'static str>, Option<i64>) {
    match state {
        RunState::Active => (None, None),
        RunState::Finished { outcome, ended_at } => (
            Some(match outcome {
                RunOutcome::ReportedSuccess => "reported_success",
                RunOutcome::Failure => "failure",
                RunOutcome::Interruption => "interruption",
            }),
            Some(ended_at.unix_millis()),
        ),
    }
}

fn check_version(connection: &Connection) -> Result<(), StorageError> {
    let version: i32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if !matches!(version, 1 | 2 | 3 | 4 | 5 | SCHEMA_VERSION) {
        return Err(StorageError::UnsupportedVersion(version));
    }
    let application: i32 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if application != APPLICATION_ID {
        return Err(StorageError::ForeignDatabase);
    }
    Ok(())
}
fn parse_id<T: std::str::FromStr>(s: String) -> Result<T, StorageError> {
    s.parse()
        .map_err(|_| StorageError::InvalidData(format!("invalid UUID: {s}")))
}
fn load(connection: &Connection) -> Result<Core, StorageError> {
    let mut snapshot = Snapshot::default();
    let mut statement = connection.prepare("SELECT id, name FROM agents")?;
    for row in statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (id, name) = row?;
        snapshot.agents.push((parse_id(id)?, name));
    }
    let mut statement = connection.prepare("SELECT id, title, status FROM tasks")?;
    for row in statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, title, status) = row?;
        let status = match status.as_str() {
            "pending" => TaskStatus::Pending,
            "in_progress" => TaskStatus::InProgress,
            "blocked" => TaskStatus::Blocked,
            "cancelled" => TaskStatus::Cancelled,
            _ => {
                return Err(StorageError::InvalidData(format!(
                    "unknown task status: {status}"
                )));
            }
        };
        snapshot.tasks.push((parse_id(id)?, title, status));
    }
    let mut statement = connection.prepare("SELECT task_id, agent_id FROM assignments")?;
    for row in statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (task, agent) = row?;
        snapshot
            .assignments
            .push((parse_id(task)?, parse_id(agent)?));
    }
    let version: i32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= 2 {
        let mut statement = connection.prepare("SELECT id, name FROM teams")?;
        for row in
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, name) = row?;
            snapshot.teams.push((parse_id(id)?, name));
        }
        let mut statement = connection.prepare("SELECT team_id, agent_id FROM team_members")?;
        for row in
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (team, agent) = row?;
            snapshot
                .memberships
                .push((parse_id(team)?, parse_id(agent)?));
        }
    }
    if version >= 3 {
        let mut statement = connection.prepare(
            "SELECT id, task_id, stage, reporting_source, started_at, outcome, ended_at FROM runs",
        )?;
        for row in statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<i64>>(6)?,
            ))
        })? {
            let (id, task, stage, reporting_source, started_at, outcome, end) = row?;
            let terminal = match (outcome.as_deref(), end) {
                (None, None) => None,
                (Some(value), Some(end)) => Some((
                    match value {
                        "reported_success" => RunOutcome::ReportedSuccess,
                        "failure" => RunOutcome::Failure,
                        "interruption" => RunOutcome::Interruption,
                        _ => return Err(StorageError::InvalidData("unknown Run outcome".into())),
                    },
                    end,
                )),
                _ => {
                    return Err(StorageError::InvalidData(
                        "incomplete Run outcome/time".into(),
                    ));
                }
            };
            snapshot.runs.push(RunRecord {
                id: parse_id(id)?,
                task: parse_id(task)?,
                stage,
                reporting_source,
                started_at,
                terminal,
                participants: Vec::new(),
            });
        }
        let mut indices = std::collections::BTreeMap::new();
        for (index, run) in snapshot.runs.iter().enumerate() {
            indices.insert(run.id, index);
        }
        let mut statement = connection.prepare("SELECT run_id, agent_id FROM run_participants")?;
        for row in
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (run, agent) = row?;
            let index = indices
                .get(&parse_id::<llm_engine_core::RunId>(run)?)
                .ok_or_else(|| StorageError::InvalidData("unknown participant Run".into()))?;
            snapshot.runs[*index].participants.push(parse_id(agent)?);
        }
    }
    if version >= 6 {
        configuration::load(connection, &mut snapshot)?;
    }
    let core = Core::restore(snapshot)?;
    if version >= 4 {
        execution::validate(connection, &core)?;
    }
    if version >= 5 {
        let invalid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_sources s LEFT JOIN executions e ON e.run_id=s.run_id WHERE e.run_id IS NULL OR length(trim(s.declared_source))=0 OR length(CAST(s.declared_source AS BLOB))>80)", [], |r| r.get(0))?;
        if invalid {
            return Err(StorageError::InvalidData(
                "invalid declared execution source".into(),
            ));
        }
    }
    Ok(core)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_connection_is_sqlite_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("product.sqlite3");
        drop(SqliteStore::open(&path).unwrap());
        let before = std::fs::read(&path).unwrap();
        let store = ReadOnlyStore::open(&path).unwrap();
        assert!(store.connection.is_readonly("main").unwrap());
        let enabled: bool = store
            .connection
            .pragma_query_value(None, "foreign_keys", |r| r.get(0))
            .unwrap();
        assert!(enabled);
        let error = store
            .connection
            .execute("INSERT INTO agents VALUES ('id', 'A')", [])
            .unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ReadOnly)
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn pre_commit_failure_rolls_back_all_written_rows_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("product.sqlite3");
        let mut store = SqliteStore::open(&path).unwrap();
        let existing = store.transact(|c| c.create_agent("Existing")).unwrap();
        let before = store.read().unwrap();
        let result = store.transact_before_commit(
            |c| {
                let agent = c.create_agent("New")?;
                let task = c.create_task("Shared")?;
                c.assign(task, existing)?;
                c.assign(task, agent)?;
                c.transition(task, TaskStatus::InProgress)?;
                Ok(())
            },
            |tx| {
                assert_eq!(
                    tx.query_row("SELECT count(*) FROM agents", [], |r| r.get::<_, i64>(0))?,
                    2
                );
                assert_eq!(
                    tx.query_row("SELECT count(*) FROM assignments", [], |r| r
                        .get::<_, i64>(0))?,
                    2
                );
                Err(StorageError::InvalidData(
                    "injected pre-commit failure".into(),
                ))
            },
        );
        assert!(
            matches!(result, Err(StorageError::InvalidData(ref message)) if message == "injected pre-commit failure")
        );
        drop(store);
        let mut reopened = SqliteStore::open(&path).unwrap();
        assert_eq!(reopened.read().unwrap(), before);
        reopened
            .transact(|c| c.create_task("Next successful write"))
            .unwrap();
        assert_eq!(reopened.read().unwrap().tasks().len(), 1);
    }

    #[test]
    fn run_sql_writes_roll_back_after_injected_failure_and_reopen() {
        use llm_engine_core::RunTimestamp;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t, run) = store
            .transact(|c| {
                let a = c.create_agent("A")?;
                let t = c.create_task("T")?;
                c.assign(t, a)?;
                let run = c.start_run(
                    t,
                    "stage",
                    "operator",
                    RunTimestamp::from_unix_millis(10)?,
                    &[a],
                )?;
                Ok((a, t, run))
            })
            .unwrap();
        let before = store.read().unwrap();
        let error = store
            .transact_before_commit(
                |c| {
                    c.finish_run(
                        run,
                        RunOutcome::Failure,
                        RunTimestamp::from_unix_millis(20)?,
                    )?;
                    c.start_run(
                        t,
                        "retry",
                        "operator",
                        RunTimestamp::from_unix_millis(30)?,
                        &[a],
                    )
                },
                |tx| {
                    assert_eq!(
                        tx.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))?,
                        2
                    );
                    assert_eq!(
                        tx.query_row("SELECT count(*) FROM run_participants", [], |r| r
                            .get::<_, i64>(0))?,
                        2
                    );
                    assert_eq!(
                        tx.query_row(
                            "SELECT outcome FROM runs WHERE id=?1",
                            [run.to_string()],
                            |r| r.get::<_, String>(0)
                        )?,
                        "failure"
                    );
                    Err(StorageError::InvalidData(
                        "injected after Run SQL writes".into(),
                    ))
                },
            )
            .unwrap_err();
        assert!(error.to_string().contains("injected after Run SQL writes"));
        drop(store);
        assert_eq!(SqliteStore::open(&path).unwrap().read().unwrap(), before);
        assert_eq!(ReadOnlyStore::open(&path).unwrap().read().unwrap(), before);
    }

    #[test]
    fn configuration_sql_failure_rolls_back_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.db");
        let mut db = SqliteStore::open(&path).unwrap();
        let before = db.read().unwrap();
        let result = db.transact_before_commit(
            |c| c.create_skill("Skill", "instructions"),
            |tx| {
                assert_eq!(
                    tx.query_row("SELECT count(*) FROM skills", [], |r| r.get::<_, i64>(0))?,
                    1
                );
                Err(StorageError::InvalidData(
                    "injected configuration failure".into(),
                ))
            },
        );
        assert!(result.is_err());
        drop(db);
        assert_eq!(SqliteStore::open(&path).unwrap().read().unwrap(), before);
    }

    #[test]
    fn every_adapter_connection_enforces_sql_constraints() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("product.sqlite3");
        let mut store = SqliteStore::open(&path).unwrap();
        let (a, t) = store
            .transact(|c| {
                let a = c.create_agent("A")?;
                let t = c.create_task("T")?;
                c.assign(t, a)?;
                Ok((a, t))
            })
            .unwrap();
        drop(store);
        for _ in 0..2 {
            let store = SqliteStore::open(&path).unwrap();
            assert!(
                store
                    .connection
                    .execute(
                        "INSERT INTO assignments VALUES (?1, ?2)",
                        params![t.to_string(), a.to_string()]
                    )
                    .is_err()
            );
            assert!(
                store
                    .connection
                    .execute(
                        "INSERT INTO assignments VALUES (?1, 'missing')",
                        [t.to_string()]
                    )
                    .is_err()
            );
            assert!(
                store
                    .connection
                    .execute(
                        "INSERT INTO assignments VALUES ('missing', ?1)",
                        [a.to_string()]
                    )
                    .is_err()
            );
            assert!(store.connection.execute("DELETE FROM agents", []).is_err());
        }
    }
}
