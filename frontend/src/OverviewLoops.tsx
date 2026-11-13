import { inspectCompanyLoops, localLoop, sameLocalSession } from './work-loop-api';
import { canControl, controlText, sourceText, type LoopControl } from './loop-control';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type Workspace } from './api';
import { loopLabel } from './LoopExecution';
import { executionLabel } from './WorkLoop';
import { confirmedLoop, loopInspection, loopReceipt, type LoopInspection } from './loop-response';

export type LoopNavigation = {taskId: string; sessionId: string; policyId?: never} | {taskId: string; policyId: string; sessionId?: never};

/** Polling and navigation inspect only; stopping requires explicit session consent. */
export function OverviewLoops({workspace, onOpenWork, onOpenSession}: {onOpenSession?: (request: LoopNavigation) => void; workspace: Workspace | null; onOpenWork: (id: string) => void}) {
  const [inspection, setInspection] = useState<LoopInspection | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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
    <CompanyMcpLoops workspace={workspace} onOpenSession={onOpenSession} />
    <p role="status">{status === 'loading' ? 'Loading Loop inspection…' : status === 'unavailable'
      ? inspection ? 'Loop inspection unavailable — showing stale sessions from the last successful inspection.' : 'Loop inspection unavailable. No session data loaded.'
      : !fresh ? 'Loop inspection stale. Inspect again before stopping.' : 'Showing recorded Loop sessions.'}</p>
    <p role="status" aria-label="Overview Loop authority">{controlText(control)}</p>
    <p role="status" aria-label="Overview Loop stop outcome">{message}</p>
    <button type="button" aria-disabled={busy} onClick={() => { if (!lock.current) refresh.current(); }}>Inspect Loop sessions again</button>
    <p>Loop admissions are separate from ordinary request counts. Expand session details here to inspect recorded attempts, or open saved work. Stop requires fresh inspection and granted local authority; otherwise stop through the owning MCP or web server. Stop prevents new admissions and requests local cancellation. Remote completion may remain unknown. Nothing starts or resumes here.</p>
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
        <button type="button" aria-expanded={expanded.has(session.session_id)} aria-controls={`overview-attempts-${session.session_id}`}
          onClick={() => setExpanded(previous => {
            const next = new Set(previous);
            if (next.has(session.session_id)) next.delete(session.session_id); else next.add(session.session_id);
            return next;
          })}>Attempt details for Loop {session.session_id}</button>
        {expanded.has(session.session_id) && <section id={`overview-attempts-${session.session_id}`} aria-label={`Attempts for Loop ${session.session_id}`}>
          <p>{fresh ? 'Recorded attempts from the last successful inspection.' : 'Stale attempt details. Inspect Loop sessions again for current persisted execution state.'}</p>
          <p>Quality unverified</p>
          {!inspection.attempts.some(a => a.session_id === session.session_id) && <p>No recorded attempts for this session. Provider completion unknown.</p>}
          {inspection.attempts.filter(a => a.session_id === session.session_id).map(a => <article key={a.run_id}>
            <p>Attempt {a.ordinal} · Run ID: {a.run_id} · {executionLabel(a.execution)}</p>
            {a.execution?.output != null && <><p>Output</p><pre>{a.execution.output}</pre></>}
            {a.execution?.error && <><p>Error</p><p>{a.execution.error}</p></>}
          </article>)}
        </section>}
        <p>Work ID: {session.preview.task_id}</p>
        {work ? <button type="button" onClick={() => onOpenSession ? onOpenSession({taskId: work.id, sessionId: session.session_id}) : onOpenWork(work.id)}>Open work: {work.input.slice(0, 55)} · Loop {session.session_id}</button>
          : <p>{workspace ? 'Linked work is unavailable in the loaded workspace.' : 'Loading linked work…'}</p>}
      </li>;
    })}</ul>}
  </section>;
}


function CompanyMcpLoops({workspace, onOpenSession}: {workspace: Workspace | null; onOpenSession?: (request: LoopNavigation) => void}) {
  const [inspection, setInspection] = useState<LoopInspection | null>(null);
  const [status, setStatus] = useState('Not inspected. Explicitly inspect recorded sessions through the retained local MCP owner.');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const stopLock = useRef(false);
  const inspectedAt = useRef(0);
  const active = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { ++revision.current; active.current?.abort(); if (expiry.current) clearTimeout(expiry.current); }, []);
  async function inspect() {
    if (stopLock.current) return;
    const generation = ++revision.current;
    active.current?.abort();
    if (expiry.current) clearTimeout(expiry.current);
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setFresh(false); setStatus('Inspecting retained local MCP owner…');
    try {
      const result = await inspectCompanyLoops(controller.signal);
      if (generation !== revision.current) return;
      if (!result.inspection) {setStatus('Retained local MCP inspection unavailable. Previous records, if any, are stale. Inspect again.'); return;}
      setInspection(result.inspection); setFresh(true); inspectedAt.current = Date.now();
      setStatus(result.inspection.sessions.length ? 'Recorded local MCP sessions loaded.' : 'No recorded local MCP sessions.');
      expiry.current = setTimeout(() => { if (generation === revision.current) {setFresh(false); setStatus('Local MCP inspection stale. Inspect again for current persisted state and authority.');} }, 2400);
    } catch {
      if (generation === revision.current) setStatus('Retained local MCP inspection unavailable. Previous records, if any, are stale. Inspect again.');
    } finally {if (generation === revision.current) setBusy(false);}
  }
  async function stop(sessionId: string) {
    const expected = inspection?.sessions.find(s => s.session_id === sessionId);
    if (stopLock.current || busy || !fresh || Date.now() - inspectedAt.current >= 2400 ||
        !canControl(inspection?.control) || expected?.state !== 'active') return;
    stopLock.current = true;
    const generation = ++revision.current;
    active.current?.abort();
    if (expiry.current) clearTimeout(expiry.current);
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setFresh(false);
    setStatus(`Stop requested for local MCP session ${sessionId}. Saved stopped state is not yet confirmed.`);
    try {
      const result = await localLoop('stop', expected.preview.task_id, controller.signal, expected);
      if (generation !== revision.current) return;
      if (result.status !== 'confirmed' || !result.receipt || !sameLocalSession(result.receipt, expected)) throw new Error('Stop delivery unconfirmed');
      setStatus('Stop response received. Confirming persisted local MCP stopped state…');
      const saved = await localLoop('inspect', expected.preview.task_id, controller.signal);
      if (generation !== revision.current) return;
      const persisted = saved.inspection?.sessions.find(s => s.session_id === sessionId);
      if (saved.status !== 'confirmed' || !persisted || persisted.state !== 'stopped' ||
          !sameLocalSession(persisted, expected)) throw new Error('Persisted stopped state unconfirmed');
      // Keep other Tasks visible, but do not refresh their authority from a Task-scoped read.
      setInspection(previous => previous && ({...previous, sessions: previous.sessions.map(s => s.session_id === sessionId ? persisted : s)}));
      setStatus(`Saved stopped state confirmed for local MCP session ${sessionId}. Remote completion may remain unknown. Inspect company Loops again before another action.`);
    } catch {
      if (generation === revision.current) setStatus(`Stop outcome for local MCP session ${sessionId} is not confirmed. Explicitly inspect company Loops again before another attempt. Nothing is resent automatically. Remote completion may remain unknown.`);
    } finally {
      stopLock.current = false;
      if (generation === revision.current) setBusy(false);
    }
  }
  return <section aria-label="Company local MCP Loop inspection">
    <h4>Retained local MCP Loop activity</h4>
    <p role="status">{status}</p>
    <button type="button" aria-disabled={stopLock.current} onClick={() => void inspect()}>Inspect company Loops through local MCP</button>
    <p>Read recorded sessions across all work. Inspection and opening work grant no consent and never preview, start or stop work. Stop requires fresh inspection and granted local authority. Stop prevents new admissions and requests local cancellation; remote completion may remain unknown.</p>
    {inspection && <>
      <p aria-label="Retained MCP owner authority">{fresh ? '' : 'Stale authority: '}{controlText(inspection.control)}</p>
      <ul aria-label="Company local MCP sessions">{inspection.sessions.map(s => {
        const work = workspace?.work.find(w => w.id === s.preview.task_id);
        return <li key={s.session_id}>
          <p>Task: {s.preview.task_id} · Session: {s.session_id} · Persisted state: {s.state}</p>
          <button type="button" aria-disabled={busy || !fresh || !canControl(inspection.control) || s.state !== 'active'}
            aria-describedby={`mcp-stop-reason-${s.session_id}`} onClick={() => void stop(s.session_id)}>Stop local MCP Loop {s.session_id} from overview</button>
          <p id={`mcp-stop-reason-${s.session_id}`}>{s.state !== 'active' ? 'This session is not active; no stop is available.'
            : busy ? 'An inspection or stop is pending. Wait before another action.'
            : !fresh ? 'Explicit fresh company inspection required before stopping.'
            : !canControl(inspection.control) ? controlText(inspection.control) : 'Stop this exact session by explicit action. Ownership is checked again by the server.'}</p>
          <p>{sourceText(s.declared_source)}</p>
          <p>{loopLabel(s, inspection.attempts)} · Admitted: {s.admitted} / {s.preview.max_iterations}</p>
          <button type="button" aria-expanded={expanded.has(s.session_id)} aria-controls={`mcp-attempts-${s.session_id}`}
            onClick={() => setExpanded(previous => {
              const next = new Set(previous);
              if (next.has(s.session_id)) next.delete(s.session_id); else next.add(s.session_id);
              return next;
            })}>Attempt details for local MCP Loop {s.session_id}</button>
          {expanded.has(s.session_id) && <section id={`mcp-attempts-${s.session_id}`} aria-label={`Attempts for local MCP Loop ${s.session_id}`}>
            <p>{fresh ? 'Recorded attempts from the last explicit inspection.' : 'Stale attempt details. Inspect company Loops again for current persisted execution state.'}</p>
            <p>Quality unverified</p>
            {!inspection.attempts.some(a => a.session_id === s.session_id) && <p>No recorded attempts for this session. Provider completion unknown.</p>}
            {inspection.attempts.filter(a => a.session_id === s.session_id).map(a => <article key={a.run_id}>
              <p>Attempt {a.ordinal} · Run ID: {a.run_id} · {executionLabel(a.execution)}</p>
              {a.execution?.output != null && <><p>Output</p><pre>{a.execution.output}</pre></>}
              {a.execution?.error && <><p>Error</p><p>{a.execution.error}</p></>}
            </article>)}
          </section>}
          {work && onOpenSession ? <button type="button" disabled={busy} onClick={() => onOpenSession({taskId: s.preview.task_id, sessionId: s.session_id})}>Inspect local MCP session {s.session_id} in work</button>
            : <p>{workspace ? 'Linked work is unavailable in the loaded workspace. Session records remain inspectable here; reload the workspace before opening work.' : 'Linked work is not loaded yet.'}</p>}
        </li>;
      })}</ul>
    </>}
  </section>;
}
