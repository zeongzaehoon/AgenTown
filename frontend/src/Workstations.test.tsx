import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { Connections, workstationClients, type ConnectionSetup } from './Connections';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const setup: ConnectionSetup = {
  schema_version: 1, workflow_version: 1, transport: 'stdio', evidence: 'No actual client validation.',
  preparation: 'Replace paths.', actions: ['Inspect work'], consent: 'Execute only with consent.', recovery: 'Inspect before retry.',
  clients: workstationClients.map(({id, name}, index) => ({id, name, readiness: 'unknown',
    status: {detected: index === 0 ? true : index === 1 ? false : null, configured: 'unknown', connected: 'unverified', exercised: 'unverified'},
    platforms: ['macos', 'windows'].map(p => ({id: p, name: p, destination: `${id}-${p}`, configuration: `artifact-${id}-${p}`, inspection: 'Inspect only'})),
  })),
};

test('App workstation keyboard navigation selects all clients, focuses setup and preserves drafts and controls without mutations', async () => {
  const fetcher = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === '/api/connections/v1') return new Response(JSON.stringify(setup));
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'a', name: 'Alex'}], work: [], configuration: null, provider: 'deterministic-test', model: 'test'}));
    if (path === '/api/config/v1/skills') return new Response(JSON.stringify({skills: [{id: 'manual', name: 'Manual', instructions: 'Saved instructions', enabled: false}]}));
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[]}');
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', {name: 'Open Skill book: Manual · ID: manual'});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Work draft'}});
  await user.click(screen.getByRole('button', {name: 'Open Skill book: Manual · ID: manual'}));
  await screen.findByLabelText('Instructions');
  fireEvent.change(screen.getByLabelText('Instructions'), {target: {value: 'Configuration draft'}});
  for (const [index, client] of workstationClients.entries()) {
    screen.getByRole('button', {name: `Open ${client.name} workstation setup`}).focus();
    await user.keyboard(index % 2 ? ' ' : '{Enter}');
    await waitFor(() => expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe(client.id));
    expect(document.activeElement).toBe(screen.getByRole('heading', {name: `${client.name} setup`}));
    expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toContain(`artifact-${client.id}`);
    expect(screen.getByRole('button', {name: 'Copy setup instructions'})).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Download setup artifact'})).toBeTruthy();
    expect(screen.getByText(/Configured: Unknown. Connected: Unverified. Exercised: Unverified/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
    await user.click(screen.getByRole('button', {name: 'Hide connections'}));
  }
  // Reopen the same workstation: setup and platform choice survive hiding.
  screen.getByRole('button', {name: 'Open ChatGPT workstation setup'}).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'ChatGPT setup'})));
  expect((screen.getByLabelText('Platform') as HTMLSelectElement).value).toBe('windows');
  await user.selectOptions(screen.getByLabelText('Client'), 'cursor');
  await user.click(screen.getByRole('button', {name: 'Hide connections'}));
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('cursor');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Work draft');
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('Configuration draft');
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/connections/v1')).toHaveLength(1);
  for (const [path, options] of fetcher.mock.calls) {
    // Presentation inspection can use POST; navigation must never call mutation/execution endpoints.
    expect(['/api/state', '/api/teams', '/api/loops/v1', '/api/config/v1/skills', '/api/config/v1/hooks', '/api/config/v1/loops', '/api/connections/v1']).toContain(path);
    expect(options?.method).toBe(['/api/state', '/api/connections/v1'].includes(path) ? 'POST' : 'GET');
  }
});

test('requested setup receives focus on initial failure, retains stale evidence and handles a missing selected client', async () => {
  let response: ConnectionSetup | null = null;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!response) throw new Error('Offline');
    return new Response(JSON.stringify(response));
  }));
  const user = userEvent.setup();
  const view = render(<Connections workspaceConnected={false} openClient={{id: 'cursor'}} />);
  expect(await screen.findByText(/Setup service disconnected/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Cursor setup'}));
  expect(screen.getByText(/Detected: Unknown. Configured: Unknown/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Download setup artifact'})).toBeNull();
  response = setup;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await screen.findByLabelText('Client');
  view.rerender(<Connections workspaceConnected={false} openClient={{id: 'codex'}} />);
  await waitFor(() => expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('codex'));
  expect(screen.getByText(/Detected: Installation hint only/)).toBeTruthy();
  response = null;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  expect(await screen.findByText(/Loaded instructions may be stale/)).toBeTruthy();
  view.rerender(<Connections workspaceConnected={false} openClient={{id: 'claude-code'}} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Claude Code setup'})));
  expect(screen.getByText(/Detected: Not detected \(inconclusive\)/)).toBeTruthy();
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toContain('artifact-claude-code');
  response = {...setup, clients: setup.clients.filter(c => c.id !== 'claude-code')};
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  expect(await screen.findByText(/Selected client setup unavailable/)).toBeTruthy();
  expect((screen.getByLabelText('Client') as HTMLSelectElement).value).toBe('claude-code');
  expect(screen.queryByRole('button', {name: 'Copy setup instructions'})).toBeNull();
  await user.selectOptions(screen.getByLabelText('Client'), 'cursor');
  expect(screen.getByRole('button', {name: 'Copy setup instructions'})).toBeTruthy();
});
