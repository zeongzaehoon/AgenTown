import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Configuration } from './Configuration';
import type { Workspace } from './api';
import type { ConfigurationRecord } from './configuration-api';
function leaveProtected() {
  const event = new Event('beforeunload', {cancelable: true});
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workspace: Workspace = {employees: [{id: 'a', name: 'Alex'}], work: [{id: 'w', input: 'Draft', status: 'pending', assignees: ['a'], attempts: []}], configuration: null, provider: 'test', model: null};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
function fixture() {
  const rows: Record<string, ConfigurationRecord[]> = {skills: [], hooks: [], loops: []};
  let offline = false;
  let transform: ((value: unknown, mutation: boolean, kind: string) => unknown) = value => value;
  let rejectSave = false;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (offline) throw new Error('offline');
    if (path === '/api/teams') return response({teams: [{id: 't', name: 'Editors', members: []}]});
    const [, , , , kind, id, enabled] = path.split('/');
    if (init.method === 'GET') return response(transform({[kind]: rows[kind]}, false, kind));
    if (rejectSave) return response({error: 'Reference unavailable'}, 404);
    const body = JSON.parse(init.body as string);
    if (typeof body.name === 'string') body.name = body.name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    const saved = id ? {...rows[kind].find(item => item.id === id), ...body} : {...body, id: `${kind}-${rows[kind].length}`, enabled: false};
    rows[kind] = [...rows[kind].filter(item => item.id !== saved.id), saved];
    expect(init.method).toBe(id ? 'PUT' : 'POST');
    if (enabled) expect(Object.keys(body)).toEqual(['enabled']);
    return response(transform(saved, true, kind));
  });
  vi.stubGlobal('fetch', fetcher);
  return {rows, fetcher, transform: (value: typeof transform) => { transform = value; }, offline: (value: boolean) => { offline = value; }, rejectSave: (value: boolean) => { rejectSave = value; }};
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), {target: {value}}); }
async function open() {
  fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
  await screen.findByText('Showing saved configuration.');
}
async function saved(kind: string) { await screen.findByText(`${kind} saved · ID: ${kind.toLowerCase()}s-0`); expect(leaveProtected()).toBe(false); }
test('create, edit, toggle all types and inspect persisted IDs after remount without execution', async () => {
  const f = fixture(); const view = render(<StrictMode><Configuration connected={true} workspace={workspace} /></StrictMode>); await open();
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
  view.unmount(); render(<Configuration connected={true} workspace={workspace} />); await open();
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
  const f = fixture(); render(<Configuration connected={true} workspace={workspace} />); await open();
  change('Name', 'Keep draft'); change('Instructions', 'Keep instructions'); f.offline(true);
  fireEvent.click(screen.getByRole('button', {name: 'Create Skill'}));
  await screen.findByRole('alert'); expect(leaveProtected()).toBe(true); expect(screen.getByText(/loaded values are stale/)).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Keep draft');
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(true);
  f.offline(false); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('Showing saved configuration.');
  expect(f.rows.skills).toEqual([]);
  fireEvent.click(screen.getByRole('button', {name: 'I inspected saved configuration'}));
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
  const f = fixture(); f.offline(true); render(<Configuration connected={true} workspace={null} />);
  fireEvent.click(screen.getByRole('button', {name: 'Open configuration'})); await screen.findByRole('alert');
  expect(screen.queryByText('No saved skills yet.')).toBeNull();
  f.offline(false); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('No saved skills yet.');
});
test('loading is announced and never presented as empty', async () => {
  let resolve!: (value: Response) => void;
  fixture();
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => path.endsWith('/skills') ? new Promise<Response>(done => { resolve = done; }) : original(path, init)));
  render(<Configuration connected={true} workspace={workspace} />); fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
  expect(screen.getByText('Loading or saving configuration…')).toBeTruthy(); expect(screen.queryByText('No saved skills yet.')).toBeNull();
  await act(async () => resolve(response({skills: []})));
  await screen.findByText('No saved skills yet.');
});

test('keyboard opens the labeled workspace and saves with focus returned to selection', async () => {
  fixture(); const user = userEvent.setup(); render(<Configuration connected={true} workspace={workspace} />);
  await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Open configuration'}));
  await user.keyboard('{Enter}'); await screen.findByText('Showing saved configuration.');
  await user.click(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'Keyboard skill');
  await user.tab(); expect(document.activeElement).toBe(screen.getByLabelText('Instructions'));
  await user.keyboard('Use clear words.'); await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Discard configuration draft'}));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Create Skill'}));
  await user.keyboard('{Enter}'); await saved('Skill');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved record'));
});

const savedRows: Record<string, ConfigurationRecord> = {
  skills: {id: 's', name: 'Saved Skill', enabled: false, instructions: 'Saved instructions'},
  hooks: {id: 'h', name: 'Saved Hook', enabled: false, skill_id: 's', target_kind: 'agent', target_id: 'a', event: 'task_created'},
  loops: {id: 'l', name: 'Saved Loop', enabled: false, task_id: 'w', max_iterations: 2, interval_seconds: 60},
};
const kinds = ['skills', 'hooks', 'loops'] as const;
function mutationCount(f: ReturnType<typeof fixture>) {
  return f.fetcher.mock.calls.filter(([, init]) => init.method !== 'GET').length;
}
function fillDraft(kind: typeof kinds[number]) {
  change('Name', 'Retained draft');
  if (kind === 'skills') change('Instructions', 'Retained instructions');
  if (kind === 'hooks') { change('Skill', 's'); change('Target', 'a'); }
  if (kind === 'loops') change('Saved work', 'w');
}
for (const kind of kinds) {
  for (const bad of [null, [], {[kind]: null}, {[kind]: [null]}, {[kind]: [{...savedRows[kind], enabled: "true"}]}, {[kind]: [savedRows[kind], savedRows[kind]]}]) {
    test(`${kind} malformed initial load is unavailable and recovers only on refresh: ${JSON.stringify(bad)}`, async () => {
      const f = fixture();
      f.transform((value, mutation, requested) => !mutation && requested === kind ? bad : value);
      render(<Configuration connected={true} workspace={workspace} />);
      fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
      await screen.findByRole('alert');
      expect(screen.queryByText('No saved skills yet.')).toBeNull();
      change('Record type', kind); fillDraft(kind);
      expect((screen.getByRole('button', {name: /^Create /}) as HTMLButtonElement).disabled).toBe(true);
      f.transform(value => value);
      fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
      await screen.findByText('Showing saved configuration.');
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
      expect(mutationCount(f)).toBe(0);
    });
  }
  test(`${kind} malformed refresh retains the complete snapshot, selections and drafts`, async () => {
    const f = fixture(); for (const key of kinds) f.rows[key] = [savedRows[key]];
    render(<Configuration connected={true} workspace={workspace} />); await open();
    for (const key of kinds) { change('Record type', key); change('Saved record', savedRows[key].id); fillDraft(key); }
    // Earlier valid lists in this response must not partially replace state.
    f.rows.skills = [{...savedRows.skills, name: 'Unexpected replacement'}];
    f.transform((value, mutation, requested) => !mutation && requested === kind ? {[kind]: [{}]} : value);
    fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByRole('alert');
    for (const key of kinds) {
      change('Record type', key);
      expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe(savedRows[key].id);
      expect(screen.getByLabelText('Saved values').textContent).toContain(savedRows[key].name);
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
      expect((screen.getByRole('button', {name: 'Save changes'}) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', {name: 'Enable configuration'}) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(mutationCount(f)).toBe(0);
  });
  for (const action of ['create', 'update', 'enable'] as const) {
    for (const invalid of ['null', 'array', 'fields', ...(action === 'create' ? [] : ['identity'])]) {
      test(`${kind} ${action} rejects ${invalid} response and requires keyboard refresh and explicit action`, async () => {
        const f = fixture(); for (const key of kinds) f.rows[key] = [savedRows[key]];
        const user = userEvent.setup(); render(<Configuration connected={true} workspace={workspace} />); await open();
        change('Record type', kind);
        if (action !== 'create') change('Saved record', savedRows[kind].id);
        fillDraft(kind);
        f.transform((value, mutation) => !mutation ? value : invalid === 'null' ? null
          : invalid === 'array' ? [] : invalid === 'identity' ? {...value as object, id: 'wrong-id'} : {...value as object, enabled: 'true'});
        const button = () => screen.getByRole('button', {name: action === 'create' ? /^Create / : action === 'update' ? 'Save changes' : 'Enable configuration'});
        fireEvent.click(button()); await screen.findByRole('alert');
        expect(screen.getByRole('alert').textContent).toContain('Nothing is automatically resent');
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
        expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe(action === 'create' ? '' : savedRows[kind].id);
        if (action !== 'create') expect(screen.getByLabelText('Saved values').textContent).toContain(savedRows[kind].name);
        expect((button() as HTMLButtonElement).disabled).toBe(true);
        expect(mutationCount(f)).toBe(1);
        f.transform(value => value);
        // Restore a confirmed disabled snapshot so recovery can explicitly enable.
        if (action === 'enable') f.rows[kind] = [savedRows[kind]];
        const refresh = screen.getByRole('button', {name: 'Refresh configuration'});
        refresh.focus(); await user.keyboard('{Enter}'); await screen.findByText('Showing saved configuration.');
        change('Record type', kind === 'skills' ? 'loops' : 'skills'); change('Record type', kind);
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
        expect(mutationCount(f)).toBe(1);
        screen.getByRole('button', {name: 'I inspected saved configuration'}).focus(); await user.keyboard('{Enter}');
        button().focus(); await user.keyboard('{Enter}');
        await screen.findByText(new RegExp(`${kind === 'skills' ? 'Skill' : kind === 'hooks' ? 'Hook' : 'Loop'} saved · ID:`));
        expect(mutationCount(f)).toBe(2);
        expect(leaveProtected()).toBe(action === 'enable');
        if (action !== 'enable') expect(document.activeElement).toBe(screen.getByLabelText('Saved record'));
      });
    }
  }
}

const contradictions = {
  skills: {name: 'Wrong name', instructions: 'Wrong instructions'},
  hooks: {name: 'Wrong name', skill_id: 'other-skill', target_kind: 'team', target_id: 't', event: 'run_failed'},
  loops: {name: 'Wrong name', task_id: 'other-work', max_iterations: 7, interval_seconds: 120},
};
for (const kind of kinds) {
  const label = kind === 'skills' ? 'Skill' : kind === 'hooks' ? 'Hook' : 'Loop';
  for (const action of ['create', 'update', 'enable', 'disable'] as const) {
    const cases = {...contradictions[kind], enabled: action === 'create' || action === 'disable', ...(action === 'create' ? {id: savedRows[kind].id} : {})};
    for (const [field, wrong] of Object.entries(cases)) {
      test(`${kind} ${action} rejects contradictory ${field}, retaining confirmed state until keyboard recovery`, async () => {
        const f = fixture();
        for (const key of kinds) f.rows[key] = [{...savedRows[key], enabled: action === 'disable' || action === 'update'}];
        const original = {...f.rows[kind][0]};
        const user = userEvent.setup(); render(<Configuration connected={true} workspace={workspace} />); await open();
        change('Record type', kind);
        if (action !== 'create') change('Saved record', original.id);
        fillDraft(kind);
        const buttonName = action === 'create' ? `Create ${label}` : action === 'update' ? 'Save changes'
          : action === 'enable' ? 'Enable configuration' : 'Disable configuration';
        f.transform((value, mutation) => mutation ? {...value as object, [field]: wrong} : value);
        fireEvent.click(screen.getByRole('button', {name: buttonName})); await screen.findByRole('alert');
        expect(leaveProtected()).toBe(true);
        expect(screen.queryByText(new RegExp(`${label} saved · ID:`))).toBeNull();
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
        expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe(action === 'create' ? '' : original.id);
        if (action !== 'create') expect(JSON.parse(screen.getByLabelText('Saved values').textContent!)).toEqual(original);
        expect((screen.getByRole('button', {name: buttonName}) as HTMLButtonElement).disabled).toBe(true);
        // A failed explicit refresh must not unlock any mutation or lose drafts.
        f.offline(true);
        screen.getByRole('button', {name: 'Refresh configuration'}).focus(); await user.keyboard('{Enter}');
        await screen.findByText(/offline.*Drafts retained/);
        expect((screen.getByRole('button', {name: buttonName}) as HTMLButtonElement).disabled).toBe(true);
        f.offline(false); f.transform(value => value);
        // Model inspection finding the original confirmed record after uncertain delivery.
        f.rows[kind] = [original];
        screen.getByRole('button', {name: 'Refresh configuration'}).focus(); await user.keyboard('{Enter}');
        await screen.findByText('Showing saved configuration.');
        expect(mutationCount(f)).toBe(1);
        change('Saved record', original.id);
        expect(JSON.parse(screen.getByLabelText('Saved values').textContent!)).toEqual(original);
        if (action === 'create') change('Saved record', '');
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
        screen.getByRole('button', {name: 'I inspected saved configuration'}).focus(); await user.keyboard('{Enter}');
        screen.getByRole('button', {name: buttonName}).focus(); await user.keyboard('{Enter}');
        await screen.findByText(new RegExp(`${label} saved · ID:`));
        expect(mutationCount(f)).toBe(2);
        expect(leaveProtected()).toBe(action === 'enable' || action === 'disable');
      });
    }
  }
  test(`${kind} accepts Rust-normalized names, preserves enabled edits and exact instruction whitespace`, async () => {
    const f = fixture(); for (const key of kinds) f.rows[key] = [savedRows[key]];
    render(<Configuration connected={true} workspace={workspace} />); await open(); change('Record type', kind); fillDraft(kind);
    change('Name', '\u0085  Normalized name \u2003');
    if (kind === 'skills') change('Instructions', '  Keep whitespace\n');
    fireEvent.click(screen.getByRole('button', {name: `Create ${label}`}));
    await screen.findByText(new RegExp(`${label} saved · ID:`));
    expect(JSON.parse(screen.getByLabelText('Saved values').textContent!).name).toBe('Normalized name');
    if (kind === 'skills') expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('  Keep whitespace\n');
    fireEvent.click(screen.getByRole('button', {name: 'Enable configuration'}));
    await screen.findByRole('button', {name: 'Disable configuration'});
    change('Name', '  Enabled edit  '); fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(JSON.parse(screen.getByLabelText('Saved values').textContent!)).toMatchObject({name: 'Enabled edit', enabled: true}));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Enabled edit');
  });
}

for (const kind of kinds) {
  const label = kind === 'skills' ? 'Skill' : kind === 'hooks' ? 'Hook' : 'Loop';
  for (const action of ['create', 'update', 'enable', 'disable'] as const) {
    for (const failure of ['missing', 'contradictory', 'malformed', 'failed'] as const) {
      test(`${kind} ${action} retains drafts and confirmed state on ${failure} persisted confirmation`, async () => {
        const f = fixture();
        for (const type of kinds) f.rows[type] = [{...savedRows[type], enabled: action === 'disable'}];
        const original = {...f.rows[kind][0]};
        const user = userEvent.setup(); render(<Configuration connected={true} workspace={workspace} />); await open();
        // Keep an unrelated record draft throughout confirmation and recovery.
        const other = kind === 'skills' ? 'hooks' : 'skills';
        change('Record type', other); fillDraft(other);
        change('Record type', kind);
        if (action !== 'create') change('Saved record', original.id);
        fillDraft(kind);
        const buttonName = action === 'create' ? `Create ${label}` : action === 'update' ? 'Save changes'
          : action === 'enable' ? 'Enable configuration' : 'Disable configuration';
        f.transform((value, mutation, requested) => {
          if (mutation || requested !== kind) return value;
          if (failure === 'failed') throw new Error('confirmation unavailable');
          const rows = (value as Record<string, ConfigurationRecord[]>)[kind];
          return {[kind]: failure === 'missing' ? [] : failure === 'malformed' ? [{}]
            : rows.map(row => ({...row, enabled: !row.enabled}))};
        });
        fireEvent.click(screen.getByRole('button', {name: buttonName}));
        await screen.findByRole('alert');
        expect(screen.getByRole('alert').textContent).toContain('Delivery is uncertain');
        expect(screen.queryByText(new RegExp(`${label} saved · ID:`))).toBeNull();
        expect(leaveProtected()).toBe(true);
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
        if (action !== 'create') expect(JSON.parse(screen.getByLabelText('Saved values').textContent!)).toEqual(original);
        expect(mutationCount(f)).toBe(1);
        const inspect = () => screen.getByRole('button', {name: 'I inspected saved configuration'}) as HTMLButtonElement;
        expect(inspect().disabled).toBe(true);
        // Failed explicit refresh cannot enable inspection.
        f.offline(true); screen.getByRole('button', {name: 'Refresh configuration'}).focus(); await user.keyboard('{Enter}');
        await screen.findByText(/offline.*Drafts retained/); expect(inspect().disabled).toBe(true);
        f.offline(false); f.transform(value => value); f.rows[kind] = [original];
        screen.getByRole('button', {name: 'Refresh configuration'}).focus(); await user.keyboard('{Enter}');
        await screen.findByText('Showing saved configuration.');
        expect((screen.getByRole('button', {name: buttonName}) as HTMLButtonElement).disabled).toBe(true);
        change('Saved record', original.id);
        expect(JSON.parse(screen.getByLabelText('Saved values').textContent!)).toEqual(original);
        if (action === 'create') change('Saved record', '');
        inspect().focus(); await user.keyboard('{Enter}');
        expect(mutationCount(f)).toBe(1);
        screen.getByRole('button', {name: buttonName}).focus(); await user.keyboard('{Enter}');
        await screen.findByText(new RegExp(`${label} saved · ID:`)); expect(mutationCount(f)).toBe(2);
        change('Record type', other);
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
        expect(leaveProtected()).toBe(true);
      });
    }
    test(`${kind} ${action} waits for persisted confirmation and blocks duplicate submission`, async () => {
      const f = fixture(); for (const type of kinds) f.rows[type] = [{...savedRows[type], enabled: action === 'disable'}];
      render(<Configuration connected={true} workspace={workspace} />); await open(); change('Record type', kind);
      if (action !== 'create') change('Saved record', savedRows[kind].id);
      fillDraft(kind);
      let release!: () => void;
      const originalFetch = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
        if (path === `/api/config/v1/${kind}` && init.method === 'GET') await new Promise<void>(resolve => { release = resolve; });
        return originalFetch(path, init);
      }));
      const buttonName = action === 'create' ? `Create ${label}` : action === 'update' ? 'Save changes'
        : action === 'enable' ? 'Enable configuration' : 'Disable configuration';
      const button = screen.getByRole('button', {name: buttonName});
      fireEvent.click(button); await waitFor(() => expect(release).toBeTypeOf('function'));
      expect(screen.queryByText(new RegExp(`${label} saved · ID:`))).toBeNull();
      expect(leaveProtected()).toBe(true);
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Retained draft');
      if (action !== 'create') expect(JSON.parse(screen.getByLabelText('Saved values').textContent!)).toEqual({...savedRows[kind], enabled: action === 'disable'});
      fireEvent.click(button); expect(mutationCount(f)).toBe(1);
      await act(async () => release()); await screen.findByText(new RegExp(`${label} saved · ID:`));
      expect(mutationCount(f)).toBe(1);
      expect(leaveProtected()).toBe(action === 'enable' || action === 'disable');
    });
  }
}

test.each(['skills', 'hooks', 'loops'] as const)('%s saved snapshot and focused draft survive disconnect; only a connected refresh unlocks', async kind => {
  const f = fixture();
  const records: Record<string, ConfigurationRecord> = {
    skills: {id: 's', name: 'Writer', instructions: 'Saved instructions', enabled: false},
    hooks: {id: 'h', name: 'Hook', skill_id: 's', target_kind: 'agent', target_id: 'a', event: 'task_created', enabled: false},
    loops: {id: 'l', name: 'Loop', task_id: 'w', max_iterations: 2, interval_seconds: 60, enabled: false},
  };
  for (const type of ['skills', 'hooks', 'loops'] as const) f.rows[type].push(records[type]);
  const view = render(<Configuration connected={true} workspace={workspace} />); await open();
  change('Record type', kind); change('Saved record', records[kind].id); change('Name', 'Retained draft');
  const name = screen.getByLabelText('Name'); name.focus();
  const snapshot = screen.getByLabelText('Saved values').textContent;
  const mutations = () => f.fetcher.mock.calls.filter(([, init]) => init.method !== 'GET').length;
  const before = mutations();
  view.rerender(<Configuration connected={false} workspace={workspace} />);
  expect(document.activeElement).toBe(name);
  expect(screen.getByLabelText('Saved values').textContent).toBe(snapshot);
  expect((name as HTMLInputElement).value).toBe('Retained draft');
  fireEvent.submit(name.closest('form')!);
  fireEvent.click(screen.getByRole('button', {name: 'Enable configuration'}));
  view.rerender(<Configuration connected={true} workspace={workspace} />);
  expect(screen.getByText(/saved values may be stale/)).toBeTruthy();
  expect((screen.getByRole('button', {name: 'Save changes'}) as HTMLButtonElement).disabled).toBe(true);
  f.offline(true); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByRole('alert');
  expect(screen.getByText(/saved values may be stale/)).toBeTruthy();
  fireEvent.submit(name.closest('form')!); expect(mutations()).toBe(before);
  f.offline(false); fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  await screen.findByText('Showing saved configuration.');
  expect((screen.getByRole('button', {name: 'Save changes'}) as HTMLButtonElement).disabled).toBe(false);
  expect((name as HTMLInputElement).value).toBe('Retained draft');
  expect(mutations()).toBe(before);
});

test.each([false, true])('late refresh across disconnection cannot unlock an empty snapshot (reconnect before response: %s)', async reconnectEarly => {
  const f = fixture(); const view = render(<Configuration connected={true} workspace={workspace} />); await open();
  change('Name', 'Draft'); change('Instructions', 'Keep');
  const original = f.fetcher.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.fetcher.mockImplementation(async (path, init) => { await pending; return original(path, init); });
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'}));
  view.rerender(<Configuration connected={false} workspace={workspace} />);
  if (reconnectEarly) view.rerender(<Configuration connected={true} workspace={workspace} />);
  await act(async () => { release(); await pending; });
  if (!reconnectEarly) view.rerender(<Configuration connected={true} workspace={workspace} />);
  expect(screen.getByText(/saved values may be stale/)).toBeTruthy();
  expect(screen.getByText('No saved skills yet.')).toBeTruthy();
  fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
  expect(f.fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(true);
  f.fetcher.mockImplementation(original);
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('Showing saved configuration.');
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(false);
});

test('save response spanning disconnection keeps the draft and requires refresh plus inspection', async () => {
  const f = fixture(); const view = render(<Configuration connected={true} workspace={workspace} />); await open();
  change('Name', 'Uncertain'); change('Instructions', 'Retain me');
  const original = f.fetcher.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.fetcher.mockImplementation(async (path, init) => {
    const result = await original(path, init);
    if (init.method !== 'GET') await pending;
    return result;
  });
  fireEvent.click(screen.getByRole('button', {name: 'Create Skill'}));
  view.rerender(<Configuration connected={false} workspace={workspace} />);
  view.rerender(<Configuration connected={true} workspace={workspace} />);
  await act(async () => { release(); await pending; });
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Uncertain');
  expect(screen.queryByText(/Skill saved · ID/)).toBeNull();
  f.fetcher.mockImplementation(original);
  fireEvent.click(screen.getByRole('button', {name: 'Refresh configuration'})); await screen.findByText('Showing saved configuration.');
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'I inspected saved configuration'}));
  expect((screen.getByRole('button', {name: 'Create Skill'}) as HTMLButtonElement).disabled).toBe(false);
  expect(f.fetcher.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
});
