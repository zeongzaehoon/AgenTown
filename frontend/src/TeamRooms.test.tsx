import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TeamRooms } from './TeamRooms';
import { App } from './App';
import type { Team, Workspace } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workspace: Workspace = {employees: [{id: 'a', name: 'Alex'}, {id: 'b', name: 'Alex'}], work: [
  {id: 'w', input: 'Shared work', status: 'pending', assignees: ['a', 'a', 'b'], attempts: []},
  {id: 'r', input: 'Result', status: 'pending', assignees: ['a'], attempts: [{id: 'run', state: 'finished', outcome: 'reported_success', participants: ['a'], output: 'Saved result'}]},
], configuration: null, provider: 'test', model: null};
const teams: Team[] = [{id: 't0', name: 'Editors', members: ['a', 'missing']}, {id: 't1', name: 'Editors', members: ['a']}, {id: 'empty', name: 'Empty', members: []}];
const response = (data: unknown) => new Response(JSON.stringify(data));

test('rooms distinguish identities, shared membership, missing employees and recorded workload with keyboard navigation', async () => {
  const fetcher = vi.fn(async () => response({teams})); vi.stubGlobal('fetch', fetcher);
  const select = vi.fn(); const manage = vi.fn(); const user = userEvent.setup();
  const view = render(<TeamRooms workspace={workspace} connected selectedEmployee="a" onSelectEmployee={select} onOpenTeam={manage} />);
  await screen.findByText('Showing persisted team rooms.');
  const first = screen.getByRole('region', {name: 'Team room: Editors · ID: t0'});
  const second = screen.getByRole('region', {name: 'Team room: Editors · ID: t1'});
  for (const room of [first, second]) {
    expect(within(room).getByText(/Member workload: 2 assigned requests · 1 pending · 0 active · 1 results \(unverified\)/)).toBeTruthy();
  }
  expect(within(first).getByText('Unavailable employee · ID: missing')).toBeTruthy();
  expect(screen.getByText('No members yet.')).toBeTruthy();
  const member = within(second).getByRole('button', {name: /Select team member/});
  expect(member.getAttribute('aria-pressed')).toBe('true');
  member.focus(); await user.keyboard('{Enter}'); expect(select).toHaveBeenCalledWith('a');
  within(second).getByRole('button', {name: /Manage team/}).focus(); await user.keyboard(' ');
  expect(manage).toHaveBeenCalledWith('t1');
  view.rerender(<TeamRooms workspace={workspace} connected={false} selectedEmployee="a" onSelectEmployee={select} onOpenTeam={manage} />);
  expect(screen.getByText(/Team rooms are stale/)).toBeTruthy();
  expect(within(first).getByText(/Stale employee assignments/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('loading, initial failure, empty, refresh failure and removed rooms retain honest snapshot states', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetcher);
  const props = {workspace: null, connected: true, selectedEmployee: ''};
  const view = render(<TeamRooms {...props} />);
  expect(screen.getByText('Loading team rooms…')).toBeTruthy();
  await act(async () => resolve(new Response(JSON.stringify({error: 'offline'}), {status: 503})));
  expect(await screen.findByText(/Team rooms unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  await act(async () => resolve(response({teams: []})));
  expect(screen.getByText(/No team rooms yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  await act(async () => resolve(response({teams})));
  expect(screen.getAllByText('Employee data unavailable · ID: a')).toHaveLength(2);
  view.rerender(<TeamRooms {...props} workspace={workspace} />);
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  await act(async () => resolve(new Response('offline', {status: 503})));
  expect(screen.getByText(/Team rooms are stale/)).toBeTruthy();
  expect(screen.getByRole('region', {name: 'Team room: Editors · ID: t1'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  await act(async () => resolve(response({teams: []})));
  expect(screen.queryByRole('region', {name: 'Team room: Editors · ID: t1'})).toBeNull();
});

test('App opens exact team repeatedly, focuses selector and retains per-team and work drafts without mutations', async () => {
  let snapshot = teams;
  const fetcher = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === '/api/state') return response(workspace);
    if (path === '/api/teams') return response({teams: snapshot});
    if (path === '/api/config/v1/skills') return response({skills: []});
    if (path === '/api/config/v1/hooks') return response({hooks: []});
    if (path === '/api/config/v1/loops') return response({loops: []});
    if (path === '/api/loops/v1') return response({schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [], attempts: [], cancellation: ''});
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('button', {name: 'Manage team: Editors · ID: t1'});
  await waitFor(() => expect(within(screen.getByLabelText('Assign to')).getAllByRole('option')).toHaveLength(3));
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep work draft'}});
  fireEvent.change(screen.getByLabelText('Assign to'), {target: {value: 'b'}});
  const open = () => screen.getByRole('button', {name: 'Manage team: Editors · ID: t1'});
  open().focus(); await user.keyboard('{Enter}');
  await waitFor(() => expect((screen.getByLabelText('Saved team') as HTMLSelectElement).value).toBe('t1'));
  expect(document.activeElement).toBe(screen.getByLabelText('Saved team'));
  fireEvent.change(screen.getByLabelText('Team name'), {target: {value: 'Keep team draft'}});
  fireEvent.click(screen.getByLabelText('Alex · Employee ID: b'));
  await user.click(screen.getByRole('button', {name: 'Manage team: Editors · ID: t0'}));
  expect((screen.getByLabelText('Alex · Employee ID: b') as HTMLInputElement).checked).toBe(false);
  await user.click(open());
  expect((screen.getByLabelText('Alex · Employee ID: b') as HTMLInputElement).checked).toBe(true);
  await user.click(open());
  expect(document.activeElement).toBe(screen.getByLabelText('Saved team'));
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'hide everything'}});
  await user.click(screen.getByRole('button', {name: 'Select team member: Alex · ID: a · Team ID: t1'}));
  expect(document.activeElement).toBe(screen.getByLabelText('Search saved work'));
  expect(screen.getByText(/Assigned work for Alex · Employee ID: a/)).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Open request: Shared work · ID: w'})).toBeTruthy();
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep work draft');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('b');
  expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Keep team draft');
  expect((screen.getByLabelText('Alex · Employee ID: b') as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole('button', {name: 'Open configuration'}));
  await waitFor(() => expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Instructions'), {target: {value: 'Keep configuration draft'}});
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'exclude all'}});
  fireEvent.change(screen.getByLabelText('Current outcome'), {target: {value: 'failed'}});
  const card = screen.getByRole('button', {name: 'Open member assignment: Result · Task ID: r · Team ID: t1'});
  card.focus(); await user.keyboard(' ');
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('r');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved work'));
  expect((screen.getByLabelText('Search saved work') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Current outcome') as HTMLSelectElement).value).toBe('all');
  expect(screen.getByText('Showing work for all employees.')).toBeTruthy();
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('Keep configuration draft');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep work draft');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('b');
  expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Keep team draft');
  card.focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved work'));
  snapshot = teams.filter(team => team.id !== 't1');
  await user.click(screen.getByRole('button', {name: 'Refresh teams'}));
  expect(await screen.findByText(/The selected team is unavailable/)).toBeTruthy();
  // The room still has its earlier snapshot: opening it must retain the missing ID.
  await user.click(open());
  expect(document.activeElement).toBe(screen.getByLabelText('Saved team'));
  expect(screen.getByText(/The selected team is unavailable/)).toBeTruthy();
  snapshot = teams;
  await user.click(screen.getByRole('button', {name: 'Refresh teams'}));
  await screen.findByRole('button', {name: 'View member work: Alex · ID: a'});
  expect((screen.getByLabelText('Alex · Employee ID: b') as HTMLInputElement).checked).toBe(true);
  expect(fetcher.mock.calls.every(([path, options]) => options?.method === (path === '/api/state' ? 'POST' : 'GET'))).toBe(true);
});


test('invalid team responses show unavailable or preserve the last valid snapshot', async () => {
  let data: unknown = {};
  vi.stubGlobal('fetch', vi.fn(async () => response(data)));
  render(<TeamRooms workspace={workspace} connected selectedEmployee="" />);
  expect(await screen.findByText(/Team rooms unavailable/)).toBeTruthy();
  expect(screen.queryByText(/No team rooms yet/)).toBeNull();
  data = {teams};
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  await screen.findByRole('region', {name: 'Team room: Editors · ID: t1'});
  data = {teams: [{id: 'broken', name: 'Incomplete'}]};
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  expect(await screen.findByText(/Team rooms are stale/)).toBeTruthy();
  expect(screen.getByRole('region', {name: 'Team room: Editors · ID: t1'})).toBeTruthy();
});


test('assignment cards deduplicate Task identities, preserve shared attribution and navigate stale snapshots by keyboard', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({teams: [{id: 't', name: 'Room', members: ['a', 'b', 'missing']}, teams[1], teams[2]]})));
  const open = vi.fn(); const user = userEvent.setup();
  const data = {...workspace, work: [workspace.work[0], workspace.work[0], {...workspace.work[1], input: 'Shared work'}, {id: 'missing-work', input: 'Unavailable assignment', status: 'blocked', assignees: ['missing'], attempts: []}]} satisfies Workspace;
  const view = render(<TeamRooms workspace={data} connected selectedEmployee="" onOpenWork={open} />);
  const room = await screen.findByRole('region', {name: 'Team room: Room · ID: t'});
  const cards = within(room).getByRole('list', {name: 'Member assignments · Team ID: t'});
  expect(within(cards).getAllByRole('listitem')).toHaveLength(3);
  expect(within(cards).getByText('Assigned members in this room: Alex · ID: a; Alex · ID: b')).toBeTruthy();
  expect(within(cards).getByText('Assigned members in this room: Unavailable employee · ID: missing')).toBeTruthy();
  expect(within(cards).getByText('Recorded status: Result available · Unverified')).toBeTruthy();
  expect(within(cards).getByText('Recorded status: Blocked')).toBeTruthy();
  expect(screen.getByText('No saved work assigned to this room’s members.')).toBeTruthy();
  expect(screen.getAllByRole('button', {name: /Open member assignment: Shared work · Task ID: w/})).toHaveLength(2);
  const target = within(cards).getByRole('button', {name: 'Open member assignment: Shared work · Task ID: r · Team ID: t'});
  target.focus(); await user.keyboard('{Enter}'); expect(open).toHaveBeenLastCalledWith('r');
  view.rerender(<TeamRooms workspace={data} connected={false} selectedEmployee="" onOpenWork={open} />);
  expect(within(room).getByText(/Stale member assignments/)).toBeTruthy();
  expect(document.activeElement).toBe(target);
  await user.keyboard(' '); expect(open).toHaveBeenLastCalledWith('r');
  view.rerender(<TeamRooms workspace={{...data, work: []}} connected selectedEmployee="" onOpenWork={open} />);
  expect(within(room).queryByRole('list')).toBeNull();
  expect(within(room).getByText('No saved work assigned to this room’s members.')).toBeTruthy();
  view.rerender(<TeamRooms workspace={null} connected={false} selectedEmployee="" onOpenWork={open} />);
  expect(within(room).getByText(/Member assignments unavailable/)).toBeTruthy();
  expect(within(room).queryByText('No saved work assigned to this room’s members.')).toBeNull();
});

test.each([{snapshot: teams}, {snapshot: [] as Team[]}])('retained membership stays stale through reconnect and failed refresh (%j)', async ({snapshot}) => {
  const pending: Array<{resolve: (value: Response) => void}> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push({resolve}))));
  const props = {workspace, selectedEmployee: ''};
  const view = render(<TeamRooms {...props} connected={false} />);
  expect(screen.getByRole('status').textContent).toContain('Disconnected');
  await act(async () => pending[0].resolve(response({teams: snapshot})));
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
  view.rerender(<TeamRooms {...props} connected />);
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
  expect(screen.queryByText(/Stale member assignments/)).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
  await act(async () => pending[1].resolve(new Response('offline', {status: 503})));
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  await act(async () => pending[2].resolve(response({teams: snapshot})));
  expect(screen.getByRole('status').textContent).toContain(snapshot.length ? 'Showing persisted team rooms.' : 'No team rooms yet.');
  view.rerender(<TeamRooms {...props} connected={false} />);
  view.rerender(<TeamRooms {...props} connected />);
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
});

test.each(['success', 'failure'])('obsolete pre-disconnect %s cannot replace membership or finish the current refresh', async outcome => {
  const pending: Array<{resolve: (value: Response) => void; reject: (error: Error) => void}> = [];
  // Deliberately ignore AbortSignal: an obsolete transport may settle after recovery.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => pending.push({resolve, reject}))));
  const props = {workspace, selectedEmployee: ''};
  const view = render(<TeamRooms {...props} connected />);
  await act(async () => pending[0].resolve(response({teams})));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh team rooms'}));
  view.rerender(<TeamRooms {...props} connected={false} />);
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
  view.rerender(<TeamRooms {...props} connected />);
  const refresh = screen.getByRole('button', {name: 'Refresh team rooms'}) as HTMLButtonElement;
  expect(refresh.disabled).toBe(false);
  fireEvent.click(refresh);
  await act(async () => {
    if (outcome === 'success') pending[1].resolve(response({teams: []}));
    else pending[1].reject(new Error('Obsolete failure'));
  });
  expect(refresh.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('Team rooms are stale');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('region', {name: 'Team room: Editors · ID: t1'})).toBeTruthy();
  await act(async () => pending[2].resolve(response({teams: []})));
  expect(refresh.disabled).toBe(false);
  expect(screen.getByRole('status').textContent).toContain('No team rooms yet.');
  expect(screen.queryByRole('region', {name: 'Team room: Editors · ID: t1'})).toBeNull();
});
