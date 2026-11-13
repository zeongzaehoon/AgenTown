import { useLayoutEffect, useRef, useState } from 'react';
import { WorkRecovery } from './WorkRecovery';
import { WorkHook } from './WorkHook';
import { WorkSkill } from './WorkSkill';
import { WorkExecution } from './WorkExecution';
import { RequestTimeoutError } from './api';
import { inspectSelectedWork, type InspectionResponse } from './work-inspection-api';

export function WorkInspection({taskId, connected = true}: {taskId: string | null; connected?: boolean}) {
  const [response, setResponse] = useState<InspectionResponse | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<{id: string; controller: AbortController} | null>(null);
  useLayoutEffect(() => {
    request.current?.controller.abort(); request.current = null;
    setResponse(null); setError(''); setPending(false);
    return () => { request.current?.controller.abort(); request.current = null; };
  }, [taskId, connected]);
  async function inspect() {
    if (!connected || !taskId || request.current) return;
    const active = {id: taskId, controller: new AbortController()};
    request.current = active; setPending(true); setResponse(null); setError('');
    try {
      const result = await inspectSelectedWork(taskId, active.controller.signal);
      if (request.current === active) setResponse(result);
    } catch (failure) {
      if (request.current === active) setError(failure instanceof RequestTimeoutError
        ? 'Local inspection timed out. Choose Inspect through local MCP to try again.'
        : 'Local inspection could not be confirmed. Check the local server and selected database, then choose Inspect through local MCP to try again.');
    } finally {
      if (request.current === active) {request.current = null; setPending(false);}
    }
  }
  const inspection = response?.status === 'success' ? response.inspection : null;
  return <section aria-label="Local MCP work inspection" aria-busy={pending}>
    <h3>Inspect selected work through local MCP</h3>
    <p>This reads recorded work through the installed local MCP server. It does not execute work or contact a provider. External-client connection remains unverified.</p>
    {!connected && <p role="status">Disconnected. Refresh the connection, then inspect explicitly for current readiness.</p>}
    {!taskId && <p role="status">Select saved work before inspecting. If it is missing, refresh saved history and select available work.</p>}
    <button type="button" disabled={!connected || !taskId || pending} onClick={() => void inspect()}>Inspect through local MCP</button>
    <p role="status" aria-live="polite">{pending ? 'Inspecting selected work through local MCP…' : ''}</p>
    {error && <p role="alert">{error}</p>}
    {response?.status === 'failure' && <div role="alert"><p>{response.message}</p><p>{response.recovery}</p><p>Inspection unavailable ({response.code}). Nothing is automatically retried.</p></div>}
    {taskId && <WorkRecovery key={`${taskId}/${connected}`} taskId={taskId} connected={connected} onRequest={() => {request.current?.controller.abort(); request.current = null; setPending(false); setResponse(null); setError('');}} onInspect={() => void inspect()} />}
    {inspection && <div>
      <p role="status">Confirmed local MCP inspection. External-client connection remains unverified.</p>
      <p>Evidence: installed local MCP · get_task · get_work_history_v1 (read_only=true) · inspect_loop_sessions_v1 · preflight_text_work_v1.</p>
      <p>Confirmed Task ID: {inspection.task.id}</p>
      <p>Recorded status: {inspection.task.status}</p><pre>{inspection.task.title}</pre>
      <p>Recorded assignment: {inspection.task.assignees.join(', ') || 'No employee assigned'}</p>
      <section aria-label="Ordinary-text execution readiness">
        <h4>Ordinary-text execution readiness</h4>
        <p>Advisory eligibility: {inspection.readiness.eligibility}</p>
        <p>Preflight Task ID: {inspection.readiness.task_id}</p>
        <p>Exact saved ordinary-text input</p>
        {inspection.readiness.input === null ? <p>Saved work was missing at preflight; no input or readiness is confirmed. Inspect again explicitly.</p> : <pre>{inspection.readiness.input}</pre>}
        <p>Preflight assigned employee IDs: {inspection.readiness.employee_ids.join(', ') || 'None'}</p>
        <p>Observed attempt count: {inspection.readiness.expected_runs}</p>
        <p>Active attempt observed: {inspection.readiness.active_attempt ? 'Yes' : 'No'}</p>
        <p>Resubmission consent required: {inspection.readiness.resubmission_consent_required ? 'Yes' : 'No'}</p>
        <p>Readiness does not validate provider configuration, grant consent or authorize execution. Execution must recheck current state.</p>
        <p>Each tool is a separate observation. Input, assignments and counts may differ as work changes between reads. Inspect again explicitly for newer observations.</p>
      </section>
      <WorkHook taskId={inspection.task.id} onInspect={() => void inspect()} />
      <WorkSkill taskId={inspection.task.id} onInspect={() => void inspect()} />
      <WorkExecution readiness={inspection.readiness} onInspect={() => void inspect()} />
      {!inspection.attempts.length && <p>No recorded attempts. No execution was requested by this inspection.</p>}
      {inspection.attempts.map((run, index) => <article key={run.id} aria-label={`Inspected attempt ${index + 1}`}>
        <h4>Attempt {index + 1}</h4><p>Run ID: {run.id}</p>
        <p>{run.state} · {run.outcome ?? 'No outcome recorded'} · {run.stage}</p>
        <p>Participants: {run.participants.join(', ') || 'None recorded'}</p>
        <p>Recorded source: {run.reporting_source}{run.declared_source ? ` · ${run.declared_source}` : ''}</p>
        {run.loop.linkage === 'confirmed' ? <section aria-label="Saved Loop context">
          <h5>Saved Loop policy: {run.loop.session.preview.policy_name}</h5>
          <p>Loop session ID: {run.loop.session.session_id} · Ordinal: {run.loop.ordinal}</p>
          <p>Policy ID: {run.loop.session.preview.policy_id} · Preview ID: {run.loop.session.preview.preview_id}</p>
          <p>Saved Loop input</p><pre>{run.loop.session.preview.input}</pre>
          <p>Saved limits: {run.loop.session.preview.max_iterations} attempts · {run.loop.session.preview.interval_seconds} seconds between attempts</p>
          <p>Saved expected prior runs: {run.loop.session.preview.expected_runs}</p>
          <p>Observed session state: {run.loop.session.state} · Observed admitted attempts: {run.loop.session.admitted} · Observed next time (Unix ms): {run.loop.session.next_at}</p>
          <p>Session progress was read separately from work history and may differ as work advances. Inspect again explicitly for newer observations.</p>
        </section> : run.loop.linkage === 'absent'
          ? <p>No recorded Loop linkage for this attempt.</p>
          : <p>Loop linkage is uncertain for this attempt. Separate reads may miss concurrent admission; inspect again explicitly. Absence is not confirmed.</p>}
        {run.hook && <section aria-label="Saved Hook context">
          <h5>Saved Hook: {run.hook.hook_name}</h5>
          <p>Hook ID: {run.hook.hook_id}</p>
          <p>Source Run ID: {run.hook.source_run_id} · {run.hook.event} · {run.hook.source_outcome}</p>
          <p>Target employee ID: {run.hook.agent_id}</p>
        </section>}
        {(run.skill || run.hook) ? (() => {
          const saved = (run.skill || run.hook)!;
          return <section aria-label="Saved Skill context">
            <h5>Saved Skill: {saved.skill_name}</h5>
            <p>Skill ID: {saved.skill_id}</p><p>Preview ID: {saved.preview_id}</p>
            <p>Saved instructions</p><pre>{saved.instructions}</pre>
            <p>Effective saved input</p><pre>{saved.input}</pre>
          </section>;
        })() : <p>No saved Skill or Hook context recorded for this attempt.</p>}
        {run.execution ? <>
          <p>Provider: {run.execution.provider} · Model: {run.execution.model}</p>
          {run.execution.output !== null ? <><p>Recorded result · Quality unverified</p><pre>{run.execution.output}</pre></> : <p>No recorded result available.</p>}
          {run.execution.error !== null && <p>Recorded execution error: {run.execution.error}</p>}
        </> : <p>No provider execution recorded for this attempt.</p>}
      </article>)}
    </div>}
  </section>;
}
