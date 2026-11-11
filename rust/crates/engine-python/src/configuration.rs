//! Configuration-only adapters: no execution imports or callbacks.
use llm_engine_core::{
    AgentId, DomainError, Hook, HookEvent, HookId, HookTarget, LoopPolicy, LoopPolicyId, Skill,
    SkillId, TaskId, TeamId, persistence::Persistence,
};
use llm_engine_sqlite::{SqliteStore, StorageError};
use pyo3::{
    exceptions::{PyKeyError, PyOSError, PyValueError},
    prelude::*,
    types::PyDict,
};

fn domain_error(e: DomainError) -> PyErr {
    // Match typed variants; never infer categories from display text.
    match e {
        DomainError::UnknownSkill(_)
        | DomainError::UnknownHook(_)
        | DomainError::UnknownLoopPolicy(_)
        | DomainError::UnknownAgent(_)
        | DomainError::UnknownTeam(_)
        | DomainError::UnknownTask(_) => {
            PyKeyError::new_err("configuration record or reference not found")
        }
        _ => PyValueError::new_err(e.to_string()),
    }
}
fn storage_error(e: StorageError) -> PyErr {
    match e {
        StorageError::Domain(e) => domain_error(e),
        _ => PyOSError::new_err("configuration storage unavailable"),
    }
}
fn parse<T: std::str::FromStr>(value: &str) -> PyResult<T> {
    value
        .parse()
        .map_err(|_| PyValueError::new_err("invalid configuration identifier"))
}
fn target(kind: &str, id: &str) -> PyResult<HookTarget> {
    match kind {
        "agent" => Ok(HookTarget::Agent(parse::<AgentId>(id)?)),
        "team" => Ok(HookTarget::Team(parse::<TeamId>(id)?)),
        _ => Err(PyValueError::new_err("target_kind must be agent or team")),
    }
}
fn event(value: &str) -> PyResult<HookEvent> {
    match value {
        "task_created" => Ok(HookEvent::TaskCreated),
        "run_completed" => Ok(HookEvent::RunCompleted),
        "run_failed" => Ok(HookEvent::RunFailed),
        _ => Err(PyValueError::new_err("unsupported hook event")),
    }
}
fn skill_record(py: Python<'_>, value: &Skill) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("id", value.id().to_string())?;
    d.set_item("name", value.name())?;
    d.set_item("instructions", value.instructions())?;
    d.set_item("enabled", value.enabled())?;
    Ok(d.unbind())
}
fn hook_record(py: Python<'_>, value: &Hook) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("id", value.id().to_string())?;
    d.set_item("name", value.name())?;
    d.set_item("skill_id", value.skill_id().to_string())?;
    let (kind, id) = match value.target() {
        HookTarget::Agent(id) => ("agent", id.to_string()),
        HookTarget::Team(id) => ("team", id.to_string()),
    };
    d.set_item("target_kind", kind)?;
    d.set_item("target_id", id)?;
    d.set_item(
        "event",
        match value.event() {
            HookEvent::TaskCreated => "task_created",
            HookEvent::RunCompleted => "run_completed",
            HookEvent::RunFailed => "run_failed",
        },
    )?;
    d.set_item("enabled", value.enabled())?;
    Ok(d.unbind())
}
fn loop_record(py: Python<'_>, value: &LoopPolicy) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("id", value.id().to_string())?;
    d.set_item("name", value.name())?;
    d.set_item("task_id", value.task_id().to_string())?;
    d.set_item("max_iterations", value.max_iterations())?;
    d.set_item("interval_seconds", value.interval_seconds())?;
    d.set_item("enabled", value.enabled())?;
    Ok(d.unbind())
}

#[pyfunction]
fn create_skill(
    py: Python<'_>,
    database: &str,
    name: &str,
    instructions: &str,
) -> PyResult<Py<PyDict>> {
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            let id = core.create_skill(name, instructions)?;
            Ok(core.skill(id)?.clone())
        })
        .map_err(storage_error)?;
    skill_record(py, &value)
}

#[pyfunction]
fn update_skill(
    py: Python<'_>,
    database: &str,
    id: &str,
    name: &str,
    instructions: &str,
) -> PyResult<Py<PyDict>> {
    let id = parse::<SkillId>(id)?;

    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            core.update_skill(id, name, instructions)?;
            Ok(core.skill(id)?.clone())
        })
        .map_err(storage_error)?;
    skill_record(py, &value)
}

#[pyfunction]
fn show_skill(py: Python<'_>, database: &str, id: &str) -> PyResult<Py<PyDict>> {
    let id = parse::<SkillId>(id)?;
    let core = SqliteStore::open(database)
        .map_err(storage_error)?
        .read()
        .map_err(storage_error)?;
    skill_record(py, core.skill(id).map_err(domain_error)?)
}

#[pyfunction]
fn list_skills(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    let core = SqliteStore::open(database)
        .map_err(storage_error)?
        .read()
        .map_err(storage_error)?;
    core.skills().map(|value| skill_record(py, value)).collect()
}

#[pyfunction]
fn set_skill_enabled(
    py: Python<'_>,
    database: &str,
    id: &str,
    enabled: bool,
) -> PyResult<Py<PyDict>> {
    let id = parse::<SkillId>(id)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            core.set_skill_enabled(id, enabled)?;
            Ok(core.skill(id)?.clone())
        })
        .map_err(storage_error)?;
    skill_record(py, &value)
}

#[pyfunction]
fn create_hook(
    py: Python<'_>,
    database: &str,
    name: &str,
    skill_id: &str,
    target_kind: &str,
    target_id: &str,
    event_name: &str,
) -> PyResult<Py<PyDict>> {
    let skill_id = parse::<SkillId>(skill_id)?;
    let target = target(target_kind, target_id)?;
    let event = event(event_name)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            let id = core.create_hook(name, skill_id, target, event)?;
            Ok(core.hook(id)?.clone())
        })
        .map_err(storage_error)?;
    hook_record(py, &value)
}

#[pyfunction]
fn update_hook(
    py: Python<'_>,
    database: &str,
    id: &str,
    name: &str,
    skill_id: &str,
    target_kind: &str,
    target_id: &str,
    event_name: &str,
) -> PyResult<Py<PyDict>> {
    let id = parse::<HookId>(id)?;
    let skill_id = parse::<SkillId>(skill_id)?;
    let target = target(target_kind, target_id)?;
    let event = event(event_name)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            core.update_hook(id, name, skill_id, target, event)?;
            Ok(core.hook(id)?.clone())
        })
        .map_err(storage_error)?;
    hook_record(py, &value)
}

#[pyfunction]
fn show_hook(py: Python<'_>, database: &str, id: &str) -> PyResult<Py<PyDict>> {
    let id = parse::<HookId>(id)?;
    let core = SqliteStore::open(database)
        .map_err(storage_error)?
        .read()
        .map_err(storage_error)?;
    hook_record(py, core.hook(id).map_err(domain_error)?)
}

#[pyfunction]
fn list_hooks(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    let core = SqliteStore::open(database)
        .map_err(storage_error)?
        .read()
        .map_err(storage_error)?;
    core.hooks().map(|value| hook_record(py, value)).collect()
}

#[pyfunction]
fn set_hook_enabled(
    py: Python<'_>,
    database: &str,
    id: &str,
    enabled: bool,
) -> PyResult<Py<PyDict>> {
    let id = parse::<HookId>(id)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            core.set_hook_enabled(id, enabled)?;
            Ok(core.hook(id)?.clone())
        })
        .map_err(storage_error)?;
    hook_record(py, &value)
}

#[pyfunction]
fn create_loop(
    py: Python<'_>,
    database: &str,
    name: &str,
    task_id: &str,
    max_iterations: u32,
    interval_seconds: u32,
) -> PyResult<Py<PyDict>> {
    let task_id = parse::<TaskId>(task_id)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            let id = core.create_loop_policy(name, task_id, max_iterations, interval_seconds)?;
            Ok(core.loop_policy(id)?.clone())
        })
        .map_err(storage_error)?;
    loop_record(py, &value)
}

#[pyfunction]
fn update_loop(
    py: Python<'_>,
    database: &str,
    id: &str,
    name: &str,
    task_id: &str,
    max_iterations: u32,
    interval_seconds: u32,
) -> PyResult<Py<PyDict>> {
    let id = parse::<LoopPolicyId>(id)?;
    let task_id = parse::<TaskId>(task_id)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            core.update_loop_policy(id, name, task_id, max_iterations, interval_seconds)?;
            Ok(core.loop_policy(id)?.clone())
        })
        .map_err(storage_error)?;
    loop_record(py, &value)
}

#[pyfunction]
fn show_loop(py: Python<'_>, database: &str, id: &str) -> PyResult<Py<PyDict>> {
    let id = parse::<LoopPolicyId>(id)?;
    let core = SqliteStore::open(database)
        .map_err(storage_error)?
        .read()
        .map_err(storage_error)?;
    loop_record(py, core.loop_policy(id).map_err(domain_error)?)
}

#[pyfunction]
fn list_loops(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    let core = SqliteStore::open(database)
        .map_err(storage_error)?
        .read()
        .map_err(storage_error)?;
    core.loop_policies()
        .map(|value| loop_record(py, value))
        .collect()
}

#[pyfunction]
fn set_loop_enabled(
    py: Python<'_>,
    database: &str,
    id: &str,
    enabled: bool,
) -> PyResult<Py<PyDict>> {
    let id = parse::<LoopPolicyId>(id)?;
    let value = SqliteStore::open(database)
        .map_err(storage_error)?
        .transact(|core| {
            core.set_loop_policy_enabled(id, enabled)?;
            Ok(core.loop_policy(id)?.clone())
        })
        .map_err(storage_error)?;
    loop_record(py, &value)
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(create_skill, m)?)?;
    m.add_function(wrap_pyfunction!(update_skill, m)?)?;
    m.add_function(wrap_pyfunction!(show_skill, m)?)?;
    m.add_function(wrap_pyfunction!(list_skills, m)?)?;
    m.add_function(wrap_pyfunction!(set_skill_enabled, m)?)?;
    m.add_function(wrap_pyfunction!(create_hook, m)?)?;
    m.add_function(wrap_pyfunction!(update_hook, m)?)?;
    m.add_function(wrap_pyfunction!(show_hook, m)?)?;
    m.add_function(wrap_pyfunction!(list_hooks, m)?)?;
    m.add_function(wrap_pyfunction!(set_hook_enabled, m)?)?;
    m.add_function(wrap_pyfunction!(create_loop, m)?)?;
    m.add_function(wrap_pyfunction!(update_loop, m)?)?;
    m.add_function(wrap_pyfunction!(show_loop, m)?)?;
    m.add_function(wrap_pyfunction!(list_loops, m)?)?;
    m.add_function(wrap_pyfunction!(set_loop_enabled, m)?)?;
    Ok(())
}
