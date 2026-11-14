import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, RequestTimeoutError } from './api';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function hasUniqueIds(items: Record<string, unknown>[]): boolean {
  return new Set(items.map(item => item.id)).size === items.length;
}
// Validate every rendered/copied field atomically. Inspection must never trim or
// rewrite configuration text, and absent optional presentation hints stay valid.
function isConnectionSetup(value: unknown): value is ConnectionSetup {
  if (!isRecord(value) || value.schema_version !== 1 || value.workflow_version !== 1 || value.transport !== 'stdio') return false;
  if (!['evidence', 'preparation', 'consent', 'recovery'].every(key => isText(value[key]))) return false;
  if (!Array.isArray(value.actions) || !value.actions.length || !value.actions.every(isText)) return false;
  if (!Array.isArray(value.clients) || !value.clients.length) return false;
  if (!value.clients.every((client: unknown) => {
    if (!isRecord(client) || !isText(client.id) || !isText(client.name) || client.readiness !== 'unknown') return false;
    if ('status' in client) {
      const status = client.status;
      if (!isRecord(status) || ![true, false, null].includes(status.detected as boolean | null) ||
          status.configured !== 'unknown' || status.connected !== 'unverified' || status.exercised !== 'unverified') return false;
    }
    if (!Array.isArray(client.platforms) || !client.platforms.length) return false;
    return client.platforms.every((platform: unknown) => isRecord(platform) &&
      ['id', 'name', 'configuration', 'destination', 'inspection'].every(key => isText(platform[key])) &&
      (!('filename' in platform) || isText(platform.filename))) && hasUniqueIds(client.platforms);
  })) return false;
  return hasUniqueIds(value.clients);
}

interface DiagnosticResponse {
  schema_version: 1;
  status: 'passed' | 'timeout' | 'failed' | 'busy';
  code: string; message: string; recovery: string;
}
function isDiagnostic(value: unknown): value is DiagnosticResponse {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.schema_version === 1 &&
    ['passed', 'timeout', 'failed', 'busy'].includes(result.status as string) &&
    ['code', 'message', 'recovery'].every(key => typeof result[key] === 'string' &&
      (result[key] as string).length <= 2000) && Boolean(result.code) && Boolean(result.message);
}
const diagnosticMessages = {
  passed: 'Local server diagnostic passed',
  timeout: 'Local server diagnostic timed out.',
  failed: 'Local server diagnostic failed.',
  busy: 'A local server diagnostic is already running.',
  missing_tools: 'Local server diagnostic failed: required workflow tools are missing.',
};
const diagnosticRecovery = {
  passed: 'Continue with the setup instructions, then inspect the connection in your external client.',
  timeout: 'Wait for the server check to close, then try again. If this continues, restart AgenTown and check its installation.',
  failed: 'Check that the installed AgenTown server and selected database are available, restart AgenTown, then try again.',
  busy: 'Wait for the current check to finish, then try again.',
  missing_tools: 'Repair or reinstall AgenTown, keeping your database. Restart AgenTown, then check again.',
};
// A response can refresh evidence only within the connected period in which
// the user requested it. Reconnection never refreshes retained observations.
function useEvidenceFreshness(connected: boolean) {
  const [stale, setStale] = useState(!connected);
  const connection = useRef({connected, generation: 0});
  useLayoutEffect(() => {
    if (connection.current.connected !== connected) {
      connection.current = {connected, generation: connection.current.generation + 1};
    }
    if (!connected) setStale(true);
  }, [connected]);
  function begin() { return {...connection.current}; }
  function finish(start: {connected: boolean; generation: number}, successful: boolean) {
    setStale(!successful || !start.connected || !connection.current.connected ||
      start.generation !== connection.current.generation);
  }
  return {stale, begin, finish};
}

function LocalDiagnostic({workspaceConnected}: {workspaceConnected: boolean}) {
  const freshness = useEvidenceFreshness(workspaceConnected);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<keyof typeof diagnosticMessages | null>(null);
  const lock = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function check() {
    if (lock.current) return;
    lock.current = true;
    const started = freshness.begin();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const result = await api<unknown>('/api/connections/v1/diagnostic', {}, controller.signal);
      if (!isDiagnostic(result)) throw new Error('Unsupported diagnostic response');
      if (!controller.signal.aborted) {
        setOutcome(result.status === 'failed' && result.code === 'missing_tools' ? 'missing_tools' : result.status);
        freshness.finish(started, result.status === 'passed');
      }
    } catch (error) {
      // Do not expose transport errors or subprocess output in the interface.
      if (!controller.signal.aborted) {
        setOutcome(error instanceof RequestTimeoutError ? 'timeout' : 'failed');
        freshness.finish(started, false);
      }
    } finally {
      lock.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return <section aria-label="Local server diagnostic" aria-busy={pending}>
    <h3>Check local server</h3>
    {outcome && freshness.stale && <p role="status">Previous local server diagnostic observation — potentially stale. Reconnect and explicitly check local server again to refresh this evidence.</p>}
    <p>Checks the installed server and selected database used by the setup artifact. Initializes MCP and discovers workflow tools without running them or calling a provider.</p>
    <button type="button" disabled={pending} onClick={() => void check()}>Check local server</button>
    <div role="status" aria-live="polite" aria-atomic="true">
      {pending ? <p>Checking local server… Waiting for initialization and workflow tool discovery.</p> : outcome && <>
        <p>{diagnosticMessages[outcome]}</p><p>{diagnosticRecovery[outcome]}</p>
      </>}
    </div>
    <p>This check does not read client settings. External client configuration remains unknown; external connection and exercise remain unverified.</p>
  </section>;
}

type SharedDataResponse =
  | (DiagnosticResponse & {status: 'passed'; employee_count: number; work_count: number})
  | (DiagnosticResponse & {status: 'timeout' | 'failed' | 'busy'});
function isSharedData(value: unknown): value is SharedDataResponse {
  if (!isDiagnostic(value)) return false;
  const result = value as DiagnosticResponse & {employee_count?: unknown; work_count?: unknown};
  if (result.status !== 'passed') return !('employee_count' in result) && !('work_count' in result);
  return [result.employee_count, result.work_count].every(count =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
}
const sharedMessages = {
  passed: 'Shared-data check passed.',
  busy: 'A local server check is already running.',
  timeout: 'Shared-data check timed out.',
  failed: 'Shared-data check failed.',
  malformed: 'Shared-data check returned an invalid response.',
};
function SharedDataCheck({workspaceConnected}: {workspaceConnected: boolean}) {
  const freshness = useEvidenceFreshness(workspaceConnected);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<keyof typeof sharedMessages | null>(null);
  const [counts, setCounts] = useState<{employees: number; work: number} | null>(null);
  const lock = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function check() {
    if (lock.current) return;
    lock.current = true;
    const started = freshness.begin();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const result = await api<unknown>('/api/connections/v1/shared-data', {}, controller.signal);
      if (controller.signal.aborted) return;
      if (!isSharedData(result)) { setOutcome('malformed'); freshness.finish(started, false); return; }
      setOutcome(result.status);
      freshness.finish(started, result.status === 'passed');
      if (result.status === 'passed') setCounts({employees: result.employee_count, work: result.work_count});
    } catch (error) {
      if (!controller.signal.aborted) {
        setOutcome(error instanceof RequestTimeoutError ? 'timeout' : 'failed');
        freshness.finish(started, false);
      }
    } finally {
      lock.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return <section aria-label="Shared employee and work access" aria-busy={pending}>
    <h3>Check shared data</h3>
    {outcome && freshness.stale && <p role="status">Previous shared-data observation and counts — potentially stale. Reconnect and explicitly check shared data again to refresh this evidence.</p>}
    <p>Use the installed local server and selected database to read employees and saved work. Only counts are shown. This separate check calls list_agents and list_tasks; it does not change data, inspect history, execute work, call a provider, or read client settings or credentials.</p>
    <button type="button" disabled={pending} onClick={() => void check()}>Check shared data</button>
    <div role="status" aria-live="polite" aria-atomic="true">
      {pending ? <p>Checking shared data… Waiting for employee and work counts.</p> : outcome && <>
        <p>{sharedMessages[outcome]}</p>
        {counts && <p>Employees: {counts.employees}. Saved work: {counts.work}.</p>}
        <p>{outcome === 'passed'
          ? 'Local read access verified for this check. Continue setup and inspect the connection in your external client.'
          : outcome === 'busy' ? 'Wait for the current check to finish, then try again.'
          : outcome === 'timeout' ? 'Wait for the server check to close, then try again. If this continues, restart AgenTown and check its installation.'
          : 'Check that the installed AgenTown server and selected database are available, restart AgenTown, then try again.'}</p>
      </>}
    </div>
    <p>External client configuration remains unknown; external connection and exercise remain unverified. This local check does not validate ChatGPT.</p>
  </section>;
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
  const freshness = useEvidenceFreshness(workspaceConnected);
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
    const started = freshness.begin();
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true);
    try {
      const next = await api<unknown>('/api/connections/v1', {}, request.signal);
      if (request.signal.aborted) return;
      if (!isConnectionSetup(next)) throw new Error('Unsupported setup');
      setData(next); setError(false); freshness.finish(started, true);
    } catch { if (!request.signal.aborted) { setError(true); freshness.finish(started, false); } }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => controller.current?.abort(); }, []);
  const client = data?.clients.find(c => c.id === clientId);
  const platform = client?.platforms.find(p => p.id === platformId) ?? client?.platforms[0];
  const instructions = data && client && platform ? [
    `${client.name} · ${platform.name} · ${client.id === 'chatgpt' ? 'Remote HTTPS prerequisites' : 'stdio workflow v1'}`,
    ...(client.id === 'chatgpt' ? [] : [data.preparation]),
    client.id === 'chatgpt' ? `Remote prerequisites for ${platform.destination}:` : `Merge into ${platform.destination}:`, platform.configuration, platform.inspection,
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
      setFeedback(client?.id === 'chatgpt'
        ? 'Prerequisite checklist download requested. Check your downloads and review the HTTPS/OAuth prerequisites. Client readiness remains unknown.'
        : 'Download requested. Check your downloads; merge the fragment manually. Client readiness remains unknown.');
    } catch { setFeedback('Could not download. Copy the setup instructions or select and save the text below manually.'); }
    finally {
      anchor?.remove();
      if (url) { const completedUrl = url; setTimeout(() => URL.revokeObjectURL(completedUrl), 1000); }
    }
  }
  const copyGeneration = useRef(0);
  useLayoutEffect(() => {
    copyGeneration.current += 1;
    copyingLock.current = false;
    setCopying(false); setFeedback('');
    return () => { copyGeneration.current += 1; };
  }, [clientId, platformId, data, openClient]);
  async function copy(fragment = false) {
    const generation = copyGeneration.current;
    if (copyingLock.current) return;
    copyingLock.current = true; setCopying(true); setFeedback('Copying…');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Unavailable');
      await navigator.clipboard.writeText(fragment ? platform!.configuration : instructions);
      if (generation !== copyGeneration.current) return;
      setFeedback(`${fragment ? 'Configuration' : 'Setup instructions'} copied. Client readiness remains unknown.`);
    } catch {
      if (generation === copyGeneration.current) setFeedback(`Could not copy. Clipboard access is unavailable or denied. Select the ${fragment ? 'Configuration fragment' : 'Setup instructions'} field and copy manually.`);
    } finally {
      if (generation === copyGeneration.current) { copyingLock.current = false; setCopying(false); }
    }
  }
  const clientName = workstationClients.find(c => c.id === clientId)?.name ?? client?.name ?? clientId;
  return <>
    <h3 tabIndex={-1} ref={heading}>{clientName} setup</h3>
    <p>Opening setup does not connect a client or execute provider work.</p>
    <p>Workspace: {workspaceConnected ? 'Connected' : 'Disconnected — loaded work may be stale'}. This does not establish an external client connection.</p>
    <button type="button" disabled={loading} onClick={() => void refresh()}>Refresh setup</button>
    <p role="status" aria-live="polite" aria-atomic="true">{loading ? 'Loading setup…' : error ? `Setup service disconnected or unavailable. ${data ? 'Previously loaded instructions may be stale.' : 'No setup instructions are available.'} Check the local server and refresh setup.` : freshness.stale ? 'Setup service freshness unverified. Refresh setup while connected.' : 'Setup service available.'}</p>
    {data && freshness.stale && <p role="status">Previous setup observation — instructions and installation hints may be stale. Reconnect and explicitly refresh setup to refresh this evidence.</p>}
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
      {client.id === 'chatgpt' ? <section aria-labelledby="chatgpt-prerequisites">
        <h3 id="chatgpt-prerequisites">ChatGPT prerequisites checklist</h3>
        <p>Remote HTTPS prerequisites; this is not a local client configuration.</p>
        <ul>{platform.configuration.split('\n').filter(line => line.trim()).map((line, index) => <li key={index}>{line}</li>)}</ul>
        <p>{platform.inspection}</p>
      </section> : <ol className="connection-steps" aria-label="Local client setup steps">
        <li><h4>Prepare AgenTown</h4><p className="connection-guidance">{data.preparation}</p></li>
        <li><h4>Configure {client.name} · {platform.name}</h4>
          <p>Merge this fragment into the selected destination manually.</p>
          <label htmlFor="connection-destination">Configuration destination</label>
          <textarea id="connection-destination" readOnly rows={2} value={platform.destination} />
          <label htmlFor="connection-configuration">Configuration fragment</label>
          <textarea id="connection-configuration" readOnly rows={10} value={platform.configuration} />
          <button type="button" disabled={copying} onClick={() => void copy(true)}>Copy configuration</button>
        </li>
        <li><h4>Inspect and verify in {client.name}</h4>
          <p className="connection-guidance">{platform.inspection}</p>
          <p>Ask the client: Using AgenTown, list employees and saved work. Inspect the selected Task and its attempt history. Do not execute work.</p>
          <LocalDiagnostic workspaceConnected={workspaceConnected} /><SharedDataCheck workspaceConnected={workspaceConnected} />
        </li>
        <li><h4>Recover if setup fails</h4><p className="connection-guidance">{data.recovery}</p></li>
      </ol>}
      <button type="button" disabled={copying} onClick={() => void copy()}>Copy setup instructions</button>
      <button type="button" onClick={download}>Download setup artifact</button>
      <p role="status" aria-live="polite">{feedback}</p>
      <label htmlFor="connection-instructions">Setup instructions</label>
      <textarea id="connection-instructions" readOnly rows={16} value={instructions} />
    </>}
  </>;
}
