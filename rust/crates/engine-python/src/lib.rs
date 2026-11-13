//! Stateless Python adapter. Each call opens the product store; no cached mutable state.
use llm_engine_core::{
    Agent, AgentId, DomainError, Run, RunId, RunOutcome, RunState, RunTimestamp, Task, TaskId,
    TaskStatus, Team, TeamId, persistence::Persistence,
};
use llm_engine_sqlite::{ReadOnlyStore, SqliteStore};
use pyo3::{exceptions::PyValueError, prelude::*};

mod configuration;
mod hook_execution;
mod loop_execution;
mod skill_execution;

type AgentRecord = (String, String);
type TaskRecord = (String, String, String, Vec<String>);

fn error(e: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(e.to_string())
}
fn task_id(id: &str) -> PyResult<TaskId> {
    id.parse()
        .map_err(|_| error(format!("invalid task ID: {id}")))
}
fn agent_id(id: &str) -> PyResult<AgentId> {
    id.parse()
        .map_err(|_| error(format!("invalid agent ID: {id}")))
}
fn agent_record(agent: &Agent) -> AgentRecord {
    (agent.id().to_string(), agent.name().to_owned())
}
fn task_record(task: &Task) -> TaskRecord {
    let status = match task.status() {
        TaskStatus::Pending => "pending",
        TaskStatus::InProgress => "in_progress",
        TaskStatus::Blocked => "blocked",
        TaskStatus::Cancelled => "cancelled",
    };
    (
        task.id().to_string(),
        task.title().to_owned(),
        status.into(),
        task.assignees().map(|id| id.to_string()).collect(),
    )
}
#[pyfunction]
fn create_agent(database: &str, name: &str) -> PyResult<AgentRecord> {
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            let id = core.create_agent(name)?;
            Ok(agent_record(core.agent(id)?))
        })
        .map_err(error)
}
#[pyfunction]
fn list_agents(database: &str) -> PyResult<Vec<AgentRecord>> {
    Ok(SqliteStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?
        .agents()
        .map(agent_record)
        .collect())
}
#[pyfunction]
fn create_task(database: &str, title: &str) -> PyResult<TaskRecord> {
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            let id = core.create_task(title)?;
            Ok(task_record(core.task(id)?))
        })
        .map_err(error)
}
/// Save the full work text and its employee assignment atomically.
#[pyfunction]
fn create_assigned_work(database: &str, input: &str, agent: &str) -> PyResult<TaskRecord> {
    let agent = agent_id(agent)?;
    if input.trim().is_empty() || input.len() > 100_000 {
        return Err(error("provide work text of 1 to 100000 UTF-8 bytes"));
    }
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            let id = core.create_text_work(input)?;
            core.assign(id, agent)?;
            Ok(task_record(core.task(id)?))
        })
        .map_err(error)
}
#[pyfunction]
fn start_web_execution(
    database: &str,
    task: &str,
    provider: &str,
    model: &str,
    expected_runs: usize,
) -> PyResult<ExecutionRecord> {
    let task = task_id(task)?;
    let mut store = SqliteStore::open(database).map_err(error)?;
    let core = store.read().map_err(error)?;
    let work = core.task(task).map_err(error)?;
    let agents: Vec<_> = work.assignees().collect();
    if agents.len() != 1 {
        return Err(error("work must have exactly one assigned employee"));
    }
    store
        .start_execution_guarded(
            task,
            agents[0],
            work.title(),
            provider,
            model,
            Some(expected_runs),
        )
        .map(execution_record)
        .map_err(error)
}
/// Versioned MCP adapter: errors intentionally exclude paths and caller input.
#[pyfunction]
fn start_mcp_execution(
    database: &str,
    task_id: &str,
    provider: &str,
    model: &str,
    expected_runs: usize,
    resubmission_consent: bool,
    declared_source: &str,
) -> PyResult<ExecutionRecord> {
    let task = task_id
        .parse::<TaskId>()
        .map_err(|_| error("invalid task ID"))?;
    SqliteStore::open(database).map_err(|_| error("database unavailable"))?
        .start_mcp_execution(task, provider, model, expected_runs, resubmission_consent, declared_source)
        .map(execution_record).map_err(|_| error("execution rejected; refresh work and check assignment, active attempts and retry consent"))
}

/// Read-only ordinary text preparation with sanitized errors.
#[pyfunction]
fn preflight_text_work(
    py: Python<'_>,
    database: &str,
    task: &str,
) -> PyResult<Py<pyo3::types::PyDict>> {
    use pyo3::types::PyDict;
    let task = task
        .parse::<TaskId>()
        .map_err(|_| error("invalid task ID"))?;
    let p = ReadOnlyStore::open(database)
        .and_then(|mut store| store.preflight_text_work(task))
        .map_err(|_| error("preflight unavailable"))?;
    let d = PyDict::new(py);
    d.set_item("task_id", p.task.to_string())?;
    d.set_item("input", p.input)?;
    d.set_item(
        "employee_ids",
        p.assignees
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
    )?;
    d.set_item("expected_runs", p.expected_runs)?;
    d.set_item("active_attempt", p.active_attempt)?;
    d.set_item("eligibility", p.eligibility)?;
    d.set_item("resubmission_consent_required", p.expected_runs > 0)?;
    Ok(d.unbind())
}

/// Untrusted declared integration metadata, keyed by Run ID; missing is unknown.
#[pyfunction]
fn execution_sources(database: &str) -> PyResult<Vec<(String, String)>> {
    SqliteStore::open(database)
        .map_err(|_| error("database unavailable"))?
        .execution_sources()
        .map_err(|_| error("history unavailable"))
}

#[pyfunction]
fn list_tasks(database: &str) -> PyResult<Vec<TaskRecord>> {
    Ok(SqliteStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?
        .tasks()
        .map(task_record)
        .collect())
}
#[pyfunction]
fn show_task(database: &str, id: &str) -> PyResult<TaskRecord> {
    let id = task_id(id)?;
    let core = SqliteStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(task_record(core.task(id).map_err(error)?))
}
#[pyfunction]
fn assign_task(database: &str, id: &str, agents: Vec<String>) -> PyResult<TaskRecord> {
    let id = task_id(id)?;
    if agents.is_empty() {
        return Err(error("provide at least one agent ID"));
    }
    let agents = agents
        .iter()
        .map(|id| agent_id(id))
        .collect::<PyResult<Vec<_>>>()?;
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            for agent in agents {
                core.assign(id, agent)?;
            }
            Ok(task_record(core.task(id)?))
        })
        .map_err(error)
}
type TeamRecord = (String, String, Vec<String>);
fn team_id(id: &str) -> PyResult<TeamId> {
    id.parse()
        .map_err(|_| error(format!("invalid team ID: {id}")))
}
fn team_record(team: &Team) -> TeamRecord {
    (
        team.id().to_string(),
        team.name().to_owned(),
        team.members().map(|id| id.to_string()).collect(),
    )
}
#[pyfunction]
fn create_team(database: &str, name: &str) -> PyResult<TeamRecord> {
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            let id = core.create_team(name)?;
            Ok(team_record(core.team(id)?))
        })
        .map_err(error)
}
#[pyfunction]
fn list_teams(database: &str) -> PyResult<Vec<TeamRecord>> {
    Ok(SqliteStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?
        .teams()
        .map(team_record)
        .collect())
}
#[pyfunction]
fn show_team(database: &str, id: &str) -> PyResult<TeamRecord> {
    let id = team_id(id)?;
    let core = SqliteStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(team_record(core.team(id).map_err(error)?))
}
#[pyfunction]
fn add_team_members(database: &str, id: &str, agents: Vec<String>) -> PyResult<TeamRecord> {
    let id = team_id(id)?;
    let agents = agents
        .iter()
        .map(|id| agent_id(id))
        .collect::<PyResult<Vec<_>>>()?;
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            core.add_team_members(id, &agents)?;
            Ok(team_record(core.team(id)?))
        })
        .map_err(error)
}
#[pyfunction]
fn assign_team(database: &str, id: &str, task: &str) -> PyResult<TaskRecord> {
    let id = team_id(id)?;
    let task = task_id(task)?;
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            core.assign_team(task, id)?;
            Ok(task_record(core.task(task)?))
        })
        .map_err(error)
}
// Detached record: identity, Task, stage, source, start/end UTC milliseconds,
// state, optional reported outcome, and immutable participant snapshot.
type RunRecord = (
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
    String,
    Option<String>,
    Vec<String>,
);
fn run_id(id: &str) -> PyResult<RunId> {
    id.parse()
        .map_err(|_| error(format!("invalid run ID: {id}")))
}
fn now() -> Result<RunTimestamp, DomainError> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| DomainError::InvalidRunTime)?;
    let millis = i64::try_from(elapsed.as_millis()).map_err(|_| DomainError::InvalidRunTime)?;
    RunTimestamp::from_unix_millis(millis)
}
fn run_record(run: &Run) -> RunRecord {
    let (state, outcome, end) = match run.state() {
        RunState::Active => ("active", None, None),
        RunState::Finished { outcome, ended_at } => (
            "finished",
            Some(match outcome {
                RunOutcome::ReportedSuccess => "reported_success".into(),
                RunOutcome::Failure => "failure".into(),
                RunOutcome::Interruption => "interruption".into(),
            }),
            Some(ended_at.unix_millis()),
        ),
    };
    (
        run.id().to_string(),
        run.task().to_string(),
        run.stage().into(),
        run.reporting_source().into(),
        run.started_at().unix_millis(),
        end,
        state.into(),
        outcome,
        run.participants().map(|id| id.to_string()).collect(),
    )
}
#[pyfunction]
fn start_run(
    database: &str,
    task: &str,
    stage: &str,
    reporting_source: &str,
    participants: Vec<String>,
) -> PyResult<RunRecord> {
    let task = task_id(task)?;
    let participants = participants
        .iter()
        .map(|id| agent_id(id))
        .collect::<PyResult<Vec<_>>>()?;
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            let id = core.start_run(task, stage, reporting_source, now()?, &participants)?;
            Ok(run_record(core.run(id)?))
        })
        .map_err(error)
}
#[pyfunction]
fn finish_run(database: &str, id: &str, outcome: &str) -> PyResult<RunRecord> {
    let id = run_id(id)?;
    let outcome = match outcome {
        "reported_success" => RunOutcome::ReportedSuccess,
        "failure" => RunOutcome::Failure,
        "interruption" => RunOutcome::Interruption,
        _ => {
            return Err(error(
                "invalid run outcome: expected reported_success, failure or interruption",
            ));
        }
    };
    SqliteStore::open(database)
        .map_err(error)?
        .transact(|core| {
            core.finish_run(id, outcome, now()?)?;
            Ok(run_record(core.run(id)?))
        })
        .map_err(error)
}
#[pyfunction]
fn list_runs(database: &str, task: &str) -> PyResult<Vec<RunRecord>> {
    let task = task_id(task)?;
    let core = ReadOnlyStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(core
        .runs_for_task(task)
        .map_err(error)?
        .map(run_record)
        .collect())
}
#[pyfunction]
fn show_run(database: &str, id: &str) -> PyResult<RunRecord> {
    let id = run_id(id)?;
    let core = ReadOnlyStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(run_record(core.run(id).map_err(error)?))
}
/// External inspection functions deliberately bypass the initializing CLI path.
#[pyfunction]
fn query_agents(database: &str) -> PyResult<Vec<AgentRecord>> {
    let core = ReadOnlyStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(core.agents().map(agent_record).collect())
}
#[pyfunction]
fn query_agent(database: &str, id: &str) -> PyResult<AgentRecord> {
    let id = agent_id(id)?;
    let core = ReadOnlyStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(agent_record(core.agent(id).map_err(error)?))
}
#[pyfunction]
fn query_tasks(database: &str) -> PyResult<Vec<TaskRecord>> {
    let core = ReadOnlyStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(core.tasks().map(task_record).collect())
}
#[pyfunction]
fn query_task(database: &str, id: &str) -> PyResult<TaskRecord> {
    let id = task_id(id)?;
    let core = ReadOnlyStore::open(database)
        .map_err(error)?
        .read()
        .map_err(error)?;
    Ok(task_record(core.task(id).map_err(error)?))
}
type ExecutionRecord = (
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
);
fn execution_record(e: llm_engine_sqlite::Execution) -> ExecutionRecord {
    (
        e.run.to_string(),
        e.input,
        e.provider,
        e.model,
        e.deadline,
        e.output,
        e.error,
    )
}
#[pyfunction]
fn start_execution(
    database: &str,
    task: &str,
    agent: &str,
    input: &str,
    provider: &str,
    model: &str,
) -> PyResult<ExecutionRecord> {
    let mut store = SqliteStore::open(database).map_err(error)?;
    store
        .start_execution(task_id(task)?, agent_id(agent)?, input, provider, model)
        .map(execution_record)
        .map_err(error)
}
#[pyfunction]
#[pyo3(signature = (database, id, output=None, failure=None))]
fn finish_execution(
    database: &str,
    id: &str,
    output: Option<&str>,
    failure: Option<&str>,
) -> PyResult<ExecutionRecord> {
    SqliteStore::open(database)
        .map_err(error)?
        .finish_execution(run_id(id)?, output, failure)
        .map(execution_record)
        .map_err(error)
}
#[pyfunction]
fn show_execution(database: &str, id: &str) -> PyResult<ExecutionRecord> {
    SqliteStore::open(database)
        .map_err(error)?
        .execution(run_id(id)?)
        .map(execution_record)
        .map_err(error)
}
#[pyfunction]
fn show_execution_read_only(database: &str, id: &str) -> PyResult<ExecutionRecord> {
    SqliteStore::open(database)
        .map_err(error)?
        .execution_read_only(run_id(id)?)
        .map(execution_record)
        .map_err(error)
}
type HistoryRecord = (
    Vec<AgentRecord>,
    Vec<(TaskRecord, Vec<RunRecord>)>,
    Vec<ExecutionRecord>,
);
#[pyfunction]
fn history_snapshot(database: &str) -> PyResult<HistoryRecord> {
    let (core, executions) = SqliteStore::open(database)
        .map_err(error)?
        .execution_snapshot()
        .map_err(error)?;
    history_record(core, executions)
}
#[pyfunction]
fn history_snapshot_read_only(database: &str) -> PyResult<HistoryRecord> {
    let (core, executions) = ReadOnlyStore::open(database)
        .map_err(error)?
        .execution_snapshot()
        .map_err(error)?;
    history_record(core, executions)
}
fn history_record(
    core: llm_engine_core::Core,
    executions: Vec<llm_engine_sqlite::Execution>,
) -> PyResult<HistoryRecord> {
    let agents = core.agents().map(agent_record).collect();
    let tasks = core
        .tasks()
        .map(|task| {
            Ok((
                task_record(task),
                core.runs_for_task(task.id())
                    .map_err(error)?
                    .map(run_record)
                    .collect(),
            ))
        })
        .collect::<PyResult<Vec<_>>>()?;
    Ok((
        agents,
        tasks,
        executions.into_iter().map(execution_record).collect(),
    ))
}
#[pyfunction]
fn recover_executions(database: &str) -> PyResult<()> {
    SqliteStore::open(database)
        .map_err(error)?
        .recover_executions()
        .map_err(error)
}
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    configuration::register(m)?;
    skill_execution::register(m)?;
    hook_execution::register(m)?;
    loop_execution::register(m)?;
    m.add_function(wrap_pyfunction!(history_snapshot, m)?)?;
    m.add_function(wrap_pyfunction!(history_snapshot_read_only, m)?)?;
    m.add_function(wrap_pyfunction!(start_mcp_execution, m)?)?;
    m.add_function(wrap_pyfunction!(preflight_text_work, m)?)?;
    m.add_function(wrap_pyfunction!(execution_sources, m)?)?;
    m.add_function(wrap_pyfunction!(create_assigned_work, m)?)?;
    m.add_function(wrap_pyfunction!(start_web_execution, m)?)?;
    m.add_function(wrap_pyfunction!(start_execution, m)?)?;
    m.add_function(wrap_pyfunction!(finish_execution, m)?)?;
    m.add_function(wrap_pyfunction!(show_execution, m)?)?;
    m.add_function(wrap_pyfunction!(show_execution_read_only, m)?)?;
    m.add_function(wrap_pyfunction!(recover_executions, m)?)?;
    m.add_function(wrap_pyfunction!(start_run, m)?)?;
    m.add_function(wrap_pyfunction!(finish_run, m)?)?;
    m.add_function(wrap_pyfunction!(list_runs, m)?)?;
    m.add_function(wrap_pyfunction!(show_run, m)?)?;
    m.add_function(wrap_pyfunction!(create_team, m)?)?;
    m.add_function(wrap_pyfunction!(list_teams, m)?)?;
    m.add_function(wrap_pyfunction!(show_team, m)?)?;
    m.add_function(wrap_pyfunction!(add_team_members, m)?)?;
    m.add_function(wrap_pyfunction!(assign_team, m)?)?;

    m.add_function(wrap_pyfunction!(query_agents, m)?)?;
    m.add_function(wrap_pyfunction!(query_agent, m)?)?;
    m.add_function(wrap_pyfunction!(query_tasks, m)?)?;
    m.add_function(wrap_pyfunction!(query_task, m)?)?;
    m.add_function(wrap_pyfunction!(create_agent, m)?)?;
    m.add_function(wrap_pyfunction!(list_agents, m)?)?;
    m.add_function(wrap_pyfunction!(create_task, m)?)?;
    m.add_function(wrap_pyfunction!(list_tasks, m)?)?;
    m.add_function(wrap_pyfunction!(show_task, m)?)?;
    m.add_function(wrap_pyfunction!(assign_task, m)?)?;
    Ok(())
}
