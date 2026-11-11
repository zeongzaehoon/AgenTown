import { useEffect, useRef, useState } from 'react';
import { api } from './api';

interface Platform { id: string; name: string; configuration: string; destination: string; inspection: string }
export interface ConnectionSetup {
  schema_version: 1; workflow_version: 1; transport: 'stdio'; evidence: string;
  preparation: string; actions: string[]; consent: string; recovery: string;
  clients: { id: string; name: string; readiness: 'unknown'; platforms: Platform[] }[];
}

export function Connections({workspaceConnected}: {workspaceConnected: boolean}) {
  const [open, setOpen] = useState(false);
  return <section aria-labelledby="connections-heading">
    <h2 id="connections-heading">Connections</h2>
    <button type="button" aria-expanded={open} aria-controls="connections-content" onClick={() => setOpen(!open)}>{open ? 'Hide connections' : 'Open connections'}</button>
    <div id="connections-content" hidden={!open}>{open && <Setup workspaceConnected={workspaceConnected} />}</div>
  </section>;
}

function Setup({workspaceConnected}: {workspaceConnected: boolean}) {
  const [data, setData] = useState<ConnectionSetup | null>(null);
  const [clientId, setClientId] = useState('codex');
  const [platformId, setPlatformId] = useState('macos');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [copying, setCopying] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const copyingLock = useRef(false);
  async function refresh() {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true);
    try {
      const next = await api<ConnectionSetup>('/api/connections/v1', {}, request.signal);
      if (request.signal.aborted) return;
      if (next.schema_version !== 1 || next.workflow_version !== 1 || next.transport !== 'stdio' || !next.clients?.length || next.clients.some(c => c.readiness !== 'unknown' || !c.platforms?.length)) throw new Error('Unsupported setup');
      setData(next); setError(false);
    } catch { if (!request.signal.aborted) setError(true); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => controller.current?.abort(); }, []);
  const client = data?.clients.find(c => c.id === clientId) ?? data?.clients[0];
  const platform = client?.platforms.find(p => p.id === platformId) ?? client?.platforms[0];
  const instructions = data && client && platform ? [
    `${client.name} · ${platform.name} · stdio workflow v1`, data.preparation,
    `Merge into ${platform.destination}:`, platform.configuration, platform.inspection,
    'Ask the client: Using AgenTown, list employees and saved work. Inspect the selected Task and its attempt history. Do not execute work.',
    ...data.actions, data.consent, data.recovery, data.evidence,
  ].join('\n\n') : '';
  async function copy() {
    if (copyingLock.current) return;
    copyingLock.current = true; setCopying(true); setFeedback('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Unavailable');
      await navigator.clipboard.writeText(instructions);
      setFeedback('Setup instructions copied. Client readiness remains unknown.');
    } catch { setFeedback('Could not copy. Clipboard access is unavailable or denied. Select the setup instructions below and copy manually.'); }
    finally { copyingLock.current = false; setCopying(false); }
  }
  return <>
    <p>Workspace: {workspaceConnected ? 'Connected' : 'Disconnected — loaded work may be stale'}. This does not establish an external client connection.</p>
    <button type="button" disabled={loading} onClick={() => void refresh()}>Refresh setup</button>
    <p role="status">{loading ? 'Loading setup…' : error ? 'Setup service disconnected or unavailable. Loaded instructions may be stale. Check the local server and refresh setup.' : 'Setup service available.'}</p>
    {data && client && platform && <>
      <label htmlFor="connection-client">Client</label>
      <select id="connection-client" value={client.id} onChange={e => {setClientId(e.target.value); setFeedback('');}}>{data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <label htmlFor="connection-platform">Platform</label>
      <select id="connection-platform" value={platform.id} onChange={e => {setPlatformId(e.target.value); setFeedback('');}}>{client.platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <p>Client readiness: Unknown</p><p>{data.evidence}</p>
      <h3>Available actions</h3><ul>{data.actions.map(a => <li key={a}>{a}</li>)}</ul>
      <h3>Explicit execution consent</h3><p>{data.consent}</p>
      <button type="button" disabled={copying} onClick={() => void copy()}>Copy setup instructions</button>
      <p role="status" aria-live="polite">{feedback}</p>
      <label htmlFor="connection-instructions">Setup instructions</label>
      <textarea id="connection-instructions" readOnly rows={16} value={instructions} />
    </>}
  </>;
}
