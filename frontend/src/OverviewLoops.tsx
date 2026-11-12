import { controlText, sourceText, type LoopControl } from './loop-control';
import { useEffect, useState } from 'react';
import { ApiError, api, type Workspace } from './api';
import { loopLabel, type LoopInspection } from './LoopExecution';

/** Read-only inspection: workspace refreshes and navigation never admit work. */
export function OverviewLoops({workspace, onOpenWork}: {workspace: Workspace | null; onOpenWork: (id: string) => void}) {
  const [inspection, setInspection] = useState<LoopInspection | null>(null);
  const [control, setControl] = useState<LoopControl | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    let live = true;
    let pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const value = await api<LoopInspection>('/api/loops/v1', {}, controller.signal, 'GET');
        if (value.schema_version !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.attempts)) throw new Error('Unsupported Loop inspection');
        if (live) { setInspection(value); setControl(value.control ?? null); setStatus('ready'); }
      } catch (error) { if (live) { setStatus('unavailable'); setControl(error instanceof ApiError ? error.control ?? null : null); } }
      finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 800);
    return () => { live = false; clearInterval(timer); controller.abort(); };
  }, []);
  return <section aria-labelledby="overview-loops-title">
    <h3 id="overview-loops-title">Bounded Loop activity</h3>
    <p role="status">{status === 'loading' ? 'Loading Loop inspection…' : status === 'unavailable'
      ? inspection ? 'Loop inspection unavailable — showing stale sessions from the last successful inspection.' : 'Loop inspection unavailable. No session data loaded.'
      : 'Showing recorded Loop sessions.'}</p>
    <p role="status">{controlText(control)}</p>
    <p>Loop admissions are separate from ordinary request counts. Open saved work to inspect attempts. Local Stop Loop requires available authority; otherwise stop through the owning MCP or web server. Nothing starts or resumes here.</p>
    {inspection && !inspection.sessions.length && <p>No recorded Loop sessions.</p>}
    {!!inspection?.sessions.length && <ul aria-label="Recorded Loop sessions">{inspection.sessions.map(session => {
      const work = workspace?.work.find(w => w.id === session.preview.task_id);
      const employee = workspace?.employees.find(e => e.id === session.preview.agent_id);
      return <li key={session.session_id}>
        <h4>{session.preview.policy_name} · {session.session_id}</h4>
        <p>{sourceText(session.declared_source)}</p>
        <p>{loopLabel(session, inspection.attempts)} · Admitted: {session.admitted} / {session.preview.max_iterations}</p>
        <p>Employee: {employee?.name ?? 'Unavailable employee'} · ID: {session.preview.agent_id}</p>
        <p>Work ID: {session.preview.task_id}</p>
        {work ? <button type="button" onClick={() => onOpenWork(work.id)}>Open work: {work.input.slice(0, 55)} · Loop {session.session_id}</button>
          : <p>{workspace ? 'Linked work is unavailable in the loaded workspace.' : 'Loading linked work…'}</p>}
      </li>;
    })}</ul>}
  </section>;
}
