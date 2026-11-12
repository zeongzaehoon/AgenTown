//! Explicit Skill adapters; safe errors never expose stored input or secrets.
use super::*;
use llm_engine_core::SkillId;
use pyo3::types::PyDict;
fn rejected(_: impl std::fmt::Display) -> PyErr {
    error("skill preview rejected; refresh work and preview again")
}
#[pyfunction]
#[pyo3(signature=(database, task, skill_id, secrets=Vec::new()))]
fn preview_skill(
    py: Python<'_>,
    database: &str,
    task: &str,
    skill_id: &str,
    secrets: Vec<String>,
) -> PyResult<Py<PyDict>> {
    let task = task.parse::<TaskId>().map_err(rejected)?;
    let skill = skill_id.parse::<SkillId>().map_err(rejected)?;
    let p = SqliteStore::open(database)
        .map_err(rejected)?
        .preview_skill(task, skill, &secrets)
        .map_err(rejected)?;
    let d = PyDict::new(py);
    d.set_item("schema_version", 1)?;
    d.set_item("preview_id", p.preview_id)?;
    d.set_item("task_id", p.task_id.to_string())?;
    d.set_item("skill_id", p.skill_id.to_string())?;
    d.set_item("input", p.input)?;
    d.set_item("expected_runs", p.expected_runs)?;
    Ok(d.unbind())
}
#[pyfunction]
#[pyo3(signature=(database, task, preview_id, provider, model, expected_runs, secrets=Vec::new(), declared_source=None))]
fn start_skill_execution(
    database: &str,
    task: &str,
    preview_id: &str,
    provider: &str,
    model: &str,
    expected_runs: usize,
    secrets: Vec<String>,
    declared_source: Option<&str>,
) -> PyResult<ExecutionRecord> {
    let task = task.parse::<TaskId>().map_err(rejected)?;
    SqliteStore::open(database)
        .map_err(rejected)?
        .start_skill_execution_with_source(
            task,
            preview_id,
            provider,
            model,
            expected_runs,
            &secrets,
            declared_source,
        )
        .map(execution_record)
        .map_err(rejected)
}
#[pyfunction]
fn skill_provenance(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    SqliteStore::open(database)
        .map_err(rejected)?
        .skill_provenance()
        .map_err(rejected)?
        .into_iter()
        .map(|p| {
            let d = PyDict::new(py);
            d.set_item("schema_version", 1)?;
            d.set_item("run_id", p.run_id)?;
            d.set_item("preview_id", p.preview_id)?;
            d.set_item("skill_id", p.skill_id)?;
            d.set_item("skill_name", p.skill_name)?;
            d.set_item("instructions", p.instructions)?;
            d.set_item("input", p.input)?;
            d.set_item("admitted_at", p.admitted_at)?;
            Ok(d.unbind())
        })
        .collect()
}
pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(preview_skill, m)?)?;
    m.add_function(wrap_pyfunction!(start_skill_execution, m)?)?;
    m.add_function(wrap_pyfunction!(skill_provenance, m)?)?;
    Ok(())
}
