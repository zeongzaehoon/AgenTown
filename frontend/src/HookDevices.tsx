import type { Attempt, Workspace } from './api';
export interface HookNavigation {taskId: string; hookId: string; employeeId: string}
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { configurationRequest, type HookRecord } from './configuration-api';

/** Office inspection is read-only and independent of provider availability. */
export function HookDevices({onOpenHook, onOpenWork, workspace, connected = true}: {onOpenHook?: (id: string) => void; onOpenWork?: (request: HookNavigation) => void; workspace?: Workspace | null; connected?: boolean}) {
  const [devices, setDevices] = useState<HookRecord[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const recoverFocus = useRef(false);
  useLayoutEffect(() => {
    if (!busy && recoverFocus.current) {
      recoverFocus.current = false;
      refreshButton.current?.focus();
    }
  }, [busy, devices]);
  function acceptSnapshot(next: HookRecord[]) {
    const ids = new Set(next.map(record => record.id));
    let removed = 0;
    for (const card of Array.from(grid.current?.children ?? [])) {
      if (!ids.has(card.getAttribute('data-record-id')!)) {
        removed++;
        if (card.contains(document.activeElement)) recoverFocus.current = true;
      }
    }
    setAnnouncement(removed
      ? `Hook devices refreshed: ${removed} record${removed === 1 ? '' : 's'} removed from this view. ${next.length ? 'Remaining cards are available below.' : 'No cards remain.'}`
      : '');
    setDevices(next);
  }
  const request = useRef<AbortController | null>(null);
  // Connection recovery does not refresh this independently loaded configuration.
  const [disconnectedSnapshot, setDisconnectedSnapshot] = useState(!connected);
  const connection = useRef({connected, revision: 0});
  useEffect(() => {
    if (connection.current.connected === connected) return;
    connection.current = {connected, revision: connection.current.revision + 1};
    request.current?.abort();
    setBusy(false);
    setDisconnectedSnapshot(true);
  }, [connected]);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const revision = connection.current.revision;
    setBusy(true); setError('');
    try {
      const result = await configurationRequest<{hooks: HookRecord[]}>('hooks', '', undefined, controller.signal);
      if (!Array.isArray(result.hooks) || result.hooks.some(device => !device || typeof device.id !== 'string' || typeof device.name !== 'string' || typeof device.enabled !== 'boolean' || typeof device.event !== 'string' || typeof device.target_kind !== 'string' || typeof device.target_id !== 'string' || typeof device.skill_id !== 'string')) throw new Error('Saved Hook data unavailable. Refresh to try again.');
      if (request.current === controller && !controller.signal.aborted && revision === connection.current.revision) {
        acceptSnapshot(result.hooks);
        setDisconnectedSnapshot(!connection.current.connected || revision !== connection.current.revision);
      }
    } catch (failure) {
      if (request.current === controller && !controller.signal.aborted && revision === connection.current.revision) setError((failure as Error).message);
    } finally {
      if (request.current === controller && !controller.signal.aborted && revision === connection.current.revision) setBusy(false);
    }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  return <section className="hook-devices" aria-labelledby="hook-devices-title">
    <h3 id="hook-devices-title">Hook trigger devices</h3>
    <p>Open a device to inspect its saved Hook in Configuration. Opening never saves, enables or executes work. Hooks do not run automatically.</p>
    <p role="status">{!connected ? 'Disconnected — Hook devices configuration may be stale. ' : disconnectedSnapshot ? 'Connection restored — Hook devices configuration may still be stale. Refresh Hook devices to check. ' : ''}{busy ? 'Loading Hook devices…' : error ? devices ? 'Hook devices are stale — showing the last successful snapshot.' : 'Hook devices unavailable.' : devices === null ? 'Hook devices unavailable.' : devices?.length ? (!connected || disconnectedSnapshot) ? 'Showing retained Hook devices configuration.' : 'Showing saved Hook devices.' : (!connected || disconnectedSnapshot) ? 'The last successful configuration snapshot was empty; current Hooks are unknown.' : 'No saved Hooks yet. Create a Hook in Configuration.'}</p>
    {error && <p role="alert">{error}</p>}
    <p aria-live="polite" aria-atomic="true" aria-label="Hook devices removals">{announcement}</p>
    <button ref={refreshButton} type="button" disabled={busy} onClick={() => void refresh()}>Refresh Hook devices</button>
    <div ref={grid} className="hook-device-grid">{devices?.map(device => <article key={device.id} data-record-id={device.id}><button type="button" className="hook-device" key={device.id}
      disabled={!onOpenHook} aria-controls="configuration-panel"
      aria-label={`Open Hook device: ${device.name} · ID: ${device.id}`} onClick={() => onOpenHook?.(device.id)}>
      <span aria-hidden="true">⚑</span><strong>{device.name}</strong><span>Trigger configuration</span><span>ID: {device.id}</span><span>Event: {device.event}</span>
      <span>Target: {device.target_kind} · ID: {device.target_id}</span>
      <span>Configuration {device.enabled ? 'enabled' : 'disabled'}</span>
      {(!connected || disconnectedSnapshot) && <span>{!connected ? 'Disconnected — potentially stale configuration snapshot' : 'Potentially stale configuration snapshot — refresh to check'}</span>}
      {(busy || error) && <span>{busy ? 'Refreshing snapshot' : 'Stale snapshot'}</span>}
    </button>
      <RecordedHookAttempts device={device} workspace={workspace} connected={connected} />
      {device.target_kind !== 'agent' || !['run_completed', 'run_failed'].includes(device.event)
        ? <p>Local follow-up preview supports employee run-completed and run-failed Hooks only. Team and task-created Hooks remain configuration only.</p>
        : <AssignedWorkChooser device={device} workspace={workspace} connected={connected} busy={busy} stale={!!error} onOpenWork={onOpenWork} />}
    </article>)}</div>
  </section>;
}


/** A choice is local intent; only Open requests inspection navigation. */
function AssignedWorkChooser({device, workspace, connected, busy, stale, onOpenWork}: {
  device: HookRecord; workspace?: Workspace | null; connected: boolean;
  busy: boolean; stale: boolean; onOpenWork?: (request: HookNavigation) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState({taskId: '', employeeId: device.target_id});
  const [removed, setRemoved] = useState(false);
  const work = workspace?.work.filter(item => item.assignees.includes(device.target_id)) ?? [];
  const valid = choice.employeeId === device.target_id && !!choice.taskId && work.some(item => item.id === choice.taskId);
  useEffect(() => {
    if (choice.employeeId !== device.target_id || (choice.taskId && !work.some(item => item.id === choice.taskId))) {
      setChoice({taskId: '', employeeId: device.target_id}); setRemoved(true);
    }
  }, [workspace, device.target_id, choice]);
  const unavailable = !connected ? 'Disconnected. Refresh connection before opening assigned work.'
    : busy ? 'Refreshing Hook devices. Wait before opening assigned work.'
    : stale ? 'Hook devices are stale. Refresh Hook devices before opening assigned work.'
    : !work.length ? 'No saved work assigned to this employee in the loaded history. Refresh saved history or assign work first.'
    : !onOpenWork ? 'Assigned-work navigation is unavailable here.' : '';
  return <div className="skill-work-chooser">
    <label htmlFor={id}>Assigned work for Hook: {device.name} · Hook ID: {device.id} · Employee ID: {device.target_id}</label>
    <select id={id} value={valid ? choice.taskId : ''} aria-describedby={`${id}-help`}
      disabled={!!unavailable} onChange={event => { setChoice({taskId: event.target.value, employeeId: device.target_id}); setRemoved(false); }}>
      <option value="">Choose assigned saved work…</option>
      {work.map(item => <option key={item.id} value={item.id}>{item.input.slice(0, 55)} · Task ID: {item.id}</option>)}
    </select>
    <p id={`${id}-help`}>{unavailable || (removed ? 'Previously chosen work or employee target changed. Choose assigned saved work again.' : 'Choose assigned saved work, then Open. Choosing and opening grant no consent and make no local MCP request.')}</p>
    <button type="button" disabled={!!unavailable || !valid} aria-controls="selected-work-inspection"
      aria-label={`Open assigned work for Hook: ${device.name} · Hook ID: ${device.id}`}
      onClick={() => { if (valid && !unavailable) onOpenWork?.({taskId: choice.taskId, hookId: device.id, employeeId: device.target_id}); }}>Open</button>
  </div>;
}

/** Saved Hook identity is independent of current configuration and assignments. */
function RecordedHookAttempts({device, workspace, connected}: {
  device: HookRecord; workspace?: Workspace | null; connected: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const matches = (workspace?.work ?? []).flatMap(work => work.attempts.flatMap(attempt =>
    attempt.hook?.hook_id === device.id ? [{work, attempt, saved: attempt.hook}] : []));
  return <div>
    <button type="button" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>
      Recorded attempts for Hook: {device.name} · Hook ID: {device.id}
    </button>
    <div id={id} hidden={!expanded}>
      <p>Read-only loaded history. Opening grants no execution consent.</p>
      {!workspace ? <p>Workspace unavailable. Refresh connection to load saved history.</p> : <>
        {!connected && <p>Disconnected — stale saved-work snapshot. Retained records do not confirm current execution state. Refresh connection.</p>}
        {!matches.length && <p>No matching records in loaded history. Other saved history may contain Hook attempts.</p>}
        {matches.map(({work, attempt, saved}) => <section key={`${work.id}:${attempt.id}`} aria-label={`Recorded Hook attempt · Task ${work.id} · Run ${attempt.id}`}>
          <p>Task ID: {work.id} · Run ID: {attempt.id}</p>
          <p>Saved Hook: {saved.hook_name} · Hook ID: {saved.hook_id}</p>
          <p>Source Run ID: {saved.source_run_id} · Event: {saved.event} · Source outcome: {saved.source_outcome}</p>
          <SourceAttempt sourceRunId={saved.source_run_id} source={work.attempts.find(source => source.id === saved.source_run_id)} />
          <p>Saved employee ID: {saved.agent_id}</p>
          <p>Saved Skill: {saved.skill_name} · Skill ID: {saved.skill_id}</p>
          <p>Preview ID: {saved.preview_id} · Provenance Run ID: {saved.run_id}</p>
          <p>Saved instructions</p><pre>{saved.instructions}</pre>
          <p>Saved effective input</p><pre>{saved.input}</pre>
          <p>Execution state: {attempt.state} · Outcome: {attempt.outcome ?? 'Not recorded'}</p>
          <p>Quality unverified</p>
          {attempt.output != null ? <><p>Recorded output</p><pre>{attempt.output}</pre></> : <p>No recorded output available.</p>}
          {attempt.error != null && <p>Recorded error: {attempt.error}</p>}
        </section>)}
      </>}
    </div>
  </div>;
}

/** Resolve from the containing Task only; disclosure never fetches or executes. */
function SourceAttempt({sourceRunId, source}: {sourceRunId: string; source?: Attempt}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <div>
    <button type="button" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>
      Source attempt details · Run ID: {sourceRunId}
    </button>
    <div id={id} hidden={!expanded}>
      {!source ? <p>Source record missing from this Task’s loaded history. Refresh saved history; no other attempt is substituted.</p> : <>
        <p>Persisted source Run ID: {source.id}</p>
        <p>Source execution state: {source.state} · Outcome: {source.outcome ?? 'Not recorded'}</p>
        {source.output != null ? <><p>Source recorded output</p><pre>{source.output}</pre></> : <p>No recorded source output available.</p>}
        {source.error != null ? <><p>Source recorded error</p><pre>{source.error}</pre></> : <p>No recorded source error available.</p>}
        <p>Source quality unverified</p>
      </>}
    </div>
  </div>;
}
