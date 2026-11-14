import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { LoopDevices } from './LoopDevices';
import { App } from './App';
import type { Workspace } from './api';

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
  expect(await screen.findByText('Loop devices are stale — showing the last successful snapshot.')).toBeTruthy();
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
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Saved work', assignees: ['a'], status: 'pending', attempts: []}, {id: 'retargeted-task', input: 'Other saved work', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'deterministic-test', model: 'test'}));
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
  const linked = screen.getByRole('button', {name: 'Open linked work for Loop: Manual · Policy ID: one · Task ID: w'});
  linked.focus(); await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
  expect(screen.getByText(/Requested Task: w · Policy: one/)).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Work draft');
  expect((screen.getByRole('button', {name: 'Open linked work for Loop: Manual · Policy ID: two · Task ID: other'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Linked work unavailable/)).toBeTruthy();
  // A malformed device refresh retains the card but must revoke navigation.
  malformed = true;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect((linked as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(document.querySelector('.loop-policy-devices [role="status"]')?.textContent).toContain('Loop devices are stale — showing the last successful snapshot.'));
  fireEvent.click(linked);
  expect((linked as HTMLButtonElement).disabled).toBe(true);
  malformed = false;
  saved = [{...loops[0], id: 'retargeted-policy', task_id: 'retargeted-task'}];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  const retargeted = await screen.findByRole('button', {name: 'Open linked work for Loop: Manual · Policy ID: retargeted-policy · Task ID: retargeted-task'});
  retargeted.focus(); await userEvent.keyboard(' ');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
  expect(screen.getByText(/Requested Task: retargeted-task · Policy: retargeted-policy/)).toBeTruthy();
  expect(screen.queryByRole('checkbox', {name: /I authorize/})).toBeNull();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved policy');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Work draft');
  saved = loops;

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


test.each(['failed', 'malformed'])('linked work requires a successful current snapshot after %s refresh', async failure => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({loops: [loops[0]]})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const workspace: Workspace = {employees: [], work: ['w', 'other'].map(id => ({id, input: id, status: 'pending', assignees: [], attempts: []})), configuration: null, provider: 'test', model: 'test'};
  const view = render(<LoopDevices workspace={workspace} onOpenPolicy={open} />);
  const linked = () => screen.getByRole('button', {name: /Open linked work for Loop/}) as HTMLButtonElement;
  await waitFor(() => expect(linked().disabled).toBe(false));
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect(linked().disabled).toBe(true);
  expect(document.getElementById(linked().getAttribute('aria-describedby')!)!.textContent).toContain('Refreshing');
  fireEvent.click(linked());
  finish(failure === 'failed' ? new Response('Offline', {status: 503}) : new Response('{"loops":[{}]}'));
  await screen.findByText('Loop devices are stale — showing the last successful snapshot.');
  expect(linked().disabled).toBe(true);
  expect(document.getElementById(linked().getAttribute('aria-describedby')!)!.textContent).toContain('stale');
  fireEvent.click(linked());
  expect(open).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({loops: [{...loops[0], id: 'new-policy', task_id: 'other'}]})));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  await waitFor(() => expect(linked().disabled).toBe(false));
  linked().focus(); await userEvent.keyboard(' ');
  expect(open.mock.calls).toEqual([[{taskId: 'other', policyId: 'new-policy'}]]);
  view.rerender(<LoopDevices workspace={workspace} connected={false} onOpenPolicy={open} />);
  expect(linked().disabled).toBe(true);
  expect(document.getElementById(linked().getAttribute('aria-describedby')!)!.textContent).toContain('Disconnected');
  view.rerender(<LoopDevices workspace={{...workspace, work: []}} onOpenPolicy={open} />);
  expect(linked().disabled).toBe(true);
  expect(document.getElementById(linked().getAttribute('aria-describedby')!)!.textContent).toContain('Linked work unavailable');
  fireEvent.click(linked());
  expect(open).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(Array(3).fill('/api/config/v1/loops'));
});


test.each([true, false])('retained freshness survives reconnection and failure (populated: %s)', async populated => {
  const records = populated ? [loops[0]] : [];
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({loops: records})));
  // Each request needs its own response body.
  fetcher.mockImplementation(async () => new Response(JSON.stringify({loops: records})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const workspace: Workspace = {employees: [], work: [{id: 'w', input: 'Saved', status: 'pending', assignees: [], attempts: []}], configuration: null, provider: 'test', model: 'test'};
  const props = {onOpenLoop: open, onOpenPolicy: vi.fn(), workspace};
  const view = render(<LoopDevices {...props} />);
  await screen.findByText(populated ? 'Showing saved Loop devices.' : 'No saved Loops yet. Create a Loop in Configuration.');
  const card = populated ? screen.getByRole('button', {name: 'Open Loop device: Manual · ID: one'}) : null;
  card?.focus();
  view.rerender(<LoopDevices {...props} connected={false} />);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Disconnected');
  if (card) {
    expect(card.textContent).toContain('Disconnected — potentially stale configuration snapshot');
    expect(document.activeElement).toBe(card);
    fireEvent.click(card);
    expect(open).toHaveBeenCalledWith('one');
    expect((screen.getByRole('button', {name: /Open linked work/}) as HTMLButtonElement).disabled).toBe(true);
  } else expect(screen.getByRole('status', {name: ''}).textContent).toContain('current Loops are unknown');
  view.rerender(<LoopDevices {...props} connected />);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('may still be stale');
  if (card) {
    expect(screen.getByRole('button', {name: 'Open Loop device: Manual · ID: one'})).toBe(card);
    expect(document.activeElement).toBe(card);
    // Freshness disclosure adds no new linked-work guard after reconnecting.
    expect((screen.getByRole('button', {name: /Open linked work/}) as HTMLButtonElement).disabled).toBe(false);
  }
  fetcher.mockRejectedValueOnce(new Error('Refresh failed'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  await screen.findByText('Refresh failed');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('may still be stale');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('last successful snapshot');
  view.rerender(<LoopDevices {...props} connected={false} />);
  view.rerender(<LoopDevices {...props} connected />);
  expect(screen.getByRole('alert').textContent).toBe('Refresh failed');
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  await screen.findByText(populated ? 'Showing saved Loop devices.' : 'No saved Loops yet. Create a Loop in Configuration.');
  expect(screen.queryByText('Potentially stale configuration snapshot — refresh to check')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test.each([true, false])('a refresh spanning disconnection cannot validate a populated or empty snapshot: %s', async populated => {
  let finish!: (response: Response) => void;
  const records = populated ? [loops[0]] : [];
  const response = () => new Response(JSON.stringify({loops: records}));
  const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValueOnce(response());
  vi.stubGlobal('fetch', fetcher);
  const view = render(<LoopDevices />);
  await screen.findByText(populated ? 'Showing saved Loop devices.' : 'No saved Loops yet. Create a Loop in Configuration.');
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Loading');
  view.rerender(<LoopDevices connected={false} />);
  view.rerender(<LoopDevices connected />);
  await act(async () => { finish(response()); });
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('may still be stale');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain(populated ? 'retained Loop devices' : 'current Loops are unknown');
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  await screen.findByText(populated ? 'Showing saved Loop devices.' : 'No saved Loops yet. Create a Loop in Configuration.');
});

test('a request started disconnected cannot clear freshness after recovery', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValueOnce(new Response('{"loops":[]}'));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<LoopDevices connected={false} />);
  view.rerender(<LoopDevices connected />);
  await act(async () => { finish(new Response('{"loops":[]}')); });
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Loop devices unavailable');
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Loop devices'}));
  await screen.findByText('No saved Loops yet. Create a Loop in Configuration.');
});


test('accepted card removals recover focus, including empty results; surviving and outside focus stay put', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  render(<><input aria-label="Outside draft" defaultValue="Keep draft" /><LoopDevices onOpenLoop={vi.fn()} /></>);
  const respond = async (records: typeof loops) => {
    await act(async () => { finish(new Response(JSON.stringify({loops: records}))); });
  };
  await respond(loops);
  const refresh = screen.getByRole('button', {name: 'Refresh Loop devices'});
  const first = screen.getByRole('button', {name: 'Open Loop device: Manual · ID: one'});
  // Refresh without moving focus, then settle while the old card still owns focus.
  first.focus(); fireEvent.click(refresh);
  await respond([{...loops[1], name: 'Renamed'}, {...loops[0], name: 'Renamed'}]);
  expect(document.activeElement).toBe(first);
  first.focus(); fireEvent.click(refresh);
  await respond([{...loops[1], name: 'Renamed'}]);
  expect(document.activeElement).toBe(refresh);
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByLabelText('Loop devices removals').getAttribute('aria-live')).toBe('polite');
  expect(screen.getByLabelText('Loop devices removals').getAttribute('aria-atomic')).toBe('true');
  expect(screen.getByLabelText('Loop devices removals').textContent).toContain('1 record removed');
  await userEvent.keyboard('{Tab}');
  const survivor = screen.getByRole('button', {name: 'Open Loop device: Renamed · ID: two'});
  expect(document.activeElement).toBe(survivor);
  fireEvent.click(refresh); await respond([]);
  expect(document.activeElement).toBe(refresh);
  expect(screen.getByLabelText('Loop devices removals').textContent).toContain('No cards remain');
  fireEvent.click(refresh); await respond(loops);
  const outside = screen.getByRole('textbox', {name: 'Outside draft'});
  outside.focus(); fireEvent.click(refresh); await respond([loops[0]]);
  expect(document.activeElement).toBe(outside);
  expect((outside as HTMLInputElement).value).toBe('Keep draft');
  const remaining = screen.getByRole('button', {name: 'Open Loop device: Manual · ID: one'});
  remaining.focus(); fireEvent.click(refresh); await respond([{...loops[0], name: 'Final'}]);
  expect(document.activeElement).toBe(remaining);
  expect(screen.getByLabelText('Loop devices removals').textContent).toBe('');
});

test.each([true, false])('failed and old-connection responses cannot override a newer refresh (old settles first: %s)', async oldFirst => {
  const pending: {resolve: (response: Response) => void; reject: (error: Error) => void}[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => pending.push({resolve, reject}))));
  const view = render(<LoopDevices onOpenLoop={vi.fn()} connected />);
  const respond = async (index: number, records: typeof loops) => {
    await act(async () => { pending[index].resolve(new Response(JSON.stringify({loops: records}))); });
  };
  await respond(0, loops);
  const refresh = screen.getByRole('button', {name: 'Refresh Loop devices'});
  const first = screen.getByRole('button', {name: 'Open Loop device: Manual · ID: one'});
  first.focus(); fireEvent.click(refresh);
  await act(async () => { pending[1].reject(new Error('Offline')); });
  expect(document.activeElement).toBe(first);
  expect(screen.getByLabelText('Loop devices removals').textContent).toBe('');
  fireEvent.click(refresh);
  view.rerender(<LoopDevices onOpenLoop={vi.fn()} connected={false} />);
  view.rerender(<LoopDevices onOpenLoop={vi.fn()} connected />);
  fireEvent.click(refresh);
  if (oldFirst) {
    await respond(2, []);
    expect(document.activeElement).toBe(first);
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Loop devices removals').textContent).toBe('');
  }
  await respond(3, [{...loops[0], name: 'Current'}]);
  expect(document.activeElement).toBe(first);
  const current = screen.getByRole('button', {name: 'Open Loop device: Current · ID: one'});
  current.focus();
  if (!oldFirst) await respond(2, []);
  expect(document.activeElement).toBe(current);
  expect(screen.getByRole('button', {name: 'Open Loop device: Current · ID: one'})).toBe(current);
  expect(screen.getByLabelText('Loop devices removals').textContent).toContain('1 record removed');
});
