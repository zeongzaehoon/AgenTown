import { useLayoutEffect, useRef, useState } from 'react';
import { RequestTimeoutError } from './api';
import { inspectSelectedWork, type InspectionResponse } from './work-inspection-api';

export function WorkInspection({taskId}: {taskId: string | null}) {
  const [response, setResponse] = useState<InspectionResponse | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<{id: string; controller: AbortController} | null>(null);
  useLayoutEffect(() => {
    request.current?.controller.abort(); request.current = null;
    setResponse(null); setError(''); setPending(false);
    return () => { request.current?.controller.abort(); request.current = null; };
  }, [taskId]);
  async function inspect() {
    if (!taskId || request.current) return;
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
    {!taskId && <p role="status">Select saved work before inspecting. If it is missing, refresh saved history and select available work.</p>}
    <button type="button" disabled={!taskId || pending} onClick={() => void inspect()}>Inspect through local MCP</button>
    <p role="status" aria-live="polite">{pending ? 'Inspecting selected work through local MCP…' : ''}</p>
    {error && <p role="alert">{error}</p>}
    {response?.status === 'failure' && <div role="alert"><p>{response.message}</p><p>{response.recovery}</p><p>Inspection unavailable ({response.code}). Nothing is automatically retried.</p></div>}
    {inspection && <div>
      <p role="status">Confirmed local MCP inspection. External-client connection remains unverified.</p>
      <p>Evidence: installed local MCP · get_task · get_work_history_v1 (read_only=true).</p>
      <p>Confirmed Task ID: {inspection.task.id}</p>
      <p>Recorded status: {inspection.task.status}</p><pre>{inspection.task.title}</pre>
      <p>Recorded assignment: {inspection.task.assignees.join(', ') || 'No employee assigned'}</p>
      {!inspection.attempts.length && <p>No recorded attempts. No execution was requested by this inspection.</p>}
      {inspection.attempts.map((run, index) => <article key={run.id} aria-label={`Inspected attempt ${index + 1}`}>
        <h4>Attempt {index + 1}</h4><p>Run ID: {run.id}</p>
        <p>{run.state} · {run.outcome ?? 'No outcome recorded'} · {run.stage}</p>
        <p>Participants: {run.participants.join(', ') || 'None recorded'}</p>
        <p>Recorded source: {run.reporting_source}{run.declared_source ? ` · ${run.declared_source}` : ''}</p>
        {run.execution ? <>
          <p>Provider: {run.execution.provider} · Model: {run.execution.model}</p>
          {run.execution.output !== null ? <><p>Recorded result · Quality unverified</p><pre>{run.execution.output}</pre></> : <p>No recorded result available.</p>}
          {run.execution.error !== null && <p>Recorded execution error: {run.execution.error}</p>}
        </> : <p>No provider execution recorded for this attempt.</p>}
      </article>)}
    </div>}
  </section>;
}
