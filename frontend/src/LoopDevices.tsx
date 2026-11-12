import { useEffect, useRef, useState } from 'react';
import { configurationRequest, savedLoopPolicies, type LoopRecord } from './configuration-api';

/** Office inspection is read-only and independent of provider availability. */
export function LoopDevices({onOpenLoop}: {onOpenLoop?: (id: string) => void}) {
  const [devices, setDevices] = useState<LoopRecord[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    try {
      const result = await configurationRequest<{loops: LoopRecord[]}>('loops', '', undefined, controller.signal);
      const policies = savedLoopPolicies(result);
      if (!controller.signal.aborted) setDevices(policies);
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  return <section className="loop-policy-devices" aria-labelledby="loop-policy-devices-title">
    <h3 id="loop-policy-devices-title">Saved Loop policy devices</h3>
    <p>Open a saved policy in Configuration. These devices are separate from execution sessions below. Configuration enabled does not mean a session is running. Opening never saves, previews, starts or stops work.</p>
    <p role="status">{busy ? 'Loading Loop devices…' : error ? devices ? 'Loop devices are stale — showing the last successful snapshot.' : 'Loop devices unavailable.' : devices?.length ? 'Showing saved Loop devices.' : 'No saved Loops yet. Create a Loop in Configuration.'}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh Loop devices</button>
    <div className="loop-policy-device-grid">{devices?.map(device => <button type="button" className="loop-policy-device" key={device.id}
      disabled={!onOpenLoop} aria-controls="configuration-panel"
      aria-label={`Open Loop device: ${device.name} · ID: ${device.id}`} onClick={() => onOpenLoop?.(device.id)}>
      <span aria-hidden="true">⚑</span><strong>{device.name}</strong><span>Saved repeating-work policy</span><span>ID: {device.id}</span><span>Linked Task ID: {device.task_id}</span>
      <span>Iteration limit: {device.max_iterations}</span><span>Interval: {device.interval_seconds} seconds</span>
      <span>Configuration {device.enabled ? 'enabled' : 'disabled'}</span>
      {(busy || error) && <span>{busy ? 'Refreshing snapshot' : 'Stale snapshot'}</span>}
    </button>)}</div>
  </section>;
}
