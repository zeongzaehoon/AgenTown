import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { LoopDevices } from './LoopDevices';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const loops = [{id: 'one', name: 'Manual', task_id: 'w', max_iterations: 2, interval_seconds: 60, enabled: true}, {id: 'two', name: 'Manual', task_id: 'other', max_iterations: 5, interval_seconds: 120, enabled: false}];

test('devices show loading, duplicate identities, keyboard controls and stale snapshots', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const user = userEvent.setup();
  render(<LoopDevices onOpenLoop={open} />);
  expect(screen.getByText('Loading Loop devices…')).toBeTruthy();
  finish(new Response(JSON.stringify({loops})));
  const first = await screen.findByRole('button', {name: 'Open Loop device: Manual · ID: one'});
  const second = screen.getByRole('button', {name: 'Open Loop device: Manual · ID: two'});
  expect(first.textContent).toContain('ID: one');
  expect(first.textContent).toContain('Iteration limit: 2');
  expect(second.textContent).toContain('Interval: 120 seconds');
  expect(second.textContent).toContain('Linked Task ID: other');
  expect(first.textContent).toContain('Configuration enabled');
  expect(second.textContent).toContain('Configuration disabled');
  first.focus(); await user.keyboard('{Enter}');
  second.focus(); await user.keyboard(' ');
  expect(open.mock.calls).toEqual([['one'], ['two']]);
  fetcher.mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect(await screen.findByText(/Loop devices are stale/)).toBeTruthy();
  expect(screen.getAllByText('Stale snapshot')).toHaveLength(2);
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({loops: [loops[0]]})));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect(await screen.findByText('Showing saved Loop devices.')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Open Loop device: Manual · ID: two'})).toBeNull();
});

test('initial failure and successful empty refresh are distinct', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(new Response('{"loops":[]}'));
  vi.stubGlobal('fetch', fetcher);
  render(<LoopDevices onOpenLoop={vi.fn()} />);
  expect(await screen.findByText('Loop devices unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect(await screen.findByText(/No saved Loops yet/)).toBeTruthy();
});

test('App opens exact IDs repeatedly, retains configuration and work drafts and handles removed records without mutations', async () => {
  let saved = [...loops];
  let offline = false;
  let malformed = false;
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Saved work', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'deterministic-test', model: 'test'}));
    if (path === '/api/config/v1/loops') { if (offline) throw new Error('Offline'); return new Response(JSON.stringify(malformed ? {loops: [{}]} : {loops: saved})); }
    if (path === '/api/config/v1/skills') return new Response('{"skills":[]}');
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":""}');
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await screen.findByRole('button', {name: 'Open Loop device: Manual · ID: one'});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Work draft'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe('two'));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Unsaved policy'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: one'}));
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Manual'));
  fireEvent.click(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy'));
  expect((screen.getByLabelText('What would you like help with?') as HTMLInputElement).value).toBe('Work draft');
  expect(screen.getAllByLabelText('Saved work').some(element => (element as HTMLSelectElement).value === 'w')).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: two'}));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  fireEvent.change(screen.getByLabelText('Record type'), {target: {value: 'skills'}});
  fireEvent.change(screen.getByLabelText('Instructions'), {target: {value: 'New Skill draft'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy'));
  fireEvent.change(screen.getByLabelText('Record type'), {target: {value: 'skills'}});
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('New Skill draft');
  fireEvent.click(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: two'}));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  malformed = true;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  expect(await screen.findByText(/Saved Loop data unavailable/)).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy');
  malformed = false;
  offline = true;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  expect(await screen.findByText(/Configuration disconnected/)).toBeTruthy();
  offline = false;
  saved = [loops[0]];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  expect(await screen.findByText(/Selected record unavailable · ID: two/)).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy');
  expect((screen.getByRole('button', {name: 'Save changes'}) as HTMLButtonElement).disabled).toBe(true);
  saved = loops;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  await screen.findByText('Saved values · ID: two');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy');
  // Only known inspection endpoints are allowed; policy navigation uses GET only.
  for (const [path, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(['/api/state', '/api/teams', '/api/loops/v1', '/api/config/v1/skills', '/api/config/v1/hooks', '/api/config/v1/loops']).toContain(path);
    if (path.startsWith('/api/config/')) {
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    }
  }
});


test.each([null, {}, {loops: null}, {loops: [{}]}, {loops: [{...loops[0], max_iterations: '2'}]}, {loops: [{...loops[0], interval_seconds: 0}]}, {loops: [{...loops[0], enabled: 'true'}]}, {loops: [loops[0], loops[0]]}])('malformed saved policy response is unavailable and refresh recovers: %j', async value => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(value))).mockResolvedValueOnce(new Response(JSON.stringify({loops})));
  vi.stubGlobal('fetch', fetcher);
  render(<LoopDevices onOpenLoop={vi.fn()} />);
  expect(await screen.findByText('Loop devices unavailable.')).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Open Loop device/})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect(await screen.findByRole('button', {name: 'Open Loop device: Manual · ID: one'})).toBeTruthy();
});
