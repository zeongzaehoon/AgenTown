import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { Workspace } from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const initial = (): Workspace => ({employees: [], work: [], configuration: null, provider: 'deterministic-test', model: 'test-model'});
function fixture(state = initial()) {
  let disconnected = false;
  let finish: (() => void) | undefined;
  const calls: {path: string; body: Record<string, unknown>}[] = [];
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    calls.push({path, body});
    if (disconnected) throw new TypeError('network');
    if (path === '/api/state') return new Response(JSON.stringify(state));
    if (path === '/api/employees') {
      state.employees.push({id: 'employee-1', name: body.name as string});
      return new Response(JSON.stringify({id: 'employee-1'}));
    }
    if (path === '/api/work') {
      state.work.push({id: 'work-1', input: body.input as string, status: 'pending', assignees: [body.employee as string], attempts: []});
      return new Response(JSON.stringify({id: 'work-1'}));
    }
    if (path.endsWith('/execute')) {
      const attempts = state.work[0].attempts;
      expect(body.expected_runs).toBe(attempts.length);
      const attempt = {id: `run-${attempts.length}`, state: 'active' as const, outcome: null, started: attempts.length, participants: ['employee-1'], provider: state.provider, model: state.model!};
      attempts.push(attempt);
      await new Promise<void>(resolve => { finish = () => {
        Object.assign(attempt, attempts.length === 1 ? {state: 'finished', outcome: 'failure', error: 'rate_limit'} : {state: 'finished', outcome: 'reported_success', output: '<script>unsafe()</script> FULL RESULT', quality: 'unverified'});
        resolve();
      }; });
      return new Response('{}');
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return {state, calls, finish: () => finish!(), disconnect: () => {disconnected = true;}, reconnect: () => {disconnected = false;}};
}
const refresh = () => fireEvent.click(screen.getByRole('button', {name: 'Refresh connection'}));
const connected = () => waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Connected'));

test('StrictMode employee → saved work → running → failure → explicit retry → full safe result and reload', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const view = render(<StrictMode><App /></StrictMode>);
  await connected();
  expect(screen.getByText('No work yet. Your saved work and results will appear here.')).toBeTruthy();
  // Paste full values so this broad flow does not spend its deadline on
  // per-character renders when the supervisor runs test files concurrently.
  screen.getByLabelText('Employee name').focus();
  await user.paste('<img src=x> Writer');
  act(() => { screen.getByRole('button', {name: 'Create employee'}).click(); screen.getByRole('button', {name: 'Create employee'}).click(); });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('What would you like help with?')));
  expect(f.calls.filter(c => c.path === '/api/employees')).toHaveLength(1);
  await user.paste('Summarize the plan');
  act(() => { screen.getByRole('button', {name: 'Save work'}).click(); screen.getByRole('button', {name: 'Save work'}).click(); });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Execute work'})));
  expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(1);
  await user.keyboard('{Enter}');
  refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Running'));
  expect((screen.getByRole('button', {name: 'Retry explicitly'}) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => f.finish());
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Failed'));
  expect(screen.getByText('Wait for provider capacity, then retry explicitly.')).toBeTruthy();
  act(() => { screen.getByRole('button', {name: 'Retry explicitly'}).click(); screen.getByRole('button', {name: 'Retry explicitly'}).click(); });
  await act(async () => f.finish());
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Result available · Unverified'));
  expect(screen.getByText('<script>unsafe()</script> FULL RESULT')).toBeTruthy();
  expect(document.querySelector('#detail script, #employees img')).toBeNull();
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(2);
  view.unmount();
  render(<StrictMode><App /></StrictMode>);
  await connected();
  refresh(); await connected();
  expect(screen.getByText('<script>unsafe()</script> FULL RESULT')).toBeTruthy();
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(2);
});

test('disconnect retains history and draft, disables mutations, reconnect never resends', async () => {
  const f = fixture({ ...initial(), employees: [{id: 'e', name: 'Writer'}], work: [{id: 'w', input: 'Saved text', status: 'pending', assignees: ['e'], attempts: []}] });
  render(<App />); await connected();
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Unsaved draft'}});
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  expect(screen.getByText('Saved text', {selector: 'pre'})).toBeTruthy();
  for (const name of ['Create employee', 'Save work', 'Execute work']) expect((screen.getByRole('button', {name}) as HTMLButtonElement).disabled).toBe(true);
  f.reconnect(); refresh(); await connected();
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Unsaved draft');
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('configuration and interrupted history remain actionable without automatic execution', async () => {
  const f = fixture({...initial(), configuration: 'Set ANTHROPIC_API_KEY and --model, then restart.', employees: [{id: 'e', name: 'Writer'}], work: [{id: 'w', input: 'Text', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state: 'finished', outcome: 'interruption', error: 'interrupted', started: 1, participants: ['e']}]}]});
  render(<StrictMode><App /></StrictMode>); await connected();
  expect(document.querySelector('#connection')!.textContent).toContain('Interrupted');
  expect(screen.getByText(/No automatic resend occurred/)).toBeTruthy();
  expect((screen.getByRole('button', {name: 'Retry explicitly'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Set ANTHROPIC_API_KEY/, {selector: '#configuration'})).toBeTruthy();
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('superseded snapshot cannot replace refreshed history', async () => {
  let resolveOld!: (value: Response) => void;
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(() => ++count === 1 ? new Promise<Response>(resolve => {resolveOld = resolve;}) : Promise.resolve(new Response(JSON.stringify({...initial(), employees: [{id: 'new', name: 'Newest employee'}]})))));
  render(<App />);
  refresh(); await connected();
  await act(async () => resolveOld(new Response(JSON.stringify(initial()))));
  expect(screen.getByText('Newest employee', {selector: 'li'})).toBeTruthy();
});

test('polling and remount of an active attempt only inspect history', async () => {
  const f = fixture({...initial(), employees: [{id: 'e', name: 'Writer'}], work: [{id: 'w', input: 'Outstanding request', status: 'in_progress', assignees: ['e'], attempts: [{id: 'r', state: 'active', outcome: null, started: 1, participants: ['e'], provider: 'deterministic-test'}]}]});
  const view = render(<StrictMode><App /></StrictMode>); await connected();
  expect(document.querySelector('#connection')!.textContent).toContain('Running');
  const before = f.calls.length;
  await waitFor(() => expect(f.calls.length).toBeGreaterThan(before), {timeout: 2000});
  view.unmount(); render(<StrictMode><App /></StrictMode>); await connected();
  expect((screen.getByRole('button', {name: 'Retry explicitly'}) as HTMLButtonElement).disabled).toBe(true);
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('uncertain save delivery refreshes history and never replays a save', async () => {
  const state = initial();
  let saves = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/employees') {
      ++saves; state.employees.push({id: 'e', name: 'Saved despite lost response'});
      throw new TypeError('connection lost after commit');
    }
    expect(path).toBe('/api/state');
    return new Response(JSON.stringify(state));
  }));
  render(<App />); await connected();
  fireEvent.change(screen.getByLabelText('Employee name'), {target: {value: 'Saved despite lost response'}});
  fireEvent.click(screen.getByRole('button', {name: 'Create employee'}));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('may have been saved or sent'));
  expect(await screen.findByText('Saved despite lost response', {selector: 'li'})).toBeTruthy();
  refresh(); await connected();
  expect(saves).toBe(1);
});

const outputs = ['  한글 😀\r\n\t<script>unsafe()</script> & <b>literal</b>\n' + 'long text '.repeat(2000) + '\n  END  ', 'Second historical response\n\t終わり  '];
function savedResults() {
  return fixture({...initial(), employees: [{id: 'e', name: 'Writer'}], work: [{id: 'w', input: 'Text', status: 'pending', assignees: ['e'], attempts: outputs.map((output, i) => ({id: `run-${i}`, state: 'finished', outcome: 'reported_success', started: i, participants: ['e'], output, provider: 'deterministic-test', quality: 'unverified'}))}]});
}
function resultActions(number: number) {
  return within(screen.getByRole('group', {name: `Attempt ${number} result actions`}));
}

test('keyboard copies exact distinct historical results after remount and while disconnected without mutations', async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const f = savedResults();
  const before = JSON.stringify(f.state);
  const view = render(<App />); await connected();
  view.unmount(); render(<App />); await connected();
  fireEvent.click(screen.getByText('Attempt 1 · Result available · Unverified'));
  for (const number of [1, 2]) {
    const copy = resultActions(number).getByRole('button', {name: 'Copy result'});
    copy.focus(); await user.keyboard(number === 1 ? '{Enter}' : ' ');
    await waitFor(() => expect(write).toHaveBeenLastCalledWith(outputs[number - 1]));
    expect(document.activeElement).toBe(copy);
  }
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  await user.click(resultActions(1).getByRole('button', {name: 'Copy result'}));
  expect(write).toHaveBeenLastCalledWith(outputs[0]);
  expect(screen.getAllByText('Test response — not live validation', {exact: false})).toHaveLength(2);
  expect(document.querySelector('pre script')).toBeNull();
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test.each(['denied', 'unavailable'])('%s clipboard reports failure and keyboard download keeps exact UTF-8 content', async failure => {
  const user = userEvent.setup();
  if (failure === 'denied') vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  else Object.defineProperty(navigator, 'clipboard', {configurable: true, value: undefined});
  const blobs: Blob[] = [];
  vi.stubGlobal('URL', {createObjectURL: vi.fn((blob: Blob) => {blobs.push(blob); return 'blob:result';}), revokeObjectURL: vi.fn()});
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {downloads.push(this.download);});
  const f = savedResults();
  const before = JSON.stringify(f.state);
  render(<App />); await connected();
  fireEvent.click(screen.getByText('Attempt 1 · Result available · Unverified'));
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  for (const number of [1, 2]) {
    const copy = resultActions(number).getByRole('button', {name: 'Copy result'});
    copy.focus(); await user.keyboard('{Enter}');
    await waitFor(() => expect(copy.closest('details')!.textContent).toContain('Could not copy.'));
    expect(document.activeElement).toBe(copy);
    await user.tab();
    expect(document.activeElement).toBe(resultActions(number).getByRole('button', {name: 'Download text'}));
    await user.keyboard(' ');
    expect(blobs[number - 1].type).toBe('text/plain;charset=utf-8');
    expect(await blobs[number - 1].text()).toBe(outputs[number - 1]);
    expect(downloads[number - 1]).toBe(`agentown-attempt-run-${number - 1}.txt`);
  }
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

const draftInput = () => screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement;
const draftButton = () => screen.getByRole('button', {name: 'Use as new draft'});
function draftHistory() {
  return fixture({...initial(), employees: [{id: 'e', name: 'Writer'}, {id: 'other', name: 'Editor'}], work: [
    {id: 'original', input: '  한글 😀\n<script>literal()</script>\n  ', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', started: 1, participants: ['e'], output: 'Original result', quality: 'unverified'}]},
    {id: 'second', input: 'Second request\n終わり', status: 'pending', assignees: ['missing'], attempts: []},
  ]});
}

test('keyboard draft action, cancel and replace preserve edits and historical selection snapshot across polling', async () => {
  const f = draftHistory(); const before = JSON.stringify(f.state);
  const user = userEvent.setup(); render(<App />); await connected();
  draftButton().focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(draftInput());
  expect(draftInput().value).toBe(f.state.work[0].input);
  expect(screen.getByText(/Saved input loaded as an editable new draft/).getAttribute('role')).toBe('status');
  fireEvent.change(draftInput(), {target: {value: 'My edit'}});
  await user.selectOptions(screen.getByLabelText('Assign to'), 'other');
  await user.selectOptions(screen.getByLabelText('Saved work'), 'second');
  const calls = f.calls.length;
  await waitFor(() => expect(f.calls.length).toBeGreaterThan(calls), {timeout: 2000});
  expect(draftInput().value).toBe('My edit');
  draftButton().focus(); await user.keyboard(' ');
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Cancel'}));
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(draftButton());
  expect(draftInput().value).toBe('My edit');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  expect(screen.getByText(/Replacement cancelled/)).toBeTruthy();
  await user.click(draftButton()); await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(draftButton());
  await user.click(draftButton());
  await user.selectOptions(screen.getByLabelText('Saved work'), 'original');
  await user.click(screen.getByRole('button', {name: 'Replace draft'}));
  expect(draftInput().value).toBe(f.state.work[1].input);
  expect(document.activeElement).toBe(draftInput());
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('');
  expect((screen.getByRole('button', {name: 'Save work'}) as HTMLButtonElement).disabled).toBe(true);
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test.each([{assignees: []}, {assignees: ['e', 'other']}, {assignees: ['missing']}])('draft requires explicit selection for assignees %j, including after polling', async ({assignees}) => {
  const f = draftHistory(); f.state.work[0].assignees = assignees;
  render(<App />); await connected(); fireEvent.click(draftButton());
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('');
  f.state.employees.push({id: 'missing', name: 'Returned'}); refresh(); await connected();
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('');
  expect(screen.getByText(/Select an employee before saving/)).toBeTruthy();
});

test('offline loaded draft reconnects, saves revised text once, and never mutates original history or submits providers', async () => {
  const f = draftHistory(); const original = JSON.stringify(f.state.work);
  render(<App />); await connected(); f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  fireEvent.click(draftButton()); expect(draftInput().value).toBe(f.state.work[0].input);
  const revised = f.state.work[0].input + '\nRevised 😀';
  fireEvent.change(draftInput(), {target: {value: revised}});
  expect((screen.getByRole('button', {name: 'Save work'}) as HTMLButtonElement).disabled).toBe(true);
  expect(JSON.stringify(f.state.work)).toBe(original);
  f.reconnect(); refresh(); await connected();
  expect(draftInput().value).toBe(revised);
  act(() => {screen.getByRole('button', {name: 'Save work'}).click(); screen.getByRole('button', {name: 'Save work'}).click();});
  await waitFor(() => expect(draftInput().value).toBe(''));
  expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(1);
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(0);
  expect(JSON.stringify(f.state.work.slice(0, 2))).toBe(original);
  expect(f.state.work[2]).toMatchObject({input: revised, assignees: ['e'], attempts: []});
});

test('outstanding save prevents replacement and edits until delivery settles', async () => {
  draftHistory(); const fetcher = globalThis.fetch;
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', (path: string, options: RequestInit) => path === '/api/work' ? new Promise<Response>(r => {resolve = r;}) : fetcher(path, options));
  render(<App />); await connected(); fireEvent.click(draftButton());
  fireEvent.click(screen.getByRole('button', {name: 'Save work'}));
  expect((draftButton() as HTMLButtonElement).disabled).toBe(true);
  expect(draftInput().disabled).toBe(true);
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(draftButton()); expect(screen.queryByRole('button', {name: 'Replace draft'})).toBeNull();
  await act(async () => resolve(new Response('{}', {status: 500})));
  expect(draftInput().value).toContain('한글');
  expect((draftButton() as HTMLButtonElement).disabled).toBe(false);
});

const searchInput = () => screen.getByLabelText('Search saved work');
const history = () => screen.getByLabelText('Saved work') as HTMLSelectElement;
function searchHistory() {
  const f = draftHistory();
  f.state.work[0].input = 'Identical prefix '.repeat(5) + ' ORIGINAL ÉCOLE 한글 😀 <script>literal()</script> .*';
  f.state.work[1].input = 'Identical prefix '.repeat(5) + ' revised 終わり';
  return f;
}

test('full-input literal Unicode search distinguishes identical labels and keyboard clear preserves selection and drafts', async () => {
  const f = searchHistory(); const before = JSON.stringify(f.state);
  const user = userEvent.setup(); render(<App />); await connected();
  const labels = [...history().options].map(o => o.textContent);
  expect(labels[0]).toContain('ID: original'); expect(labels[1]).toContain('ID: second');
  fireEvent.change(draftInput(), {target: {value: 'Keep my draft'}});
  await user.selectOptions(screen.getByLabelText('Assign to'), 'other');
  for (const query of ['école', '한글 😀', '<script>literal()</script>', '.*']) {
    fireEvent.change(searchInput(), {target: {value: query}});
    expect(history().options).toHaveLength(1);
    expect(history().value).toBe('original');
  }
  expect(document.querySelector('.history script')).toBeNull();
  searchInput().focus(); await user.clear(searchInput()); await user.type(searchInput(), 'absent');
  expect(screen.getByText(/No saved work matches/)).toBeTruthy();
  expect(screen.getByText(/Its detail remains selected/)).toBeTruthy();
  expect(document.querySelector('#detail pre')!.textContent).toBe(f.state.work[0].input);
  expect(document.querySelector('#search-count')!.textContent).toBe('0 of 2 saved requests match.');
  await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Clear search'}));
  await user.keyboard('{Enter}'); expect(document.activeElement).toBe(searchInput());
  expect(history().value).toBe('original');
  expect(draftInput().value).toBe('Keep my draft');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  fireEvent.change(searchInput(), {target: {value: '終わり'}});
  await user.selectOptions(history(), 'second');
  expect(document.querySelector('#detail pre')!.textContent).toBe(f.state.work[1].input);
  fireEvent.click(screen.getByRole('button', {name: 'Clear search'}));
  expect(history().value).toBe('second');
  expect(JSON.stringify(f.state)).toBe(before); expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('polling and disconnected search preserve expanded history without repeated count DOM announcements or mutations', async () => {
  const f = savedResults(); const before = JSON.stringify(f.state);
  render(<App />); await connected();
  fireEvent.click(screen.getByText('Attempt 1 · Result available · Unverified'));
  const details = [...document.querySelectorAll('details')];
  await waitFor(() => expect(details.every(d => d.open)).toBe(true));
  fireEvent.change(searchInput(), {target: {value: 'excluded'}});
  const count = document.querySelector('#search-count')!;
  expect(count.getAttribute('role')).toBe('status');
  const changes = vi.fn(); const observer = new MutationObserver(changes);
  observer.observe(count, {childList: true, characterData: true, subtree: true});
  const calls = f.calls.length;
  await waitFor(() => expect(f.calls.length).toBeGreaterThan(calls), {timeout: 2000});
  expect(changes).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('details')]).toEqual(details);
  expect(details.every(d => d.open)).toBe(true);
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('history may be out of date'));
  fireEvent.click(screen.getByRole('button', {name: 'Clear search'}));
  expect(history().value).toBe(f.state.work[0].id);
  for (const name of ['Create employee', 'Save work', 'Retry explicitly']) expect((screen.getByRole('button', {name}) as HTMLButtonElement).disabled).toBe(true);
  expect(details.every(d => d.open)).toBe(true);
  observer.disconnect();
  expect(JSON.stringify(f.state)).toBe(before); expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('explicit offline match selection opens history and save selects new excluded work without execution', async () => {
  const f = searchHistory(); const original = JSON.stringify(f.state.work);
  const user = userEvent.setup(); render(<App />); await connected();
  await user.selectOptions(history(), 'second');
  f.disconnect(); refresh(); await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  fireEvent.change(searchInput(), {target: {value: 'original'}});
  await user.selectOptions(history(), 'original');
  expect(document.querySelector('#detail pre')!.textContent).toBe(f.state.work[0].input);
  expect(screen.getByText('Attempt 1 · Result available · Unverified')).toBeTruthy();
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
  fireEvent.change(draftInput(), {target: {value: 'New excluded request'}});
  f.reconnect(); refresh(); await connected();
  fireEvent.click(screen.getByRole('button', {name: 'Save work'}));
  await waitFor(() => expect(document.querySelector('#detail pre')!.textContent).toBe('New excluded request'));
  expect(screen.getByText(/Its detail remains selected/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Execute work'}));
  expect(JSON.stringify(f.state.work.slice(0, 2))).toBe(original);
  expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(1);
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(0);
  expect(f.state.work[2].attempts).toEqual([]);
});

test.each([
  ['active', null, undefined, undefined],
  ['finished', 'reported_success', 'Saved output', undefined],
  ['finished', 'failure', undefined, 'network'],
  ['finished', 'interruption', undefined, 'interrupted'],
] as const)('recorded timestamps for %s / %s stay stable across polling and disconnection', async (state, outcome, output, error) => {
  const started = Date.parse('2025-12-31T23:59:59.999Z');
  const ended = state === 'active' ? null : started + 1;
  const f = fixture({...initial(), employees: [{id: 'e', name: 'Writer'}], work: [{id: 'w', input: 'Text', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state, outcome, output, error, started, ended, participants: ['e'], provider: 'deterministic-test'}]}]});
  render(<App />); await connected();
  const detail = document.querySelector('details')!;
  expect(detail.textContent).toContain('2025-12-31 23:59:59.999 UTC');
  expect(detail.querySelector('time')!.dateTime).toBe('2025-12-31T23:59:59.999Z');
  if (ended === null) expect(detail.textContent).toContain('No recorded end — attempt is active.');
  else {
    expect(detail.querySelectorAll('time')[1].dateTime).toBe('2026-01-01T00:00:00.000Z');
    expect(detail.textContent).toContain('2026-01-01 00:00:00.000 UTC');
  }
  if (error === 'interrupted') expect(detail.textContent).toContain('Interruption recorded: 2026-01-01 00:00:00.000 UTC');
  if (output) expect(detail.textContent).toContain('Unverified');
  expect(detail.textContent).toContain('Test response — not live validation');
  const changes = vi.fn(); const observer = new MutationObserver(changes);
  document.querySelectorAll('[role=status], #connection, details').forEach(node => observer.observe(node, {subtree: true, childList: true, characterData: true}));
  const calls = f.calls.length;
  await waitFor(() => expect(f.calls.length).toBeGreaterThan(calls), {timeout: 2000});
  expect(changes).not.toHaveBeenCalled(); observer.disconnect();
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('history may be out of date'));
  expect(document.querySelector('details')).toBe(detail);
  expect(detail.querySelector('time')!.dateTime).toBe('2025-12-31T23:59:59.999Z');
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test.each([null, undefined, NaN, Infinity, -1, 0.5, 253402300800000, 8640000000000001])('unavailable timestamp %s never invents a date for a reported attempt', async value => {
  fixture({...initial(), work: [{id: 'w', input: 'Reported', status: 'pending', assignees: [], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', started: value, ended: value, participants: []}]}]});
  render(<App />); await connected();
  expect(document.querySelectorAll('time')).toHaveLength(0);
  expect(screen.getAllByText('Time unavailable')).toHaveLength(2);
  expect(screen.getByText(/Caller-reported attempt — no provider request/)).toBeTruthy();
  expect(screen.queryByText(/Waiting for the provider/)).toBeNull();
});

test.each([
  [0, '1970-01-01T00:00:00.000Z'],
  [253402300799999, '9999-12-31T23:59:59.999Z'],
  [Date.parse('2026-01-01T00:30:00+09:00'), '2025-12-31T15:30:00.000Z'],
  [Date.parse('2026-03-08T03:00:00-04:00'), '2026-03-08T07:00:00.000Z'],
])('reported active date %s uses explicit UTC across date and timezone boundaries', async (started, iso) => {
  fixture({...initial(), work: [{id: 'w', input: 'Reported', status: 'pending', assignees: [], attempts: [{id: 'r', state: 'active', outcome: null, started, ended: null, participants: []}]}]});
  render(<App />); await connected();
  expect(document.querySelector('time')!.dateTime).toBe(iso);
  expect(document.querySelector('time')!.textContent).toBe(`${iso.slice(0, 10)} ${iso.slice(11, 23)} UTC`);
  expect(screen.getByText(/No recorded end/)).toBeTruthy();
  expect(screen.getByText('Caller-reported active attempt; no provider request is recorded.')).toBeTruthy();
  expect(document.querySelector('#connection')!.textContent).not.toContain('waiting for response');
  expect(screen.queryByText(/Waiting for the provider/)).toBeNull();
});

test.each([
  ['ASCII', 'a'.repeat(100000), true], ['ASCII over', 'a'.repeat(100001), false],
  ['Korean', '한'.repeat(33333) + 'a', true], ['Korean over', '한'.repeat(33334), false],
  ['emoji', '😀'.repeat(25000), true], ['emoji over', '😀'.repeat(25001), false],
  ['combining', 'e\u0301'.repeat(33333) + 'a', true], ['combining over', 'e\u0301'.repeat(33334), false],
  ['blank', '\n\t\u0085\u2003', false], ['BOM is native nonblank', '\ufeff', true],
  ['escaped over', '"'.repeat(60000), false], ['invalid Unicode', '\ud800', false],
])('%s request validation preserves full pasted draft', async (_label, text, valid) => {
  const state = initial(); state.employees = [{id: 'employee-1', name: 'Writer'}];
  const f = fixture(state); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('option', {name: 'Writer'});
  const editor = screen.getByLabelText('What would you like help with?');
  await user.click(editor); await user.paste(text);
  expect((editor as HTMLTextAreaElement).value).toBe(text);
  expect(editor.hasAttribute('maxlength')).toBe(false);
  await user.click(screen.getByRole('button', {name: 'Save work'}));
  await waitFor(() => expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(valid ? 1 : 0));
  if (valid) expect(f.calls.find(c => c.path === '/api/work')!.body.input).toBe(text);
  else {
    expect((editor as HTMLTextAreaElement).value).toBe(text); expect(document.activeElement).toBe(editor);
    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('employee-1');
  }
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(0);
});

test('serialized exact limit, keyboard correction, polling and disconnected draft', async () => {
  const state = initial(); state.employees = [{id: 'employee-1', name: 'Writer'}];
  const f = fixture(state); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('option', {name: 'Writer'});
  const editor = screen.getByLabelText('What would you like help with?');
  const overhead = new TextEncoder().encode(JSON.stringify({input: '', employee: 'employee-1'})).length;
  const exact = '"'.repeat(Math.floor((120000 - overhead) / 2)) + 'a'.repeat((120000 - overhead) % 2);
  await user.click(editor); await user.paste(exact + 'a');
  expect(editor.getAttribute('aria-invalid')).toBe('true');
  await user.click(screen.getByRole('button', {name: 'Save work'}));
  expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(0);
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  expect((editor as HTMLTextAreaElement).value).toBe(exact + 'a');
  f.disconnect();
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect((screen.getByRole('button', {name: 'Save work'}) as HTMLButtonElement).disabled).toBe(true));
  expect((editor as HTMLTextAreaElement).value).toBe(exact + 'a');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('employee-1');
  await user.click(editor); await user.keyboard('{End}{Backspace}');
  expect((editor as HTMLTextAreaElement).value).toBe(exact);
  expect(editor.getAttribute('aria-invalid')).toBe('false');
  f.reconnect(); await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect((screen.getByRole('button', {name: 'Save work'}) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', {name: 'Save work'}));
  await waitFor(() => expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(1));
  expect(f.calls.find(c => c.path === '/api/work')!.body.input).toBe(exact);
});

test.each(['request_too_large', 'invalid_work_text', 'database'])('server %s rejection retains draft and assignee', async code => {
  const state = initial(); state.employees = [{id: 'employee-1', name: 'Writer'}];
  const fetcher = vi.fn(async (path: string) => path === '/api/state'
    ? new Response(JSON.stringify(state))
    : new Response(JSON.stringify({code, error: code === 'database' ? 'Check database access.' : 'Shorten the request; your draft is unchanged.'}), {status: code === 'request_too_large' ? 413 : 400}));
  vi.stubGlobal('fetch', fetcher); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('option', {name: 'Writer'});
  const editor = screen.getByLabelText('What would you like help with?');
  const text = '\n  한글 😀 <b>literal</b> e\u0301  ';
  await user.click(editor); await user.paste(text);
  await user.click(screen.getByRole('button', {name: 'Save work'}));
  await screen.findByText(code === 'database' ? 'Check database access.' : 'Shorten the request; your draft is unchanged.');
  expect((editor as HTMLTextAreaElement).value).toBe(text); expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('employee-1');
  expect(editor.getAttribute('aria-invalid')).toBe(String(code !== 'database'));
  if (code !== 'database') await waitFor(() => expect(document.activeElement).toBe(editor));
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/work')).toHaveLength(1);
});


test('output limit explains discarded partial text and keyboard draft correction without execution', async () => {
  const original = {id: 'w', input: 'Long request 한글', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state: 'finished' as const, outcome: 'failure', started: 1000, ended: 2000, participants: ['e'], provider: 'anthropic', error: 'output_limit', output: null}]};
  const f = fixture({...initial(), employees: [{id: 'e', name: 'Writer'}], work: [original]});
  const before = JSON.stringify(original);
  const user = userEvent.setup();
  render(<App />); await connected();
  expect(screen.getByText(/partial response was not retained/).textContent).toContain('Retry resends unchanged input and may hit the same limit');
  expect(document.querySelector('#connection')!.textContent).toContain('Failed — response reached the output limit');
  expect(screen.getByText('Attempt 1 · Failed — response reached the output limit')).toBeTruthy();
  expect(screen.queryByText(/unsupported or incomplete response/)).toBeNull();
  expect(screen.getByText(/partial response was not retained/).textContent).toContain('shorter answer or split the work');
  expect(document.querySelectorAll('#detail time')).toHaveLength(2);
  expect(screen.queryByRole('button', {name: 'Copy result'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Download text'})).toBeNull();
  expect(screen.queryByText('Result available · Unverified')).toBeNull();
  expect(Array.from(document.querySelectorAll('#detail time'), time => time.getAttribute('datetime'))).toEqual(['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z']);
  const action = screen.getByRole('button', {name: 'Use as new draft'});
  action.focus(); await user.keyboard('{Enter}');
  const editor = screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement;
  expect(document.activeElement).toBe(editor);
  expect(editor.value).toBe(original.input);
  fireEvent.change(editor, {target: {value: 'Please answer in two sentences.'}});
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  expect(screen.getByText(/partial response was not retained/)).toBeTruthy();
  await user.click(action);
  await user.click(screen.getByRole('button', {name: /^Cancel$/}));
  expect(document.activeElement).toBe(action);
  expect(editor.value).toBe('Please answer in two sentences.');
  f.reconnect(); refresh(); await connected();
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('e');
  await user.click(screen.getByRole('button', {name: 'Save work'}));
  await waitFor(() => expect(f.calls.filter(c => c.path === '/api/work')).toHaveLength(1));
  expect(f.calls.find(c => c.path === '/api/work')!.body.input).toBe('Please answer in two sentences.');
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(0);
  expect(JSON.stringify(original)).toBe(before);
});

test.each(['openai', 'bedrock', 'xai'])('%s requests are labelled as real provider attempts', async provider => {
  fixture({...initial(), provider, employees: [{id: 'e', name: 'Writer'}], work: [{
    id: 'w', input: 'Text', status: 'pending', assignees: ['e'], attempts: [{
      id: 'r', state: 'finished', outcome: 'reported_success', provider, model: 'chosen-model',
      output: 'Full answer', quality: 'unverified', participants: ['e'],
    }],
  }]});
  render(<App />); await connected();
  expect(screen.getByText(/Real provider requests/)).toBeTruthy();
  expect(screen.getByText(/Real provider response/)).toBeTruthy();
  expect(screen.queryByText(/Test response — not live validation/)).toBeNull();
});

// A cancellable event checks the native confirmation request, not browser dialog UI.
function expectLeaveProtection(active: boolean) {
  const event = new Event('beforeunload', {cancelable: true});
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(active);
  expect(document.querySelector('#input-unsaved')!.textContent).toBe(active
    ? 'Unsaved request. Save work or clear this text before leaving. Reloading or closing this page can lose your draft.' : '');
}

test('typed and whitespace drafts protect leaving through polling, search, selection and disconnection without mutations', async () => {
  const f = draftHistory();
  f.state.configuration = 'Set provider configuration to execute.';
  render(<StrictMode><App /></StrictMode>); await connected();
  expectLeaveProtection(false);
  expect(draftInput().getAttribute('aria-describedby')!.split(' ')).toContain('input-unsaved');
  for (const text of ['My unsaved request', ' \n\t ']) {
    fireEvent.change(draftInput(), {target: {value: text}});
    expectLeaveProtection(true);
    refresh(); await connected();
    fireEvent.change(searchInput(), {target: {value: 'Second'}});
    fireEvent.change(history(), {target: {value: 'second'}});
    expect(draftInput().value).toBe(text);
    expectLeaveProtection(true);
    fireEvent.click(screen.getByRole('button', {name: 'Clear search'}));
  }
  fireEvent.click(screen.getByRole('button', {name: 'Save work'}));
  expectLeaveProtection(true); // Local blank validation cannot mark text saved.
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  expectLeaveProtection(true);
  fireEvent.change(draftInput(), {target: {value: ''}});
  expectLeaveProtection(false);
  expect(f.calls.every(call => call.path === '/api/state')).toBe(true);
});

test('loaded draft stays protected during pending and rejected saving until explicit confirmed save', async () => {
  const f = draftHistory(); const fetcher = globalThis.fetch;
  const submissions: unknown[] = [];
  let settle!: (response: Response) => void;
  vi.stubGlobal('fetch', (path: string, options: RequestInit) => {
    if (path !== '/api/work') return fetcher(path, options);
    submissions.push(JSON.parse(options.body as string));
    return new Promise<Response>(resolve => { settle = resolve; });
  });
  render(<App />); await connected();
  fireEvent.click(draftButton());
  const text = draftInput().value;
  expectLeaveProtection(true);
  expect(submissions).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', {name: 'Save work'}));
  expectLeaveProtection(true);
  await act(async () => settle(new Response('{}', {status: 500})));
  expect(draftInput().value).toBe(text);
  expectLeaveProtection(true);
  fireEvent.click(screen.getByRole('button', {name: 'Save work'}));
  expectLeaveProtection(true);
  await act(async () => settle(new Response(JSON.stringify({id: 'saved'}))));
  expect(draftInput().value).toBe('');
  expectLeaveProtection(false);
  expect(submissions).toEqual([{input: text, employee: 'e'}, {input: text, employee: 'e'}]);
  expect(f.calls.every(call => call.path === '/api/state')).toBe(true);
});

test('StrictMode leaves no beforeunload listener after clearing, unmounting or remounting', async () => {
  fixture();
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const view = render(<StrictMode><App /></StrictMode>); await connected();
  fireEvent.change(draftInput(), {target: {value: 'First'}});
  expectLeaveProtection(true);
  fireEvent.change(draftInput(), {target: {value: 'More text'}});
  expect(add.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(1);
  fireEvent.change(draftInput(), {target: {value: ''}});
  expectLeaveProtection(false);
  fireEvent.change(draftInput(), {target: {value: 'Another draft'}});
  view.unmount();
  const added = add.mock.calls.filter(([type]) => type === 'beforeunload');
  const removed = remove.mock.calls.filter(([type]) => type === 'beforeunload');
  expect(added).toHaveLength(2);
  expect(removed.map(call => call[1])).toEqual(added.map(call => call[1]));
  const event = new Event('beforeunload', {cancelable: true});
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  render(<StrictMode><App /></StrictMode>); await connected();
  expect(draftInput().value).toBe('');
  expectLeaveProtection(false);
});

const retry = () => screen.getByRole('button', {name: 'Retry explicitly'});
const resend = () => screen.getByRole('button', {name: 'Confirm resend'});
const resendRegion = () => screen.queryByRole('region', {name: 'Resend saved work?'});

test('saved-result consent cancels by keyboard and Escape without changing drafts, selection or history', async () => {
  const f = savedResults();
  f.state.employees.push({id: 'other', name: 'Editor'});
  const before = JSON.stringify(f.state);
  const user = userEvent.setup(); render(<StrictMode><App /></StrictMode>); await connected();
  fireEvent.change(draftInput(), {target: {value: 'Unsaved revised request'}});
  await user.selectOptions(screen.getByLabelText('Assign to'), 'other');
  retry().focus(); await user.keyboard('{Enter}');
  expect(resendRegion()?.getAttribute('aria-describedby')).toBe('resend-help');
  expect(screen.getByText(/This resends the original saved input/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Cancel resend'}));
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(0);
  await user.keyboard('{Enter}'); expect(resendRegion()).toBeNull();
  expect(document.activeElement).toBe(retry());
  await user.keyboard(' '); await user.tab(); expect(document.activeElement).toBe(resend());
  await user.keyboard('{Escape}'); expect(resendRegion()).toBeNull();
  expect(document.activeElement).toBe(retry());
  expect(draftInput().value).toBe('Unsaved revised request');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  expect(history().value).toBe('w');
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test.each(['keyboard', 'rapid clicks'])('unchanged polling retains consent; %s confirms one guarded request and preserves results', async method => {
  const f = savedResults(); const original = JSON.stringify(f.state.work[0].attempts);
  const user = userEvent.setup(); render(<App />); await connected();
  fireEvent.change(draftInput(), {target: {value: 'Keep draft'}});
  await user.click(retry()); await user.tab();
  const confirm = resend(); expect(document.activeElement).toBe(confirm);
  const calls = f.calls.length;
  await waitFor(() => expect(f.calls.length).toBeGreaterThan(calls), {timeout: 2000});
  expect(resend()).toBe(confirm); expect(document.activeElement).toBe(confirm);
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(0);
  if (method === 'keyboard') await user.keyboard('{Enter}');
  else act(() => {confirm.click(); confirm.click(); retry().click();});
  expect(resendRegion()).toBeNull();
  expect(document.activeElement).toBe(history());
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toEqual([{path: '/api/work/w/execute', body: {expected_runs: 2}}]);
  await act(async () => f.finish());
  expect(JSON.stringify(f.state.work[0].attempts.slice(0, 2))).toBe(original);
  expect(draftInput().value).toBe('Keep draft'); expect(history().value).toBe('w');
  expect(f.state.work[0].input).toBe('Text');
  expect(f.state.work[0].attempts).toHaveLength(3);
});

test.each(['selection', 'new attempt', 'changed attempt', 'disconnect', 'configuration', 'cancelled', 'assignees', 'active', 'model'])('invalidates saved-result consent on %s without submitting stale confirmation', async change => {
  const f = savedResults();
  f.state.work.push({...f.state.work[0], id: 'second', input: 'Other work', attempts: []});
  const user = userEvent.setup(); render(<App />); await connected();
  fireEvent.change(draftInput(), {target: {value: 'Keep draft'}});
  await user.click(retry()); const stale = resend();
  const work = f.state.work[0];
  if (change === 'selection') await user.selectOptions(history(), 'second');
  else {
    if (change === 'new attempt') work.attempts.push({...work.attempts[0], id: 'new'});
    if (change === 'changed attempt') work.attempts[0].output = 'Updated history';
    if (change === 'disconnect') f.disconnect();
    if (change === 'configuration') f.state.configuration = 'Execution unavailable';
    if (change === 'cancelled') work.status = 'cancelled';
    if (change === 'assignees') work.assignees = [];
    if (change === 'active') work.attempts[0].state = 'active';
    if (change === 'model') f.state.model = 'different-model';
    await act(async () => refresh());
  }
  await waitFor(() => expect(resendRegion()).toBeNull());
  act(() => stale.click());
  expect(screen.getByRole('alert').textContent).toContain('Review history before retrying');
  expect(draftInput().value).toBe('Keep draft');
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
  if (change === 'disconnect') {
    expect(document.activeElement).toBe(history());
    f.reconnect(); await act(async () => refresh()); await connected();
    expect(resendRegion()).toBeNull();
    await user.click(retry()); expect(resendRegion()).toBeTruthy();
    expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
  }
});

test('an empty saved output still requires consent', async () => {
  const f = savedResults(); f.state.work[0].attempts.at(-1)!.output = '';
  render(<App />); await connected(); fireEvent.click(retry());
  expect(resendRegion()).toBeTruthy();
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('a failed latest attempt retries directly even with older saved results', async () => {
  const f = savedResults();
  Object.assign(f.state.work[0].attempts[1], {output: null, outcome: 'failure', error: 'rate_limit'});
  render(<App />); await connected(); fireEvent.click(retry());
  expect(resendRegion()).toBeNull();
  expect(f.calls.filter(c => c.path.endsWith('/execute'))).toEqual([{path: '/api/work/w/execute', body: {expected_runs: 2}}]);
  await act(async () => f.finish());
  expect(f.state.work[0].attempts[0].output).toBe(outputs[0]);
});

const outcomeFilter = () => screen.getByRole('combobox', {name: 'Current outcome'}) as HTMLSelectElement;
const matchingIds = () => [...history().options].map(o => o.value).filter(Boolean);

test('outcomes combine with literal search, include other states in All and reset both without mutations', async () => {
  const f = fixture({...initial(), work: [
    {id: 'pending', input: 'Plan pending', status: 'pending', assignees: [], attempts: []},
    {id: 'active', input: 'Plan active', status: 'pending', assignees: [], attempts: [{id: 'a', state: 'active', outcome: null, participants: []}]},
    {id: 'result', input: 'Other result', status: 'pending', assignees: [], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', output: '', participants: []}]},
    {id: 'failed', input: 'Plan failed', status: 'pending', assignees: [], attempts: [{id: 'f', state: 'finished', outcome: 'failure', participants: []}]},
    {id: 'other', input: 'Plan cancelled', status: 'cancelled', assignees: [], attempts: []},
  ]});
  const before = JSON.stringify(f.state);
  const user = userEvent.setup(); render(<App />); await connected();
  expect(outcomeFilter().value).toBe('all'); expect(matchingIds()).toHaveLength(5);
  fireEvent.change(searchInput(), {target: {value: 'PLAN'}});
  screen.getByRole('button', {name: 'Clear search'}).focus();
  await user.tab(); expect(document.activeElement).toBe(outcomeFilter());
  for (const [value, ids] of [['pending', ['pending']], ['active', ['active']], ['results', []], ['failed', ['failed']]] as const) {
    await user.selectOptions(outcomeFilter(), value);
    expect(matchingIds()).toEqual(ids);
    expect(document.querySelector('#search-count')!.textContent).toBe(`${ids.length} of 5 saved requests match.`);
  }
  await user.selectOptions(outcomeFilter(), 'results');
  expect(screen.getByText(/Change either filter/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Clear search'}));
  expect(outcomeFilter().value).toBe('results'); expect(matchingIds()).toEqual(['result']);
  fireEvent.change(searchInput(), {target: {value: 'absent'}});
  const reset = screen.getByRole('button', {name: 'Show all loaded work'});
  reset.focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(searchInput());
  expect(outcomeFilter().value).toBe('all'); expect((searchInput() as HTMLInputElement).value).toBe('');
  expect(matchingIds()).toHaveLength(5); expect(history().value).toBe('pending');
  expect(JSON.stringify(f.state)).toBe(before); expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('polling changes outcome matches while retaining selected details, expanded results, draft and employee offline', async () => {
  const f = savedResults();
  f.state.employees.push({id: 'other', name: 'Editor'});
  render(<App />); await connected();
  fireEvent.change(draftInput(), {target: {value: 'Keep my unsaved text'}});
  fireEvent.change(screen.getByLabelText('Assign to'), {target: {value: 'other'}});
  fireEvent.click(screen.getByText('Attempt 1 · Result available · Unverified'));
  const details = [...document.querySelectorAll('details')];
  await waitFor(() => expect(details.every(d => d.open)).toBe(true));
  fireEvent.change(searchInput(), {target: {value: 'TEXT'}});
  fireEvent.change(outcomeFilter(), {target: {value: 'results'}});
  expect(matchingIds()).toEqual(['w']);
  f.state.work[0].attempts.push({id: 'new', state: 'active', outcome: null, participants: ['e']});
  await waitFor(() => expect(matchingIds()).toEqual([]), {timeout: 2000});
  expect(screen.getByText(/Its detail remains selected/)).toBeTruthy();
  expect(document.querySelector('#detail .badge')!.textContent).toContain('Caller-reported active attempt');
  Object.assign(f.state.work[0].attempts.at(-1)!, {state: 'finished', outcome: 'interruption'});
  fireEvent.change(outcomeFilter(), {target: {value: 'failed'}});
  await waitFor(() => expect(matchingIds()).toEqual(['w']), {timeout: 2000});
  expect(document.querySelector('#detail .badge')!.textContent).toContain('Interrupted');
  f.disconnect(); refresh();
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  fireEvent.change(outcomeFilter(), {target: {value: 'pending'}});
  expect(matchingIds()).toEqual([]);
  fireEvent.click(screen.getByRole('button', {name: 'Show all loaded work'}));
  expect(history().value).toBe('w');
  for (const detail of details) { expect(detail.isConnected).toBe(true); expect(detail.open).toBe(true); }
  expect(draftInput().value).toBe('Keep my unsaved text');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('employee navigation uses IDs, composes filters and preserves drafts, results and consent', async () => {
  const f = savedResults();
  f.state.employees = [{id: 'e', name: 'Alex'}, {id: 'other', name: 'Alex'}, {id: 'idle', name: 'Idle'}];
  f.state.work.push({id: 'other-work', input: 'Text for other Alex', status: 'pending', assignees: ['other'], attempts: []});
  const before = JSON.stringify(f.state);
  const user = userEvent.setup(); render(<App />); await connected();
  fireEvent.change(draftInput(), {target: {value: 'Keep unsaved request'}});
  await user.selectOptions(screen.getByLabelText('Assign to'), 'other');
  await user.click(screen.getByText('Attempt 1 · Result available · Unverified'));
  const expanded = [...document.querySelectorAll<HTMLDetailsElement>('#detail details')];
  await waitFor(() => expect(expanded.every(d => d.open)).toBe(true));
  await user.click(retry());
  const card = screen.getByRole('button', {name: 'View assigned work: Alex · ID: other'});
  card.focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(card);
  expect(card.getAttribute('aria-pressed')).toBe('true');
  expect(matchingIds()).toEqual(['other-work']);
  expect(screen.getByText(/Its detail remains selected/)).toBeTruthy();
  for (const detail of expanded) { expect(detail.isConnected).toBe(true); expect(detail.open).toBe(true); }
  expect(resendRegion()).toBeTruthy(); // Filtering alone does not change saved work consent.
  fireEvent.change(searchInput(), {target: {value: 'Text'}});
  await user.selectOptions(outcomeFilter(), 'results');
  expect(matchingIds()).toEqual([]);
  expect(screen.getByText(/No saved work matches your employee/)).toBeTruthy();
  await user.selectOptions(outcomeFilter(), 'all');
  const staleConsent = resend();
  await user.click(screen.getByRole('button', {name: /Open request: Text for other Alex/}));
  expect(history().value).toBe('other-work'); expect(document.activeElement).toBe(history());
  expect(resendRegion()).toBeNull();
  act(() => staleConsent.click());
  await user.click(screen.getByRole('button', {name: 'Return to all employees'}));
  expect(matchingIds()).toEqual(['w', 'other-work']);
  const first = screen.getByRole('button', {name: 'View assigned work: Alex · ID: e'});
  first.focus(); await user.keyboard(' ');
  expect(matchingIds()).toEqual(['w']);
  await user.click(screen.getByRole('button', {name: /^Open request: Text ·/}));
  await user.click(screen.getByRole('button', {name: 'View assigned work: Idle · ID: idle'}));
  expect(matchingIds()).toEqual([]);
  await user.click(screen.getByRole('button', {name: 'Show all loaded work'}));
  expect(document.activeElement).toBe(searchInput());
  expect(draftInput().value).toBe('Keep unsaved request');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});

test('employee assignment polling and disconnected navigation retain selected history and expanded results', async () => {
  const f = savedResults();
  const user = userEvent.setup(); render(<App />); await connected();
  fireEvent.change(draftInput(), {target: {value: 'Keep draft offline'}});
  await user.click(screen.getByText('Attempt 1 · Result available · Unverified'));
  const expanded = [...document.querySelectorAll<HTMLDetailsElement>('#detail details')];
  await waitFor(() => expect(expanded.every(d => d.open)).toBe(true));
  await user.click(screen.getByRole('button', {name: /View assigned work: .* · ID: e$/}));
  expect(matchingIds()).toEqual(['w']);
  f.state.work[0].assignees = ['unavailable'];
  await waitFor(() => expect(matchingIds()).toEqual([]), {timeout: 2000});
  f.state.employees = [];
  refresh(); await screen.findByText(/Assigned work for an unavailable employee/);
  f.disconnect(); refresh();
  await screen.findByText(/Using stale assignments/);
  await user.click(screen.getByRole('button', {name: 'Return to all employees'}));
  expect(matchingIds()).toEqual(['w']); expect(history().value).toBe('w');
  expect(draftInput().value).toBe('Keep draft offline');
  for (const detail of expanded) { expect(detail.isConnected).toBe(true); expect(detail.open).toBe(true); }
  expect(f.calls.every(c => c.path === '/api/state')).toBe(true);
});
