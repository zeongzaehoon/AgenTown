import { canControl, controlText, sourceText, type LoopControl } from './loop-control';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type Workspace } from './api';
import { loopLabel } from './LoopExecution';
import { confirmedLoop, loopInspection, loopReceipt, type LoopInspection } from './loop-response';

/** Polling and navigation inspect only; stopping requires explicit session consent. */
export function OverviewLoops({workspace, onOpenWork}: {workspace: Workspace | null; onOpenWork: (id: string) => void}) {
  const [inspection, setInspection] = useState<LoopInspection | null>(null);
  const [control, setControl] = useState<LoopControl | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inspectedAt = useRef(0);
  const epoch = useRef(0);
  const lock = useRef(false);
  const mounted = useRef(false);
  const refresh = useRef<() => void>(() => {});
  const fresh = status === 'ready' && now - inspectedAt.current < 2400;
  async function stop(sessionId: string) {
    if (lock.current || status !== 'ready' || Date.now() - inspectedAt.current >= 2400 || !canControl(control)
      || !inspection?.sessions.some(s => s.session_id === sessionId && s.state === 'active')) return;
    lock.current = true;
    ++epoch.current;
    setBusy(true); setStatus('loading'); inspectedAt.current = 0;
    setMessage(`Stop request for Loop ${sessionId} submitted. Awaiting response; cancellation is not confirmed.`);
    try {
      const expected = inspection.sessions.find(s => s.session_id === sessionId)!;
      const receipt = loopReceipt(await api<unknown>('/api/loops/v1/stop', {session_id: sessionId}), expected, 'stop', expected.provider, expected.model);
      if (mounted.current) setMessage('Loop stop response received. Confirming saved stopped state…');
      const saved = confirmedLoop(await api<unknown>('/api/loops/v1', {}, undefined, 'GET'), receipt, 'stop');
      if (mounted.current) { setInspection(saved); setControl(saved.control ?? null); }
      if (mounted.current) setMessage(`Saved stopped state confirmed. Local stop acknowledged for Loop ${sessionId}. Remote completion may remain unknown. Inspect again before another explicit attempt.`);
    } catch (error) {
      if (mounted.current) {
        setControl(error instanceof ApiError ? error.control ?? null : null);
        setMessage(`Stop outcome for Loop ${sessionId} is not confirmed. ${(error as Error).message} Inspect again before another explicit attempt. Remote completion may remain unknown.`);
      }
    } finally {
      ++epoch.current; lock.current = false;
      if (mounted.current) { setBusy(false); setStatus('loading'); }
    }
  }
  useEffect(() => {
    let live = true; mounted.current = true;
    let pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending || lock.current) return;
      pending = true;
      const generation = epoch.current;
      try {
        const value = loopInspection(await api<unknown>('/api/loops/v1', {}, controller.signal, 'GET'));
        if (live && generation === epoch.current) { inspectedAt.current = Date.now(); setNow(Date.now()); setInspection(value); setControl(value.control ?? null); setStatus('ready'); }
      } catch (error) { if (live && generation === epoch.current) { setStatus('unavailable'); setControl(error instanceof ApiError ? error.control ?? null : null); } }
      finally { pending = false; }
    }
    refresh.current = () => void load();
    void load();
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, 800);
    return () => { live = false; mounted.current = false; clearInterval(timer); controller.abort(); };
  }, []);
  return <section aria-labelledby="overview-loops-title">
    <h3 id="overview-loops-title">Bounded Loop activity</h3>
    <p role="status">{status === 'loading' ? 'Loading Loop inspection…' : status === 'unavailable'
      ? inspection ? 'Loop inspection unavailable — showing stale sessions from the last successful inspection.' : 'Loop inspection unavailable. No session data loaded.'
      : !fresh ? 'Loop inspection stale. Inspect again before stopping.' : 'Showing recorded Loop sessions.'}</p>
    <p role="status" aria-label="Overview Loop authority">{controlText(control)}</p>
    <p role="status" aria-label="Overview Loop stop outcome">{message}</p>
    <button type="button" aria-disabled={busy} onClick={() => { if (!lock.current) refresh.current(); }}>Inspect Loop sessions again</button>
    <p>Loop admissions are separate from ordinary request counts. Open saved work to inspect attempts. Stop requires fresh inspection and granted local authority; otherwise stop through the owning MCP or web server. Stop prevents new admissions and requests local cancellation. Remote completion may remain unknown. Nothing starts or resumes here.</p>
    {inspection && !inspection.sessions.length && <p>No recorded Loop sessions.</p>}
    {!!inspection?.sessions.length && <ul aria-label="Recorded Loop sessions">{inspection.sessions.map(session => {
      const work = workspace?.work.find(w => w.id === session.preview.task_id);
      const employee = workspace?.employees.find(e => e.id === session.preview.agent_id);
      return <li key={session.session_id}>
        <h4>{session.preview.policy_name} · {session.session_id}</h4>
        <p>{sourceText(session.declared_source)}</p>
        <p>{loopLabel(session, inspection.attempts)} · Admitted: {session.admitted} / {session.preview.max_iterations}</p>
        <p>Employee: {employee?.name ?? 'Unavailable employee'} · ID: {session.preview.agent_id}</p>
        <button type="button" aria-disabled={busy || !fresh || !canControl(control) || session.state !== 'active'}
          aria-describedby={`stop-reason-${session.session_id}`} onClick={() => void stop(session.session_id)}>Stop Loop {session.session_id} from overview</button>
        <p id={`stop-reason-${session.session_id}`}>{session.state !== 'active' ? 'This session is not active; no stop is available.'
          : busy ? 'A stop request is pending. Wait, then inspect again.'
          : !fresh ? 'Fresh inspection required. Inspect Loop sessions again or wait for a successful refresh.'
          : !canControl(control) ? controlText(control) : 'Available by explicit action only. The server checks ownership again.'}</p>
        <p>Work ID: {session.preview.task_id}</p>
        {work ? <button type="button" onClick={() => onOpenWork(work.id)}>Open work: {work.input.slice(0, 55)} · Loop {session.session_id}</button>
          : <p>{workspace ? 'Linked work is unavailable in the loaded workspace.' : 'Loading linked work…'}</p>}
      </li>;
    })}</ul>}
  </section>;
}
