import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { REQUEST_DEADLINE_MS } from './api';
import { Connections, type ConnectionSetup } from './Connections';

afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
const setup: ConnectionSetup = {
  schema_version: 1, workflow_version: 1, transport: 'stdio', evidence: 'Copying does not verify a client.',
  preparation: 'Replace both paths.', actions: ['Inspect saved work', 'Execute only with consent'], consent: 'Explicit consent required before spending.', recovery: 'Inspect history before retrying.',
  clients: ['codex', 'claude-code'].map(id => ({id, name: id === 'codex' ? 'Codex' : 'Claude Code', readiness: 'unknown', platforms: ['macos', 'windows'].map(p => ({id: p, name: p, destination: `${id}-${p}`, configuration: `config-${id}-${p}`, inspection: 'Inspect /mcp'}))})),
};

const recoverySetup: ConnectionSetup = {...setup,
  preparation: 'Artifacts use this running packaged Python and selected database. No checkout or Node is required. '
    + 'Back up the destination and merge only the agentown entry; do not replace other settings. '
    + 'Download saves a merge fragment, not a settings installation. For ChatGPT use the prerequisite checklist instead. '
    + 'Moving the installation or selecting another database requires fresh artifacts.',
  clients: [...fragmentClients(), {
  ...setup.clients[0], id: 'chatgpt', name: 'ChatGPT',
  status: {detected: null, configured: 'unknown', connected: 'unverified', exercised: 'unverified'},
  platforms: [{...setup.clients[0].platforms[0], configuration: 'Provide HTTPS\nProvide OAuth\n', filename: 'chatgpt-prerequisites.txt'}],
}]};
function fragmentClients() {
  return setup.clients.map(client => ({...client, platforms: client.platforms.map(platform => ({
    ...platform, configuration: `  ${platform.configuration}\n\n  trailing space \n`, filename: `${client.id}-${platform.id}.txt`,
  }))}));
}
// Mutations include unselected clients/platforms: a response is accepted as a
// whole, never just the currently visible fragment.
const malformedFields: [string, unknown][] = [
  ...['schema_version', 'workflow_version', 'transport', 'evidence', 'preparation', 'consent', 'recovery', 'actions', 'clients']
    .flatMap(field => [[field, undefined], [field, {}]] as [string, unknown][]),
  ['actions', []], ['actions.0', null], ['actions.0', '  '], ['clients', []], ['clients.1', null],
  ...['id', 'name', 'readiness', 'platforms'].flatMap(field =>
    [[`clients.1.${field}`, undefined], [`clients.1.${field}`, 42]] as [string, unknown][]),
  ['clients.1.id', 'codex'], ['clients.1.platforms', []], ['clients.1.platforms.1', null],
  ...['id', 'name', 'configuration', 'destination', 'inspection'].flatMap(field =>
    [[`clients.1.platforms.1.${field}`, undefined], [`clients.1.platforms.1.${field}`, {}], [`clients.1.platforms.1.${field}`, '  ']] as [string, unknown][]),
  ['clients.1.platforms.1.id', 'macos'], ['clients.1.platforms.1.filename', null],
  ['clients.1.platforms.1.filename', ''], ['clients.1.platforms.1.filename', 17],
  ['clients.2.status', null], ['clients.2.status.detected', undefined], ['clients.2.status.detected', 'yes'],
  ...['configured', 'connected', 'exercised'].flatMap(field =>
    [[`clients.2.status.${field}`, undefined], [`clients.2.status.${field}`, 'verified']] as [string, unknown][]),
  ['clients.2.platforms.0.configuration', undefined], ['clients.2.platforms.0.configuration', []],
  ['clients.2.platforms.0.configuration', '  '],
];

test.each(malformedFields)('setup recovery rejects malformed %s (%j) atomically', async (path, invalid) => {
  const malformed = structuredClone(recoverySetup);
  const keys = path.split('.');
  let target: Record<string, unknown> = malformed as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys[keys.length - 1]] = invalid;
  let response: unknown = malformed;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup();
  render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  const unavailable = await screen.findByText(/No setup instructions are available/);
  expect(unavailable.getAttribute('role')).toBe('status');
  expect(screen.queryByLabelText('Client')).toBeNull();
  expect(screen.queryByLabelText('Setup instructions')).toBeNull();
  expect(screen.queryByRole('button', {name: /Copy|Download/})).toBeNull();

  response = recoverySetup;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByLabelText('Client');
  // Exercise both the local fragment and the ChatGPT checklist paths.
  const remote = path.startsWith('clients.2');
  await user.selectOptions(screen.getByLabelText('Client'), remote ? 'chatgpt' : 'claude-code');
  if (!remote) await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  const previous = (screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value;
  const configuration = remote ? recoverySetup.clients[2].platforms[0].configuration : recoverySetup.clients[1].platforms[1].configuration;
  response = malformed;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByText(/Previously loaded instructions may be stale/);
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toBe(previous);
  expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe(remote ? 'chatgpt' : 'claude-code');
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await user.click(screen.getByRole('button', {name: remote ? 'Copy setup instructions' : 'Copy configuration'}));
  expect(copy).toHaveBeenLastCalledWith(remote ? previous : configuration);
  const create = vi.fn((_blob: Blob) => 'blob:valid-setup');
  vi.stubGlobal('URL', {createObjectURL: create, revokeObjectURL: vi.fn()});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await user.click(screen.getByRole('button', {name: 'Download setup artifact'}));
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0].size).toBe(new Blob([configuration]).size);
  expect(click).toHaveBeenCalledOnce();
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
  const recovered = structuredClone(recoverySetup);
  recovered.preparation = 'Recovered setup instructions.';
  recovered.clients[2].platforms[0].configuration = 'Recovered HTTPS/OAuth prerequisites.';
  response = recovered;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByText('Setup service available.');
  const refreshed = (screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value;
  expect(refreshed).toContain(remote ? 'Recovered HTTPS/OAuth prerequisites.' : 'Recovered setup instructions.');
  if (remote) expect(refreshed).not.toContain(recovered.preparation);
  expect(screen.queryByText(/Previously loaded instructions may be stale/)).toBeNull();
});

test.each([null, [], 'invalid'])('non-object setup %j is unavailable and retryable', async response => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup();
  render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByText(/No setup instructions are available/);
  expect(screen.queryByRole('button', {name: /Copy|Download/})).toBeNull();
  expect((screen.getByRole('button', {name: 'Refresh setup'}) as HTMLButtonElement).disabled).toBe(false);
});

test('keyboard selection copies exact instructions without establishing readiness or mutating work', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(setup)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<Connections workspaceConnected />);
  expect(fetcher).not.toHaveBeenCalled();
  screen.getByRole('button', {name: 'Open connections'}).focus();
  await user.keyboard('{Enter}');
  await screen.findByLabelText('Client');
  await user.selectOptions(screen.getByLabelText('Client'), 'claude-code');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  const text = screen.getByLabelText('Setup instructions') as HTMLTextAreaElement;
  expect(text.value).toContain('config-claude-code-windows');
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  screen.getByRole('button', {name: 'Copy setup instructions'}).focus();
  await user.keyboard('{Enter}');
  expect(copy).toHaveBeenCalledWith(text.value);
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(await screen.findByText(/Setup instructions copied/)).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
});

test('clipboard denial and disconnected setup retain selection and instructions with explicit recovery', async () => {
  let offline = false;
  vi.stubGlobal('fetch', vi.fn(async () => {if (offline) throw new Error('offline'); return new Response(JSON.stringify(setup));}));
  const user = userEvent.setup();
  const view = render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByLabelText('Client');
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(await screen.findByText(/Could not copy/)).toBeTruthy();
  const instructions = (screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value;
  offline = true; view.rerender(<Connections workspaceConnected={false} />);
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  expect(await screen.findByText(/Setup service disconnected/)).toBeTruthy();
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toBe(instructions);
  expect(screen.getByText(/Workspace: Disconnected/)).toBeTruthy();
  offline = false;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByText('Setup service freshness unverified. Refresh setup while connected.');
  expect(screen.getByText(/Previous setup observation/)).toBeTruthy();
  view.rerender(<Connections workspaceConnected />);
  expect(screen.getByText(/Previous setup observation/)).toBeTruthy();
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await waitFor(() => expect(screen.getByText('Setup service available.')).toBeTruthy());
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
});

test('all five choices offer artifacts; download failure preserves truthful status', async () => {
  const all = {...setup, clients: ['codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt'].map(id => ({
    ...setup.clients[0], id, name: id, platforms: [{...setup.clients[0].platforms[0], configuration: `artifact-${id}`, filename: `${id}.txt`}],
  }))};
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(all))));
  const user = userEvent.setup();
  const create = vi.fn((_blob: Blob) => 'blob:setup');
  vi.stubGlobal('URL', {createObjectURL: create, revokeObjectURL: vi.fn()});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<Connections workspaceConnected={false} />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByLabelText('Client');
  for (const id of ['codex', 'claude-code', 'claude-desktop', 'cursor', 'chatgpt']) {
    await user.selectOptions(screen.getByLabelText('Client'), id);
    screen.getByRole('button', {name: 'Download setup artifact'}).focus();
    await user.keyboard('{Enter}');
    expect(create.mock.calls.at(-1)?.[0]).toBeInstanceOf(Blob);
    expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
    expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toContain(`artifact-${id}`);
  }
  expect(click).toHaveBeenCalledTimes(5);
  create.mockImplementation(() => {throw new Error('download denied');});
  await user.click(screen.getByRole('button', {name: 'Download setup artifact'}));
  expect(screen.getByText(/Could not download/)).toBeTruthy();
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
});

const diagnosticPath = '/api/connections/v1/diagnostic';
const diagnosticResult = (status: string) => ({schema_version: 1, status, code: status, message: 'Server result', recovery: 'Server recovery'});
async function openDiagnostic() {
  const user = userEvent.setup();
  render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByRole('button', {name: 'Check local server'});
  return user;
}

test('explicit diagnostic submits only an empty body, prevents duplicates and permits repeat checks', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((path: string) => path === diagnosticPath
    ? new Promise<Response>(resolve => { finish = resolve; })
    : Promise.resolve(new Response(JSON.stringify(setup))));
  vi.stubGlobal('fetch', fetcher);
  const user = await openDiagnostic();
  expect(fetcher.mock.calls.filter(([path]) => path === diagnosticPath)).toHaveLength(0);
  const button = screen.getByRole('button', {name: 'Check local server'});
  await user.dblClick(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Checking local server…/)).toBeTruthy();
  expect(fetcher.mock.calls.filter(([path]) => path === diagnosticPath)).toHaveLength(1);
  const call = (fetcher.mock.calls as unknown as [string, RequestInit][]).find(([path]) => path === diagnosticPath)!;
  expect(call[1].method).toBe('POST');
  expect(call[1].body).toBe('{}');
  finish(new Response(JSON.stringify(diagnosticResult('passed'))));
  expect(await screen.findByText('Local server diagnostic passed')).toBeTruthy();
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
  await user.click(button);
  finish(new Response(JSON.stringify(diagnosticResult('passed'))));
  await screen.findByText('Local server diagnostic passed');
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/connections/v1', diagnosticPath, diagnosticPath]);
});

test.each([
  ['timeout', 'Local server diagnostic timed out.', 'Wait for the server check to close'],
  ['failed', 'Local server diagnostic failed.', 'Check that the installed AgenTown server'],
  ['busy', 'A local server diagnostic is already running.', 'Wait for the current check to finish'],
])('diagnostic %s offers recovery without changing readiness', async (status, message, recovery) => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === diagnosticPath ? diagnosticResult(status) : setup))));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByText(new RegExp(recovery))).toBeTruthy();
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect((screen.getByRole('button', {name: 'Check local server'}) as HTMLButtonElement).disabled).toBe(false);
});

test.each([
  {...diagnosticResult('passed'), status: 'connected'},
  {...diagnosticResult('passed'), recovery: null},
  {...diagnosticResult('passed'), schema_version: 2},
  null,
])('malformed diagnostic responses fail safely', async result => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === diagnosticPath ? result : setup))));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  expect(await screen.findByText('Local server diagnostic failed.')).toBeTruthy();
  expect(screen.queryByText('Local server diagnostic passed')).toBeNull();
});

test('missing workflow tools offers installation recovery without displaying server output', async () => {
  const result = {...diagnosticResult('failed'), code: 'missing_tools', message: 'private subprocess output', recovery: 'private database path'};
  const fetcher = vi.fn(async (path: string) => new Response(JSON.stringify(path === diagnosticPath ? result : setup)));
  vi.stubGlobal('fetch', fetcher);
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  expect(await screen.findByText('Local server diagnostic failed: required workflow tools are missing.')).toBeTruthy();
  expect(screen.getByText('Repair or reinstall AgenTown, keeping your database. Restart AgenTown, then check again.')).toBeTruthy();
  expect(screen.queryByText(/private/)).toBeNull();
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/connections/v1', diagnosticPath]);
});

test('transport failure is sanitized and the pending request is aborted on unmount', async () => {
  let fail = true;
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    if (path !== diagnosticPath) return new Response(JSON.stringify(setup));
    if (fail) throw new Error('private subprocess stderr');
    signal = options.signal as AbortSignal;
    return new Promise<Response>(() => {});
  }));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await screen.findByText('Local server diagnostic failed.');
  expect(screen.queryByText(/private subprocess stderr/)).toBeNull();
  fail = false;
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  cleanup();
  expect(signal?.aborted).toBe(true);
});

test('ChatGPT retains remote prerequisites without a local diagnostic action or result', async () => {
  const remote = {...setup, clients: [...setup.clients, {...setup.clients[0], id: 'chatgpt', name: 'ChatGPT', platforms: [{...setup.clients[0].platforms[0], configuration: 'HTTPS and OAuth required'}]}]};
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === diagnosticPath ? diagnosticResult('passed') : remote))));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await screen.findByText('Local server diagnostic passed');
  await user.selectOptions(screen.getByLabelText('Client'), 'chatgpt');
  expect(screen.queryByRole('button', {name: 'Check local server'})).toBeNull();
  expect(screen.queryByText('Local server diagnostic passed')).toBeNull();
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toContain('HTTPS and OAuth required');
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
});

test('request deadline uses diagnostic recovery and releases the control', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => path === diagnosticPath
    ? new Promise<Response>(() => {})
    : Promise.resolve(new Response(JSON.stringify(setup)))));
  await openDiagnostic();
  vi.useFakeTimers();
  const button = screen.getByRole('button', {name: 'Check local server'});
  await act(async () => { button.click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS); });
  expect(screen.getByText('Local server diagnostic timed out.')).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/Saving or execution may already have occurred/)).toBeNull();
});

const sharedPath = '/api/connections/v1/shared-data';
const sharedResult = (employees = 2, work = 3) => ({...diagnosticResult('passed'), employee_count: employees, work_count: work});

test.each([[2, 3], [0, 0]])('explicit shared-data check displays only validated counts (%i, %i)', async (employees, work) => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((path: string) => path === sharedPath
    ? new Promise<Response>(resolve => { finish = resolve; })
    : Promise.resolve(new Response(JSON.stringify(setup))));
  vi.stubGlobal('fetch', fetcher);
  const user = await openDiagnostic();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(['/api/connections/v1']));
  const button = screen.getByRole('button', {name: 'Check shared data'});
  button.focus();
  await user.keyboard('{Enter}');
  await user.dblClick(button);
  expect(screen.getByText(/Checking shared data…/)).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/connections/v1', sharedPath]);
  const call = (fetcher.mock.calls as unknown as [string, RequestInit][])[1];
  expect(call[1].method).toBe('POST');
  expect(call[1].body).toBe('{}');
  finish(new Response(JSON.stringify({...sharedResult(employees, work), message: 'private work text', recovery: 'private database path'})));
  await screen.findByText('Shared-data check passed.');
  expect(screen.getByText(`Employees: ${employees}. Saved work: ${work}.`)).toBeTruthy();
  expect(screen.queryByText(/private/)).toBeNull();
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
  expect(screen.queryByText('Local server diagnostic passed')).toBeNull();
  await user.click(button);
  expect(screen.queryByText(`Employees: ${employees}. Saved work: ${work}.`)).toBeNull();
  finish(new Response(JSON.stringify(sharedResult(0, 0))));
  await screen.findByText('Employees: 0. Saved work: 0.');
});

test.each([
  null, {...sharedResult(), schema_version: 2}, {...sharedResult(), status: 'connected'},
  {...sharedResult(), employee_count: -1}, {...sharedResult(), employee_count: 1.5},
  {...sharedResult(), employee_count: Number.MAX_SAFE_INTEGER + 1},
  {...sharedResult(), work_count: '3'}, {...sharedResult(), work_count: null},
  diagnosticResult('passed'), {...sharedResult(), recovery: null},
  {...sharedResult(), message: 'x'.repeat(2001)}, {...sharedResult(), status: 'failed'},
])('shared-data rejects malformed responses without counts', async result => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === sharedPath ? result : setup))));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await screen.findByText('Shared-data check returned an invalid response.');
  expect(screen.queryByText(/^Employees:/)).toBeNull();
  expect((screen.getByRole('button', {name: 'Check shared data'}) as HTMLButtonElement).disabled).toBe(false);
});

test.each([
  ['busy', 'A local server check is already running.', 'Wait for the current check to finish'],
  ['timeout', 'Shared-data check timed out.', 'Wait for the server check to close'],
  ['failed', 'Shared-data check failed.', 'Check that the installed AgenTown server'],
])('shared-data %s offers explicit retry recovery', async (status, message, recovery) => {
  let result = diagnosticResult(status);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === sharedPath ? result : setup))));
  const user = await openDiagnostic();
  const button = screen.getByRole('button', {name: 'Check shared data'});
  await user.click(button);
  await screen.findByText(message);
  // Discovery and shared-data controls have separate status regions.
  expect(screen.getAllByText(new RegExp(recovery)).length).toBeGreaterThan(0);
  expect(screen.queryByText(/^Employees:/)).toBeNull();
  result = sharedResult();
  await user.click(button);
  await screen.findByText('Employees: 2. Saved work: 3.');
});

test('shared-data sanitizes transport errors and aborts on unmount', async () => {
  let fail = true;
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    if (path !== sharedPath) return new Response(JSON.stringify(setup));
    if (fail) throw new Error('private work text');
    signal = options.signal as AbortSignal;
    return new Promise<Response>(() => {});
  }));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await screen.findByText('Shared-data check failed.');
  expect(screen.queryByText(/private work text/)).toBeNull();
  fail = false;
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  cleanup();
  expect(signal?.aborted).toBe(true);
});

test('shared-data deadline releases pending state with safe recovery', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => path === sharedPath
    ? new Promise<Response>(() => {}) : Promise.resolve(new Response(JSON.stringify(setup)))));
  await openDiagnostic();
  vi.useFakeTimers();
  const button = screen.getByRole('button', {name: 'Check shared data'});
  await act(async () => {button.click();});
  await act(async () => {await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);});
  expect(screen.getByText('Shared-data check timed out.')).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/Saving or execution may already have occurred/)).toBeNull();
});

test('a late shared-data response cannot replace timeout or a later explicit retry', async () => {
  const responses: ((response: Response) => void)[] = [];
  const fetcher = vi.fn((path: string) => path === sharedPath
    ? new Promise<Response>(resolve => {responses.push(resolve);})
    : Promise.resolve(new Response(JSON.stringify(setup))));
  vi.stubGlobal('fetch', fetcher);
  await openDiagnostic();
  vi.useFakeTimers();
  const button = screen.getByRole('button', {name: 'Check shared data'});
  await act(async () => {button.click();});
  await act(async () => {await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);});
  expect(screen.getByText('Shared-data check timed out.')).toBeTruthy();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/connections/v1', sharedPath]);
  await act(async () => {button.click();});
  await act(async () => {responses[0](new Response(JSON.stringify(sharedResult(99, 99))));});
  expect(screen.getByText(/Checking shared data…/)).toBeTruthy();
  expect(screen.queryByText(/^Employees:/)).toBeNull();
  await act(async () => {responses[1](new Response(JSON.stringify(sharedResult(0, 0))));});
  expect(screen.getByText('Employees: 0. Saved work: 0.')).toBeTruthy();
  expect(screen.queryByText(/Employees: 99/)).toBeNull();
});

test('ChatGPT never offers shared-data validation and selection change aborts the check', async () => {
  const remote = {...setup, clients: [...setup.clients, {...setup.clients[0], id: 'chatgpt', name: 'ChatGPT'}]};
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (path !== sharedPath) return new Response(JSON.stringify(remote));
    signal = options.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetcher);
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await user.selectOptions(screen.getByLabelText('Client'), 'chatgpt');
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole('button', {name: 'Check shared data'})).toBeNull();
  expect(screen.queryByText(/Checking shared data…/)).toBeNull();
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/connections/v1', sharedPath]);
});

// Include whitespace that must survive copying without instructions or destination.
const fragmentSetup: ConnectionSetup = {...setup, clients: setup.clients.map(client => ({
  ...client, platforms: client.platforms.map(platform => ({
    ...platform, configuration: `  ${platform.configuration}\n\n  trailing space \n`,
  })),
}))};

test('configuration fields and native keyboard copy preserve exact selected client/platform fragments', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fragmentSetup)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByLabelText('Client');
  for (const client of fragmentSetup.clients) {
    await user.selectOptions(screen.getByLabelText('Client'), client.id);
    for (const platform of client.platforms) {
      await user.selectOptions(screen.getByLabelText('Platform'), platform.id);
      const destination = screen.getByLabelText('Configuration destination') as HTMLTextAreaElement;
      const fragment = screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement;
      expect(destination.value).toBe(platform.destination);
      expect(fragment.value).toBe(platform.configuration);
      expect(destination.readOnly && fragment.readOnly).toBe(true);
      const button = screen.getByRole('button', {name: 'Copy configuration'});
      button.focus();
      await user.keyboard(platform.id === 'macos' ? '{Enter}' : ' ');
      expect(copy).toHaveBeenLastCalledWith(platform.configuration);
      expect(document.activeElement).toBe(button);
      const status = await screen.findByText('Configuration copied. Client readiness remains unknown.');
      expect(status.getAttribute('role')).toBe('status');
    }
  }
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
});

test.each(['denied', 'unavailable'])('configuration clipboard %s leaves selectable manual recovery', async failure => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fragmentSetup)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  if (failure === 'denied') vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  else vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard);
  render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByLabelText('Client');
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  await screen.findByText(/Select the Configuration fragment field and copy manually/);
  const field = screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement;
  field.focus(); field.select();
  expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(fragmentSetup.clients[0].platforms[0].configuration);
  expect((screen.getByRole('button', {name: 'Copy configuration'}) as HTMLButtonElement).disabled).toBe(false);
  expect(fetcher.mock.calls).toHaveLength(1);
});

test.each(['client', 'platform', 'workstation'])('pending copy feedback cannot follow a changed %s selection', async change => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fragmentSetup))));
  const user = userEvent.setup();
  let finish!: () => void;
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;})).mockResolvedValue();
  const view = render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByLabelText('Client');
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(screen.getByText('Copying…')).toBeTruthy();
  if (change === 'client') await user.selectOptions(screen.getByLabelText('Client'), 'claude-code');
  else if (change === 'platform') await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  else view.rerender(<Connections workspaceConnected openClient={{id: 'claude-code'}} />);
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(copy).toHaveBeenCalledTimes(1);
  await act(async () => {finish();});
  expect(screen.queryByText('Configuration copied. Client readiness remains unknown.')).toBeNull();
  expect(screen.queryByText('Copying…')).toBeNull();
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(copy).toHaveBeenLastCalledWith((screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement).value);
  await screen.findByText('Configuration copied. Client readiness remains unknown.');
});

test('ChatGPT shows a separate prerequisites checklist without local fragment controls', async () => {
  const remote = {...setup, clients: [{...setup.clients[0], id: 'chatgpt', name: 'ChatGPT', platforms: [{...setup.clients[0].platforms[0], configuration: 'Provide HTTPS\nProvide OAuth'}]}]};
  const fetcher = vi.fn(async () => new Response(JSON.stringify(remote)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'chatgpt'}} />);
  const checklist = await screen.findByRole('region', {name: 'ChatGPT prerequisites checklist'});
  expect(checklist.textContent).toContain('Provide HTTPS');
  expect(checklist.textContent).toContain('Provide OAuth');
  expect(screen.queryByRole('button', {name: 'Copy configuration'})).toBeNull();
  expect(screen.queryByLabelText('Configuration fragment')).toBeNull();
  expect(screen.queryByLabelText('Configuration destination')).toBeNull();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(copy).toHaveBeenCalledWith((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value);
  expect(screen.getByRole('button', {name: 'Download setup artifact'})).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
});


const guidedSetup: ConnectionSetup = {...setup, clients: [
  ...['codex', 'claude-code', 'claude-desktop', 'cursor'].map((id, index) => ({
    ...setup.clients[0], id, name: ['Codex', 'Claude Code', 'Claude Desktop', 'Cursor'][index],
    platforms: setup.clients[0].platforms.map(platform => ({...platform,
      destination: `${id}/${platform.id}/settings`, configuration: `fragment ${id} ${platform.id}\n`,
      inspection: `Inspect ${id} on ${platform.id}.\nRestart the selected client.`,
    })),
  })), recoverySetup.clients[2],
]};

test('ordered local setup follows all four clients and platforms and separates ChatGPT', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(guidedSetup)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  // The workstation heading receives focus; native controls follow in reading order.
  expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Codex setup'}));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Refresh setup'}));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByLabelText('Client'));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByLabelText('Platform'));
  for (const client of guidedSetup.clients.slice(0, 4)) {
    await user.selectOptions(screen.getByLabelText('Client'), client.id);
    for (const platform of client.platforms) {
      await user.selectOptions(screen.getByLabelText('Platform'), platform.id);
      const steps = within(screen.getByRole('list', {name: 'Local client setup steps'}));
      expect(steps.getAllByRole('heading', {level: 4}).map(node => node.textContent)).toEqual([
        'Prepare AgenTown', `Configure ${client.name} · ${platform.name}`,
        `Inspect and verify in ${client.name}`, 'Recover if setup fails',
      ]);
      expect(steps.getByText(guidedSetup.preparation)).toBeTruthy();
      expect(steps.getByText(platform.inspection, {normalizer: value => value})).toBeTruthy();
      expect(steps.getByText(guidedSetup.recovery)).toBeTruthy();
      expect((steps.getByLabelText('Configuration destination') as HTMLTextAreaElement).value).toBe(platform.destination);
      expect((steps.getByLabelText('Configuration fragment') as HTMLTextAreaElement).value).toBe(platform.configuration);
    }
  }
  await user.selectOptions(screen.getByLabelText('Client'), 'chatgpt');
  expect(screen.queryByRole('list', {name: 'Local client setup steps'})).toBeNull();
  expect(screen.getByRole('region', {name: 'ChatGPT prerequisites checklist'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Check local server'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Check shared data'})).toBeNull();
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
});

test('failed refresh retains readable steps and keyboard refresh recovers selected guidance', async () => {
  let fail = false;
  let response = guidedSetup;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify(response));
  }));
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'cursor'}} />);
  await screen.findByLabelText('Client');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  fail = true;
  refresh.focus();
  await user.keyboard('{Enter}');
  await screen.findByText(/Previously loaded instructions may be stale/);
  let steps = within(screen.getByRole('list', {name: 'Local client setup steps'}));
  expect(steps.getByText(guidedSetup.preparation)).toBeTruthy();
  expect(steps.getByText('Inspect cursor on windows.\nRestart the selected client.', {normalizer: value => value})).toBeTruthy();
  expect(steps.getByText(guidedSetup.recovery)).toBeTruthy();
  fail = false;
  response = {...guidedSetup, preparation: 'New preparation', recovery: 'New recovery'};
  await user.keyboard(' ');
  await screen.findByText('Setup service available.');
  steps = within(screen.getByRole('list', {name: 'Local client setup steps'}));
  expect(steps.getByText('New preparation')).toBeTruthy();
  expect(steps.getByText('New recovery')).toBeTruthy();
  expect(steps.getByRole('heading', {name: 'Configure Cursor · windows'})).toBeTruthy();
  expect(screen.queryByText(/Previously loaded instructions may be stale/)).toBeNull();
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
});

test('ChatGPT copies remote guidance and downloads exact prerequisites before returning to local setup', async () => {
  const remote = recoverySetup.clients[2].platforms[0];
  const fetcher = vi.fn(async () => new Response(JSON.stringify(recoverySetup)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const create = vi.fn((_blob: Blob) => 'blob:prerequisites');
  vi.stubGlobal('URL', {createObjectURL: create, revokeObjectURL: vi.fn()});
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    filename = this.download;
  });
  render(<Connections workspaceConnected openClient={{id: 'chatgpt'}} />);
  await screen.findByRole('region', {name: 'ChatGPT prerequisites checklist'});
  const instructions = (screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value;
  expect(instructions).toContain('Remote HTTPS prerequisites');
  expect(instructions).toContain(`Remote prerequisites for ${remote.destination}:`);
  expect(instructions).toContain(remote.configuration);
  expect(instructions).toContain(remote.inspection);
  expect(instructions).not.toMatch(/merge|fragment/i);
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(copy).toHaveBeenLastCalledWith(instructions);
  await user.click(screen.getByRole('button', {name: 'Download setup artifact'}));
  const blob = create.mock.calls[0][0];
  const downloaded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  expect(downloaded).toBe(remote.configuration);
  expect(filename).toBe(remote.filename);
  const feedback = screen.getByText(/Prerequisite checklist download requested/);
  expect(feedback.getAttribute('role')).toBe('status');
  expect(feedback.textContent).toContain('HTTPS/OAuth prerequisites');
  expect(feedback.textContent).not.toMatch(/merge|fragment/i);
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Check local server'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Check shared data'})).toBeNull();

  await user.selectOptions(screen.getByLabelText('Client'), 'codex');
  expect(screen.queryByText(/Prerequisite checklist download requested/)).toBeNull();
  const local = recoverySetup.clients[0].platforms[0];
  expect(screen.getByRole('list', {name: 'Local client setup steps'})).toBeTruthy();
  expect(screen.getByText(recoverySetup.preparation)).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Check local server'})).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Check shared data'})).toBeTruthy();
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining(`Merge into ${local.destination}:`));
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining(recoverySetup.preparation));
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(copy).toHaveBeenLastCalledWith(local.configuration);
  await user.click(screen.getByRole('button', {name: 'Download setup artifact'}));
  expect(screen.getByText(/Download requested. Check your downloads; merge the fragment manually/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(['/api/connections/v1']));
});

test.each(['denied', 'unavailable'])('ChatGPT clipboard %s preserves selectable remote instructions and recovers', async failure => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(recoverySetup))));
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const clipboard = navigator.clipboard;
  if (failure === 'denied') copy.mockRejectedValueOnce(new Error('denied'));
  else vi.spyOn(navigator, 'clipboard', 'get').mockReturnValueOnce(undefined as unknown as Clipboard).mockReturnValue(clipboard);
  render(<Connections workspaceConnected openClient={{id: 'chatgpt'}} />);
  await screen.findByLabelText('Setup instructions');
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  await screen.findByText(/Select the Setup instructions field and copy manually/);
  const field = screen.getByLabelText('Setup instructions') as HTMLTextAreaElement;
  field.focus(); field.select();
  expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(field.value);
  expect(field.readOnly).toBe(true);
  expect(field.value).toContain(recoverySetup.clients[2].platforms[0].configuration);
  expect(field.value).not.toMatch(/merge|fragment/i);
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(copy).toHaveBeenLastCalledWith(field.value);
  await screen.findByText('Setup instructions copied. Client readiness remains unknown.');
});

test('connection recovery keeps independent previous observations until explicit successful reruns', async () => {
  let fail = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (fail) throw new Error('offline');
    const path = String(input);
    return new Response(JSON.stringify(path.endsWith('/diagnostic')
      ? {schema_version: 1, status: 'passed', code: 'ok', message: 'ok', recovery: ''}
      : path.endsWith('/shared-data')
        ? {schema_version: 1, status: 'passed', code: 'ok', message: 'ok', recovery: '', employee_count: 2, work_count: 3}
        : recoverySetup));
  });
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  const view = render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await screen.findByText('Local server diagnostic passed');
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await screen.findByText('Employees: 2. Saved work: 3.');
  const fragment = (screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement).value;
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  refresh.focus();
  const calls = fetcher.mock.calls.length;
  view.rerender(<Connections workspaceConnected={false} />);
  await screen.findByText(/Previous setup observation/);
  expect(screen.getByText(/Previous local server diagnostic observation/)).toBeTruthy();
  expect(screen.getByText(/Previous shared-data observation and counts/)).toBeTruthy();
  view.rerender(<Connections workspaceConnected />);
  expect(fetcher.mock.calls.length).toBe(calls);
  expect(document.activeElement).toBe(refresh);
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('windows');
  expect((screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement).value).toBe(fragment);
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(clipboard).toHaveBeenLastCalledWith(fragment);
  fail = true;
  await user.click(refresh);
  await screen.findByText(/Setup service disconnected/);
  expect(screen.getByText(/Previous setup observation/)).toBeTruthy();
  fail = false;
  await user.click(refresh);
  await waitFor(() => expect(screen.queryByText(/Previous setup observation/)).toBeNull());
  expect(screen.getByText(/Previous local server diagnostic observation/)).toBeTruthy();
  expect(screen.getByText(/Previous shared-data observation and counts/)).toBeTruthy();
  fail = true;
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await screen.findByText('Local server diagnostic failed.');
  expect(screen.getByText(/Previous local server diagnostic observation/)).toBeTruthy();
  fail = false;
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await waitFor(() => expect(screen.queryByText(/Previous local server diagnostic observation/)).toBeNull());
  expect(screen.getByText(/Previous shared-data observation and counts/)).toBeTruthy();
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await waitFor(() => expect(screen.queryByText(/Previous shared-data observation and counts/)).toBeNull());
  expect(fetcher.mock.calls.every(([path]) => String(path).startsWith('/api/connections/v1'))).toBe(true);
});

test.each(['setup', 'diagnostic', 'shared-data'])('%s responses spanning disconnection remain previous observations', async surface => {
  let resolve: ((response: Response) => void) | undefined;
  let defer = false;
  const result = (path: string) => path.endsWith('/diagnostic')
    ? {schema_version: 1, status: 'passed', code: 'ok', message: 'ok', recovery: ''}
    : path.endsWith('/shared-data')
      ? {schema_version: 1, status: 'passed', code: 'ok', message: 'ok', recovery: '', employee_count: 4, work_count: 5}
      : setup;
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (defer) return new Promise<Response>(done => { resolve = done; });
    return Promise.resolve(new Response(JSON.stringify(result(path))));
  });
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  const view = render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  defer = true;
  const button = screen.getByRole('button', {name: surface === 'setup' ? 'Refresh setup' : surface === 'diagnostic' ? 'Check local server' : 'Check shared data'});
  await user.click(button);
  const calls = fetcher.mock.calls.length;
  view.rerender(<Connections workspaceConnected={false} />);
  view.rerender(<Connections workspaceConnected />);
  expect(fetcher.mock.calls.length).toBe(calls);
  await act(async () => { resolve!(new Response(JSON.stringify(result(surface === 'setup' ? '/api/connections/v1' : `/api/connections/v1/${surface}`)))); });
  const disclosure = surface === 'setup' ? /Previous setup observation/ : surface === 'diagnostic' ? /Previous local server diagnostic observation/ : /Previous shared-data observation and counts/;
  expect(await screen.findByText(disclosure)).toBeTruthy();
  defer = false;
  await user.click(button);
  await waitFor(() => expect(screen.queryByText(disclosure)).toBeNull());
});

const focusRecoveryNotice = 'The setup control you were using is no longer available. Review the refreshed setup or choose another client.';

test.each(['Configuration fragment', 'Platform', 'Setup instructions', 'Check local server'])(
  'accepted delayed setup removal recovers focused %s to the workstation heading', async label => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(setup)))
      .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})));
    const user = userEvent.setup();
    render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
    await screen.findByLabelText('Client');
    await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
    const focused = label === 'Check local server' ? screen.getByRole('button', {name: label}) : screen.getByLabelText(label);
    focused.focus();
    expect(document.activeElement).toBe(focused);
    await act(async () => {finish(new Response(JSON.stringify({...setup, clients: [setup.clients[1]]})));});
    expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Codex setup'}));
    const notice = screen.getByText(focusRecoveryNotice);
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('codex');
    expect(screen.getByText(/Selected client setup unavailable/).textContent).toContain('Connected: Unverified');
    expect(screen.queryByLabelText('Configuration fragment')).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Refresh setup'}));
  },
);

test.each(['surviving', 'outside', 'selector', 'moved outside'])(
  'accepted delayed setup refresh preserves %s focus', async location => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(setup)))
      .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})));
    const user = userEvent.setup();
    render(<><input aria-label="Outside draft" /><Connections workspaceConnected openClient={{id: 'codex'}} /></>);
    await screen.findByLabelText('Client');
    await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
    const outside = screen.getByLabelText('Outside draft');
    const focused = location === 'selector' ? screen.getByLabelText('Client')
      : location === 'outside' ? outside : screen.getByLabelText('Configuration fragment');
    focused.focus();
    if (location === 'moved outside') outside.focus();
    const clients = location === 'surviving' ? [{...setup.clients[0], name: 'Renamed Codex'}] : [setup.clients[1]];
    await act(async () => {finish(new Response(JSON.stringify({...setup, clients})));});
    expect(document.activeElement).toBe(location === 'moved outside' ? outside : focused);
    expect(screen.queryByText(focusRecoveryNotice)).toBeNull();
    expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('codex');
  },
);

test.each(['failure', 'malformed', 'superseded'])(
  'rejected %s setup response never recovers focus or removes controls', async outcome => {
    let finish!: (response: Response) => void;
    let reject!: (error: Error) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(setup)))
      .mockImplementationOnce(() => new Promise<Response>((resolve, fail) => {finish = resolve; reject = fail;}))
      .mockResolvedValue(new Response(JSON.stringify(setup))));
    const user = userEvent.setup();
    render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
    await screen.findByLabelText('Client');
    const refresh = screen.getByRole('button', {name: 'Refresh setup'});
    await user.click(refresh);
    const focused = screen.getByLabelText('Configuration fragment');
    focused.focus();
    if (outcome === 'superseded') {
      // Finish this request, then explicitly cancel and replace a deferred refresh.
      await act(async () => {finish(new Response(JSON.stringify(setup)));});
      const fetcher = vi.mocked(fetch);
      fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
      fireEvent.click(refresh);
      fireEvent.click(screen.getByRole('button', {name: 'Cancel waiting for setup'}));
      fireEvent.click(refresh);
      await screen.findByText('Setup service available.');
      focused.focus();
    }
    await act(async () => {
      if (outcome === 'failure') reject(new Error('offline'));
      else finish(new Response(JSON.stringify(outcome === 'malformed' ? {...setup, clients: []} : {...setup, clients: [setup.clients[1]]})));
    });
    expect(document.activeElement).toBe(focused);
    expect(screen.getByLabelText('Configuration fragment')).toBe(focused);
    expect(screen.queryByText(focusRecoveryNotice)).toBeNull();
    if (outcome !== 'superseded') expect(screen.getByText(/Previously loaded instructions may be stale/)).toBeTruthy();
  },
);

const withoutWindows: ConnectionSetup = {...setup, clients: setup.clients.map(client => ({
  ...client, platforms: client.platforms.filter(platform => platform.id !== 'windows'),
}))};

test.each(['Configuration fragment', 'Setup instructions', 'Copy configuration', 'Platform', 'outside'])(
  'platform removal requires explicit recovery and preserves orientation from %s', async location => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(setup)))
      .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})));
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<><input aria-label="Outside draft" /><Connections workspaceConnected openClient={{id: 'codex'}} /></>);
    await screen.findByLabelText('Platform');
    await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
    await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
    const focused = location === 'outside' ? screen.getByLabelText('Outside draft')
      : location === 'Copy configuration' ? screen.getByRole('button', {name: location}) : screen.getByLabelText(location);
    focused.focus();
    await act(async () => {finish(new Response(JSON.stringify(withoutWindows)));});
    const selector = screen.getByLabelText('Platform');
    expect((selector as HTMLSelectElement).value).toBe('windows');
    expect(screen.getByRole('option', {name: 'windows · setup unavailable'})).toBeTruthy();
    expect(screen.getByText(/Selected platform setup unavailable/).getAttribute('role')).toBe('status');
    expect(screen.queryByLabelText('Configuration fragment')).toBeNull();
    expect(screen.queryByLabelText('Setup instructions')).toBeNull();
    expect(screen.queryByRole('button', {name: /Copy|Download/})).toBeNull();
    expect(copy).not.toHaveBeenCalled();
    if (location === 'outside' || location === 'Platform') {
      expect(document.activeElement).toBe(focused);
      expect(screen.queryByText(focusRecoveryNotice)).toBeNull();
    } else {
      expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Codex setup'}));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Refresh setup'}));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByLabelText('Client'));
      await user.tab();
      expect(document.activeElement).toBe(selector);
    }
    await user.selectOptions(selector, 'macos');
    expect(screen.queryByText(/Selected platform setup unavailable/)).toBeNull();
    await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
    expect(copy).toHaveBeenLastCalledWith('config-codex-macos');
    const create = vi.fn(() => 'blob:recovered');
    vi.stubGlobal('URL', {createObjectURL: create, revokeObjectURL: vi.fn()});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', {name: 'Download setup artifact'}));
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]).toEqual([expect.any(Blob)]);
  },
);

test.each(['resolved', 'rejected'])('removed platform isolates %s pending clipboard feedback', async outcome => {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  let response = setup;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementationOnce(() => new Promise<void>((resolve, reject) => {finish = resolve; fail = reject;}))
    .mockResolvedValue();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Platform');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(screen.getByText('Copying…')).toBeTruthy();
  response = withoutWindows;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByText(/Selected platform setup unavailable/);
  await user.selectOptions(screen.getByLabelText('Platform'), 'macos');
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect((screen.getByRole('button', {name: 'Copy setup instructions'}) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {if (outcome === 'resolved') finish(); else fail(new Error('denied'));});
  expect(screen.queryByText(/copied. Client readiness/)).toBeNull();
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  await screen.findByText('Setup instructions copied. Client readiness remains unknown.');
  expect(screen.getByText('Setup instructions copied. Client readiness remains unknown.')).toBeTruthy();
  expect(screen.queryByText(/Could not copy/)).toBeNull();
});

test.each(['unchanged', 'failed'])('%s refresh preserves selected Windows artifacts and focus', async outcome => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(setup)))
    .mockImplementationOnce(async () => {
      if (outcome === 'failed') throw new Error('offline');
      return new Response(JSON.stringify(setup));
    }));
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Platform');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByText(outcome === 'failed' ? /Previously loaded instructions may be stale/ : 'Setup service available.');
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('windows');
  expect((screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement).value).toBe('config-codex-windows');
  expect(screen.queryByText(/Selected platform setup unavailable/)).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Refresh setup'}));
});

test('initial setup and explicit ChatGPT selection retain their default platform', async () => {
  const response = {...recoverySetup, clients: recoverySetup.clients.map(client => ({...client,
    platforms: client.id === 'codex' ? [client.platforms[1]] : client.platforms,
  }))};
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Configuration fragment');
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('windows');
  await user.selectOptions(screen.getByLabelText('Client'), 'chatgpt');
  expect(screen.getByRole('region', {name: 'ChatGPT prerequisites checklist'})).toBeTruthy();
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('macos');
});

test.each(['command', 'database'])('accepted %s changes invalidate both checks independently without replacing controls', async change => {
  let current = structuredClone(setup);
  let failCheck = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(
    path === diagnosticPath ? diagnosticResult(failCheck ? 'failed' : 'passed') : path === sharedPath ? sharedResult() : current))));
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await screen.findByText('Employees: 2. Saved work: 3.');
  current.clients[0].platforms[1].configuration = `${change}=new absolute path`;
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  const diagnostic = screen.getByRole('button', {name: 'Check local server'});
  await user.click(refresh);
  expect(await screen.findByText(/Previous local server diagnostic observation/)).toBeTruthy();
  expect(screen.getByText(/Previous shared-data observation and counts/)).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Check local server'})).toBe(diagnostic);
  expect(document.activeElement).toBe(refresh);
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('windows');
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(clipboard).toHaveBeenLastCalledWith(`${change}=new absolute path`);
  failCheck = true;
  await user.click(diagnostic);
  expect(screen.getByText(/Previous local server diagnostic observation/)).toBeTruthy();
  failCheck = false;
  await user.click(diagnostic);
  await waitFor(() => expect(screen.queryByText(/Previous local server diagnostic observation/)).toBeNull());
  expect(screen.getByText(/Previous shared-data observation and counts/)).toBeTruthy();
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await waitFor(() => expect(screen.queryByText(/Previous shared-data observation and counts/)).toBeNull());
  expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified./)).toBeTruthy();
});

test.each(['diagnostic', 'shared-data'])('%s begun before a changed setup cannot establish fresh evidence, even after configuration returns', async check => {
  let current = structuredClone(setup);
  let resolve: ((response: Response) => void) | undefined;
  let defer = true;
  const path = `/api/connections/v1/${check}`;
  const result = check === 'diagnostic' ? diagnosticResult('passed') : sharedResult(7, 8);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => input === path
    ? defer ? new Promise<Response>(done => {resolve = done;}) : new Response(JSON.stringify(result))
    : new Response(JSON.stringify(current))));
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  const button = screen.getByRole('button', {name: check === 'diagnostic' ? 'Check local server' : 'Check shared data'});
  await user.click(button);
  current.clients[0].platforms[0].configuration = 'new database';
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  current = structuredClone(setup);
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await act(async () => {resolve!(new Response(JSON.stringify(result)));});
  const previous = check === 'diagnostic' ? /Previous local server diagnostic observation/ : /Previous shared-data observation and counts/;
  expect(await screen.findByText(previous)).toBeTruthy();
  defer = false;
  await user.click(button);
  await waitFor(() => expect(screen.queryByText(previous)).toBeNull());
});

test.each(['unchanged', 'hint', 'failed', 'malformed', 'superseded'])('%s setup responses preserve applicable local observations', async mode => {
  let current: unknown = structuredClone(setup);
  let fail = false;
  let defer = false;
  const responses: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === diagnosticPath) return new Response(JSON.stringify(diagnosticResult('passed')));
    if (path === sharedPath) return new Response(JSON.stringify(sharedResult()));
    if (fail) throw new Error('offline');
    if (defer) return new Promise<Response>(done => responses.push(done));
    return new Response(JSON.stringify(current));
  }));
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await screen.findByText('Employees: 2. Saved work: 3.');
  const changed = structuredClone(setup);
  changed.clients[0].platforms[0].configuration = 'obsolete changed database';
  if (mode === 'hint') (current as ConnectionSetup).clients[0].status = {detected: true, configured: 'unknown', connected: 'unverified', exercised: 'unverified'};
  if (mode === 'failed') fail = true;
  if (mode === 'malformed') current = {...changed, workflow_version: 9};
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  if (mode === 'superseded') {
    defer = true;
    fireEvent.click(refresh);
    fireEvent.click(screen.getByRole('button', {name: 'Cancel waiting for setup'}));
    fireEvent.click(refresh);
    await act(async () => {responses[1](new Response(JSON.stringify(setup)));});
    await act(async () => {responses[0](new Response(JSON.stringify(changed)));});
  } else await user.click(refresh);
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText(/Previous local server diagnostic observation/)).toBeNull();
  expect(screen.queryByText(/Previous shared-data observation and counts/)).toBeNull();
  expect(screen.getByText('Employees: 2. Saved work: 3.')).toBeTruthy();
  expect((screen.getByLabelText('Configuration fragment') as HTMLTextAreaElement).value).toBe(setup.clients[0].platforms[0].configuration);
});


test.each([
  ['diagnostic', 'resolve'], ['diagnostic', 'reject'],
  ['shared-data', 'resolve'], ['shared-data', 'reject'],
])('%s cancellation retains evidence and owns immediate retry after late %s', async (kind, late) => {
  const path = kind === 'diagnostic' ? diagnosticPath : sharedPath;
  const label = kind === 'diagnostic' ? 'Check local server' : 'Check shared data';
  const otherLabel = kind === 'diagnostic' ? 'Check shared data' : 'Check local server';
  const region = kind === 'diagnostic' ? 'Local server diagnostic' : 'Shared employee and work access';
  const previous = kind === 'diagnostic' ? /Previous local server diagnostic observation/ : /Previous shared-data observation and counts/;
  const passed = kind === 'diagnostic' ? 'Local server diagnostic passed' : 'Shared-data check passed.';
  const result = kind === 'diagnostic' ? diagnosticResult('passed') : sharedResult(7, 8);
  const requests: {resolve: (response: Response) => void; reject: (error: Error) => void; signal: AbortSignal}[] = [];
  let seed = true;
  const fetcher = vi.fn((input: string, init?: RequestInit) => {
    if (input === path && !seed) return new Promise<Response>((resolve, reject) => {
      requests.push({resolve, reject, signal: init!.signal as AbortSignal});
    });
    return Promise.resolve(new Response(JSON.stringify(input === path ? result : setup)));
  });
  vi.stubGlobal('fetch', fetcher);
  const user = await openDiagnostic();
  const section = within(screen.getByRole('region', {name: region}));
  const button = section.getByRole('button', {name: label});
  await user.click(button);
  await screen.findByText(passed);
  seed = false;
  button.focus();
  await user.keyboard('{Enter}');
  const cancel = section.getByRole('button', {name: /Cancel waiting/});
  // Disabling the focused check can reset the tab starting point. Follow
  // keyboard navigation from that point rather than assuming one Tab suffices.
  for (let tabs = 0; tabs < 20 && document.activeElement !== cancel; tabs++) {
    await user.tab();
  }
  expect(document.activeElement).toBe(cancel);
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(requests[0].signal.aborted).toBe(true);
  expect(section.queryByRole('button', {name: /Cancel waiting/})).toBeNull();
  expect(section.getByText(/Stopped waiting.*does not confirm that the server process stopped/)).toBeTruthy();
  expect(section.getByText(previous)).toBeTruthy();
  expect(section.getByText(passed)).toBeTruthy();
  if (kind === 'shared-data') expect(section.getByText('Employees: 7. Saved work: 8.')).toBeTruthy();
  expect(requests).toHaveLength(1); // no automatic retry
  // Start the retry in the same event turn as another cancellation, before
  // the aborted API promise's catch/finally can run.
  fireEvent.click(button);
  const second = section.getByRole('button', {name: /Cancel waiting/});
  fireEvent.click(second);
  fireEvent.click(button);
  fireEvent.click(button); // duplicate admission remains guarded
  expect(requests).toHaveLength(3);
  await act(async () => {
    for (const request of requests.slice(0, 2)) {
      if (late === 'reject') request.reject(new Error('late transport error'));
      else request.resolve(new Response(JSON.stringify(kind === 'diagnostic' ? diagnosticResult('failed') : sharedResult(99, 99))));
    }
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(section.getByText(/Checking .*…/)).toBeTruthy();
  expect(section.getByText(previous)).toBeTruthy();
  fireEvent.click(button);
  expect(requests).toHaveLength(3);
  expect((screen.getByRole('button', {name: otherLabel}) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => requests[2].resolve(new Response(JSON.stringify(result))));
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(section.queryByText(previous)).toBeNull();
  expect(section.queryByText(/Stopped waiting/)).toBeNull();
  expect(section.getByText(passed)).toBeTruthy();
  expect(fetcher.mock.calls.every(([input]) => ['/api/connections/v1', path].includes(input))).toBe(true);
});

test.each(['diagnostic', 'shared-data'])('%s completion preserves cancel focus or an outside control', async kind => {
  const path = kind === 'diagnostic' ? diagnosticPath : sharedPath;
  const label = kind === 'diagnostic' ? 'Check local server' : 'Check shared data';
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((input: string) => input === path
    ? new Promise<Response>(resolve => { finish = resolve; })
    : Promise.resolve(new Response(JSON.stringify(setup)))));
  const user = await openDiagnostic();
  const button = screen.getByRole('button', {name: label});
  const result = kind === 'diagnostic' ? diagnosticResult('passed') : sharedResult();
  await user.click(button);
  screen.getByRole('button', {name: /Cancel waiting/}).focus();
  await act(async () => finish(new Response(JSON.stringify(result))));
  expect(document.activeElement).toBe(button);
  await user.click(button);
  const outside = screen.getByLabelText('Client');
  outside.focus();
  // Programmatic cancellation models activation without moving focus to it.
  fireEvent.click(screen.getByRole('button', {name: /Cancel waiting/}));
  expect(document.activeElement).toBe(outside);
  await act(async () => finish(new Response(JSON.stringify(result))));
  expect(document.activeElement).toBe(outside);
});

test('cancelling either check leaves the other pending and independently cancellable', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => input === diagnosticPath || input === sharedPath
    ? new Promise<Response>(() => { signals.push(init!.signal as AbortSignal); })
    : Promise.resolve(new Response(JSON.stringify(setup)))));
  const user = await openDiagnostic();
  await user.click(screen.getByRole('button', {name: 'Check local server'}));
  await user.click(screen.getByRole('button', {name: 'Check shared data'}));
  await user.click(screen.getByRole('button', {name: 'Cancel waiting for local server'}));
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  expect(screen.getByText(/Checking shared data…/)).toBeTruthy();
  await user.click(screen.getByRole('button', {name: 'Cancel waiting for shared data'}));
  expect(signals[1].aborted).toBe(true);
  expect((screen.getByRole('button', {name: 'Check local server'}) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', {name: 'Check shared data'}) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getAllByText(/Stopped waiting.*retry explicitly/)).toHaveLength(2);
  expect(screen.queryByText('Local server diagnostic passed')).toBeNull();
  expect(screen.queryByText('Shared-data check passed.')).toBeNull();
  expect(screen.queryByText(/Employees:.*Saved work:/)).toBeNull();
  expect(signals).toHaveLength(2);
});

test.each(['success', 'failure'])('StrictMode setup replay admits a replacement and ignores late cleanup %s', async outcome => {
  const requests: {resolve: (response: Response) => void; reject: (error: Error) => void; signal: AbortSignal}[] = [];
  vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => requests.push({resolve, reject, signal: init!.signal as AbortSignal}))));
  render(<StrictMode><Connections workspaceConnected openClient={{id: 'codex'}} /></StrictMode>);
  expect(requests).toHaveLength(2);
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests[1].signal.aborted).toBe(false);
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  await act(async () => {
    if (outcome === 'failure') requests[0].reject(new Error('late cleanup failure'));
    else requests[0].resolve(new Response(JSON.stringify({...setup, preparation: 'Obsolete setup'})));
  });
  expect((refresh as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', {name: 'Cancel waiting for setup'})).toBeTruthy();
  expect(screen.queryByLabelText('Setup instructions')).toBeNull();
  expect(screen.queryByText(/Setup service disconnected/)).toBeNull();
  fireEvent.click(refresh);
  expect(requests).toHaveLength(2);
  await act(async () => requests[1].resolve(new Response(JSON.stringify(setup))));
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toContain(setup.preparation);
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole('button', {name: 'Cancel waiting for setup'})).toBeNull();
});

test.each(['initial', 'retained'])('setup %s cancellation permits immediate explicit refresh and ignores late responses', async mode => {
  const requests: {resolve: (response: Response) => void; reject: (error: Error) => void; signal: AbortSignal}[] = [];
  let seeded = mode === 'initial';
  const fetcher = vi.fn((_path: string, init?: RequestInit) => {
    if (!seeded) { seeded = true; return Promise.resolve(new Response(JSON.stringify(setup))); }
    return new Promise<Response>((resolve, reject) => requests.push({resolve, reject, signal: init!.signal as AbortSignal}));
  });
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  let instructions: string | undefined;
  if (mode === 'retained') {
    await screen.findByLabelText('Client');
    await user.selectOptions(screen.getByLabelText('Client'), 'claude-code');
    await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
    instructions = (screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value;
    fireEvent.click(refresh);
  }
  const cancel = screen.getByRole('button', {name: 'Cancel waiting for setup'});
  for (let tabs = 0; tabs < 30 && document.activeElement !== cancel; tabs++) await user.tab();
  expect(document.activeElement).toBe(cancel);
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(refresh);
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests).toHaveLength(1);
  expect(screen.getByText(/Stopped waiting for setup/)).toBeTruthy();
  if (mode === 'initial') expect(screen.queryByLabelText('Setup instructions')).toBeNull();
  else {
    expect(screen.getByText(/Previous setup observation/)).toBeTruthy();
    expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('claude-code');
    expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('windows');
    expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toBe(instructions);
  }
  fireEvent.click(refresh);
  fireEvent.click(screen.getByRole('button', {name: 'Cancel waiting for setup'}));
  fireEvent.click(refresh);
  fireEvent.click(refresh);
  expect(requests).toHaveLength(3);
  await act(async () => {
    requests[0].resolve(new Response(JSON.stringify({...setup, clients: [setup.clients[0]]})));
    requests[1].reject(new Error('late failure'));
  });
  expect((refresh as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Loading setup…')).toBeTruthy();
  expect(screen.queryByText(/Stopped waiting for setup/)).toBeNull();
  expect(screen.queryByText(/Setup service disconnected/)).toBeNull();
  await act(async () => requests[2].resolve(new Response(JSON.stringify(setup))));
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/Previous setup observation/)).toBeNull();
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'POST' && init.body === '{}')).toBe(true);
});

test.each(['success', 'failure', 'cancel', 'outside', 'hidden'])('setup disappearance restores focus appropriately: %s', async outcome => {
  let finish!: (response: Response) => void;
  let fail!: (error: Error) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => {finish = resolve; fail = reject;})));
  const user = userEvent.setup();
  render(<><input aria-label="Outside draft" /><Connections workspaceConnected openClient={{id: 'codex'}} /></>);
  const refresh = screen.getByRole('button', {name: 'Refresh setup'});
  const cancel = screen.getByRole('button', {name: 'Cancel waiting for setup'});
  cancel.focus();
  const outside = screen.getByLabelText('Outside draft');
  if (outcome === 'outside') outside.focus();
  if (outcome === 'hidden') await user.click(screen.getByRole('button', {name: 'Hide connections'}));
  const previous = document.activeElement;
  if (outcome === 'cancel' || outcome === 'outside') fireEvent.click(cancel);
  else await act(async () => {
    if (outcome === 'failure') fail(new Error('offline'));
    else finish(new Response(JSON.stringify(setup)));
  });
  expect(document.activeElement).toBe(['outside', 'hidden'].includes(outcome) ? previous : refresh);
  if (outcome === 'hidden') {
    await user.click(screen.getByRole('button', {name: 'Open connections'}));
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Hide connections'}));
  }
});

test.each(['success', 'failure'])('abandoned clipboard %s retains manual access and write admission until settlement', async outcome => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(setup))));
  const user = userEvent.setup();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const copy = vi.spyOn(navigator.clipboard, 'writeText')
    .mockImplementationOnce(() => new Promise<void>((resolve, reject) => {finish = resolve; fail = reject;}))
    .mockResolvedValue();
  render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  const field = await screen.findByLabelText('Setup instructions') as HTMLTextAreaElement;
  const text = field.value;
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  const stop = screen.getByRole('button', {name: 'Stop waiting for clipboard'});
  stop.focus();
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(field);
  expect(screen.getByText(/stopping waiting does not undo it/)).toBeTruthy();
  expect(field.value).toBe(text);
  field.select();
  expect(field.selectionEnd).toBe(text.length);
  expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('codex');
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('macos');
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(copy).toHaveBeenCalledTimes(1);
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(copy).toHaveBeenCalledTimes(1);
  vi.stubGlobal('URL', {createObjectURL: () => {throw new Error('unavailable');}});
  await user.click(screen.getByRole('button', {name: 'Download setup artifact'}));
  const newerFeedback = screen.getByText(/Could not download/).textContent;
  await act(async () => {if (outcome === 'success') finish(); else fail(new Error('denied'));});
  expect(screen.getByText(/Could not download/).textContent).toBe(newerFeedback);
  expect(screen.queryByText(/copied. Client readiness/)).toBeNull();
  expect(screen.queryByText(/Could not copy/)).toBeNull();
  expect(screen.getByText(/previous write has settled/)).toBeTruthy();
  await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
  expect(copy).toHaveBeenCalledTimes(2);
  expect(copy).toHaveBeenLastCalledWith('config-codex-windows');
  await screen.findByText('Configuration copied. Client readiness remains unknown.');
});

test.each(['success', 'failure', 'outside', 'hidden', 'unmount-success', 'unmount-failure'])(
  'clipboard waiting control disappearance respects focus and lifetime: %s', async outcome => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(setup))));
    const user = userEvent.setup();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve, reject) => {finish = resolve; fail = reject;}));
    const view = render(<><input aria-label="Outside draft" /><Connections workspaceConnected openClient={{id: 'codex'}} /></>);
    const field = await screen.findByLabelText('Setup instructions');
    await user.click(screen.getByRole('button', {name: 'Copy configuration'}));
    screen.getByRole('button', {name: 'Stop waiting for clipboard'}).focus();
    const outside = screen.getByLabelText('Outside draft');
    if (outcome === 'outside') outside.focus();
    if (outcome === 'hidden') await user.click(screen.getByRole('button', {name: 'Hide connections'}));
    const previous = document.activeElement;
    if (outcome.startsWith('unmount')) view.unmount();
    await act(async () => {if (outcome.includes('failure')) fail(new Error('denied')); else finish();});
    if (outcome.startsWith('unmount')) {
      expect(screen.queryByText(/copied. Client readiness/)).toBeNull();
      return;
    }
    expect(document.activeElement).toBe(['outside', 'hidden'].includes(outcome) ? previous : field);
    if (outcome === 'hidden') {
      await user.click(screen.getByRole('button', {name: 'Open connections'}));
      expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Hide connections'}));
    }
  },
);

test.each(['diagnostic', 'shared-data'])('%s observation times belong only to accepted responses and retained counts', async kind => {
  const NativeDate = Date;
  let now = '2026-11-15T01:02:03.000Z';
  class ReceiptDate extends NativeDate {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return new NativeDate(now).getTime(); }
  }
  vi.stubGlobal('Date', ReceiptDate);
  const path = kind === 'diagnostic' ? diagnosticPath : sharedPath;
  const label = kind === 'diagnostic' ? 'Check local server' : 'Check shared data';
  const region = kind === 'diagnostic' ? 'Local server diagnostic' : 'Shared employee and work access';
  const passed = kind === 'diagnostic' ? diagnosticResult('passed') : sharedResult(7, 8);
  let current = structuredClone(setup);
  let transportFailure = false;
  const requests: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string) => input === path && transportFailure
    ? Promise.reject(new Error('unavailable')) : input === path
    ? new Promise<Response>(resolve => requests.push(resolve))
    : Promise.resolve(new Response(JSON.stringify(current)))));
  const view = render(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  await screen.findByLabelText('Client');
  const section = screen.getByRole('region', {name: region});
  const scope = within(section);
  const button = scope.getByRole('button', {name: label});
  const times = () => Array.from(section.querySelectorAll('time')).map(time => time.dateTime);
  const settle = async (index: number, value: unknown) => {
    await act(async () => requests[index](new Response(JSON.stringify(value))));
  };
  fireEvent.click(button);
  expect(times()).toEqual([]);
  await settle(0, passed);
  const original = now;
  expect(times()).toEqual(kind === 'diagnostic' ? [original] : [original, original]);
  expect(scope.getByText(/browser receipt time, not proof of an external client connection/)).toBeTruthy();
  now = '2026-11-15T02:03:04.000Z';
  fireEvent.click(button);
  expect(scope.getAllByText(/Previous .*potentially stale/).length).toBeGreaterThan(0);
  fireEvent.click(scope.getByRole('button', {name: /Cancel waiting/}));
  fireEvent.click(button);
  await settle(1, passed); // cancelled and superseded response must not relabel evidence
  expect(times().every(time => time === original)).toBe(true);
  await settle(2, diagnosticResult('failed'));
  expect(times()).toEqual(kind === 'diagnostic' ? [now] : [now, original]);
  expect(scope.getByText(/Local response \(failed\)/)).toBeTruthy();
  if (kind === 'shared-data') expect(scope.getByText(/Previous counts — potentially stale/)).toBeTruthy();
  now = '2026-11-15T03:04:05.000Z';
  fireEvent.click(button);
  await settle(3, {schema_version: 999});
  expect(times()[0]).toBe('2026-11-15T02:03:04.000Z');
  transportFailure = true;
  fireEvent.click(button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(times()[0]).toBe('2026-11-15T02:03:04.000Z');
  transportFailure = false;
  fireEvent.click(button);
  await settle(4, passed);
  expect(times().every(time => time === now)).toBe(true);
  const retained = times();
  view.rerender(<Connections workspaceConnected={false} openClient={{id: 'codex'}} />);
  expect(times()).toEqual(retained);
  view.rerender(<Connections workspaceConnected openClient={{id: 'codex'}} />);
  current.clients[0].platforms[0].configuration = 'changed database';
  fireEvent.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByDisplayValue('changed database');
  expect(times()).toEqual(retained);
  expect(scope.getAllByText(/Previous .*potentially stale/).length).toBeGreaterThan(0);
  fireEvent.click(button);
  view.unmount();
  now = '2026-11-15T04:05:06.000Z';
  await settle(5, passed);
  // Detached observation nodes retain the last accepted time after unmount.
  expect(times()).toEqual(retained);
});
