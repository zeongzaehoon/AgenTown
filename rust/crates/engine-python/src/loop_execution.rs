//! Thin Loop interface. Runtime ownership is supplied by the execution service.
use super::*;
use llm_engine_core::{LoopPolicyId, LoopSessionId};
use llm_engine_sqlite::{LoopExecutionOwner, LoopPreview, LoopSession};
use pyo3::types::PyDict;
fn rejected(_: impl std::fmt::Display) -> PyErr {
    error("loop command rejected; refresh and explicitly preview/start again")
}
/// Explicitly close only after execution workers have joined/cancelled.
#[pyclass]
struct LoopOwner {
    inner: Option<LoopExecutionOwner>,
}
#[pymethods]
impl LoopOwner {
    fn close(&mut self) {
        self.inner.take();
    }
}
impl LoopOwner {
    fn get(&self) -> PyResult<&LoopExecutionOwner> {
        self.inner
            .as_ref()
            .ok_or_else(|| rejected("closed execution owner"))
    }
}
#[pyfunction]
fn acquire_loop_execution_owner(database: &str) -> PyResult<LoopOwner> {
    Ok(LoopOwner {
        inner: Some(LoopExecutionOwner::acquire(database).map_err(|_| {
            error("Loop execution ownership unavailable; another execution service may be active")
        })?),
    })
}
fn preview_record(py: Python<'_>, p: LoopPreview) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("schema_version", 1)?;
    d.set_item("preview_id", p.preview_id)?;
    d.set_item("policy_id", p.policy_id.to_string())?;
    d.set_item("policy_name", p.policy_name)?;
    d.set_item("task_id", p.task_id.to_string())?;
    d.set_item("agent_id", p.agent_id.to_string())?;
    d.set_item("input", p.input)?;
    d.set_item("max_iterations", p.max_iterations)?;
    d.set_item("interval_seconds", p.interval_seconds)?;
    d.set_item("expected_runs", p.expected_runs)?;
    d.set_item("created_at", p.created_at)?;
    d.set_item("policy_enabled", true)?;
    Ok(d.unbind())
}
fn session_record(py: Python<'_>, s: LoopSession) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("schema_version", 1)?;
    d.set_item("session_id", s.session_id.to_string())?;
    d.set_item("preview", preview_record(py, s.preview)?)?;
    d.set_item("state", s.state)?;
    d.set_item("provider", s.provider)?;
    d.set_item("model", s.model)?;
    d.set_item("started_at", s.started_at)?;
    d.set_item("expires_at", s.expires_at)?;
    d.set_item("admitted", s.admitted)?;
    d.set_item("next_at", s.next_at)?;
    d.set_item("declared_source", s.declared_source)?;
    Ok(d.unbind())
}
#[pyfunction]
#[pyo3(signature=(database,policy_id,secrets=Vec::new()))]
fn preview_loop(
    py: Python<'_>,
    database: &str,
    policy_id: &str,
    secrets: Vec<String>,
) -> PyResult<Py<PyDict>> {
    let p = SqliteStore::open(database)
        .map_err(rejected)?
        .preview_loop(
            policy_id.parse::<LoopPolicyId>().map_err(rejected)?,
            &secrets,
        )
        .map_err(rejected)?;
    preview_record(py, p)
}
#[pyfunction]
#[pyo3(signature=(owner,preview_id,expected_runs,provider,model,secrets=Vec::new(),declared_source=None))]
fn start_loop_session(
    py: Python<'_>,
    owner: &LoopOwner,
    preview_id: &str,
    expected_runs: usize,
    provider: &str,
    model: &str,
    secrets: Vec<String>,
    declared_source: Option<&str>,
) -> PyResult<Py<PyDict>> {
    session_record(
        py,
        owner
            .get()?
            .start(
                preview_id,
                expected_runs,
                provider,
                model,
                &secrets,
                declared_source,
            )
            .map_err(rejected)?,
    )
}
#[pyfunction]
#[pyo3(signature=(owner,session_id,secrets=Vec::new()))]
fn admit_loop_attempt(
    owner: &LoopOwner,
    session_id: &str,
    secrets: Vec<String>,
) -> PyResult<Option<ExecutionRecord>> {
    owner
        .get()?
        .admit(
            session_id.parse::<LoopSessionId>().map_err(rejected)?,
            &secrets,
        )
        .map(|e| e.map(execution_record))
        .map_err(rejected)
}
#[pyfunction]
fn stop_loop_session(py: Python<'_>, owner: &LoopOwner, session_id: &str) -> PyResult<Py<PyDict>> {
    session_record(
        py,
        owner
            .get()?
            .stop(session_id.parse::<LoopSessionId>().map_err(rejected)?)
            .map_err(rejected)?,
    )
}
#[pyfunction]
fn recover_loop_sessions(owner: &LoopOwner) -> PyResult<()> {
    owner.get()?.recover().map_err(rejected)
}
#[pyfunction]
fn loop_sessions(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    SqliteStore::open(database)
        .map_err(rejected)?
        .loop_sessions()
        .map_err(rejected)?
        .into_iter()
        .map(|s| session_record(py, s))
        .collect()
}
#[pyfunction]
fn loop_attempts(py: Python<'_>, database: &str) -> PyResult<Vec<Py<PyDict>>> {
    SqliteStore::open(database)
        .map_err(rejected)?
        .loop_attempts()
        .map_err(rejected)?
        .into_iter()
        .map(|a| {
            let d = PyDict::new(py);
            d.set_item("schema_version", 1)?;
            d.set_item("session_id", a.session_id.to_string())?;
            d.set_item("run_id", a.run_id.to_string())?;
            d.set_item("ordinal", a.ordinal)?;
            d.set_item("admitted_at", a.admitted_at)?;
            Ok(d.unbind())
        })
        .collect()
}
pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<LoopOwner>()?;
    m.add_function(wrap_pyfunction!(acquire_loop_execution_owner, m)?)?;
    m.add_function(wrap_pyfunction!(preview_loop, m)?)?;
    m.add_function(wrap_pyfunction!(start_loop_session, m)?)?;
    m.add_function(wrap_pyfunction!(admit_loop_attempt, m)?)?;
    m.add_function(wrap_pyfunction!(stop_loop_session, m)?)?;
    m.add_function(wrap_pyfunction!(recover_loop_sessions, m)?)?;
    m.add_function(wrap_pyfunction!(loop_sessions, m)?)?;
    m.add_function(wrap_pyfunction!(loop_attempts, m)?)?;
    Ok(())
}
