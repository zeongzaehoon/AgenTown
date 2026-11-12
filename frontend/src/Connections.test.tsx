import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

const recoverySetup: ConnectionSetup = {...setup, clients: [...fragmentClients(), {
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
  response = {...recoverySetup, preparation: 'Recovered setup instructions.'};
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByText('Setup service available.');
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toContain('Recovered setup instructions.');
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
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/connections/v1']);
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
