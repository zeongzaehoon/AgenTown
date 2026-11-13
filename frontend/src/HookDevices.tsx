import type { Workspace } from './api';
export interface HookNavigation {taskId: string; hookId: string; employeeId: string}
import { useEffect, useRef, useState } from 'react';
import { configurationRequest, type HookRecord } from './configuration-api';

/** Office inspection is read-only and independent of provider availability. */
export function HookDevices({onOpenHook, onOpenWork, workspace, connected = true}: {onOpenHook?: (id: string) => void; onOpenWork?: (request: HookNavigation) => void; workspace?: Workspace | null; connected?: boolean}) {
  const [devices, setDevices] = useState<HookRecord[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    try {
      const result = await configurationRequest<{hooks: HookRecord[]}>('hooks', '', undefined, controller.signal);
      if (!Array.isArray(result.hooks) || result.hooks.some(device => !device || typeof device.id !== 'string' || typeof device.name !== 'string' || typeof device.enabled !== 'boolean' || typeof device.event !== 'string' || typeof device.target_kind !== 'string' || typeof device.target_id !== 'string' || typeof device.skill_id !== 'string')) throw new Error('Saved Hook data unavailable. Refresh to try again.');
      if (!controller.signal.aborted) setDevices(result.hooks);
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  return <section className="hook-devices" aria-labelledby="hook-devices-title">
    <h3 id="hook-devices-title">Hook trigger devices</h3>
    <p>Open a device to inspect its saved Hook in Configuration. Opening never saves, enables or executes work. Hooks do not run automatically.</p>
    <p role="status">{busy ? 'Loading Hook devices…' : error ? devices ? 'Hook devices are stale — showing the last successful snapshot.' : 'Hook devices unavailable.' : devices?.length ? 'Showing saved Hook devices.' : 'No saved Hooks yet. Create a Hook in Configuration.'}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh Hook devices</button>
    <div className="hook-device-grid">{devices?.map(device => <article key={device.id}><button type="button" className="hook-device" key={device.id}
      disabled={!onOpenHook} aria-controls="configuration-panel"
      aria-label={`Open Hook device: ${device.name} · ID: ${device.id}`} onClick={() => onOpenHook?.(device.id)}>
      <span aria-hidden="true">⚑</span><strong>{device.name}</strong><span>Trigger configuration</span><span>ID: {device.id}</span><span>Event: {device.event}</span>
      <span>Target: {device.target_kind} · ID: {device.target_id}</span>
      <span>Configuration {device.enabled ? 'enabled' : 'disabled'}</span>
      {(busy || error) && <span>{busy ? 'Refreshing snapshot' : 'Stale snapshot'}</span>}
    </button>
      {device.target_kind !== 'agent' || !['run_completed', 'run_failed'].includes(device.event)
        ? <p>Local follow-up preview supports employee run-completed and run-failed Hooks only. Team and task-created Hooks remain configuration only.</p>
        : <><p>Choose saved work assigned to employee ID: {device.target_id}. Opening does not inspect, discover, preview or execute.</p>
          {!workspace?.work.some(w => w.assignees.includes(device.target_id)) && <p>No saved work assigned to this employee in the loaded history. Refresh saved history or assign work first.</p>}
          {workspace?.work.filter(w => w.assignees.includes(device.target_id)).map(w => <button type="button" key={w.id}
            disabled={!connected || busy || !!error || !onOpenWork} aria-controls="selected-work-inspection"
            aria-label={`Open work for Hook: ${device.name} · Hook ID: ${device.id} · Task ID: ${w.id}`}
            onClick={() => onOpenWork?.({taskId: w.id, hookId: device.id, employeeId: device.target_id})}>Open work: {w.input.slice(0, 55)} · Task ID: {w.id} · local MCP</button>)}
        </>}
    </article>)}</div>
  </section>;
}
