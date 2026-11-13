import type { LoopNavigation } from './OverviewLoops';
import { useLayoutEffect, useRef, useState } from 'react';
import { canControl, controlText } from './loop-control';
import { loopLabel } from './LoopExecution';
import type { LoopAttempt, LoopInspection, LoopSession } from './loop-response';
import type { LoopRecord } from './configuration-api';
import { localLoop, type LocalLoopPreview, type LoopOperation } from './work-loop-api';

function executionLabel(execution: LoopAttempt['execution']): string {
  if (!execution) return 'Execution record unavailable · Provider completion unknown';
  if (execution.state === 'active') return 'Active · Waiting for provider response';
  if (execution.state === 'finished' || (!execution.state && execution.outcome)) {
    if ((execution.outcome === 'reported_success' || execution.outcome === 'success')) return 'Finished · Provider execution succeeded';
    if (execution.outcome === 'failure') return 'Finished · Provider execution failed';
    return `Finished · ${execution.outcome || 'Terminal outcome unavailable'}`;
  }
  return `Execution state: ${execution.state || 'unavailable'} · Provider completion unknown`;
}

/** Kept mounted across inspection/selection changes so owner Stop remains reachable. */
export function WorkLoop({taskId, connected, inspected, navigation}: {navigation?: LoopNavigation | null; taskId: string | null; connected: boolean; inspected: boolean}) {
  const [policies, setPolicies] = useState<LoopRecord[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<LocalLoopPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [records, setRecords] = useState<Record<string, LoopInspection>>({});
  const [receipts, setReceipts] = useState<Record<string, LoopSession>>({});
  const [focusedSession, setFocusedSession] = useState('');
  const [focusedPolicy, setFocusedPolicy] = useState('');
  const [uncertainStops, setUncertainStops] = useState<string[]>([]);
  const policyControl = useRef<HTMLSelectElement>(null);
  const navigationRegion = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recoveryRead, setRecoveryRead] = useState<string[]>([]);
  const [recovery, setRecovery] = useState<string[]>([]);
  const pending = useRef<AbortController | null>(null);
  const region = useRef<HTMLElement>(null);
  const previewRegion = useRef<HTMLElement>(null);
  const previewControl = useRef<HTMLButtonElement>(null);
  const operation = useRef<LoopOperation | null>(null);
  const revision = useRef(0);
  const previousDestination = useRef({taskId, navigation});
  function invalidate() {++revision.current; setPreview(null); setConsent(false); setFocusedPolicy('');}
  useLayoutEffect(() => {
    // Recover only focus owned by the disappearing preview. Requested navigation
    // has its own destination and takes precedence over this fallback.
    const ownedFocus = previewRegion.current?.contains(document.activeElement);
    const hadPreview = !!previewRegion.current;
    const requestedNavigation = !!navigation && (previousDestination.current.navigation !== navigation || previousDestination.current.taskId !== taskId);
    previousDestination.current = {taskId, navigation};
    invalidate(); setPolicies([]); setSelected('');
    setMessage(hadPreview ? 'Local Loop preview dismissed. Consent cleared. No activation requested.' : '');
    if (ownedFocus && !requestedNavigation) region.current?.focus();
    if (operation.current && !['start', 'stop'].includes(operation.current)) {pending.current?.abort(); pending.current = null; setBusy(false);}
  }, [taskId, connected, inspected, navigation]);
  useLayoutEffect(() => {setFocusedSession(''); if (navigation) navigationRegion.current?.focus();}, [navigation, taskId]);
  useLayoutEffect(() => {if (focusedSession) document.getElementById(`local-session-${focusedSession}`)?.focus();}, [focusedSession]);
  useLayoutEffect(() => {
    if (focusedPolicy && !busy) policyControl.current?.focus();
  }, [focusedPolicy, busy]);
  useLayoutEffect(() => () => {pending.current?.abort(); pending.current = null;}, []);
  useLayoutEffect(() => {if (preview) previewRegion.current?.focus();}, [preview]);
  function dismissPreview() {
    if (!preview || busy) return;
    invalidate();
    setMessage('Local Loop preview dismissed. Consent cleared. No activation requested.');
    if (previewControl.current && !previewControl.current.disabled) previewControl.current.focus();
    else region.current?.focus();
  }
  async function perform(op: LoopOperation, task = taskId, saved?: LoopSession) {
    if (!task || !connected || pending.current || (op === 'start' && (!preview || !consent || recovery.includes(task)))) return;
    const expected = op === 'preview' ? selected : op === 'start' ? preview! : saved;
    invalidate(); if (op === 'inspect') setFocusedSession(''); const generation = revision.current;
    const active = new AbortController(); operation.current = op; pending.current = active; setBusy(true);
    if (op === 'start') {setRecovery(rows => [...new Set([...rows, task])]); setRecoveryRead(rows => rows.filter(t => t !== task));}
    try {
      let result = await localLoop(op, task, active.signal, expected);
      if (op === 'stop' && result.receipt) {
        const receipt = result.receipt;
        const confirmed = await localLoop('inspect', task, active.signal);
        const persisted = confirmed.inspection?.sessions.find(s => s.session_id === receipt.session_id);
        if (confirmed.status !== 'confirmed' || !persisted || persisted.state !== 'stopped' || JSON.stringify(persisted.preview) !== JSON.stringify(receipt.preview) || persisted.provider !== receipt.provider || persisted.model !== receipt.model) throw new Error('Stopped state unconfirmed');
        result = {...confirmed, recovery: 'Saved stopped state confirmed. Remote completion may remain unknown.'};
      }
      if (pending.current !== active) return;
      if (op === 'stop' && saved && result.status === 'uncertain') setUncertainStops(rows => [...new Set([...rows, saved.session_id])]);
      if (op !== 'start' && op !== 'stop' && generation !== revision.current) return;
      // Mutation provenance is retained even if selection changes during delivery.
      if (result.receipt) {setReceipts(rows => ({...rows, [result.receipt!.session_id]: result.receipt!})); setRecoveryRead(rows => rows.filter(t => t !== task));}
      if (result.inspection) {
        {
          const prior = records[task];
          if (result.inspection!.sessions.some(s => {
            const old = receipts[s.session_id] || prior?.sessions.find(p => p.session_id === s.session_id);
            return old && (JSON.stringify(old.preview) !== JSON.stringify(s.preview) || old.provider !== s.provider || old.model !== s.model);
          })) throw new Error('Saved provenance changed');
          setRecords(rows => ({...rows, [task]: result.inspection!}));
          if (op === 'inspect') {
            setUncertainStops(rows => rows.filter(id => !result.inspection!.sessions.some(s => s.session_id === id)));
            if (navigation?.sessionId && navigation.taskId === task && generation === revision.current) {
              const found = result.inspection.sessions.find(s => s.session_id === navigation.sessionId);
              setFocusedSession(found?.session_id || '');
              if (!found) {setMessage('Requested Loop session is missing from this Task inspection. Nothing was started or stopped.'); return;}
            }
          }
          if (op === 'inspect') setRecoveryRead(rows => [...new Set([...rows, task])]);
          setReceipts(rows => {const next = {...rows}; result.inspection!.sessions.forEach(s => {delete next[s.session_id];}); return next;});
        }
      }
      if (generation === revision.current) {
        if (result.policies) {
          setPolicies(result.policies); setSelected('');
          if (navigation?.policyId && navigation.taskId === task) {
            const found = result.policies.find(p => p.id === navigation.policyId);
            if (!found || found.task_id !== task || !found.enabled) {
              setMessage(!found ? 'Requested Loop policy is missing or no longer matches this Task. Nothing was previewed or activated.' : !found.enabled ? 'Requested Loop policy is disabled. Nothing was previewed or activated.' : 'Requested Loop policy no longer matches this Task. Nothing was previewed or activated.');
              return;
            }
            setSelected(found.id);
            setFocusedPolicy(found.id);
          }
        }
        if (result.preview) setPreview(result.preview);
      }
      setMessage(`${result.status} (${result.code}). ${result.recovery}${result.receipt ? ' Receipt received; inspect persisted sessions to confirm progress.' : ''}`);
    } catch {
      if (op === 'stop' && saved) setUncertainStops(rows => [...new Set([...rows, saved.session_id])]);
      if (pending.current === active && (generation === revision.current || op === 'start' || op === 'stop')) setMessage(op === 'start' || op === 'stop'
        ? 'Delivery uncertain. Activation or Stop may have reached the owner. Inspect persisted sessions before any new activation. Nothing is resent automatically.'
        : 'Local MCP response could not be confirmed. Inspect explicitly before trying again.');
    } finally {if (pending.current === active) {pending.current = null; setBusy(false); if (generation === revision.current && (op === 'start' || op === 'stop')) region.current?.focus();}}
  }
  const sessions = new Map<string, LoopSession>();
  Object.values(records).forEach(r => r.sessions.forEach(s => sessions.set(s.session_id, s)));
  Object.values(receipts).forEach(s => sessions.set(s.session_id, s));
  return <section ref={region} tabIndex={-1} aria-label="Bounded Loop through local MCP" aria-busy={busy}>
    {navigation && <section ref={navigationRegion} tabIndex={-1} aria-label="Requested Loop inspection"><p>Requested Task: {navigation.taskId} · {navigation.policyId ? `Policy: ${navigation.policyId}. Choose Inspect through local MCP, then Find matching Loops through local MCP to select this exact policy.` : `Loop: ${navigation.sessionId}. Choose Inspect local Loop sessions to read and focus this exact session.`} Cached records may be stale; navigation grants no ownership.</p></section>}
    <h4>Bounded Loop through local MCP</h4>
    <p>Enabled means configured only. Discovery and preview never activate work. Explicit activation may incur provider costs. External-client connection and live-provider operation remain unverified.</p>
    {!connected && <p>Disconnected. Session records may be stale. Reconnect to request Stop through the retained owner.</p>}
    <button type="button" disabled={!inspected || !connected || busy} onClick={() => void perform('list')}>Find matching Loops through local MCP</button>
    <label>Local enabled Loop <select ref={policyControl} value={selected} disabled={busy || !connected || !inspected} onChange={e => {invalidate(); setSelected(e.target.value);}}>
      <option value="">Choose a Loop</option>{policies.filter(p => p.enabled && p.task_id === taskId).map(p => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}
    </select></label>
    <button ref={previewControl} type="button" disabled={!selected || busy || !connected || !inspected || recovery.includes(taskId || '')} onClick={() => void perform('preview')}>Preview local Loop</button>
    <button type="button" disabled={!taskId || !connected || busy} onClick={() => void perform('inspect')}>Inspect local Loop sessions</button>
    {taskId && recovery.includes(taskId) && <><p>Activation consent consumed. Inspect persisted sessions and attempts before acknowledging recovery and requesting a fresh preview.</p><button type="button" disabled={busy || !connected || !recoveryRead.includes(taskId)} onClick={() => {invalidate(); setRecovery(rows => rows.filter(t => t !== taskId));}}>I inspected local Loop records</button></>}
    <p role="status">{busy ? 'Waiting for retained local MCP owner…' : message}</p>
    {preview && <section ref={previewRegion} tabIndex={-1} aria-label="Local Loop preview" onKeyDown={e => {if (e.key === 'Escape') {e.preventDefault(); e.stopPropagation(); dismissPreview();}}}>
      <h5>{preview.policy_name}</h5><p>Task: {preview.task_id} · Employee: {preview.agent_id} · Policy: {preview.policy_id}</p>
      <p>Exact input</p><pre>{preview.input}</pre>
      <p>Maximum attempts: {preview.max_iterations} · Interval: {preview.interval_seconds} seconds · Prior attempts: {preview.expected_runs}</p>
      <p>Provider: {preview.provider} · Model: {preview.model} · Preview ID: {preview.preview_id}</p>
      <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I authorize one activation of this exact bounded Loop preview.</label>
      <button type="button" disabled={!consent || busy || !connected} onClick={() => void perform('start')}>Authorize and activate local Loop</button>
      <button type="button" onClick={dismissPreview}>Cancel local Loop preview</button>
    </section>}
    <p>Stop prevents new admissions and attempts local cancellation. Remote completion may remain unknown. Disconnecting or changing selection does not stop a session.</p>
    {[...sessions.values()].map(s => <section tabIndex={-1} id={`local-session-${s.session_id}`} key={s.session_id} aria-label={`Local Loop session ${s.session_id}`}>
      <h5>{s.preview.policy_name} · {s.session_id}</h5><p>Task: {s.preview.task_id}</p>
      <p>{loopLabel(s, records[s.preview.task_id]?.attempts || [])} · Admitted: {s.admitted} / {s.preview.max_iterations}</p>
      <p>{controlText(records[s.preview.task_id]?.control)}</p>
      <button type="button" disabled={busy || !connected} onClick={() => void perform('inspect', s.preview.task_id)}>Inspect retained session {s.session_id}</button>
      {s.state === 'active' && <button type="button" disabled={busy || !connected || uncertainStops.includes(s.session_id) || (!!records[s.preview.task_id] && !canControl(records[s.preview.task_id].control))} onClick={() => void perform('stop', s.preview.task_id, s)}>Stop local Loop {s.session_id}</button>}
      <p>Saved input</p><pre>{s.preview.input}</pre><p>Quality unverified</p>
      {records[s.preview.task_id]?.attempts.filter(a => a.session_id === s.session_id).map(a => <article key={a.run_id}><p>Attempt {a.ordinal} · {a.run_id} · {executionLabel(a.execution)}</p>{a.execution?.output != null && <pre>{a.execution.output}</pre>}{a.execution?.error && <p>{a.execution.error}</p>}</article>)}
    </section>)}
  </section>;
}
