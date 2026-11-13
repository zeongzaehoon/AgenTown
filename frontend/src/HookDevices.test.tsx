import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { HookDevices } from './HookDevices';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const hooks = [{id: 'one', name: 'Manual', skill_id: 's', target_kind: 'agent', target_id: 'a', event: 'run_completed', enabled: true}, {id: 'two', name: 'Manual', skill_id: 's', target_kind: 'team', target_id: 't', event: 'run_failed', enabled: false}];

test('devices show loading, duplicate identities, keyboard controls and stale snapshots', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const user = userEvent.setup();
  render(<HookDevices onOpenHook={open} />);
  expect(screen.getByText('Loading Hook devices…')).toBeTruthy();
  finish(new Response(JSON.stringify({hooks})));
  const first = await screen.findByRole('button', {name: 'Open Hook device: Manual · ID: one'});
  const second = screen.getByRole('button', {name: 'Open Hook device: Manual · ID: two'});
  expect(first.textContent).toContain('Event: run_completed');
  expect(second.textContent).toContain('Target: team · ID: t');
  expect(first.textContent).toContain('Configuration enabled');
  expect(second.textContent).toContain('Configuration disabled');
  first.focus(); await user.keyboard('{Enter}');
  second.focus(); await user.keyboard(' ');
  expect(open.mock.calls).toEqual([['one'], ['two']]);
  fetcher.mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  expect(await screen.findByText(/Hook devices are stale/)).toBeTruthy();
  expect(screen.getAllByText('Stale snapshot')).toHaveLength(2);
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({hooks: [hooks[0]]})));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  expect(await screen.findByText('Showing saved Hook devices.')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Open Hook device: Manual · ID: two'})).toBeNull();
});

test('initial failure and successful empty refresh are distinct', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(new Response('{"hooks":[]}'));
  vi.stubGlobal('fetch', fetcher);
  render(<HookDevices onOpenHook={vi.fn()} />);
  expect(await screen.findByText('Hook devices unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  expect(await screen.findByText(/No saved Hooks yet/)).toBeTruthy();
});

test('App opens exact IDs repeatedly, retains configuration and work drafts and handles removed records without mutations', async () => {
  let saved = [...hooks];
  let offline = false;
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Saved work', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'deterministic-test', model: 'test'}));
    if (path === '/api/config/v1/hooks') { if (offline) throw new Error('Offline'); return new Response(JSON.stringify({hooks: saved})); }
    if (path === '/api/config/v1/skills') return new Response('{"skills":[]}');
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":""}');
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await screen.findByRole('button', {name: 'Open Hook device: Manual · ID: one'});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Work draft'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Hook device: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe('two'));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Unsaved trigger'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Hook device: Manual · ID: one'}));
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Manual'));
  fireEvent.click(screen.getByRole('button', {name: 'Open Hook device: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved trigger'));
  expect((screen.getByLabelText('What would you like help with?') as HTMLInputElement).value).toBe('Work draft');
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('w');
  fireEvent.click(screen.getByRole('button', {name: 'Open Hook device: Manual · ID: two'}));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  fireEvent.change(screen.getByLabelText('Record type'), {target: {value: 'skills'}});
  fireEvent.change(screen.getByLabelText('Instructions'), {target: {value: 'New Skill draft'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Hook device: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved trigger'));
  fireEvent.change(screen.getByLabelText('Record type'), {target: {value: 'skills'}});
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('New Skill draft');
  fireEvent.click(screen.getByRole('button', {name: 'Open Hook device: Manual · ID: two'}));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  const linked = screen.getByRole('button', {name: 'Open work for Hook: Manual · Hook ID: one · Task ID: w'});
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'obstructing filter'}});
  linked.focus(); await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Hook inspection'}));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved trigger');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Work draft');
  expect((screen.getByLabelText('Search saved work') as HTMLInputElement).value).toBe('');
  fireEvent.click(linked);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Hook inspection'}));
  offline = true;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  expect(await screen.findByText(/Configuration disconnected/)).toBeTruthy();
  offline = false;
  saved = [hooks[0]];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  expect(await screen.findByText(/Selected record unavailable · ID: two/)).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved trigger');
  expect((screen.getByRole('button', {name: 'Save changes'}) as HTMLButtonElement).disabled).toBe(true);
  saved = hooks;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  await screen.findByText('Saved values · ID: two');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved trigger');
  // State inspection uses POST; configuration book navigation uses GET only.
  for (const [path, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(['/api/state', '/api/teams', '/api/loops/v1', '/api/config/v1/skills', '/api/config/v1/hooks', '/api/config/v1/loops']).toContain(path);
    if (path.startsWith('/api/config/')) {
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    }
  }
});

test('explicit work choices carry exact IDs with duplicate names and explain unsupported or empty assignments', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({hooks: [hooks[0], {...hooks[0], id: 'duplicate'}, hooks[1], {...hooks[0], id: 'empty', target_id: 'missing'}, {...hooks[0], id: 'created', event: 'task_created'}]}))));
  const open = vi.fn();
  render(<HookDevices onOpenWork={open} workspace={{employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Saved', assignees: ['a'], status: 'pending', attempts: []}]} as never} />);
  const choice = await screen.findByRole('button', {name: 'Open work for Hook: Manual · Hook ID: duplicate · Task ID: w'});
  choice.focus(); await userEvent.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith({taskId: 'w', hookId: 'duplicate', employeeId: 'a'});
  expect(screen.getByText(/No saved work assigned/)).toBeTruthy();
  expect(screen.getAllByText(/Team and task-created Hooks remain configuration only/)).toHaveLength(2);
});
