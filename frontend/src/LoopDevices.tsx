import type { LoopNavigation } from './OverviewLoops';
import type { Workspace } from './api';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { configurationRequest, savedLoopPolicies, type LoopRecord } from './configuration-api';

/** Office inspection is read-only and independent of provider availability. */
export function LoopDevices({onOpenLoop, onOpenPolicy, workspace, connected = true}: {onOpenLoop?: (id: string) => void; onOpenPolicy?: (request: LoopNavigation) => void; workspace?: Workspace | null; connected?: boolean}) {
  const [devices, setDevices] = useState<LoopRecord[] | null>(null);
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
  function acceptSnapshot(next: LoopRecord[]) {
    const ids = new Set(next.map(record => record.id));
    let removed = 0;
    for (const card of Array.from(grid.current?.children ?? [])) {
      if (!ids.has(card.getAttribute('data-record-id')!)) {
        removed++;
        if (card.contains(document.activeElement)) recoverFocus.current = true;
      }
    }
    setAnnouncement(removed
      ? `Loop devices refreshed: ${removed} record${removed === 1 ? '' : 's'} removed from this view. ${next.length ? 'Remaining cards are available below.' : 'No cards remain.'}`
      : '');
    setDevices(next);
  }
  const request = useRef<AbortController | null>(null);
  // Connection recovery does not validate independently loaded configuration.
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
    const startedConnected = connection.current.connected;
    const revision = connection.current.revision;
    setBusy(true); setError('');
    try {
      const result = await configurationRequest<{loops: LoopRecord[]}>('loops', '', undefined, controller.signal);
      const policies = savedLoopPolicies(result);
      if (request.current === controller && !controller.signal.aborted && revision === connection.current.revision) {
        acceptSnapshot(policies);
        setDisconnectedSnapshot(!startedConnected || !connection.current.connected || revision !== connection.current.revision);
      }
    } catch (failure) {
      if (request.current === controller && !controller.signal.aborted && revision === connection.current.revision) setError((failure as Error).message);
    } finally {
      if (request.current === controller && !controller.signal.aborted && revision === connection.current.revision) setBusy(false);
    }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  return <section className="loop-policy-devices" aria-labelledby="loop-policy-devices-title">
    <h3 id="loop-policy-devices-title">Saved Loop policy devices</h3>
    <p>Open linked work for explicit local MCP inspection, or open a saved policy in Configuration. These devices are separate from execution sessions below. Configuration enabled does not mean a session is running. Opening never saves, previews, starts or stops work.</p>
    <p role="status">{!connected ? 'Disconnected — Loop devices configuration may be stale. ' : disconnectedSnapshot ? 'Connection restored — Loop devices configuration may still be stale. Refresh Loop devices to check. ' : ''}{busy ? 'Loading Loop devices…' : error ? devices ? 'Loop devices are stale — showing the last successful snapshot.' : 'Loop devices unavailable.' : devices === null ? 'Loop devices unavailable.' : devices?.length ? (!connected || disconnectedSnapshot) ? 'Showing retained Loop devices configuration.' : 'Showing saved Loop devices.' : (!connected || disconnectedSnapshot) ? 'The last successful configuration snapshot was empty; current Loops are unknown.' : 'No saved Loops yet. Create a Loop in Configuration.'}</p>
    {error && <p role="alert">{error}</p>}
    <p aria-live="polite" aria-atomic="true" aria-label="Loop devices removals">{announcement}</p>
    <button ref={refreshButton} type="button" disabled={busy} onClick={() => void refresh()}>Refresh Loop devices</button>
    <div ref={grid} className="loop-policy-device-grid">{devices?.map((device, index) => {
      const unavailable = !connected ? 'Disconnected. Reconnect before opening linked work.'
        : busy ? 'Refreshing Loop devices. Wait for a successful snapshot before opening linked work.'
        : error ? 'Loop devices are stale. Refresh successfully before opening linked work.'
        : !workspace?.work.some(w => w.id === device.task_id) ? 'Linked work unavailable in loaded saved work. Refresh saved history before opening.'
        : !onOpenPolicy ? 'Linked work navigation unavailable.' : '';
      const explanationId = `loop-linked-work-unavailable-${index}`;
      return <article key={device.id} data-record-id={device.id}><button type="button" className="loop-policy-device" key={device.id}
      disabled={!onOpenLoop} aria-controls="configuration-panel"
      aria-label={`Open Loop device: ${device.name} · ID: ${device.id}`} onClick={() => onOpenLoop?.(device.id)}>
      <span aria-hidden="true">⚑</span><strong>{device.name}</strong><span>Saved repeating-work policy</span><span>ID: {device.id}</span><span>Linked Task ID: {device.task_id}</span>
      <span>Iteration limit: {device.max_iterations}</span><span>Interval: {device.interval_seconds} seconds</span>
      <span>Open Configuration</span><span>Configuration {device.enabled ? 'enabled' : 'disabled'}</span>
      {(!connected || disconnectedSnapshot) && <span>{!connected ? 'Disconnected — potentially stale configuration snapshot' : 'Potentially stale configuration snapshot — refresh to check'}</span>}
      {(busy || error) && <span>{busy ? 'Refreshing snapshot' : 'Stale snapshot'}</span>}
    </button>
      <button type="button" aria-controls="selected-work-inspection" disabled={Boolean(unavailable)} aria-describedby={unavailable ? explanationId : undefined}
        aria-label={`Open linked work for Loop: ${device.name} · Policy ID: ${device.id} · Task ID: ${device.task_id}`}
        onClick={() => { if (!unavailable) onOpenPolicy?.({taskId: device.task_id, policyId: device.id}); }}>Open linked work · local MCP</button>
      {unavailable && <p id={explanationId}>{unavailable}</p>}
    </article>; })}</div>
  </section>;
}
