//! Explicit Hook adapters; safe errors never expose stored input or secrets.
use super::*;
use llm_engine_core::HookId;
use pyo3::types::PyDict;
fn rejected(_: impl std::fmt::Display) -> PyErr {
    error("hook preview rejected; refresh work and preview again")
}
#[pyfunction]
#[pyo3(signature=(database, task, hook_id, secrets=Vec::new()))]
fn preview_hook(
    py: Python<'_>,
    database: &str,
    task: &str,
    hook_id: &str,
    secrets: Vec<String>,
) -> PyResult<Py<PyDict>> {
    let task = task.parse::<TaskId>().map_err(rejected)?;
    let hook = hook_id.parse::<HookId>().map_err(rejected)?;
    let p = SqliteStore::open(database)
        .map_err(rejected)?
        .preview_hook(task, hook, &secrets)
        .map_err(rejected)?;
    let d = PyDict::new(py);
    d.set_item("schema_version", 1)?;
    d.set_item("hook_enabled", true)?;
    d.set_item("skill_enabled", true)?;
    d.set_item("target_kind", "agent")?;
    d.set_item("preview_id", p.preview_id)?;
    d.set_item("task_id", p.task_id.to_string())?;
    d.set_item("skill_id", p.skill_id.to_string())?;
    d.set_item("hook_id", p.hook_id)?;
    d.set_item("hook_name", p.hook_name)?;
    d.set_item("event", p.event)?;
    d.set_item("agent_id", p.agent_id)?;
    d.set_item("source_run_id", p.source_run_id)?;
    d.set_item("source_outcome", p.source_outcome)?;
    d.set_item("skill_name", p.skill_name)?;
    d.set_item("instructions", p.instructions)?;
    d.set_item("input", p.input)?;
    d.set_item("expected_runs", p.expected_runs)?;
    Ok(d.unbind())
}
#[pyfunction]
#[pyo3(signature=(database, task, preview_id, provider, model, expected_runs, secrets=Vec::new()))]
fn start_hook_execution(
    database: &str,
    task: &str,
    preview_id: &str,
    provider: &str,
    model: &str,
    expected_runs: usize,
    secrets: Vec<String>,
) -> PyResult<ExecutionRecord> {
    let task = task.parse::<TaskId>().map_err(rejected)?;
    SqliteStore::open(database)
        .map_err(rejected)?
        .start_hook_execution(task, preview_id, provider, model, expected_runs, &secrets)
        .map(execution_record)
        .map_err(rejected)
}
#[pyfunction]
fn hook_provenance(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    SqliteStore::open(database)
        .map_err(rejected)?
        .hook_provenance()
        .map_err(rejected)?
        .into_iter()
        .map(|p| {
            let d = PyDict::new(py);
            d.set_item("schema_version", 1)?;
            d.set_item("hook_enabled", true)?;
            d.set_item("skill_enabled", true)?;
            d.set_item("target_kind", "agent")?;
            d.set_item("run_id", p.run_id)?;
            d.set_item("preview_id", p.preview_id)?;
            d.set_item("skill_id", p.skill_id)?;
            d.set_item("skill_name", p.skill_name)?;
            d.set_item("instructions", p.instructions)?;
            d.set_item("task_id", p.task_id)?;
            d.set_item("hook_id", p.hook_id)?;
            d.set_item("hook_name", p.hook_name)?;
            d.set_item("event", p.event)?;
            d.set_item("agent_id", p.agent_id)?;
            d.set_item("source_run_id", p.source_run_id)?;
            d.set_item("source_outcome", p.source_outcome)?;
            d.set_item("input", p.input)?;
            d.set_item("admitted_at", p.admitted_at)?;
            Ok(d.unbind())
        })
        .collect()
}
pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(preview_hook, m)?)?;
    m.add_function(wrap_pyfunction!(start_hook_execution, m)?)?;
    m.add_function(wrap_pyfunction!(hook_provenance, m)?)?;
    Ok(())
}
