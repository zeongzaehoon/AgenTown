import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Teams } from './Teams';
import type { Team, Workspace } from './api';

function leaveProtected() {
  const event = new Event('beforeunload', {cancelable: true});
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workspace: Workspace = {employees: [{id: 'a', name: 'Alex'}, {id: 'b', name: 'Alex'}], work: [], configuration: null, provider: 'test', model: null};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
function setup(initial: Team[] = []) {
  let teams = initial;
  let fail = false;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (fail) throw new TypeError('offline');
    if (init.method === 'GET') { expect(path).toBe('/api/teams'); expect(init.body).toBeUndefined(); return response({teams}); }
    const body = JSON.parse(init.body as string);
    if (path === '/api/teams') {
      const saved = {id: `t${teams.length}`, name: body.name, members: []};
      teams = [...teams, saved]; return response(saved, 201);
    }
    expect(path).toBe('/api/teams/t0/members');
    const saved = {...teams[0], members: body.members}; teams = [saved, ...teams.slice(1)]; return response(saved);
  });
  vi.stubGlobal('fetch', fetcher);
  const select = vi.fn();
  const view = render(<Teams workspace={workspace} connected onSelectEmployee={select} />);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  return {fetcher, select, view, fail: (value: boolean) => { fail = value; }};
}
test('create duplicate names, persist membership across remount, and navigate by employee ID without execution', async () => {
  const fixture = setup();
  await screen.findByText(/No teams yet/);
  for (let index = 0; index < 2; index++) {
    fireEvent.change(screen.getByLabelText('Team name'), {target: {value: 'Editors'}});
    fireEvent.submit(screen.getByLabelText('Team name').closest('form')!);
    await screen.findByText(`Team saved · ID: t${index}`);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved team')));
  }
  expect(screen.getByRole('option', {name: 'Editors · ID: t0'})).toBeTruthy();
  expect(screen.getByRole('option', {name: 'Editors · ID: t1'})).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Saved team'), {target: {value: 't0'}});
  fireEvent.click(screen.getByLabelText('Alex · Employee ID: b'));
  fireEvent.click(screen.getByRole('button', {name: 'Add members'}));
  await screen.findByText('Membership saved · Team ID: t0');
  expect(leaveProtected()).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'View member work: Alex · ID: b'}));
  expect(fixture.select).toHaveBeenCalledWith('b');
  fixture.view.unmount();
  render(<Teams workspace={workspace} connected onSelectEmployee={fixture.select} />);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  await screen.findByRole('button', {name: 'View member work: Alex · ID: b'});
  expect(fixture.fetcher.mock.calls.some(([path]) => path.includes('execute'))).toBe(false);
});
test('failed initial load recovers; stale snapshot retains name and per-team membership drafts', async () => {
  const fixture = setup([{id: 't0', name: 'Editors', members: []}, {id: 't1', name: 'Editors', members: []}]);
  await screen.findByText('Team ID: t0');
  expect(leaveProtected()).toBe(false);
  fireEvent.change(screen.getByLabelText('Team name'), {target: {value: 'Keep name'}});
  fireEvent.click(screen.getByLabelText('Alex · Employee ID: a'));
  fireEvent.change(screen.getByLabelText('Saved team'), {target: {value: 't1'}});
  fireEvent.change(screen.getByLabelText('Saved team'), {target: {value: 't0'}});
  expect((screen.getByLabelText('Alex · Employee ID: a') as HTMLInputElement).checked).toBe(true);
  fixture.fail(true);
  fireEvent.click(screen.getByRole('button', {name: 'Add members'}));
  await screen.findByRole('alert');
  expect(leaveProtected()).toBe(true);
  expect(screen.getByText(/Showing stale team data/)).toBeTruthy();
  expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Keep name');
  expect((screen.getByLabelText('Alex · Employee ID: a') as HTMLInputElement).checked).toBe(true);
  fixture.fail(false);
  fireEvent.click(screen.getByRole('button', {name: 'Refresh teams'}));
  await screen.findByText('Showing persisted teams.');
  expect((screen.getByLabelText('Alex · Employee ID: a') as HTMLInputElement).checked).toBe(true);
  fixture.view.unmount();
  fixture.fail(true);
  render(<Teams workspace={workspace} connected onSelectEmployee={fixture.select} />);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  await screen.findByText('Team data unavailable.');
  fixture.fail(false);
  fireEvent.click(screen.getByRole('button', {name: 'Refresh teams'}));
  await screen.findByText('Showing persisted teams.');
});
test('loading is distinct from empty and disconnect keeps loaded membership browsable', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const select = vi.fn();
  const view = render(<Teams workspace={workspace} connected onSelectEmployee={select} />);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  expect(screen.getByText('Loading or saving teams…')).toBeTruthy();
  expect(screen.queryByText(/No teams yet/)).toBeNull();
  await act(async () => resolve(response({teams: [{id: 't0', name: 'Editors', members: ['b', 'missing']}]})));
  view.rerender(<Teams workspace={workspace} connected={false} onSelectEmployee={select} />);
  expect(screen.getByText(/Showing stale team data/)).toBeTruthy();
  expect(screen.getByText('Unavailable employee · ID: missing')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'View member work: Alex · ID: b'}));
  expect(select).toHaveBeenCalledWith('b');
});

test('App team navigation preserves unsaved work, assignment and existing resend consent', async () => {
  const { App } = await import('./App');
  const state: Workspace = {...workspace, work: [{id: 'w', input: 'Original', status: 'pending', assignees: ['b'], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', participants: ['b'], output: 'Saved result'}]}]};
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/state') return response(state);
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/skills') {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return response({skills: []});
    }
    expect(path).toBe('/api/teams');
    return response({teams: [{id: 't', name: 'Editors', members: ['b']}]});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await screen.findByText('Saved result');
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Retained draft'}});
  fireEvent.change(screen.getByLabelText('Assign to'), {target: {value: 'a'}});
  // Saved history can render before the independent Loop availability check.
  // Wait for the same admission state a user needs before requesting consent.
  await waitFor(() => expect((screen.getByRole('button', {name: 'Retry explicitly'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', {name: 'Retry explicitly'}));
  expect(screen.getByRole('region', {name: 'Resend saved work?'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  fireEvent.click(await screen.findByRole('button', {name: 'View member work: Alex · ID: b'}));
  expect(document.activeElement).toBe(screen.getByLabelText('Search saved work'));
  expect(screen.getByRole('region', {name: 'Resend saved work?'})).toBeTruthy();
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Retained draft');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('a');
  expect(fetcher.mock.calls.every(([path]) => path === '/api/state' || path === '/api/teams' || (path === '/api/config/v1/skills' || path === '/api/config/v1/hooks' || path === '/api/config/v1/loops' || path === '/api/loops/v1'))).toBe(true);
});

for (const operation of ['create', 'members'] as const) {
  for (const invalid of ['malformed', 'unreadable', 'mismatched', 'incomplete', 'duplicate'] as const) {
    test(`${operation}: ${invalid} receipt retains confirmed data and drafts until explicit successful refresh`, async () => {
      const original = {id: 't0', name: 'Editors', members: ['missing']};
      let recovery: 'initial' | 'failed' | 'valid' = 'initial';
      let validSave = false;
      const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
        if (init.method === 'GET') {
          if (recovery === 'failed') return response({teams: [original, {...original, name: 'Corrupt replacement'}]});
          return response({teams: [original, {id: 't1', name: 'Editors', members: []}]});
        }
        const saved = operation === 'create' ? {id: 'new', name: 'New team', members: []} : {...original, members: ['missing', 'a']};
        if (validSave) return response(saved);
        if (invalid === 'unreadable') return new Response('{');
        if (invalid === 'malformed') return response({id: 1});
        if (invalid === 'mismatched') return response({...saved, name: 'Different', id: 'other'});
        if (invalid === 'incomplete') return response({...saved, members: ['a']});
        return response(operation === 'create' ? {...saved, id: 't0'} : {...saved, members: ['missing', 'a', 'a']});
      });
      vi.stubGlobal('fetch', fetcher);
      render(<Teams workspace={workspace} connected onSelectEmployee={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
      await screen.findByText('Team ID: t0');
  expect(leaveProtected()).toBe(false);
      fireEvent.change(screen.getByLabelText('Team name'), {target: {value: 'New team'}});
      fireEvent.click(screen.getByLabelText('Alex · Employee ID: a'));
      const submit = () => fireEvent.submit(screen.getByRole('button', {name: operation === 'create' ? 'Create team' : 'Add members'}).closest('form')!);
      submit(); submit();
      await screen.findByRole('alert');
  expect(leaveProtected()).toBe(true);
      expect(screen.getByRole('alert').textContent).toContain('nothing is automatically resent');
      const postCount = () => fetcher.mock.calls.filter(([, init]) => init.method === 'POST').length;
      expect(postCount()).toBe(1);
      expect(screen.queryByText(/Team saved ·|Membership saved ·/)).toBeNull();
      expect(screen.getByText('Unavailable employee · ID: missing')).toBeTruthy();
      expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('New team');
      expect((screen.getByLabelText('Alex · Employee ID: a') as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('button', {name: 'Create team'}) as HTMLButtonElement).disabled).toBe(true);
      submit(); expect(postCount()).toBe(1);
      fireEvent.change(screen.getByLabelText('Saved team'), {target: {value: 't1'}});
      fireEvent.change(screen.getByLabelText('Saved team'), {target: {value: 't0'}});
      expect((screen.getByLabelText('Alex · Employee ID: a') as HTMLInputElement).checked).toBe(true);
      recovery = 'failed';
      fireEvent.click(screen.getByRole('button', {name: 'Refresh teams'}));
      await screen.findByRole('alert');
  expect(leaveProtected()).toBe(true);
      await waitFor(() => expect((screen.getByRole('button', {name: 'Refresh teams'}) as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByText(/Corrupt replacement/)).toBeNull();
      submit(); expect(postCount()).toBe(1);
      recovery = 'valid';
      // Native keyboard activation exercises the enabled recovery control and submit flow.
      const user = (await import('@testing-library/user-event')).default.setup();
      screen.getByRole('button', {name: 'Refresh teams'}).focus();
      await user.keyboard('{Enter}');
      await screen.findByText('Showing persisted teams.');
      expect(postCount()).toBe(1);
      expect((screen.getByLabelText('Alex · Employee ID: a') as HTMLInputElement).checked).toBe(true);
      validSave = true;
      screen.getByRole('button', {name: operation === 'create' ? 'Create team' : 'Add members'}).focus();
      await user.keyboard('{Enter}');
      await screen.findByText(operation === 'create' ? 'Team saved · ID: new' : 'Membership saved · Team ID: t0');
      expect(postCount()).toBe(2);
      expect(leaveProtected()).toBe(true);
      expect(document.activeElement).toBe(screen.getByLabelText('Saved team'));
      if (operation === 'create') expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('');
      else expect(screen.getByText('Unavailable employee · ID: missing')).toBeTruthy();
    });
  }
}

test('invalid initial snapshot stays unavailable until explicit valid refresh', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({teams: [{id: 'broken', name: 'Editors'}]}))
    .mockResolvedValueOnce(response({teams: []}));
  vi.stubGlobal('fetch', fetcher);
  render(<Teams workspace={workspace} connected onSelectEmployee={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  await screen.findByText('Team data unavailable.');
  expect(screen.queryByRole('option', {name: /broken/})).toBeNull();
  fireEvent.change(screen.getByLabelText('Team name'), {target: {value: 'Retained'}});
  expect((screen.getByRole('button', {name: 'Create team'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'Refresh teams'}));
  await screen.findByText(/No teams yet/);
  expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Retained');
  expect(fetcher.mock.calls).toHaveLength(2);
});
