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
  const [snapshot, setSnapshot] = useState<{activity: Activity; receivedAt: string} | null>(null);
  const data = snapshot?.activity;
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [stale, setStale] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const loadControl = useRef<HTMLButtonElement | null>(null);
  const cancelControl = useRef<HTMLButtonElement | null>(null);
  const restoreLoadFocus = useRef(false);
  useLayoutEffect(() => {
    if (!pending && restoreLoadFocus.current) {
      restoreLoadFocus.current = false;
      if (!loadControl.current?.closest('[hidden]') && document.activeElement === document.body) loadControl.current?.focus();
    }
  }, [pending]);
  function endWaiting() {
    restoreLoadFocus.current = document.activeElement === cancelControl.current;
    setPending(false);
  }
  const heading = useRef<HTMLHeadingElement | null>(null);
  const content = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const activityFocus = useRef<HTMLElement | null>(null);
  const previousClient = useRef(clientId);
  const [focusNotice, setFocusNotice] = useState('');
  useLayoutEffect(() => {
    const clientChanged = previousClient.current !== clientId;
    previousClient.current = clientId;
    const previous = previousFocus.current ?? (clientChanged ? activityFocus.current : null);
    previousFocus.current = null;
    // Consume removed focus even when the hidden panel cannot recover it.
    if (previous && !previous.isConnected) activityFocus.current = null;
    if (clientChanged) setFocusNotice('');
    if (previous && !previous.isConnected && document.activeElement === document.body && content.current && !content.current.closest('[hidden]')) {
      heading.current?.focus();
      if (clientChanged) setFocusNotice('The recorded attempt control you were using is no longer shown for the selected integration. Review the visible recorded activity.');
    }
  }, [data, clientId]);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useLayoutEffect(() => {
    if (!connected) {
      const controller = request.current; request.current = null;
      controller?.abort(); lock.current = false; endWaiting(); setStale(true);
    }
    return () => { const controller = request.current; request.current = null; controller?.abort(); lock.current = false; };
  }, [connected]);
  function cancel() {
    const controller = request.current;
    if (!controller) return;
    request.current = null;
    lock.current = false;
    controller.abort();
    setCancelled(true); setStale(true);
    endWaiting();
  }
  async function load() {
    if (!connected || lock.current) return;
    lock.current = true;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setUnavailable(false); setCancelled(false);
    try {
      const next = await api<unknown>('/api/connections/v1/activity', {limit: 50}, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      if (!isActivity(next)) throw new Error('Invalid recorded activity');
      const focused = document.activeElement;
      previousFocus.current = focused instanceof HTMLElement && content.current?.contains(focused) ? focused : null;
      setSnapshot({activity: next, receivedAt: new Date(Date.now()).toISOString()}); setStale(false);
    } catch {
      if (request.current === controller && !controller.signal.aborted) { setUnavailable(true); setStale(true); }
    } finally {
      // Only this request may release admission or recover its disappearing control's focus.
      if (request.current === controller) { request.current = null; lock.current = false; endWaiting(); }
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
  return <section className="connection-activity" ref={content}
    onFocusCapture={event => { activityFocus.current = event.target; }}
    onBlurCapture={() => { activityFocus.current = null; }}
    aria-label="Recorded integration activity" aria-busy={pending}>
    <h3 ref={heading} tabIndex={-1}>Recorded integration activity</h3>
    <p>Persisted Run records only. Declared source is untrusted historical metadata, not authenticated client identity. Activity does not verify current connection, configuration or result quality. Copying setup and passing local checks cannot create this evidence.</p>
    <button ref={loadControl} type="button" aria-disabled={pending || !connected} onClick={() => void load()}>Load recorded activity</button>
    {pending && <button ref={cancelControl} type="button" onClick={cancel}>Cancel waiting for recorded activity</button>}
    <div role="status" aria-live="polite" aria-atomic="true">
      {cancelled && <p>Stopped waiting for recorded activity. This does not confirm that the server stopped processing the request. Select Load recorded activity to reload explicitly.</p>}
      {focusNotice && <p>{focusNotice}</p>}
      {pending ? <p>Loading recorded activity…</p> : unavailable ? <p>Recorded activity unavailable. Check the workspace connection and explicitly load again.</p> : !data ? <p>Recorded activity not loaded.</p> : <p>Showing a snapshot of up to {data.limit} recent recorded attempts across all sources. Load again explicitly to refresh.</p>}
      {!connected && <p>Workspace disconnected. Activity loading and saved-work navigation unavailable; nothing is automatically replayed.</p>}
      {data && (stale || pending) && <p>Previous recorded activity observation — potentially stale.</p>}
      {data && !pending && !matching.length && <p>No recorded activity for this declared client in the loaded recent snapshot. This does not prove the client was never used.</p>}
    </div>
    {snapshot && <p>Entire recorded activity snapshot received by this browser: <time dateTime={snapshot.receivedAt}>{new Date(snapshot.receivedAt).toLocaleString()}</time>. Receipt time does not verify current client connectivity, authenticated identity or result quality.</p>}
    {!!matching.length && <ul aria-label="Selected client recorded attempts">{matching.map(row)}</ul>}
    {!!unclassified.length && <><h4>Unrecognized or missing declared source — not attributed to this client</h4><ul aria-label="Unclassified recorded attempts">{unclassified.map(row)}</ul></>}
  </section>;
}
