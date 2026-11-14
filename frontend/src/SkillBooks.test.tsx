import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { Workspace } from './api';
import { SkillBooks } from './SkillBooks';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const skills = [{id: 'one', name: 'Manual', instructions: 'First', enabled: true}, {id: 'two', name: 'Manual', instructions: 'Second', enabled: false}];

test('books show loading, duplicate identities, keyboard controls and stale snapshots', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const user = userEvent.setup();
  render(<SkillBooks onOpenSkill={open} />);
  expect(screen.getByText('Loading Skill books…')).toBeTruthy();
  finish(new Response(JSON.stringify({skills})));
  const first = await screen.findByRole('button', {name: 'Open Skill book: Manual · ID: one'});
  const second = screen.getByRole('button', {name: 'Open Skill book: Manual · ID: two'});
  expect(first.textContent).toContain('Configuration enabled');
  expect(second.textContent).toContain('Configuration disabled');
  first.focus(); await user.keyboard('{Enter}');
  second.focus(); await user.keyboard(' ');
  expect(open.mock.calls).toEqual([['one'], ['two']]);
  fetcher.mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  await waitFor(() => expect(screen.getByRole('status', {name: ''}).textContent).toBe('Skill books are stale — showing the last successful snapshot.'));
  expect(screen.getAllByText('Stale snapshot')).toHaveLength(2);
});

test('initial failure and successful empty refresh are distinct', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(new Response('{"skills":[]}'));
  vi.stubGlobal('fetch', fetcher);
  render(<SkillBooks onOpenSkill={vi.fn()} />);
  expect(await screen.findByText('Skill books unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  expect(await screen.findByText(/No saved Skills yet/)).toBeTruthy();
});

test('App opens exact IDs repeatedly, retains configuration and work drafts and handles removed records without mutations', async () => {
  let saved = [...skills];
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Saved work', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'deterministic-test', model: 'test'}));
    if (path === '/api/config/v1/skills') return new Response(JSON.stringify({skills: saved}));
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":""}');
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await screen.findByRole('button', {name: 'Open Skill book: Manual · ID: one'});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Work draft'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Skill book: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe('two'));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  fireEvent.change(screen.getByLabelText('Instructions'), {target: {value: 'Unsaved manual'}});
  fireEvent.click(screen.getByRole('button', {name: 'Open Skill book: Manual · ID: one'}));
  await waitFor(() => expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('First'));
  fireEvent.click(screen.getByRole('button', {name: 'Open Skill book: Manual · ID: two'}));
  await waitFor(() => expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('Unsaved manual'));
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Work draft');
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('w');
  fireEvent.click(screen.getByRole('button', {name: 'Open Skill book: Manual · ID: two'}));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Saved record')));
  saved = [skills[0]];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  expect(await screen.findByText(/Selected record unavailable · ID: two/)).toBeTruthy();
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('Unsaved manual');
  expect((screen.getByRole('button', {name: 'Save changes'}) as HTMLButtonElement).disabled).toBe(true);
  // State inspection uses POST; configuration book navigation uses GET only.
  for (const [path, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    if (path.startsWith('/api/config/')) expect(options.method).toBe('GET');
  }
});

test('Skill work navigation preserves drafts, clears filters and focuses inspection without MCP or mutations', async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Saved work', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'deterministic-test', model: 'test'}));
    if (path === '/api/config/v1/skills') return new Response(JSON.stringify({skills}));
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":""}');
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher); render(<App />);
  const chooser = await screen.findByLabelText('Saved work for Skill: Manual · Skill ID: two');
  const action = screen.getByRole('button', {name: 'Open saved work for Skill: Manual · Skill ID: two'});
  const beforeChoice = fetcher.mock.calls.length;
  chooser.focus();
  await userEvent.selectOptions(chooser, 'w');
  expect(document.activeElement).toBe(chooser);
  expect(fetcher.mock.calls.length).toBe(beforeChoice);
  await userEvent.tab();
  expect(document.activeElement).toBe(action);
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep draft'}});
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'excluded'}});
  action.focus(); await userEvent.keyboard('{Enter}');
  expect((screen.getByLabelText('Search saved work') as HTMLInputElement).value).toBe('');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Skill inspection'}));
  expect(screen.getByRole('region', {name: 'Requested Skill inspection'}).textContent).toContain('Skill: two');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep draft');
  action.focus(); await userEvent.keyboard(' ');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Skill inspection'}));
  expect(fetcher.mock.calls.every(([path]) => !path.includes('/connections/'))).toBe(true);
  expect(screen.queryByRole('button', {name: 'Find Skills through local MCP'})).toBeNull();
});


test('many saved Tasks retain exact per-book choices across polling and require a new choice after removal', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({skills})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const user = userEvent.setup();
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null,
    work: Array.from({length: 150}, (_, index) => ({id: `task-${index}`, input: 'Duplicate text', status: 'pending', assignees: [], attempts: []}))};
  const props = {onOpenWork: open, workspace};
  const view = render(<SkillBooks {...props} />);
  const first = await screen.findByLabelText('Saved work for Skill: Manual · Skill ID: one') as HTMLSelectElement;
  const second = screen.getByLabelText('Saved work for Skill: Manual · Skill ID: two') as HTMLSelectElement;
  const action = screen.getByRole('button', {name: 'Open saved work for Skill: Manual · Skill ID: two'}) as HTMLButtonElement;
  expect(action.disabled).toBe(true);
  expect(screen.getAllByRole('button', {name: /Open saved work for Skill/})).toHaveLength(2);
  expect(second.options).toHaveLength(151);
  await user.selectOptions(first, 'task-2');
  await user.selectOptions(second, 'task-149');
  expect(open).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  view.rerender(<SkillBooks {...props} workspace={{...workspace, work: [...workspace.work].reverse()}} />);
  expect(first.value).toBe('task-2'); expect(second.value).toBe('task-149');
  second.focus(); await user.tab(); expect(document.activeElement).toBe(action);
  await user.keyboard('{Enter}');
  expect(open.mock.calls).toEqual([[{taskId: 'task-149', skillId: 'two'}]]);
  view.rerender(<SkillBooks {...props} workspace={{...workspace, work: workspace.work.slice(0, 149)}} />);
  expect(second.value).toBe(''); expect(action.disabled).toBe(true);
  expect(screen.getByText(/Previously chosen work is no longer available/)).toBeTruthy();
  view.rerender(<SkillBooks {...props} workspace={{...workspace}} />);
  expect(second.value).toBe(''); expect(action.disabled).toBe(true);
  expect(first.value).toBe('task-2');
  await user.selectOptions(second, 'task-149');
  action.focus(); await user.keyboard(' ');
  expect(open).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('empty, disconnected, refreshing and stale snapshots explain unavailable Open actions', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({skills: [skills[0]]})));
  vi.stubGlobal('fetch', fetcher);
  const workspace: Workspace = {employees: [], work: [], configuration: null, provider: 'test', model: null};
  const open = vi.fn();
  const view = render(<SkillBooks workspace={workspace} onOpenWork={open} />);
  const chooser = await screen.findByLabelText('Saved work for Skill: Manual · Skill ID: one') as HTMLSelectElement;
  const action = screen.getByRole('button', {name: 'Open saved work for Skill: Manual · Skill ID: one'}) as HTMLButtonElement;
  expect(screen.getByText(/No saved work in the loaded history/)).toBeTruthy();
  expect(chooser.disabled).toBe(true); expect(action.disabled).toBe(true);
  workspace.work = [{id: 'w', input: 'Work', assignees: [], status: 'pending', attempts: []}];
  view.rerender(<SkillBooks workspace={{...workspace}} onOpenWork={open} />);
  fireEvent.change(chooser, {target: {value: 'w'}});
  view.rerender(<SkillBooks workspace={{...workspace}} connected={false} onOpenWork={open} />);
  expect(screen.getByText(/Disconnected. Refresh connection before opening/)).toBeTruthy();
  expect(action.disabled).toBe(true);
  view.rerender(<SkillBooks workspace={{...workspace}} onOpenWork={open} />);
  // A disclosure is not a new fetch or a new inspection-navigation guard.
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Connection restored');
  expect(chooser.disabled).toBe(false); expect(action.disabled).toBe(false);
  expect(chooser.value).toBe('w');
  expect(fetcher).toHaveBeenCalledTimes(1);
  let reject!: (error: Error) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>((_, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  expect(screen.getByText(/Refreshing Skill books. Wait/)).toBeTruthy();
  expect(action.disabled).toBe(true);
  reject(new Error('Offline'));
  expect(await screen.findByText(/Skill books are stale. Refresh Skill books before opening/)).toBeTruthy();
  expect(chooser.value).toBe('w'); expect(action.disabled).toBe(true);
  fireEvent.click(action); expect(open).not.toHaveBeenCalled();
});


test('recorded Skill disclosures match persisted IDs, preserve context and focus through refresh, and send no requests', async () => {
  let configured = skills;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({skills: configured})));
  vi.stubGlobal('fetch', fetcher);
  const saved = {run_id: 'direct', preview_id: 'saved-preview', skill_id: 'one', skill_name: 'Original manual', instructions: 'Original instructions', input: 'Original effective input', admitted_at: 1};
  const direct = {id: 'direct', state: 'active' as const, outcome: null, participants: [], skill: saved};
  const hook = {...saved, run_id: 'hook', hook_id: 'h', hook_name: 'Follow up', event: 'run_completed', agent_id: 'a', source_run_id: 'source', source_outcome: 'success'};
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null, work: [
    {id: 'task', input: 'Task input', status: 'pending', assignees: [], attempts: [direct,
      {id: 'hook', state: 'finished', outcome: 'failure', participants: [], hook, error: 'timeout'},
      {id: 'unrelated', state: 'finished', outcome: 'success', participants: [], skill: {...saved, skill_id: 'elsewhere', skill_name: 'Manual'}, output: 'Unrelated output'}]},
    {id: 'other-task', input: 'Other task', status: 'pending', assignees: [], attempts: [
      {...direct, id: 'both', skill: {...saved, run_id: 'both'}, hook: {...hook, run_id: 'both'}}]},
  ]};
  const view = render(<SkillBooks workspace={workspace} />);
  const button = await screen.findByRole('button', {name: 'Recorded use for Skill: Manual · Skill ID: one'});
  const user = userEvent.setup();
  const before = fetcher.mock.calls.length;
  button.focus(); await user.keyboard('{Enter}');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(button);
  expect(screen.getAllByRole('region', {name: /Recorded Skill use/})).toHaveLength(3);
  const directRegion = screen.getByRole('region', {name: 'Recorded Skill use · Task task · Run direct'});
  expect(within(directRegion).getByText('Original instructions')).toBeTruthy();
  expect(within(directRegion).getByText('Original effective input')).toBeTruthy();
  expect(within(directRegion).getByText(/Preview ID: saved-preview/)).toBeTruthy();
  expect(within(directRegion).getByText('Quality unverified')).toBeTruthy();
  expect(screen.getAllByText('Hook-backed Skill use')).toHaveLength(2);
  expect(screen.queryByText('Unrelated output')).toBeNull();
  expect(screen.queryByRole('region', {name: /Run unrelated/})).toBeNull();
  await user.keyboard(' '); expect(button.getAttribute('aria-expanded')).toBe('false');
  await user.keyboard(' '); expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(fetcher).toHaveBeenCalledTimes(before);
  const refreshed: Workspace = {...workspace, work: workspace.work.map(work => ({...work, attempts: work.attempts.map(attempt => attempt.id === 'direct' ? {...attempt, state: 'finished' as const, outcome: 'success', output: 'Fresh saved output'} : attempt)}))};
  view.rerender(<SkillBooks workspace={refreshed} />);
  expect(within(directRegion).getByText('Fresh saved output')).toBeTruthy();
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  configured = [{...skills[0], name: 'Edited manual', instructions: 'Rewritten configuration'}, skills[1]];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  await screen.findByRole('button', {name: 'Recorded use for Skill: Edited manual · Skill ID: one'});
  expect(document.activeElement).toBe(button);
  expect(within(directRegion).getByText('Original instructions')).toBeTruthy();
  expect(within(directRegion).queryByText('Rewritten configuration')).toBeNull();
  view.rerender(<SkillBooks workspace={refreshed} connected={false} />);
  expect(screen.getAllByText(/Disconnected — stale saved-work snapshot/).length).toBeGreaterThan(0);
  expect(within(directRegion).getByText('Fresh saved output')).toBeTruthy();
  view.rerender(<SkillBooks workspace={{...workspace, work: []}} />);
  expect(screen.getAllByText(/No matching records in loaded history/).length).toBeGreaterThan(0);
  view.rerender(<SkillBooks workspace={null} connected={false} />);
  expect(screen.getAllByText(/Workspace unavailable. Refresh connection/).length).toBeGreaterThan(0);
  expect(fetcher).toHaveBeenCalledTimes(before + 1);
});


test('disconnected configuration stays explicit until a successful refresh, retaining cards and keyboard focus', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({skills: skills})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const user = userEvent.setup();
  const view = render(<SkillBooks onOpenSkill={open} connected />);
  const card = await screen.findByRole('button', {name: 'Open Skill book: Manual · ID: one'});
  card.focus();
  view.rerender(<SkillBooks onOpenSkill={open} connected={false} />);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Disconnected');
  expect(card.textContent).toContain('Disconnected — potentially stale configuration snapshot');
  expect(document.activeElement).toBe(card);
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('one');
  view.rerender(<SkillBooks onOpenSkill={open} connected />);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Connection restored');
  expect(card.textContent).toContain('Potentially stale configuration snapshot');
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRejectedValueOnce(new Error('Configuration refresh failed'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  await screen.findByRole('alert');
  view.rerender(<SkillBooks onOpenSkill={open} connected={false} />);
  view.rerender(<SkillBooks onOpenSkill={open} connected />);
  expect(screen.getByRole('alert').textContent).toBe('Configuration refresh failed');
  expect(fetcher).toHaveBeenCalledTimes(2);
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Loading Skill books');
  expect(card.textContent).toContain('Refreshing snapshot');
  finish(new Response(JSON.stringify({skills: skills})));
  await waitFor(() => expect(screen.getByRole('status', {name: ''}).textContent).toBe('Showing saved Skill books.'));
  expect(card.textContent).not.toContain('stale');
});

test('empty and unavailable disconnected snapshots never claim current absence; reconnect during a pending fetch is not a refresh', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<SkillBooks connected />);
  view.rerender(<SkillBooks connected={false} />);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Disconnected');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Skill books unavailable');
  view.rerender(<SkillBooks connected />);
  finish(new Response('{"skills":[]}'));
  await waitFor(() => expect(screen.getByRole('status', {name: ''}).textContent).toContain('Skill books unavailable'));
  view.rerender(<SkillBooks connected={false} />);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Disconnected');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Skill books unavailable');
  view.rerender(<SkillBooks connected />);
  expect(screen.queryByText(/No saved .* yet/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRejectedValueOnce(new Error('Refresh unavailable'));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  await screen.findByRole('alert');
  view.unmount();
  fetcher.mockRejectedValueOnce(new Error('Initial configuration unavailable'));
  const unavailable = render(<SkillBooks connected={false} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Skill books unavailable');
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Disconnected');
  unavailable.rerender(<SkillBooks connected />);
  expect(screen.getByRole('status', {name: ''}).textContent).toContain('Skill books unavailable');
  expect(screen.queryByText(/No saved .* yet/)).toBeNull();
});


test('accepted card removals recover focus, including empty results; surviving and outside focus stay put', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const workspace: Workspace = {employees: [], configuration: null, provider: 'test', model: null,
    work: [{id: 'saved', input: 'Keep selection', status: 'pending', assignees: ['a'], attempts: []}]};
  render(<><input aria-label="Outside draft" defaultValue="Keep draft" /><SkillBooks workspace={workspace} onOpenWork={vi.fn()} onOpenSkill={vi.fn()} /></>);
  const respond = async (records: typeof skills) => {
    await act(async () => { finish(new Response(JSON.stringify({skills: records}))); });
  };
  await respond(skills);
  const chooser = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
  fireEvent.change(chooser, {target: {value: 'saved'}});
  const refresh = screen.getByRole('button', {name: 'Refresh Skill books'});
  const first = screen.getByRole('button', {name: 'Open Skill book: Manual · ID: one'});
  // Refresh without moving focus, then settle while the old card still owns focus.
  first.focus(); fireEvent.click(refresh);
  await respond([{...skills[1], name: 'Renamed'}, {...skills[0], name: 'Renamed'}]);
  expect(document.activeElement).toBe(first);
  expect(chooser.value).toBe('saved');
  expect(screen.getAllByRole('combobox')).toContain(chooser);
  first.focus(); fireEvent.click(refresh);
  await respond([{...skills[1], name: 'Renamed'}]);
  expect(document.activeElement).toBe(refresh);
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByLabelText('Skill books removals').getAttribute('aria-live')).toBe('polite');
  expect(screen.getByLabelText('Skill books removals').getAttribute('aria-atomic')).toBe('true');
  expect(screen.getByLabelText('Skill books removals').textContent).toContain('1 record removed');
  await userEvent.keyboard('{Tab}');
  const survivor = screen.getByRole('button', {name: 'Open Skill book: Renamed · ID: two'});
  expect(document.activeElement).toBe(survivor);
  fireEvent.click(refresh); await respond([]);
  expect(document.activeElement).toBe(refresh);
  expect(screen.getByLabelText('Skill books removals').textContent).toContain('No cards remain');
  fireEvent.click(refresh); await respond(skills);
  const outside = screen.getByRole('textbox', {name: 'Outside draft'});
  outside.focus(); fireEvent.click(refresh); await respond([skills[0]]);
  expect(document.activeElement).toBe(outside);
  expect((outside as HTMLInputElement).value).toBe('Keep draft');
  const remaining = screen.getByRole('button', {name: 'Open Skill book: Manual · ID: one'});
  remaining.focus(); fireEvent.click(refresh); await respond([{...skills[0], name: 'Final'}]);
  expect(document.activeElement).toBe(remaining);
  expect(screen.getByLabelText('Skill books removals').textContent).toBe('');
});

test.each([true, false])('failed and old-connection responses cannot override a newer refresh (old settles first: %s)', async oldFirst => {
  const pending: {resolve: (response: Response) => void; reject: (error: Error) => void}[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => pending.push({resolve, reject}))));
  const view = render(<SkillBooks onOpenSkill={vi.fn()} connected />);
  const respond = async (index: number, records: typeof skills) => {
    await act(async () => { pending[index].resolve(new Response(JSON.stringify({skills: records}))); });
  };
  await respond(0, skills);
  const refresh = screen.getByRole('button', {name: 'Refresh Skill books'});
  const first = screen.getByRole('button', {name: 'Open Skill book: Manual · ID: one'});
  first.focus(); fireEvent.click(refresh);
  await act(async () => { pending[1].reject(new Error('Offline')); });
  expect(document.activeElement).toBe(first);
  expect(screen.getByLabelText('Skill books removals').textContent).toBe('');
  fireEvent.click(refresh);
  view.rerender(<SkillBooks onOpenSkill={vi.fn()} connected={false} />);
  view.rerender(<SkillBooks onOpenSkill={vi.fn()} connected />);
  fireEvent.click(refresh);
  if (oldFirst) {
    await respond(2, []);
    expect(document.activeElement).toBe(first);
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Skill books removals').textContent).toBe('');
  }
  await respond(3, [{...skills[0], name: 'Current'}]);
  expect(document.activeElement).toBe(first);
  const current = screen.getByRole('button', {name: 'Open Skill book: Current · ID: one'});
  current.focus();
  if (!oldFirst) await respond(2, []);
  expect(document.activeElement).toBe(current);
  expect(screen.getByRole('button', {name: 'Open Skill book: Current · ID: one'})).toBe(current);
  expect(screen.getByLabelText('Skill books removals').textContent).toContain('1 record removed');
});
