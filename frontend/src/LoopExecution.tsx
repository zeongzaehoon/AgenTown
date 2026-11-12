import { useEffect, useRef, useState } from 'react';
import { api, type Attempt, type Work, type Workspace } from './api';
import { configurationRequest, type LoopFields } from './configuration-api';

type Policy = LoopFields & {id: string; enabled: boolean};
export interface LoopPreview {
  schema_version: 1; preview_id: string; policy_id: string; policy_name: string;
  task_id: string; agent_id: string; input: string; max_iterations: number;
  interval_seconds: number; expected_runs: number; policy_enabled: boolean;
}
export interface LoopSession {
  session_id: string; preview: LoopPreview; state: string; admitted: number;
  next_at: number; provider: string; model: string;
}
interface LoopAttempt {session_id: string; run_id: string; ordinal: number; execution: Partial<Attempt> | null}
export interface LoopInspection {schema_version: number; sessions: LoopSession[]; attempts: LoopAttempt[]; cancellation: string}
function attemptState(a: LoopAttempt): string {
  if (!a.execution) return 'unavailable';
  return a.execution.state || (a.execution.output != null || a.execution.error != null ? 'finished' : 'active');
}
export function loopLabel(session: LoopSession, attempts: LoopAttempt[]): string {
  if (session.state === 'complete') return 'Exhausted — bounded attempts completed';
  if (session.state !== 'active') return ({stopped: 'Stopped', failed: 'Failed', expired: 'Expired', restarted: 'Restarted — explicit new consent required', stale: 'Stale — work or configuration changed'} as Record<string, string>)[session.state] || `Unknown session state: ${session.state}`;
  const rows = attempts.filter(a => a.session_id === session.session_id);
  if (rows.some(a => attemptState(a) === 'active')) return 'Active — waiting for provider response';
  if (rows.length === session.admitted && rows.length > 0 && rows.every(a => attemptState(a) === 'finished') && session.admitted < session.preview.max_iterations) return 'Waiting — next admission controlled by the server';
  return 'Active — awaiting server admission or reconciliation';
}
export function LoopExecution({work, workspace, connected, draft, disabled, availability, submit}: {
  work: Work; workspace: Workspace; connected: boolean; draft: string; disabled: boolean;
  availability: (blocked: boolean) => void;
  submit: (path: string, payload: object, emergency?: boolean) => Promise<void>;
}) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [inspection, setInspection] = useState<LoopInspection | null>(null);
  const [available, setAvailable] = useState(false);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{value: LoopPreview; snapshot: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const epoch = useRef(0);
  const region = useRef<HTMLElement>(null);
  const inspectButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const active = inspection?.sessions.some(s => s.preview.task_id === work.id && s.state === 'active') ?? false;
  const snapshot = JSON.stringify([work, workspace.configuration, workspace.provider, workspace.model, draft, connected, selected, policies, available, disabled, active]);
  const current = useRef(snapshot);
  const revision = useRef(0);
  if (current.current !== snapshot) { ++revision.current; current.current = snapshot; }
  const valid = preview?.snapshot === snapshot;
  function focusBack() { if (inspectButton.current && !inspectButton.current.disabled) inspectButton.current.focus(); else region.current?.focus(); }
  useEffect(() => {
    let live = true;
    let pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending) return;
      pending = true;
      const generation = epoch.current;
      try {
        const [config, state] = await Promise.all([
          configurationRequest<{loops: Policy[]}>('loops', '', undefined, controller.signal),
          api<LoopInspection>('/api/loops/v1', {}, controller.signal, 'GET'),
        ]);
        if (!Array.isArray(config.loops) || state.schema_version !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.attempts)) throw new Error('Unsupported Loop response');
        if (live && generation === epoch.current) { setPolicies(config.loops); setInspection(state); setAvailable(true); }
      } catch { if (live && generation === epoch.current) setAvailable(false); }
      finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 800);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => { availability(!available || active); }, [availability, available, active]);
  useEffect(() => {
    if (preview && !valid) {
      if (focused.current) focusBack();
      setPreview(null); setMessage('Preview invalidated. Review saved work and configuration, then preview again.');
    }
  }, [preview, valid]);
  useEffect(() => { if (valid) startButton.current?.focus(); }, [valid]);
  const eligible = (p: Policy) => p.enabled && p.task_id === work.id;
  async function inspect() {
    if (lock.current || disabled || active || !available || !connected) return;
    lock.current = true; setBusy(true); setPreview(null);
    const captured = snapshot;
    const capturedRevision = revision.current;
    try {
      const value = await api<LoopPreview>('/api/loops/v1/preview', {policy_id: selected});
      if (current.current !== captured || revision.current !== capturedRevision) { setMessage('Work or configuration changed. Preview again.'); return; }
      const policy = policies.find(p => p.id === selected && eligible(p));
      if (!policy || value.schema_version !== 1 || !value.preview_id || !value.policy_enabled || value.policy_id !== policy.id || value.task_id !== work.id || value.agent_id !== work.assignees[0] || value.input !== work.input || value.expected_runs !== work.attempts.length || value.max_iterations !== policy.max_iterations || value.interval_seconds !== policy.interval_seconds) throw new Error('Unsupported or stale Loop preview. Refresh before trying again.');
      setPreview({value, snapshot: captured}); setMessage('Preview ready. Explicit authorization is required.');
    } catch (error) { if (current.current === captured && revision.current === capturedRevision) setMessage((error as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function send(path: string, payload: object, emergency = false) {
    if (lock.current || !connected) return;
    lock.current = true; ++epoch.current; setBusy(true); setPreview(null); setAvailable(false);
    setMessage('Request submitted. Inspect session and attempt records before retrying.');
    region.current?.focus();
    try { await submit(path, payload, emergency); }
    finally { ++epoch.current; lock.current = false; setBusy(false); }
  }
  return <section ref={region} tabIndex={-1} aria-label="Run a bounded Loop">
    <h4>Run a bounded Loop</h4>
    <p>Enabled means configured only. Preview uses saved work, not the unsaved draft. Starting authorizes bounded attempts; it does not activate Hooks or Skills.</p>
    <label htmlFor="execution-loop">Saved Loop</label>
    <select id="execution-loop" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
      <option value="">Choose a Loop</option>
      {policies.map(p => <option key={p.id} value={p.id} disabled={!eligible(p)}>{p.name} · {p.id} · {!p.enabled ? 'Disabled' : p.task_id !== work.id ? 'Different work' : 'Configured'}</option>)}
    </select>
    <button ref={inspectButton} type="button" disabled={busy || disabled || active || !connected || !available || !policies.some(p => p.id === selected && eligible(p))} onClick={() => void inspect()}>Preview Loop with saved work</button>
    <p role="status" aria-live="polite">{!connected || !available ? 'Disconnected or Loop data unavailable. Loaded sessions may be stale; reconnect to inspect before submitting.' : message || 'Configured Loops require preview and explicit start.'}</p>
    {preview && valid && <section aria-label="Loop execution preview" onFocusCapture={() => { focused.current = true; }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) focused.current = false; }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setPreview(null); focusBack(); } }}>
      <p>Employee: {workspace.employees.find(e => e.id === preview.value.agent_id)?.name} · {preview.value.agent_id}</p>
      <pre>{preview.value.input}</pre>
      <p>Maximum attempts: {preview.value.max_iterations} · Interval: {preview.value.interval_seconds} seconds. Earlier attempts are preserved. Preview does not call a provider.</p>
      <button type="button" onClick={() => { setPreview(null); focusBack(); }}>Cancel Loop preview</button>
      <button ref={startButton} type="button" disabled={busy || disabled} onClick={() => {
        if (lock.current || disabled || current.current !== preview.snapshot) return;
        void send('/api/loops/v1/start', {preview_id: preview.value.preview_id, expected_runs: preview.value.expected_runs});
      }}>Authorize and start bounded Loop</button>
    </section>}
    <p>{inspection?.cancellation || 'Stop prevents new admissions and attempts local cancellation. Remote completion may remain unknown.'}</p>
    <div aria-live="polite">{inspection?.sessions.filter(s => s.preview.task_id === work.id).map(s => <section key={s.session_id} aria-label={`Loop session ${s.session_id}`}>
      <h5>{s.preview.policy_name} · {s.session_id}</h5>
      <p>{loopLabel(s, inspection.attempts)} · Admitted: {s.admitted} / {s.preview.max_iterations} · {s.provider} / {s.model}</p>
      {s.state === 'active' && <button type="button" disabled={busy || !connected} onClick={() => void send('/api/loops/v1/stop', {session_id: s.session_id}, true)}>Stop Loop {s.session_id}</button>}
      <ul>{inspection.attempts.filter(a => a.session_id === s.session_id).map(a => <li key={a.run_id}>Attempt {a.ordinal} · {a.run_id} · {a.execution ? `${attemptState(a)} · ${a.execution.outcome || (a.execution.error ? 'Failure or interruption' : a.execution.output != null ? 'Result available · Unverified' : 'No terminal outcome')}${a.execution.error ? ` · ${a.execution.error}` : ''}` : 'Execution record unavailable'}{a.execution?.output != null && <pre>{a.execution.output}</pre>}</li>)}</ul>
    </section>)}</div>
  </section>;
}
