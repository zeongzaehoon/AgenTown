import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api';

export const workstationClients = [
  {id: 'codex', name: 'Codex'}, {id: 'claude-code', name: 'Claude Code'},
  {id: 'claude-desktop', name: 'Claude Desktop'}, {id: 'cursor', name: 'Cursor'},
  {id: 'chatgpt', name: 'ChatGPT'},
] as const;
export type ConnectionClientId = typeof workstationClients[number]['id'];
export interface OpenClientRequest { id: ConnectionClientId }

interface Platform { id: string; name: string; configuration: string; destination: string; inspection: string; filename?: string }
export interface ConnectionSetup {
  schema_version: 1; workflow_version: 1; transport: 'stdio'; evidence: string;
  preparation: string; actions: string[]; consent: string; recovery: string;
  clients: { id: string; name: string; readiness: 'unknown'; status?: {detected: boolean | null; configured: 'unknown'; connected: 'unverified'; exercised: 'unverified'}; platforms: Platform[] }[];
}

export function Connections({workspaceConnected, openClient}: {workspaceConnected: boolean; openClient?: OpenClientRequest | null}) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  useLayoutEffect(() => {
    if (openClient) { setVisited(true); setOpen(true); }
  }, [openClient]);
  return <section aria-labelledby="connections-heading">
    <h2 id="connections-heading">Connections</h2>
    <button type="button" aria-expanded={open} aria-controls="connections-content" onClick={() => {setVisited(true); setOpen(!open);}}>{open ? 'Hide connections' : 'Open connections'}</button>
    <div id="connections-content" hidden={!open}>{visited && <Setup active={open} workspaceConnected={workspaceConnected} openClient={openClient} />}</div>
  </section>;
}

function Setup({workspaceConnected, openClient, active}: {active: boolean; workspaceConnected: boolean; openClient?: OpenClientRequest | null}) {
  const [data, setData] = useState<ConnectionSetup | null>(null);
  const [clientId, setClientId] = useState<string>(openClient?.id ?? 'codex');
  const [platformId, setPlatformId] = useState('macos');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [copying, setCopying] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useLayoutEffect(() => {
    if (openClient) { setClientId(openClient.id); setFeedback(''); }
  }, [openClient]);
  useLayoutEffect(() => {
    if (openClient && active) heading.current?.focus();
  }, [openClient, active]);
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
  const client = data?.clients.find(c => c.id === clientId);
  const platform = client?.platforms.find(p => p.id === platformId) ?? client?.platforms[0];
  const instructions = data && client && platform ? [
    `${client.name} · ${platform.name} · ${client.id === 'chatgpt' ? 'Remote HTTPS prerequisites' : 'stdio workflow v1'}`, data.preparation,
    `Merge into ${platform.destination}:`, platform.configuration, platform.inspection,
    'Ask the client: Using AgenTown, list employees and saved work. Inspect the selected Task and its attempt history. Do not execute work.',
    ...data.actions, data.consent, data.recovery, data.evidence,
  ].join('\n\n') : '';
  function download() {
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(new Blob([platform?.configuration ?? ''], {type: 'text/plain;charset=utf-8'}));
      anchor = document.createElement('a');
      anchor.href = url; anchor.download = platform?.filename ?? `${clientId}-setup.txt`;
      document.body.appendChild(anchor); anchor.click();
      setFeedback('Download requested. Check your downloads; merge the fragment manually. Client readiness remains unknown.');
    } catch { setFeedback('Could not download. Copy the setup instructions or select and save the text below manually.'); }
    finally {
      anchor?.remove();
      if (url) { const completedUrl = url; setTimeout(() => URL.revokeObjectURL(completedUrl), 1000); }
    }
  }
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
  const clientName = workstationClients.find(c => c.id === clientId)?.name ?? client?.name ?? clientId;
  return <>
    <h3 tabIndex={-1} ref={heading}>{clientName} setup</h3>
    <p>Opening setup does not connect a client or execute provider work.</p>
    <p>Workspace: {workspaceConnected ? 'Connected' : 'Disconnected — loaded work may be stale'}. This does not establish an external client connection.</p>
    <button type="button" disabled={loading} onClick={() => void refresh()}>Refresh setup</button>
    <p role="status">{loading ? 'Loading setup…' : error ? 'Setup service disconnected or unavailable. Loaded instructions may be stale. Check the local server and refresh setup.' : 'Setup service available.'}</p>
    {data && !client && <p role="status">Selected client setup unavailable. Refresh setup to try again. Detected: Unknown. Configured: Unknown. Connected: Unverified. Exercised: Unverified.</p>}
    {!data && <p>Detected: Unknown. Configured: Unknown. Connected: Unverified. Exercised: Unverified.</p>}
    {data && <>
      <label htmlFor="connection-client">Client</label>
      <select id="connection-client" value={clientId} onChange={e => {setClientId(e.target.value); setFeedback('');}}>
        {!client && <option value={clientId}>{clientName} · setup unavailable</option>}
        {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </>}
    {data && client && platform && <>
      <label htmlFor="connection-platform">Platform</label>
      <select id="connection-platform" value={platform.id} onChange={e => {setPlatformId(e.target.value); setFeedback('');}}>{client.platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <p>Client readiness: Unknown</p>
      <p>Detected: {client.status?.detected === true ? 'Installation hint only' : client.status?.detected === false ? 'Not detected (inconclusive)' : 'Unknown'}. Configured: Unknown. Connected: Unverified. Exercised: Unverified.</p><p>{data.evidence}</p>
      <h3>Available actions</h3><ul>{data.actions.map(a => <li key={a}>{a}</li>)}</ul>
      <h3>Explicit execution consent</h3><p>{data.consent}</p>
      <button type="button" disabled={copying} onClick={() => void copy()}>Copy setup instructions</button>
      <button type="button" onClick={download}>Download setup artifact</button>
      <p role="status" aria-live="polite">{feedback}</p>
      <label htmlFor="connection-instructions">Setup instructions</label>
      <textarea id="connection-instructions" readOnly rows={16} value={instructions} />
    </>}
  </>;
}
