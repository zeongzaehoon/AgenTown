import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
