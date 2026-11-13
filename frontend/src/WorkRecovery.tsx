import { useLayoutEffect, useRef, useState } from 'react';
import { reconcileSelectedWork, type WorkRecoveryResponse } from './work-recovery-api';

export function WorkRecovery({taskId, connected, onRequest, onInspect}: {
  taskId: string; connected: boolean; onRequest: () => void; onInspect: () => void;
}) {
  const [review, setReview] = useState(false);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<WorkRecoveryResponse | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [consumed, setConsumed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const checkbox = useRef<HTMLInputElement>(null);
  const inspect = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => () => {request.current?.abort(); request.current = null;}, []);
  useLayoutEffect(() => {if (review) checkbox.current?.focus();}, [review]);
  useLayoutEffect(() => {if (consumed && !pending) inspect.current?.focus();}, [consumed, pending]);
  async function recover() {
    if (!connected || !consent || consumed || request.current) return;
    const active = new AbortController(); request.current = active;
    setPending(true); setConsumed(true); setConsent(false); onRequest();
    try {
      const response = await reconcileSelectedWork(taskId, active.signal);
      if (request.current === active) setResult(response);
    } catch {if (request.current === active) setUncertain(true);}
    finally {if (request.current === active) {request.current = null; setPending(false);}}
  }
  return <section aria-label="Recover expired attempts" aria-busy={pending}>
    <h4>Recover expired attempts</h4>
    <p>Selected Task ID: {taskId}</p>
    <button type="button" disabled={!connected || pending} onClick={() => {setReview(true); setConsent(false); setConsumed(false); setResult(null); setUncertain(false);}}>Review recovery scope</button>
    {review && <>
      <p>Recovery may mark expired attempts as interrupted across other work in the database history snapshot. The selected work limits the returned history, not which expired attempts can change. Live attempts remain active. This never executes work or contacts a provider.</p>
      <p>Requesting recovery clears prior execution consent. Inspect again explicitly and give new execution consent before executing.</p>
      <label><input ref={checkbox} type="checkbox" checked={consent} disabled={!connected || consumed} onChange={e => setConsent(e.target.checked)} />I authorize reconciliation of expired attempts across the database history snapshot.</label>
      <button type="button" disabled={!connected || !consent || consumed} onClick={() => void recover()}>Reconcile expired attempts once</button>
    </>}
    <p role="status">{pending ? 'Recovery requested. Waiting for confirmation…' : ''}</p>
    {(uncertain || result?.status === 'uncertain') && <p role="alert">Recovery delivery is uncertain. Changes may already have persisted. Inspect read-only before deciding on another explicit recovery request. Nothing is automatically resent.</p>}
    {result && <div role={result.status === 'confirmed' ? 'status' : 'alert'}>
      {result.status === 'confirmed' ? <>
        <p>Reconciliation confirmed. This receipt does not prove which attempts changed.</p>
        {result.inspection!.attempts.some(run => run.execution?.error === 'interrupted') && <p>Recovered state observed: interrupted attempts recorded.</p>}
        {result.inspection!.attempts.some(run => run.state === 'active') && <p>Unchanged-active state observed: active attempts remain. Rust decides lease expiry.</p>}
        {!result.inspection!.attempts.length && <p>No attempts returned for selected work.</p>}
      </> : <p>Recovery {result.status} ({result.code}).</p>}
      <p>{result.recovery}</p>
    </div>}
    {consumed && <button type="button" ref={inspect} disabled={!connected || pending} onClick={onInspect}>Inspect after recovery</button>}
  </section>;
}
