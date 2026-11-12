import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
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
  expect(await screen.findByText(/Skill books are stale/)).toBeTruthy();
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
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[]}');
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
