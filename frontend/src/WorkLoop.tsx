import { useLayoutEffect, useRef, useState } from 'react';
import { canControl, controlText } from './loop-control';
import { loopLabel } from './LoopExecution';
import type { LoopInspection, LoopSession } from './loop-response';
import type { LoopRecord } from './configuration-api';
import { localLoop, type LocalLoopPreview, type LoopOperation } from './work-loop-api';

/** Kept mounted across inspection/selection changes so owner Stop remains reachable. */
export function WorkLoop({taskId, connected, inspected}: {taskId: string | null; connected: boolean; inspected: boolean}) {
  const [policies, setPolicies] = useState<LoopRecord[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<LocalLoopPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [records, setRecords] = useState<Record<string, LoopInspection>>({});
  const [receipts, setReceipts] = useState<Record<string, LoopSession>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recoveryRead, setRecoveryRead] = useState<string[]>([]);
  const [recovery, setRecovery] = useState<string[]>([]);
  const pending = useRef<AbortController | null>(null);
  const region = useRef<HTMLElement>(null);
  const previewRegion = useRef<HTMLElement>(null);
  const revision = useRef(0);
  function invalidate() {++revision.current; setPreview(null); setConsent(false);}
  useLayoutEffect(() => {invalidate(); setPolicies([]); setSelected('');}, [taskId, connected, inspected]);
  useLayoutEffect(() => () => {pending.current?.abort(); pending.current = null;}, []);
  useLayoutEffect(() => {if (preview) previewRegion.current?.focus();}, [preview]);
  async function perform(op: LoopOperation, task = taskId, saved?: LoopSession) {
    if (!task || !connected || pending.current || (op === 'start' && (!preview || !consent || recovery.includes(task)))) return;
    const expected = op === 'preview' ? selected : op === 'start' ? preview! : saved;
    invalidate(); const generation = revision.current;
    const active = new AbortController(); pending.current = active; setBusy(true);
    if (op === 'start') {setRecovery(rows => [...new Set([...rows, task])]); setRecoveryRead(rows => rows.filter(t => t !== task));}
    try {
      const result = await localLoop(op, task, active.signal, expected);
      if (pending.current !== active) return;
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
          if (op === 'inspect') setRecoveryRead(rows => [...new Set([...rows, task])]);
          setReceipts(rows => {const next = {...rows}; result.inspection!.sessions.forEach(s => {delete next[s.session_id];}); return next;});
        }
      }
      if (generation === revision.current) {
        if (result.policies) {setPolicies(result.policies); setSelected('');}
        if (result.preview) setPreview(result.preview);
      }
      setMessage(`${result.status} (${result.code}). ${result.recovery}${result.receipt ? ' Receipt received; inspect persisted sessions to confirm progress.' : ''}`);
    } catch {
      if (pending.current === active) setMessage(op === 'start' || op === 'stop'
        ? 'Delivery uncertain. Activation or Stop may have reached the owner. Inspect persisted sessions before any new activation. Nothing is resent automatically.'
        : 'Local MCP response could not be confirmed. Inspect explicitly before trying again.');
    } finally {if (pending.current === active) {pending.current = null; setBusy(false); if (op === 'start' || op === 'stop') region.current?.focus();}}
  }
  const sessions = new Map<string, LoopSession>();
  Object.values(records).forEach(r => r.sessions.forEach(s => sessions.set(s.session_id, s)));
  Object.values(receipts).forEach(s => sessions.set(s.session_id, s));
  return <section ref={region} tabIndex={-1} aria-label="Bounded Loop through local MCP" aria-busy={busy}>
    <h4>Bounded Loop through local MCP</h4>
    <p>Enabled means configured only. Discovery and preview never activate work. Explicit activation may incur provider costs. External-client connection and live-provider operation remain unverified.</p>
    {!connected && <p>Disconnected. Session records may be stale. Reconnect to request Stop through the retained owner.</p>}
    <button type="button" disabled={!inspected || !connected || busy} onClick={() => void perform('list')}>Find matching Loops through local MCP</button>
    <label>Local enabled Loop <select value={selected} disabled={busy || !connected || !inspected} onChange={e => {invalidate(); setSelected(e.target.value);}}>
      <option value="">Choose a Loop</option>{policies.filter(p => p.enabled).map(p => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}
    </select></label>
    <button type="button" disabled={!selected || busy || !connected || !inspected || recovery.includes(taskId || '')} onClick={() => void perform('preview')}>Preview local Loop</button>
    <button type="button" disabled={!taskId || !connected || busy} onClick={() => void perform('inspect')}>Inspect local Loop sessions</button>
    {taskId && recovery.includes(taskId) && <><p>Activation consent consumed. Inspect persisted sessions and attempts before acknowledging recovery and requesting a fresh preview.</p><button type="button" disabled={busy || !connected || !recoveryRead.includes(taskId)} onClick={() => {invalidate(); setRecovery(rows => rows.filter(t => t !== taskId));}}>I inspected local Loop records</button></>}
    <p role="status">{busy ? 'Waiting for retained local MCP owner…' : message}</p>
    {preview && <section ref={previewRegion} tabIndex={-1} aria-label="Local Loop preview" onKeyDown={e => {if (e.key === 'Escape') {invalidate(); region.current?.focus();}}}>
      <h5>{preview.policy_name}</h5><p>Task: {preview.task_id} · Employee: {preview.agent_id} · Policy: {preview.policy_id}</p>
      <p>Exact input</p><pre>{preview.input}</pre>
      <p>Maximum attempts: {preview.max_iterations} · Interval: {preview.interval_seconds} seconds · Prior attempts: {preview.expected_runs}</p>
      <p>Provider: {preview.provider} · Model: {preview.model} · Preview ID: {preview.preview_id}</p>
      <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I authorize one activation of this exact bounded Loop preview.</label>
      <button type="button" disabled={!consent || busy || !connected} onClick={() => void perform('start')}>Authorize and activate local Loop</button>
      <button type="button" onClick={() => {invalidate(); region.current?.focus();}}>Cancel local Loop preview</button>
    </section>}
    <p>Stop prevents new admissions and attempts local cancellation. Remote completion may remain unknown. Disconnecting or changing selection does not stop a session.</p>
    {[...sessions.values()].map(s => <section key={s.session_id} aria-label={`Local Loop session ${s.session_id}`}>
      <h5>{s.preview.policy_name} · {s.session_id}</h5><p>Task: {s.preview.task_id}</p>
      <p>{loopLabel(s, records[s.preview.task_id]?.attempts || [])} · Admitted: {s.admitted} / {s.preview.max_iterations}</p>
      <p>{controlText(records[s.preview.task_id]?.control)}</p>
      <button type="button" disabled={busy || !connected} onClick={() => void perform('inspect', s.preview.task_id)}>Inspect retained session {s.session_id}</button>
      {s.state === 'active' && <button type="button" disabled={busy || !connected || (!!records[s.preview.task_id] && !canControl(records[s.preview.task_id].control))} onClick={() => void perform('stop', s.preview.task_id, s)}>Stop local Loop {s.session_id}</button>}
      <p>Saved input</p><pre>{s.preview.input}</pre><p>Quality unverified</p>
      {records[s.preview.task_id]?.attempts.filter(a => a.session_id === s.session_id).map(a => <article key={a.run_id}><p>Attempt {a.ordinal} · {a.run_id} · {a.execution?.outcome || 'No terminal outcome recorded'}</p>{a.execution?.output != null && <pre>{a.execution.output}</pre>}{a.execution?.error && <p>{a.execution.error}</p>}</article>)}
    </section>)}
  </section>;
}
