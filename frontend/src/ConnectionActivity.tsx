import { useLayoutEffect, useRef, useState } from 'react';
import { api } from './api';

interface RecordedAttempt {
  task_id: string; run_id: string; started_at: number; ended_at: number | null;
  state: 'active' | 'finished'; outcome: string | null;
  declared_source: string | null; integration: string | null;
}
interface Activity { schema_version: 1; limit: number; attempts: RecordedAttempt[] }
const clients = ['codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function isActivity(v: unknown): v is Activity {
  if (!record(v) || v.schema_version !== 1 || v.limit !== 50 || !Array.isArray(v.attempts) || v.attempts.length > 50) return false;
  const e = v.evidence;
  if (!record(e) || e.read_only !== true || e.source !== 'persisted_run_records' ||
      e.source_labels !== 'untrusted_historical_metadata' || e.current_connection_verified !== false ||
      e.authenticated_client_identity_verified !== false || e.quality_approved !== false || e.local_product_attempts_excluded !== true) return false;
  return v.attempts.every(a => record(a) && text(a.task_id) && text(a.run_id) && timestamp(a.started_at) &&
    (a.ended_at === null || timestamp(a.ended_at)) && ['active', 'finished'].includes(a.state as string) &&
    (a.outcome === null || text(a.outcome)) && (a.declared_source === null || text(a.declared_source)) &&
    a.integration === (clients.includes(a.declared_source as string) ? a.declared_source : null)) &&
    new Set(v.attempts.map(a => a.run_id)).size === v.attempts.length;
}
export interface RecordedAttemptNavigation { taskId: string; runId: string }
export interface ActivityNavigation {
  savedTaskIds?: string[];
  onOpenRecordedTask?: (request: RecordedAttemptNavigation) => void;
}
export function ConnectionActivity({clientId, connected, savedTaskIds = [], onOpenRecordedTask}: ActivityNavigation & {clientId: string; connected: boolean}) {
  const [data, setData] = useState<Activity | null>(null);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [stale, setStale] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const content = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const previous = previousFocus.current;
    previousFocus.current = null;
    if (previous && !previous.isConnected && document.activeElement === document.body && content.current && !content.current.closest('[hidden]')) heading.current?.focus();
  }, [data]);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useLayoutEffect(() => {
    if (!connected) {
      request.current?.abort(); lock.current = false; setPending(false); setStale(true);
    }
    return () => { request.current?.abort(); lock.current = false; };
  }, [connected]);
  async function load() {
    if (!connected || lock.current) return;
    lock.current = true;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setUnavailable(false);
    try {
      const next = await api<unknown>('/api/connections/v1/activity', {limit: 50}, controller.signal);
      if (controller.signal.aborted) return;
      if (!isActivity(next)) throw new Error('Invalid recorded activity');
      const focused = document.activeElement;
      previousFocus.current = focused instanceof HTMLElement && content.current?.contains(focused) ? focused : null;
      setData(next); setStale(false);
    } catch {
      if (!controller.signal.aborted) { setUnavailable(true); setStale(true); }
    } finally {
      if (!controller.signal.aborted) { lock.current = false; setPending(false); }
    }
  }
  const matching = data?.attempts.filter(a => a.integration === clientId) ?? [];
  const unclassified = data?.attempts.filter(a => a.integration === null) ?? [];
  function row(a: RecordedAttempt) {
    const canOpen = connected && savedTaskIds.includes(a.task_id) && !!onOpenRecordedTask;
    return <li key={a.run_id}>
      <p>Run: {a.run_id} · Task: {a.task_id}</p>
      <p>Recorded state: {a.state}. Recorded outcome: {a.outcome ?? 'Not recorded'}.</p>
      <p>Declared source (untrusted): {a.declared_source ?? 'Not recorded'}</p>
      <p>Recorded timestamps (Unix milliseconds): started {a.started_at}; ended {a.ended_at ?? 'Not recorded'}.</p>
      <button type="button" aria-disabled={!canOpen} onClick={() => { if (canOpen) onOpenRecordedTask?.({taskId: a.task_id, runId: a.run_id}); }}>Open saved Task: {a.task_id} · Run: {a.run_id}</button>
      {!canOpen && <p>{!connected ? 'Reconnect before opening saved work.' : 'Saved Task unavailable in the current workspace. It may have been removed; refresh the workspace to inspect again.'}</p>}
    </li>;
  }
  return <section className="connection-activity" ref={content} aria-label="Recorded integration activity" aria-busy={pending}>
    <h3 ref={heading} tabIndex={-1}>Recorded integration activity</h3>
    <p>Persisted Run records only. Declared source is untrusted historical metadata, not authenticated client identity. Activity does not verify current connection, configuration or result quality. Copying setup and passing local checks cannot create this evidence.</p>
    <button type="button" aria-disabled={pending || !connected} onClick={() => void load()}>Load recorded activity</button>
    <div role="status" aria-live="polite" aria-atomic="true">
      {pending ? <p>Loading recorded activity…</p> : unavailable ? <p>Recorded activity unavailable. Check the workspace connection and explicitly load again.</p> : !data ? <p>Recorded activity not loaded.</p> : <p>Showing a snapshot of up to {data.limit} recent recorded attempts across all sources. Load again explicitly to refresh.</p>}
      {!connected && <p>Workspace disconnected. Activity loading and saved-work navigation unavailable; nothing is automatically replayed.</p>}
      {data && (stale || pending) && <p>Previous recorded activity observation — potentially stale.</p>}
      {data && !pending && !matching.length && <p>No recorded activity for this declared client in the loaded recent snapshot. This does not prove the client was never used.</p>}
    </div>
    {!!matching.length && <ul aria-label="Selected client recorded attempts">{matching.map(row)}</ul>}
    {!!unclassified.length && <><h4>Unrecognized or missing declared source — not attributed to this client</h4><ul aria-label="Unclassified recorded attempts">{unclassified.map(row)}</ul></>}
  </section>;
}
