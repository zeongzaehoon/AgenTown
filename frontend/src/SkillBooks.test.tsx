import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Skill books are stale — showing the last successful snapshot.'));
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
