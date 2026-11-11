import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Configuration } from './Configuration';
import type { Workspace } from './api';
import type { ConfigurationRecord } from './configuration-api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workspace: Workspace = {employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Draft', status: 'pending', assignees: ['a'], attempts: []}], configuration: null, provider: 'test', model: null};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
function fixture() {
  const rows: Record<string, ConfigurationRecord[]> = {skills: [], hooks: [], loops: []};
  let offline = false;
  let rejectSave = false;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (offline) throw new Error('offline');
    if (path === '/api/teams') return response({teams: [{id: 't', name: 'Editors'}]});
    const [, , , , kind, id, enabled] = path.split('/');
    if (init.method === 'GET') return response({[kind]: rows[kind]});
    if (rejectSave) return response({error: 'Reference unavailable'}, 404);
    const body = JSON.parse(init.body as string);
    const saved = id ? {...rows[kind].find(item => item.id === id), ...body} : {...body, id: `${kind}-${rows[kind].length}`, enabled: false};
    rows[kind] = [...rows[kind].filter(item => item.id !== saved.id), saved];
    expect(init.method).toBe(id ? 'PUT' : 'POST');
    if (enabled) expect(Object.keys(body)).toEqual(['enabled']);
    return response(saved);
  });
  vi.stubGlobal('fetch', fetcher);
  return {rows, fetcher, offline: (value: boolean) => { offline = value; }, rejectSave: (value: boolean) => { rejectSave = value; }};
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), {target: {value}}); }
async function open() {
  fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
  await screen.findByText('Showing saved configuration.');
}
async function saved(kind: string) { await screen.findByText(`${kind} saved · ID: ${kind.toLowerCase()}s-0`); }
test('create, edit, toggle all types and inspect persisted IDs after remount without execution', async () => {
  const f = fixture(); const view = render(<StrictMode><Configuration workspace={workspace} /></StrictMode>); await open();
  expect(screen.getByText('No saved skills yet.')).toBeTruthy();
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(true);
  change('Name', 'Writer'); change('Instructions', 'Write clearly.');
  fireEvent.click(screen.getByRole('button', {name: 'Create Skill'})); await saved('Skill');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved record'));
  for (const kind of ['Skill', 'Hook', 'Loop']) {
    change('Record type', `${kind.toLowerCase()}s`);
    if (kind !== 'Skill') {
      change('Name', kind);
      if (kind === 'Hook') { change('Skill', 'skills-0'); change('Target type', 'team'); change('Target', 't'); change('Event', 'run_failed'); }
      else { change('Saved work', 'w'); change('Maximum iterations', '101'); expect((screen.getByRole('button', {name: 'Create Loop'}) as HTMLButtonElement).disabled).toBe(true); change('Maximum iterations', '3'); change('Interval seconds', '90'); }
      fireEvent.click(screen.getByRole('button', {name: `Create ${kind}`})); await saved(kind);
    }
    change('Name', `Edited ${kind}`);
    if (kind === 'Skill') change('Instructions', 'Revised instructions');
    if (kind === 'Hook') { change('Target type', 'agent'); change('Target', 'a'); change('Event', 'run_completed'); }
    if (kind === 'Loop') { change('Maximum iterations', '4'); change('Interval seconds', '120'); }
    fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(screen.getByLabelText('Saved values').textContent).toContain(`Edited ${kind}`));
    fireEvent.click(screen.getByRole('button', {name: 'Enable configuration'}));
    await screen.findByRole('button', {name: 'Disable configuration'});
    fireEvent.click(screen.getByRole('button', {name: 'Disable configuration'}));
    await screen.findByRole('button', {name: 'Enable configuration'});
  }
  view.unmount(); render(<Configuration workspace={workspace} />); await open();
  for (const kind of ['skills', 'hooks', 'loops']) {
    change('Record type', kind); change('Saved record', `${kind}-0`);
    const snapshot = JSON.parse(screen.getByLabelText('Saved values').textContent!);
    expect(snapshot).toEqual(f.rows[kind][0]); expect(snapshot.enabled).toBe(false);
  }
  expect(f.rows.skills[0]).toMatchObject({instructions: 'Revised instructions'});
  expect(f.rows.hooks[0]).toMatchObject({target_kind: 'agent', target_id: 'a', event: 'run_completed'});
  expect(f.rows.loops[0]).toMatchObject({max_iterations: 4, interval_seconds: 120});
  expect(f.fetcher.mock.calls.every(([path]) => path.startsWith('/api/config/v1/') || path === '/api/teams')).toBe(true);
});
test('failure preserves drafts and saved snapshot; refresh unlocks only explicit retry', async () => {
  const f = fixture(); render(<Configuration workspace={workspace} />); await open();
  change('Name', 'Keep draft'); change('Instructions', 'Keep instructions'); f.offline(true);
  fireEvent.click(screen.getByRole('button', {name: 'Create Skill'}));
  await screen.findByRole('alert'); expect(screen.getByText(/loaded values are stale/)).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Keep draft');
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(true);
  f.offline(false); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('Showing saved configuration.');
  expect(f.rows.skills).toEqual([]);
  change('Record type', 'loops'); change('Record type', 'skills');
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('Keep instructions');
  fireEvent.click(screen.getByRole('button', {name: 'Create Skill'})); await saved('Skill');
  change('Name', 'Unsaved edit'); f.rejectSave(true);
  fireEvent.click(screen.getByRole('button', {name: 'Save changes'})); await screen.findByRole('alert');
  expect(screen.getByLabelText('Saved values').textContent).toContain('Keep draft');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved edit');
  f.rejectSave(false); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('Showing saved configuration.');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved edit');
});
test('initial disconnected state recovers without inventing empty records', async () => {
  const f = fixture(); f.offline(true); render(<Configuration workspace={null} />);
  fireEvent.click(screen.getByRole('button', {name: 'Open configuration'})); await screen.findByRole('alert');
  expect(screen.queryByText('No saved skills yet.')).toBeNull();
  f.offline(false); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('No saved skills yet.');
});
test('loading is announced and never presented as empty', async () => {
  let resolve!: (value: Response) => void;
  fixture();
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => path.endsWith('/skills') ? new Promise<Response>(done => { resolve = done; }) : original(path, init)));
  render(<Configuration workspace={workspace} />); fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
  expect(screen.getByText('Loading or saving configuration…')).toBeTruthy(); expect(screen.queryByText('No saved skills yet.')).toBeNull();
  await act(async () => resolve(response({skills: []})));
  await screen.findByText('No saved skills yet.');
});

test('keyboard opens the labeled workspace and saves with focus returned to selection', async () => {
  fixture(); const user = userEvent.setup(); render(<Configuration workspace={workspace} />);
  await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Open configuration'}));
  await user.keyboard('{Enter}'); await screen.findByText('Showing saved configuration.');
  await user.click(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'Keyboard skill');
  await user.tab(); expect(document.activeElement).toBe(screen.getByLabelText('Instructions'));
  await user.keyboard('Use clear words.'); await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Create Skill'}));
  await user.keyboard('{Enter}'); await saved('Skill');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved record'));
});
