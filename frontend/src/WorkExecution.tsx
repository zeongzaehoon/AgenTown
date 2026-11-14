import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkReadiness } from './work-inspection-api';
import { executeSelectedWork, type WorkExecutionResponse } from './work-execution-api';

/** Mounted for exactly one explicit inspection. Consuming it never triggers a replay. */
export function WorkExecution({readiness, onInspect}: {readiness: WorkReadiness; onInspect: () => void}) {
  const [consent, setConsent] = useState(false);
  const [consumed, setConsumed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<WorkExecutionResponse | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const flow = useRef<HTMLElement>(null);
  const ownsFocus = useRef(false);
  useEffect(() => {
    const followFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      // Disabling submission can leave focus on the body or a focusable parent
      // inspection region without user navigation.
      if (target === document.body || (flow.current && target.contains(flow.current))) return;
      if (request.current) ownsFocus.current = flow.current?.contains(event.target as Node) ?? false;
    };
    document.addEventListener('focusin', followFocus);
    return () => document.removeEventListener('focusin', followFocus);
  }, []);
  const recovery = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => () => {request.current?.abort(); request.current = null;}, []);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const automaticFallback = active === document.body || !!(active && flow.current && active.contains(flow.current));
    if (consumed && !pending && ownsFocus.current &&
      (automaticFallback || flow.current?.contains(active))) {
      recovery.current?.focus();
    }
  }, [consumed, pending]);
  const eligible = readiness.eligibility === 'eligible' && !readiness.active_attempt;
  async function execute() {
    if (!eligible || !consent || consumed || request.current) return;
    ownsFocus.current = flow.current?.contains(document.activeElement) ?? false;
    const active = new AbortController(); request.current = active;
    setConsumed(true); setConsent(false); setPending(true);
    try {
      const response = await executeSelectedWork(readiness.task_id, readiness.expected_runs, active.signal);
      if (request.current === active) setResult(response);
    } catch {
      if (request.current === active) setError('Delivery is uncertain. The request may have executed. Inspect selected work before any new consent; nothing is automatically resent.');
    } finally {
      if (request.current === active) {
        request.current = null; setPending(false);
      }
    }
  }
  return <section ref={flow} aria-label="Execute inspected ordinary text" aria-busy={pending}>
    <h4>Execute inspected ordinary text</h4>
    <p>Review the exact saved input and assigned employee above. This sends one request using the server’s configured provider and model and may incur cost.</p>
    {!eligible && <p>Execution unavailable for this observation. Inspect again after resolving the assignment or active attempt.</p>}
    <label><input type="checkbox" checked={consent} disabled={!eligible || consumed}
      onChange={event => setConsent(event.target.checked)} />{readiness.expected_runs > 0
        ? 'I authorize one resubmission of this saved input, after reviewing prior attempts.'
        : 'I authorize one execution of this saved input.'}</label>
    <button type="button" disabled={!eligible || !consent || consumed} onClick={() => void execute()}>Execute once through local MCP</button>
    <p role="status">{pending ? 'Execution requested. Waiting for a recorded result…' : consumed ? 'Consent consumed. Inspect explicitly before another request.' : ''}</p>
    {error && <p role="alert">{error}</p>}
    {result && <div role={result.status === 'completed' ? 'status' : 'alert'}>
      <p>{result.status === 'completed' ? 'Transport completed: execution recorded. This does not establish provider success or result quality.' : `Execution ${result.status} (${result.code}).`}</p>
      <p>{result.recovery}</p>
      {result.execution && <>
        <p>Run ID: {result.execution.run_id} · Provider: {result.execution.provider} · Model: {result.execution.model}</p>
        <p>Quality unverified</p>
        {result.execution.output !== null && <pre>{result.execution.output}</pre>}
        {result.execution.error !== null && <p>Recorded provider error: {result.execution.error}</p>}
      </>}
    </div>}
    {consumed && <button ref={recovery} type="button" disabled={pending} onClick={onInspect}>Inspect before another execution</button>}
  </section>;
}
