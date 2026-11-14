import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { LoopExecution, loopLabel, type LoopPreview, type LoopSession } from './LoopExecution';
import type { Work, Workspace } from './api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const work: Work = {id: 'w', input: 'Saved input', status: 'pending', assignees: ['e'], attempts: []};
const workspace: Workspace = {work: [work], employees: [{id: 'e', name: 'Writer'}], configuration: null, provider: 'fixture', model: 'fixture'};
const preview: LoopPreview = {schema_version: 1, preview_id: 'p', policy_id: 'l', policy_name: 'Bounded', task_id: 'w', agent_id: 'e', input: work.input, expected_runs: 0, policy_enabled: true, max_iterations: 2, interval_seconds: 60};
const session: LoopSession = {session_id: 'session', preview, state: 'active', admitted: 0, next_at: 0, provider: 'fixture', model: 'fixture'};
function setup() {
  const data = {schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [] as LoopSession[], attempts: [], cancellation: 'Remote completion may remain unknown.'};
  const fetcher = vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/config/v1/loops' ? {loops: [{id: 'l', name: 'Bounded', task_id: 'w', enabled: true, max_iterations: 2, interval_seconds: 60}]} : path.endsWith('/preview') ? preview : data)));
  vi.stubGlobal('fetch', fetcher);
  const submit = vi.fn(async () => {});
  return {data, fetcher, props: {work, workspace, connected: true, draft: '', disabled: false, availability: vi.fn(), submit}};
}
async function inspect() {
  const user = userEvent.setup();
  await screen.findByRole('option', {name: /Bounded · l · Configured/});
  await user.selectOptions(screen.getByLabelText('Saved Loop'), 'l');
  screen.getByRole('button', {name: 'Preview Loop with saved work'}).focus();
  await user.keyboard('{Enter}');
  return screen.findByRole('button', {name: 'Authorize and start bounded Loop'});
}
test('keyboard preview, cancel focus, bounded details and single-use start consent', async () => {
  const f = setup(); render(<LoopExecution {...f.props} />);
  let start = await inspect(); expect(document.activeElement).toBe(start);
  expect(screen.getByText(/Maximum attempts: 2/)).toBeTruthy();
  expect(f.props.submit).not.toHaveBeenCalled();
  await userEvent.setup().keyboard('{Escape}');
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Preview Loop with saved work'}));
  start = await inspect(); act(() => { start.click(); start.click(); });
  expect(f.props.submit).toHaveBeenCalledTimes(1);
  expect(f.props.submit).toHaveBeenCalledWith('/api/loops/v1/start', {preview_id: 'p', expected_runs: 0}, false);
  expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
});
test.each(['draft', 'disconnect', 'model', 'disabled'])('invalidates consent on %s and restores focus', async change => {
  const f = setup(); const view = render(<LoopExecution {...f.props} />); await inspect();
  view.rerender(<LoopExecution {...f.props} draft={change === 'draft' ? 'new' : ''} connected={change !== 'disconnect'} disabled={change === 'disabled'} workspace={change === 'model' ? {...workspace, model: 'changed'} : workspace} />);
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull());
  expect(document.activeElement?.textContent).toMatch(/Preview Loop|Run a bounded Loop/);
  expect(f.props.submit).not.toHaveBeenCalled();
});
test('rejects delayed preview after draft change', async () => {
  const f = setup(); const original = globalThis.fetch;
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', (path: string, options: RequestInit) => path.endsWith('/preview') ? new Promise<Response>(r => { resolve = r; }) : original(path, options));
  const view = render(<LoopExecution {...f.props} />);
  await screen.findByRole('option', {name: /Bounded · l/});
  await userEvent.setup().selectOptions(screen.getByLabelText('Saved Loop'), 'l');
  await userEvent.setup().click(screen.getByRole('button', {name: 'Preview Loop with saved work'}));
  view.rerender(<LoopExecution {...f.props} draft="changed" />);
  await act(async () => resolve(new Response(JSON.stringify(preview))));
  expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
});
test('recovers saved active sessions and keeps emergency stop available when execution is disabled', async () => {
  const f = setup(); f.data.sessions = [session];
  const view = render(<LoopExecution {...f.props} disabled />);
  const stop = await screen.findByRole('button', {name: 'Stop Loop session'});
  expect((stop as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<LoopExecution {...f.props} disabled connected={false} />);
  expect((stop as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('status')[0].textContent).toMatch(/stale/);
  view.rerender(<LoopExecution {...f.props} disabled connected />);
  await userEvent.setup().click(screen.getByRole('button', {name: 'Refresh Loop session records'}));
  await userEvent.setup().click(stop);
  expect(f.props.submit).toHaveBeenCalledWith('/api/loops/v1/stop', {session_id: 'session'}, true);
});
test.each(['stopped', 'failed', 'expired', 'restarted', 'stale', 'complete'])('displays persisted terminal state %s', state => {
  expect(loopLabel({...session, state}, [])).toMatch(state === 'complete' ? /Exhausted/ : new RegExp(state, 'i'));
});
test('waiting requires actual finished attempt evidence; missing records stay active', () => {
  const s = {...session, admitted: 1};
  expect(loopLabel(s, [])).toMatch(/^Active/);
  expect(loopLabel(s, [{session_id: 'session', run_id: 'r', ordinal: 1, execution: {id: 'r', state: 'finished', outcome: 'reported_success', participants: ['e']}}])).toMatch(/^Waiting/);
});
test('initial connection reads Loop availability without waiting for polling or submitting work', async () => {
  const realInterval = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
    delay === 800 ? 0 as unknown as ReturnType<typeof setInterval> : realInterval(callback, delay, ...args));
  try {
    const f = setup();
    const view = render(<LoopExecution {...f.props} connected={false} />);
    expect(f.fetcher).not.toHaveBeenCalled();
    view.rerender(<LoopExecution {...f.props} connected />);
    await waitFor(() => expect(f.props.availability).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText('Loop inspection').textContent).toMatch(/Configured Loops/);
    expect(f.props.submit).not.toHaveBeenCalled();
  } finally { timer.mockRestore(); }
});
test('polling recovers disconnected inspection without resubmitting consent', async () => {
  vi.useFakeTimers();
  try {
    const f = setup(); const original = globalThis.fetch; let offline = true;
    vi.stubGlobal('fetch', (path: string, options: RequestInit) => offline ? Promise.reject(new Error('offline')) : original(path, options));
    render(<LoopExecution {...f.props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getAllByRole('status')[0].textContent).toMatch(/unavailable/);
    offline = false; f.data.sessions = [{...session, state: 'restarted'}];
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByText(/Restarted — explicit new consent required/)).toBeTruthy();
    expect(f.props.submit).not.toHaveBeenCalled();
    expect(f.props.availability).toHaveBeenLastCalledWith(false);
  } finally { vi.useRealTimers(); }
});
test('uses actual API execution records for active and waiting labels', () => {
  const row = {session_id: 'session', run_id: 'r', ordinal: 1, execution: {output: null, error: null}};
  expect(loopLabel({...session, admitted: 1}, [row])).toMatch(/^Active/);
  expect(loopLabel({...session, admitted: 1}, [{...row, execution: {output: 'TEST RESPONSE', error: null}}])).toMatch(/^Waiting/);
});

test('authority changes invalidate consent; competing owner and storage errors preserve readable history and recover without mutation', async () => {
  vi.useFakeTimers();
  try {
    const f = setup();
    let control: object = {state: 'competing_owner', can_control: false, message: ''};
    let storage = false;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
      if (path !== '/api/loops/v1') return original(path, options);
      return new Response(JSON.stringify(storage ? {error: 'Storage unavailable', control} : {...f.data, control}), {status: storage ? 503 : 200});
    });
    f.data.sessions = [{...session, declared_source: 'cursor'}];
    render(<LoopExecution {...f.props} />);
    await act(async () => {});
    const stop = screen.getByRole('button', {name: 'Stop Loop session'}) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(screen.getByText(/Caller-declared source \(unverified\): cursor/)).toBeTruthy();
    expect(screen.getByText(/another server owns execution/)).toBeTruthy();
    act(() => stop.click());
    control = {state: 'local_authority', can_control: true, message: ''};
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(stop.disabled).toBe(false);
    storage = true; control = {state: 'storage_failure', can_control: false, message: ''};
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(stop.disabled).toBe(true);
    expect(screen.getByText(/storage failure/)).toBeTruthy();
    expect(screen.getAllByRole('status')[0].textContent).toMatch(/stale/);
    storage = false; control = {state: 'available', can_control: true, message: ''};
    f.data.sessions = [{...session, declared_source: null}];
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByText(/Unknown \/ legacy session/)).toBeTruthy();
    expect(stop.disabled).toBe(false);
    expect(f.props.submit).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.every(([path]) => !path.endsWith('/start') && !path.endsWith('/stop'))).toBe(true);
  } finally { vi.useRealTimers(); }
});

test('missing or unknown availability fails closed even when can_control is true', async () => {
  const f = setup();
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => path === '/api/loops/v1'
    ? new Response(JSON.stringify({...f.data, sessions: [session], control: {state: 'future', can_control: true}})) : original(path, options));
  render(<LoopExecution {...f.props} />);
  const stop = await screen.findByRole('button', {name: 'Stop Loop session'});
  expect((stop as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/unknown authority/)).toBeTruthy();
  expect(f.props.submit).not.toHaveBeenCalled();
});

test.each(['start', 'cancel', 'outside'])('authority loss with focus on %s invalidates consent and recovery requires fresh consent', async focus => {
  let poll = () => {};
  const realInterval = globalThis.setInterval;
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }
    return realInterval(callback, delay, ...args);
  });
  try {
    const f = setup();
    f.data.sessions = [{...session, state: 'stopped'}];
    let owner = true;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (path: string, options: RequestInit) => path === '/api/loops/v1'
      ? new Response(JSON.stringify({...f.data, control: owner
        ? {state: 'available', can_control: true, message: ''}
        : {state: 'competing_owner', can_control: false, message: ''}})) : original(path, options));
    const view = render(<><button>Outside Loop</button><LoopExecution {...f.props} draft="Keep my draft" /></>);
    const start = await inspect();
    const outside = screen.getByRole('button', {name: 'Outside Loop'});
    const target = focus === 'start' ? start : focus === 'cancel'
      ? screen.getByRole('button', {name: 'Cancel Loop preview'}) : outside;
    target.focus();
    expect(document.activeElement).toBe(target);
    owner = false;
    await act(async () => poll());
    expect(screen.queryByRole('region', {name: 'Loop execution preview'})).toBeNull();
    expect(document.activeElement).toBe(focus === 'outside' ? outside : screen.getByRole('region', {name: 'Run a bounded Loop'}));
    expect((screen.getByLabelText('Saved Loop') as HTMLSelectElement).value).toBe('l');
    expect(screen.getByRole('region', {name: 'Loop session session'})).toBeTruthy();
    expect((screen.getByRole('button', {name: 'Preview Loop with saved work'}) as HTMLButtonElement).disabled).toBe(true);
    const recoveryFocus = document.activeElement;
    owner = true;
    await act(async () => poll());
    expect(document.activeElement).toBe(recoveryFocus);
    expect((screen.getByRole('button', {name: 'Preview Loop with saved work'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
    expect(f.props.submit).not.toHaveBeenCalled();
    // An unchanged draft survives recovery; rerendering it must not invalidate
    // the newly requested preview. Recovery itself never fetches a preview.
    expect(f.fetcher.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(1);
    const freshStart = await inspect();
    view.rerender(<><button>Outside Loop</button><LoopExecution {...f.props} draft="Keep my draft" /></>);
    expect(screen.getByRole('button', {name: 'Authorize and start bounded Loop'})).toBe(freshStart);
    expect(f.fetcher.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(2);
    expect(f.props.submit).not.toHaveBeenCalled();
    await userEvent.setup().keyboard('{Enter}');
    expect(f.props.submit).toHaveBeenCalledTimes(1);
    expect(f.props.submit).toHaveBeenCalledWith('/api/loops/v1/start', {preview_id: 'p', expected_runs: 0}, false);
  } finally { interval.mockRestore(); }
});

test.each(['policy', 'preview', 'attempt', 'session', 'null'])('malformed %s responses preserve selection and drafts, invalidate focused consent and recover without replay', async kind => {
  let poll: () => void = () => {};
  const realInterval = globalThis.setInterval;
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }
    return realInterval(callback, delay, ...args);
  });
  const f = setup();
  f.data.sessions = [{...session, state: 'stopped'}];
  const original = globalThis.fetch;
  let broken = true;
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    if (broken && path === '/api/config/v1/loops' && kind === 'policy') return new Response(JSON.stringify({loops: [{id: 'l', name: {bad: true}}]}));
    if (broken && path === '/api/loops/v1' && kind !== 'policy') return new Response(JSON.stringify(kind === 'null' ? null : {...f.data,
      sessions: kind === 'session' ? [null] : kind === 'preview' ? [{...session, preview: {bad: true}}] : [],
      attempts: kind === 'attempt' ? [{session_id: 'session', run_id: 'r', ordinal: 1, execution: {error: {bad: true}}}] : [],
    }));
    return original(path, options);
  });
  try {
    const view = render(<LoopExecution {...f.props} draft="Keep my draft" />);
    await act(async () => {});
    expect(screen.getByLabelText('Loop inspection').textContent).toMatch(/unavailable/);
    broken = false; await act(async () => poll());
    await inspect();
    broken = true; await act(async () => poll());
    expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Run a bounded Loop'}));
    expect((screen.getByLabelText('Saved Loop') as HTMLSelectElement).value).toBe('l');
    expect(screen.getByRole('region', {name: 'Loop session session'})).toBeTruthy();
    expect((screen.getByRole('button', {name: 'Preview Loop with saved work'}) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<LoopExecution {...f.props} draft="Keep my draft" />);
    broken = false; await act(async () => poll());
    expect((screen.getByLabelText('Saved Loop') as HTMLSelectElement).value).toBe('l');
    expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
    expect(f.props.submit).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(1);
    await inspect();
    expect(f.fetcher.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(2);
    expect(f.props.submit).not.toHaveBeenCalled();
  } finally { interval.mockRestore(); }
});


test.each(['__proto__', 'constructor', 'toString'])('renders prototype-named session state %s without mutations', async state => {
  const f = setup();
  f.data.sessions = [{...session, state}];
  render(<LoopExecution {...f.props} />);
  expect(await screen.findByText(content => content.startsWith(`Unknown session state: ${state} ·`))).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Stop Loop session'})).toBeNull();
  expect(f.props.submit).not.toHaveBeenCalled();
  expect(f.fetcher.mock.calls.every(([path]) => path === '/api/loops/v1' || path === '/api/config/v1/loops')).toBe(true);
});

test.each(['valid', 'null', 'malformed', 'unsupported', 'wrong-preview'])('start receipt %s consumes consent, preserves selection and recovers without replay', async kind => {
  let poll = () => {};
  const realInterval = globalThis.setInterval;
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }
    return realInterval(callback, delay, ...args);
  });
  try {
    const f = setup();
    const receipt = {...session, schema_version: 1, started_at: 0, expires_at: 1};
    let resolve!: (value: unknown) => void;
    const submit = vi.fn(() => new Promise<unknown>(r => { resolve = r; }));
    render(<LoopExecution {...f.props} draft="Keep draft" submit={submit} />);
    const start = await inspect();
    act(() => { start.click(); start.click(); });
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => resolve(kind === 'valid' ? receipt : kind === 'null' ? null : kind === 'malformed' ? {} : kind === 'unsupported' ? {...receipt, schema_version: 2} : {...receipt, preview: {...preview, preview_id: 'wrong'}}));
    expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/not confirmed/);
    expect((screen.getByLabelText('Saved Loop') as HTMLSelectElement).value).toBe('l');
    expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
    f.data.sessions = [session];
    await act(async () => poll());
    const stop = screen.getByRole('button', {name: 'Stop Loop session'});
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    stop.focus(); await userEvent.setup().keyboard('{Enter}');
    f.data.sessions = [{...session, state: 'stopped'}];
    await act(async () => resolve({...receipt, state: 'stopped'}));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/Local stop acknowledged.*Remote completion may remain unknown/);
  } finally { interval.mockRestore(); }
});

test.each([null, {}, {schema_version: 2}, {session_id: 'wrong'}])('uncertain saved-work stop receipt %j retains records and requires fresh inspection', async broken => {
  vi.useFakeTimers();
  try {
    const f = setup(); f.data.sessions = [session];
    const submit = vi.fn(async () => ({...session, schema_version: 1, started_at: 0, expires_at: 1, state: 'stopped', ...broken}));
    // null must remain null rather than becoming a valid merged record.
    if (broken === null || Object.keys(broken).length === 0) submit.mockImplementation(async () => broken as never);
    render(<LoopExecution {...f.props} disabled submit={submit} />);
    await act(async () => {});
    const stop = screen.getByRole('button', {name: 'Stop Loop session'});
    await act(async () => { stop.click(); stop.click(); });
    expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/not confirmed/);
    expect(screen.getByRole('region', {name: 'Loop session session'})).toBeTruthy();
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

test('saved-work stop rejects a stale in-flight inspection and restores emergency control after fresh inspection', async () => {
  vi.useFakeTimers();
  try {
    const f = setup(); f.data.sessions = [session];
    let reads = 0;
    let resolvePoll!: (value: Response) => void;
    let resolveStop!: (value: unknown) => void;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (path: string, options: RequestInit) => {
      if (path === '/api/loops/v1' && ++reads === 2) return new Promise<Response>(r => { resolvePoll = r; });
      return original(path, options);
    });
    const submit = vi.fn(() => new Promise<unknown>(r => { resolveStop = r; }));
    render(<LoopExecution {...f.props} disabled submit={submit} />);
    await act(async () => {});
    const stop = screen.getByRole('button', {name: 'Stop Loop session'});
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    act(() => { stop.click(); stop.click(); });
    await act(async () => resolvePoll(new Response(JSON.stringify(f.data))));
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveStop(null));
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/not confirmed/);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

 test('held confirmation blocks duplicate starts; polling cannot release recovery; keyboard inspection never replays', async () => {
  const f = setup();
  let poll = () => {};
  const realInterval = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }
    return realInterval(callback, delay, ...args);
  });
  let resolve!: (value: Response) => void;
  let hold = false;
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', (path: string, options: RequestInit) => hold && path === '/api/loops/v1'
    ? new Promise<Response>(r => { resolve = r; }) : original(path, options));
  const submit = vi.fn(async () => ({...session, schema_version: 1, started_at: 0, expires_at: 1}));
  try {
    render(<LoopExecution {...f.props} submit={submit} />);
    const start = await inspect(); hold = true;
    await act(async () => { start.click(); start.click(); });
    expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/response received/);
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => resolve(new Response(JSON.stringify(f.data))));
    expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/not confirmed/);
    hold = false;
    await act(async () => poll());
    expect((screen.getByRole('button', {name: 'Preview Loop with saved work'}) as HTMLButtonElement).disabled).toBe(true);
    const user = userEvent.setup();
    screen.getByRole('button', {name: 'Refresh Loop session records'}).focus(); await user.keyboard('{Enter}');
    screen.getByRole('button', {name: 'I inspected refreshed Loop records'}).focus(); await user.keyboard('{Enter}');
    expect((screen.getByRole('button', {name: 'Preview Loop with saved work'}) as HTMLButtonElement).disabled).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Saved Loop') as HTMLSelectElement).value).toBe('l');
  } finally { timer.mockRestore(); }
});
 test.each(['active', 'complete', 'failed', 'stopped'])('start confirms legitimate persisted progression to %s', async state => {
  const f = setup();
  const submit = vi.fn(async () => {
    f.data.sessions = [{...session, state, admitted: 2}];
    return {...session, schema_version: 1, started_at: 0, expires_at: 1};
  });
  render(<LoopExecution {...f.props} submit={submit} />);
  await userEvent.setup().click(await inspect());
  await waitFor(() => expect(screen.getByLabelText('Loop request outcome').textContent).toMatch(/saved session confirmed/));
  expect(submit).toHaveBeenCalledTimes(1);
});


test.each(['cancel', 'escape'])('saved-work Loop %s clears consent locally and requires a fresh preview', async method => {
  // Hold configuration/session polling so zero-request assertions concern dismissal only.
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  try {
    const f = setup(); const props = f.props;
    const user = userEvent.setup();
    render(<><button>Outside preview</button><LoopExecution {...props} /></>);
    await inspect();
    const previewButton = screen.getByRole('button', {name: 'Preview Loop with saved work'});
    const consent = screen.getByRole('button', {name: 'Authorize and start bounded Loop'});
    const fetcher = vi.mocked(globalThis.fetch);
    const requests = fetcher.mock.calls.length;
    await user.click(screen.getByRole('button', {name: 'Outside preview'}));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', {name: 'Authorize and start bounded Loop'})).toBe(consent);
    expect(screen.queryByText(/Consent cleared/)).toBeNull();
    if (method === 'cancel') {
      await user.click(screen.getByRole('button', {name: 'Cancel Loop preview'}));
    } else {
      consent.focus();
      await user.keyboard('{Escape}');
    }
    expect(screen.queryByRole('region', {name: 'Loop execution preview'})).toBeNull();
    expect(document.activeElement).toBe(previewButton);
    expect(screen.getByText('Loop preview dismissed. Consent cleared. No start was requested. Preview again before starting.').getAttribute('role')).toBe('status');
    await user.keyboard('{Escape}');
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(props.submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
    await user.click(previewButton);
    await screen.findByRole('button', {name: 'Authorize and start bounded Loop'});
    expect(fetcher.mock.calls).toHaveLength(requests + 1);
    expect(props.submit).not.toHaveBeenCalled();
  } finally { interval.mockRestore(); }
});


test.each(['prior refresh', 'held refresh', 'held poll', 'held confirmation'])('reconnect rejects %s for recovery consent while preserving emergency Stop', async scenario => {
  let poll = () => {};
  const realInterval = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }
    return realInterval(callback, delay, ...args);
  });
  try {
    const f = setup();
    f.data.sessions = [{...session, state: 'stopped'}];
    let hold = false;
    let release!: (value: Response) => void;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (path: string, options: RequestInit) => hold && path === '/api/loops/v1'
      ? new Promise<Response>(resolve => { release = resolve; }) : original(path, options));
    const submit = vi.fn(async (path: string) => path.endsWith('/start')
      ? scenario === 'held confirmation' ? {...session, schema_version: 1, started_at: 0, expires_at: 1} : null
      : {...session, state: 'stopped', schema_version: 1, started_at: 0, expires_at: 1});
    const view = render(<LoopExecution {...f.props} submit={submit} />);
    const start = await inspect();
    hold = scenario === 'held confirmation';
    await act(async () => start.click());
    const refresh = screen.getByRole('button', {name: 'Refresh Loop session records'});
    const acknowledge = () => screen.getByRole('button', {name: 'I inspected refreshed Loop records'}) as HTMLButtonElement;
    if (scenario === 'prior refresh') {
      await userEvent.setup().click(refresh);
      expect(acknowledge().disabled).toBe(false);
    } else if (scenario !== 'held confirmation') {
      hold = true;
      if (scenario === 'held refresh') await userEvent.setup().click(refresh);
      else await act(async () => poll());
    }
    view.rerender(<LoopExecution {...f.props} submit={submit} connected={false} />);
    expect(acknowledge().disabled).toBe(true);
    view.rerender(<LoopExecution {...f.props} submit={submit} connected />);
    if (scenario !== 'prior refresh') {
      await act(async () => release(new Response(JSON.stringify({...f.data, sessions: [session]}))));
      expect(screen.getByRole('region', {name: 'Loop session session'}).textContent).toMatch(/Stopped/);
    }
    expect(acknowledge().disabled).toBe(true);
    expect(screen.getByText('Retained session and attempt records are stale. Refresh on the current connection to inspect them.')).toBeTruthy();
    expect(screen.getByLabelText('Loop inspection').textContent).toMatch(/stale/);
    hold = false;
    f.data.sessions = [session];
    await act(async () => poll());
    expect(screen.getByText('Session and attempt records observed on the current connection.')).toBeTruthy();
    expect(acknowledge().disabled).toBe(true);
    const stop = screen.getByRole('button', {name: 'Stop Loop session'}) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    // Emergency control is independent of uncertain-start acknowledgment.
    f.data.sessions = [{...session, state: 'stopped'}];
    await act(async () => stop.click());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith('/api/loops/v1/stop', {session_id: 'session'}, true);
    expect(acknowledge().disabled).toBe(true);
    await userEvent.setup().click(refresh);
    expect(acknowledge().disabled).toBe(false);
    acknowledge().focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(screen.queryByRole('button', {name: 'I inspected refreshed Loop records'})).toBeNull();
    expect((screen.getByRole('button', {name: 'Preview Loop with saved work'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', {name: 'Authorize and start bounded Loop'})).toBeNull();
    expect(submit).toHaveBeenCalledTimes(2);
  } finally { timer.mockRestore(); }
});

test.each(['removed', 'terminal', 'outside', 'surviving', 'failed', 'invalid', 'obsolete'])('delayed saved Loop refresh preserves keyboard orientation: %s', async mode => {
  const realInterval = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
    delay === 800 ? 0 as unknown as ReturnType<typeof setInterval> : realInterval(callback, delay, ...args));
  try {
    const f = setup(); f.data.sessions = [session];
    const view = render(<><button>Outside</button><LoopExecution {...f.props} /></>);
    const stop = await screen.findByRole('button', {name: 'Stop Loop session'});
    const retained = screen.getByRole('region', {name: 'Loop session session'});
    let finish!: (value: Response) => void;
    let fail!: (error: Error) => void;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (path: string, options: RequestInit) => path === '/api/loops/v1'
      ? new Promise<Response>((resolve, reject) => {finish = resolve; fail = reject;}) : original(path, options));
    await userEvent.click(screen.getByRole('button', {name: 'Refresh Loop session records'}));
    if (mode === 'surviving') retained.focus(); else stop.focus();
    if (mode === 'outside') screen.getByRole('button', {name: 'Outside'}).focus();
    if (mode === 'obsolete') view.rerender(<><button>Outside</button><LoopExecution {...f.props} connected={false} /></>);
    const before = document.activeElement;
    await act(async () => {
      if (mode === 'failed') fail(new Error('offline'));
      else finish(new Response(JSON.stringify(mode === 'invalid' ? {sessions: 'invalid'} : {...f.data, sessions: mode === 'terminal' ? [{...session, state: 'stopped'}] : mode === 'surviving' ? [session] : []})));
    });
    if (mode === 'removed') expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Run a bounded Loop'}));
    else if (mode === 'terminal') expect(document.activeElement).toBe(retained);
    else expect(document.activeElement).toBe(before);
    expect(screen.getByLabelText('Loop focus update').textContent).toMatch(mode === 'removed' ? /no longer appears/ : mode === 'terminal' ? /Stop is no longer available/ : /^$/);
    expect(f.props.submit).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.every(call => !call[0].endsWith('/start') && !call[0].endsWith('/stop'))).toBe(true);
  } finally {timer.mockRestore();}
});
