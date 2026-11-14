import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { Workspace } from './api';
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
  expect(await screen.findByText('Hook devices are stale — showing the last successful snapshot.')).toBeTruthy();
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
  const chooser = screen.getByLabelText('Assigned work for Hook: Manual · Hook ID: one · Employee ID: a');
  const beforeChoice = fetcher.mock.calls.length;
  // A synchronous selection isolates this assertion from App's independent polling.
  // Native keyboard interaction is covered below with the standalone device panel.
  fireEvent.change(chooser, {target: {value: 'w'}});
  expect(fetcher.mock.calls.length).toBe(beforeChoice);
  const linked = screen.getByRole('button', {name: 'Open assigned work for Hook: Manual · Hook ID: one'});
  chooser.focus(); await userEvent.tab(); expect(document.activeElement).toBe(linked);
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'obstructing filter'}});
  linked.focus(); await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Hook inspection'}));
  expect(screen.getByRole('region', {name: 'Requested Hook inspection'}).textContent).toContain('Requested Task: w · Hook: one · Employee: a');
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
  const chooser = await screen.findByLabelText('Assigned work for Hook: Manual · Hook ID: duplicate · Employee ID: a');
  await userEvent.selectOptions(chooser, 'w');
  const choice = screen.getByRole('button', {name: 'Open assigned work for Hook: Manual · Hook ID: duplicate'});
  choice.focus(); await userEvent.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith({taskId: 'w', hookId: 'duplicate', employeeId: 'a'});
  expect(screen.getByText(/No saved work assigned/)).toBeTruthy();
  expect(screen.getAllByText(/Team and task-created Hooks remain configuration only/)).toHaveLength(2);
});

test('many assigned choices survive polling but assignment, disappearance and target changes require reselection', async () => {
  let saved = [hooks[0], {...hooks[0], id: 'duplicate'}];
  const fetcher = vi.fn(async () => new Response(JSON.stringify({hooks: saved})));
  vi.stubGlobal('fetch', fetcher);
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null,
    work: Array.from({length: 150}, (_, index) => ({id: `task-${index}`, input: 'Same name', status: 'pending', assignees: ['a', 'b'], attempts: []}))};
  workspace.work.push({id: 'other', input: 'Other employee only', status: 'pending', assignees: ['c'], attempts: []});
  const open = vi.fn();
  const view = render(<HookDevices workspace={workspace} onOpenWork={open} />);
  const chooser = await screen.findByLabelText('Assigned work for Hook: Manual · Hook ID: one · Employee ID: a') as HTMLSelectElement;
  const second = screen.getByLabelText('Assigned work for Hook: Manual · Hook ID: duplicate · Employee ID: a') as HTMLSelectElement;
  const action = screen.getByRole('button', {name: 'Open assigned work for Hook: Manual · Hook ID: one'}) as HTMLButtonElement;
  expect(chooser.options).toHaveLength(151);
  expect(chooser.options[150].textContent).toContain('Task ID: task-149');
  expect(action.disabled).toBe(true);
  expect(screen.getAllByRole('button', {name: /Open assigned work for Hook/})).toHaveLength(2);
  await userEvent.selectOptions(chooser, 'task-149');
  await userEvent.selectOptions(second, 'task-2');
  expect(fetcher).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
  view.rerender(<HookDevices workspace={{...workspace, work: [...workspace.work].reverse()}} onOpenWork={open} />);
  expect(chooser.value).toBe('task-149'); expect(second.value).toBe('task-2');
  const refresh = async () => {
    fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
    await screen.findByText('Showing saved Hook devices.');
  };
  saved = [...saved].reverse(); await refresh();
  expect(chooser.value).toBe('task-149'); expect(second.value).toBe('task-2');
  chooser.focus(); await userEvent.tab(); expect(document.activeElement).toBe(action);
  await userEvent.keyboard('{Enter}');
  expect(open.mock.calls).toEqual([[{taskId: 'task-149', hookId: 'one', employeeId: 'a'}]]);
  for (const change of ['assignment', 'disappearance']) {
    const work = change === 'assignment' ? workspace.work.map(item => item.id === 'task-149' ? {...item, assignees: ['b']} : item) : workspace.work.filter(item => item.id !== 'task-149');
    view.rerender(<HookDevices workspace={{...workspace, work}} onOpenWork={open} />);
    expect(chooser.value).toBe(''); expect(action.disabled).toBe(true);
    view.rerender(<HookDevices workspace={{...workspace}} onOpenWork={open} />);
    expect(chooser.value).toBe(''); expect(action.disabled).toBe(true);
    await userEvent.selectOptions(chooser, 'task-149');
  }
  saved = saved.map(hook => hook.id === 'one' ? {...hook, target_id: 'b'} : hook); await refresh();
  await screen.findByLabelText('Assigned work for Hook: Manual · Hook ID: one · Employee ID: b');
  expect(chooser.value).toBe(''); expect(action.disabled).toBe(true);
  // The target label commits before the effect clears the previous choice.
  expect(await screen.findByText(/Previously chosen work or employee target changed/)).toBeTruthy();
  await userEvent.selectOptions(chooser, 'task-149');
  action.focus(); await userEvent.keyboard(' ');
  expect(open).toHaveBeenLastCalledWith({taskId: 'task-149', hookId: 'one', employeeId: 'b'});
});

test('disconnected, refreshing and stale choices cannot navigate and recover without losing valid selection', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({hooks: [hooks[0]]})));
  vi.stubGlobal('fetch', fetcher);
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null,
    work: [{id: 'w', input: 'Saved', status: 'pending', assignees: ['a'], attempts: []}]};
  const open = vi.fn();
  const view = render(<HookDevices workspace={workspace} onOpenWork={open} />);
  const chooser = await screen.findByLabelText('Assigned work for Hook: Manual · Hook ID: one · Employee ID: a') as HTMLSelectElement;
  const action = screen.getByRole('button', {name: 'Open assigned work for Hook: Manual · Hook ID: one'}) as HTMLButtonElement;
  await userEvent.selectOptions(chooser, 'w');
  view.rerender(<HookDevices workspace={workspace} onOpenWork={open} connected={false} />);
  expect(screen.getByText(/Disconnected. Refresh connection before opening/)).toBeTruthy();
  expect(chooser.disabled).toBe(true); expect(action.disabled).toBe(true);
  fireEvent.click(action); expect(open).not.toHaveBeenCalled();
  view.rerender(<HookDevices workspace={workspace} onOpenWork={open} />);
  // A disclosure is not a new fetch or a new inspection-navigation guard.
  expect(screen.getByRole('status').textContent).toContain('Connection restored');
  expect(chooser.disabled).toBe(false); expect(action.disabled).toBe(false);
  expect(chooser.value).toBe('w');
  expect(fetcher).toHaveBeenCalledTimes(1);
  let reject!: (error: Error) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>((_, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  expect(screen.getByText(/Refreshing Hook devices. Wait/)).toBeTruthy();
  expect(action.disabled).toBe(true);
  reject(new Error('Offline'));
  await screen.findByText(/Hook devices are stale. Refresh Hook devices before opening/);
  expect(chooser.value).toBe('w'); expect(action.disabled).toBe(true);
  fireEvent.click(action); expect(open).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({hooks: [hooks[0]]})));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  await screen.findByText('Showing saved Hook devices.');
  expect(chooser.value).toBe('w'); expect(action.disabled).toBe(false);
  view.rerender(<HookDevices workspace={workspace} />);
  expect(screen.getByText('Assigned-work navigation is unavailable here.')).toBeTruthy();
  expect(action.disabled).toBe(true);
});


test('recorded Hook attempts use saved identity across work and retain focus and context through refresh', async () => {
  let configured = hooks;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({hooks: configured})));
  vi.stubGlobal('fetch', fetcher);
  const saved = {run_id: 'follow-up', preview_id: 'preview', hook_id: 'one', hook_name: 'Original Hook',
    event: 'run_failed', agent_id: 'former-employee', source_run_id: 'source', source_outcome: 'failure',
    skill_id: 'old-skill', skill_name: 'Original Skill', instructions: 'Saved instructions text', input: 'Saved effective text', admitted_at: 1};
  const attempt = {id: 'follow-up', state: 'active' as const, outcome: null, participants: [], hook: saved};
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null, work: [
    {id: 'task', input: 'Work', status: 'pending', assignees: [], attempts: [attempt,
      {...attempt, id: 'unrelated', hook: {...saved, hook_id: 'two'}, output: 'Other Hook output'},
      {id: 'direct', state: 'finished', outcome: 'success', participants: [], skill: saved, output: 'Direct Skill output'}]},
    {id: 'other-task', input: 'Same work name', status: 'pending', assignees: ['elsewhere'], attempts: [
      {...attempt, state: 'finished', outcome: 'failure', error: 'Saved timeout'}]},
  ]};
  const view = render(<HookDevices workspace={workspace} />);
  const button = await screen.findByRole('button', {name: 'Recorded attempts for Hook: Manual · Hook ID: one'});
  const user = userEvent.setup();
  const before = fetcher.mock.calls.length;
  button.focus(); await user.keyboard('{Enter}');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(button);
  expect(screen.getAllByRole('region', {name: /Recorded Hook attempt/})).toHaveLength(2);
  const region = screen.getByRole('region', {name: 'Recorded Hook attempt · Task task · Run follow-up'});
  for (const text of ['Saved Hook: Original Hook · Hook ID: one', 'Saved employee ID: former-employee',
    'Saved Skill: Original Skill · Skill ID: old-skill', 'Saved instructions text', 'Saved effective text',
    'Preview ID: preview · Provenance Run ID: follow-up', 'Quality unverified', 'No recorded output available.',
    'Source Run ID: source · Event: run_failed · Source outcome: failure']) {
    expect(within(region).getByText(text)).toBeTruthy();
  }
  expect(screen.getByText('Recorded error: Saved timeout')).toBeTruthy();
  expect(screen.queryByRole('region', {name: /Run unrelated/})).toBeNull();
  expect(screen.queryByText('Direct Skill output')).toBeNull();
  await user.keyboard(' '); expect(button.getAttribute('aria-expanded')).toBe('false');
  await user.keyboard(' '); expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(fetcher).toHaveBeenCalledTimes(before);
  const refreshed = {...workspace, work: workspace.work.map(work => ({...work, attempts: work.attempts.map(item =>
    item.id === 'follow-up' ? {...item, state: 'finished' as const, outcome: 'success', output: 'Updated saved output'} : item)}))};
  view.rerender(<HookDevices workspace={refreshed} />);
  expect(within(region).getByText('Updated saved output')).toBeTruthy();
  expect(within(region).getByText('Execution state: finished · Outcome: success')).toBeTruthy();
  expect(document.activeElement).toBe(button);
  configured = [hooks[1], {...hooks[0], name: 'Changed', enabled: false, target_kind: 'team', target_id: 'new-team', event: 'task_created', skill_id: 'new-skill'}];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  await screen.findByRole('button', {name: 'Recorded attempts for Hook: Changed · Hook ID: one'});
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(within(region).getByText('Saved employee ID: former-employee')).toBeTruthy();
  expect(within(region).getByText('Saved Skill: Original Skill · Skill ID: old-skill')).toBeTruthy();
  const second = screen.getByRole('button', {name: 'Recorded attempts for Hook: Manual · Hook ID: two'});
  second.focus(); await user.keyboard('{Enter}');
  expect(screen.getByRole('region', {name: 'Recorded Hook attempt · Task task · Run unrelated'})).toBeTruthy();
  expect(screen.getByText('Other Hook output')).toBeTruthy();
  view.rerender(<HookDevices workspace={refreshed} connected={false} />);
  expect(screen.getAllByText(/Disconnected — stale saved-work snapshot/)).toHaveLength(2);
  expect(within(region).getByText('Updated saved output')).toBeTruthy();
  view.rerender(<HookDevices workspace={{...workspace, work: []}} />);
  expect(screen.getAllByText(/No matching records in loaded history/)).toHaveLength(2);
  view.rerender(<HookDevices workspace={null} connected={false} />);
  expect(screen.getAllByText(/Workspace unavailable. Refresh connection/)).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(before + 1);
});

test('source disclosures inspect only the saved Run in the same Task and update from loaded history without requests', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({hooks})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const saved = {run_id: 'follow', preview_id: 'preview', hook_id: 'one', hook_name: 'Old name',
    event: 'run_failed', agent_id: 'a', source_run_id: 'source', source_outcome: 'failure',
    skill_id: 's', skill_name: 'Saved Skill', instructions: 'Saved instructions', input: 'Saved input', admitted_at: 1};
  const source = {id: 'source', state: 'finished' as const, outcome: 'failure', participants: [], output: 'Exact source output', error: 'Exact source error'};
  const follow = {id: 'follow', state: 'finished' as const, outcome: 'success', participants: [], output: 'Follow-up output', hook: saved};
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null, work: [
    {id: 'task', input: 'Work', status: 'pending', assignees: [], attempts: [source, follow,
      {...source, id: 'latest', output: 'Wrong latest output'},
      {...follow, id: 'second-follow', hook: {...saved, source_run_id: 'latest'}},
      {...follow, id: 'missing-follow', hook: {...saved, source_run_id: 'foreign'}}]},
    {id: 'other-task', input: 'Other', status: 'pending', assignees: [], attempts: [
      {...source, output: 'Wrong cross-Task output'}, {...source, id: 'foreign', output: 'Wrong foreign output'},
      {...follow, hook: {...saved, hook_id: 'two'}}]},
  ]};
  const view = render(<HookDevices workspace={workspace} onOpenWork={open} onOpenHook={open} />);
  const user = userEvent.setup();
  const outer = await screen.findByRole('button', {name: 'Recorded attempts for Hook: Manual · Hook ID: one'});
  const before = fetcher.mock.calls.length;
  outer.focus(); await user.keyboard('{Enter}');
  const region = screen.getByRole('region', {name: 'Recorded Hook attempt · Task task · Run follow'});
  const details = within(region).getByRole('button', {name: 'Source attempt details · Run ID: source'});
  details.focus(); await user.keyboard('{Enter}');
  expect(details.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(details);
  expect(within(region).getByText('Exact source output')).toBeTruthy();
  expect(within(region).getByText('Exact source error')).toBeTruthy();
  expect(within(region).getByText('Source execution state: finished · Outcome: failure')).toBeTruthy();
  expect(within(region).queryByText('Wrong latest output')).toBeNull();
  // Other collapsed Hooks retain their own source DOM; inspect this follow-up's boundary.
  expect(within(region).queryByText('Wrong cross-Task output')).toBeNull();
  await user.keyboard(' '); expect(details.getAttribute('aria-expanded')).toBe('false');
  await user.keyboard(' ');
  const second = screen.getByRole('region', {name: 'Recorded Hook attempt · Task task · Run second-follow'});
  fireEvent.click(within(second).getByRole('button', {name: /Source attempt details/}));
  expect(within(second).getByText('Wrong latest output')).toBeTruthy();
  const missing = screen.getByRole('region', {name: 'Recorded Hook attempt · Task task · Run missing-follow'});
  fireEvent.click(within(missing).getByRole('button', {name: /Source attempt details/}));
  expect(within(missing).getByText(/Source record missing from this Task/)).toBeTruthy();
  expect(within(missing).queryByText('Wrong foreign output')).toBeNull();
  const duplicate = screen.getByRole('button', {name: 'Recorded attempts for Hook: Manual · Hook ID: two'});
  fireEvent.click(duplicate);
  const other = screen.getByRole('region', {name: 'Recorded Hook attempt · Task other-task · Run follow'});
  fireEvent.click(within(other).getByRole('button', {name: /Source attempt details/}));
  expect(within(other).getByText('Wrong cross-Task output')).toBeTruthy();
  details.focus();
  const refreshed = {...workspace, work: workspace.work.map(work => work.id !== 'task' ? work : {...work,
    attempts: work.attempts.map(attempt => attempt.id !== 'source' ? attempt : {...attempt, output: 'Refreshed source output', error: null})})};
  view.rerender(<HookDevices workspace={refreshed} connected={false} />);
  expect(within(region).getByText('Refreshed source output')).toBeTruthy();
  expect(within(region).getByText('No recorded source error available.')).toBeTruthy();
  expect(screen.getAllByText(/Disconnected — stale saved-work snapshot/)).toHaveLength(2);
  expect(document.activeElement).toBe(details);
  expect(details.getAttribute('aria-expanded')).toBe('true');
  view.rerender(<HookDevices workspace={{...workspace, work: workspace.work.map(work => ({...work, attempts: work.attempts.filter(attempt => attempt.id !== 'source')}))}} />);
  expect(within(region).getByText(/Source record missing from this Task/)).toBeTruthy();
  expect(within(region).queryByText('Exact source output')).toBeNull();
  expect(document.activeElement).toBe(details);
  view.rerender(<HookDevices workspace={null} connected={false} />);
  expect(screen.getAllByText(/Workspace unavailable. Refresh connection/)).toHaveLength(2);
  expect(screen.queryByText(/Source record missing from this Task/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(before);
  expect(open).not.toHaveBeenCalled();
});


test('disconnected configuration stays explicit until a successful refresh, retaining cards and keyboard focus', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({hooks: hooks})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const user = userEvent.setup();
  const view = render(<HookDevices onOpenHook={open} connected />);
  const card = await screen.findByRole('button', {name: 'Open Hook device: Manual · ID: one'});
  card.focus();
  view.rerender(<HookDevices onOpenHook={open} connected={false} />);
  expect(screen.getByRole('status').textContent).toContain('Disconnected');
  expect(card.textContent).toContain('Disconnected — potentially stale configuration snapshot');
  expect(document.activeElement).toBe(card);
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('one');
  view.rerender(<HookDevices onOpenHook={open} connected />);
  expect(screen.getByRole('status').textContent).toContain('Connection restored');
  expect(card.textContent).toContain('Potentially stale configuration snapshot');
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRejectedValueOnce(new Error('Configuration refresh failed'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  await screen.findByRole('alert');
  view.rerender(<HookDevices onOpenHook={open} connected={false} />);
  view.rerender(<HookDevices onOpenHook={open} connected />);
  expect(screen.getByRole('alert').textContent).toBe('Configuration refresh failed');
  expect(fetcher).toHaveBeenCalledTimes(2);
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  expect(screen.getByRole('status').textContent).toContain('Loading Hook devices');
  expect(card.textContent).toContain('Refreshing snapshot');
  finish(new Response(JSON.stringify({hooks: hooks})));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Showing saved Hook devices.'));
  expect(card.textContent).not.toContain('stale');
});

test('empty and unavailable disconnected snapshots never claim current absence; reconnect during a pending fetch is not a refresh', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<HookDevices connected />);
  view.rerender(<HookDevices connected={false} />);
  expect(screen.getByRole('status').textContent).toContain('Disconnected');
  expect(screen.getByRole('status').textContent).toContain('Loading');
  view.rerender(<HookDevices connected />);
  finish(new Response('{"hooks":[]}'));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('snapshot was empty'));
  view.rerender(<HookDevices connected={false} />);
  expect(screen.getByRole('status').textContent).toContain('Disconnected');
  expect(screen.getByRole('status').textContent).toContain('snapshot was empty');
  view.rerender(<HookDevices connected />);
  expect(screen.queryByText(/No saved .* yet/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRejectedValueOnce(new Error('Refresh unavailable'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  await screen.findByRole('alert');
  view.unmount();
  fetcher.mockRejectedValueOnce(new Error('Initial configuration unavailable'));
  const unavailable = render(<HookDevices connected={false} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('status').textContent).toContain('Hook devices unavailable');
  expect(screen.getByRole('status').textContent).toContain('Disconnected');
  unavailable.rerender(<HookDevices connected />);
  expect(screen.getByRole('status').textContent).toContain('Hook devices unavailable');
  expect(screen.queryByText(/No saved .* yet/)).toBeNull();
});
