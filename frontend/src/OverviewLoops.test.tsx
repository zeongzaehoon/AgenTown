import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { OverviewLoops } from './OverviewLoops';
import type { LoopInspection, LoopSession } from './LoopExecution';
import type { Workspace } from './api';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const workspace: Workspace = {employees: [{id: 'a', name: 'Alex'}], work: [{id: 't', input: 'Saved request', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'test', model: 'test'};
const session: LoopSession = {session_id: 's', state: 'active', admitted: 1, next_at: 0, provider: 'test', model: 'test', preview: {schema_version: 1, preview_id: 'p', policy_id: 'l', policy_name: 'Follow up', task_id: 't', agent_id: 'a', input: 'Saved request', max_iterations: 2, interval_seconds: 60, expected_runs: 0, policy_enabled: true}};
const initial = (): LoopInspection => ({schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [session], attempts: [{session_id: 's', run_id: 'r', ordinal: 1, execution: {output: null, error: null}}], cancellation: ''});

test('read-only inspection transitions independently through active, waiting, stale, recovered and terminal states', async () => {
  vi.useFakeTimers();
  let value = initial();
  let failed = false;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    expect(path).toBe('/api/loops/v1'); expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    if (failed) throw new Error('offline');
    return new Response(JSON.stringify(value));
  });
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const view = render(<OverviewLoops workspace={workspace} onOpenWork={open} />);
  expect(screen.getByText('Loading Loop inspection…')).toBeTruthy();
  await act(async () => {});
  expect(screen.getByText(/Active — waiting for provider response/)).toBeTruthy();
  expect(screen.getByText(/Admitted: 1 \/ 2/)).toBeTruthy();
  value = {...value, attempts: [{...value.attempts[0], execution: {output: 'fixture', error: null}}]};
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(screen.getByText(/Waiting — next admission controlled/)).toBeTruthy();
  failed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  view.rerender(<OverviewLoops workspace={{...workspace}} onOpenWork={open} />);
  expect(screen.getByText(/showing stale sessions/)).toBeTruthy();
  const button = screen.getByRole('button', {name: /Open work: Saved request/});
  button.focus(); expect(document.activeElement).toBe(button);
  fireEvent.click(button); expect(open).toHaveBeenCalledWith('t');
  failed = false;
  for (const state of ['complete', 'stopped', 'failed', 'expired', 'restarted', 'stale']) {
    value = {...value, sessions: [{...session, state}]};
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByText('Showing recorded Loop sessions.')).toBeTruthy();
    expect(screen.queryByText(/Waiting — next admission/)).toBeNull();
  }
  view.unmount();
  const calls = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});

test('unavailable initial inspection, absent linked IDs and late response cleanup are safe', async () => {
  vi.useFakeTimers();
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify(initial()));
  }));
  const view = render(<OverviewLoops workspace={{...workspace, employees: [], work: []}} onOpenWork={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByText('Loop inspection unavailable. No session data loaded.')).toBeTruthy();
  fail = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(screen.getByText(/Unavailable employee/)).toBeTruthy();
  expect(screen.getByText(/Linked work is unavailable/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Open work:/})).toBeNull();
  expect(screen.getByRole('button', {name: 'Stop Loop s from overview'})).toBeTruthy();
  view.unmount();
  let signal: AbortSignal | undefined;
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn((_path: string, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise<Response>(r => { resolve = r; }); });
  vi.stubGlobal('fetch', fetcher);
  const pending = render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  pending.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(new Response(JSON.stringify(initial()))); });
  expect(vi.getTimerCount()).toBe(0);
});

test('App linked-work navigation clears filters explicitly, preserves drafts and focuses saved-work inspection', async () => {
  vi.useFakeTimers();
  const { App } = await import('./App');
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/loops/v1/stop') {
      expect(init?.method).toBe('POST'); expect(JSON.parse(init?.body as string)).toEqual({session_id: 's'});
      return new Response('{}');
    }
    if (path === '/api/state') return new Response(JSON.stringify(workspace));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    if (path === '/api/loops/v1') return new Response(JSON.stringify(initial()));
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/skills') return new Response('{"skills":[]}');
    throw new Error(`Unexpected mutation: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep my draft'}});
  const stop = screen.getByRole('button', {name: 'Stop Loop s from overview'});
  stop.focus();
  await act(async () => { fireEvent.click(stop); fireEvent.click(stop); });
  expect(document.activeElement).toBe(stop);
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep my draft');
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/loops/v1/stop')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'hidden'}});
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect((screen.getByLabelText('Search saved work') as HTMLInputElement).value).toBe('hidden');
  const button = screen.getByRole('button', {name: 'Open work: Saved request · Loop s'});
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect((screen.getByLabelText('Search saved work') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('t');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved work'));
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep my draft');
  expect(screen.getByRole('button', {name: 'Stop Loop s'})).toBeTruthy();
});

test('competing owner remains connected for inspection and navigation with unverified source', async () => {
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    return new Response(JSON.stringify({...initial(), control: {state: 'competing_owner', can_control: false, message: ''}, sessions: [{...session, declared_source: 'claude-code'}]}));
  });
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  render(<OverviewLoops workspace={workspace} onOpenWork={open} />);
  const button = await screen.findByRole('button', {name: /Open work:/});
  expect(screen.getByText('Showing recorded Loop sessions.')).toBeTruthy();
  expect(screen.getByLabelText('Overview Loop authority').textContent).toContain('another server owns execution');
  expect(screen.getByText(/Caller-declared source \(unverified\): claude-code/)).toBeTruthy();
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith('t');
  expect(fetcher).toHaveBeenCalledTimes(1);
});


test('explicit stop without linked work ignores a pre-stop poll and requires post-stop inspection', async () => {
  vi.useFakeTimers();
  let resolvePoll!: (response: Response) => void;
  let resolveStop!: (response: Response) => void;
  let reads = 0;
  const fetcher = vi.fn((path: string, init?: RequestInit) => {
    if (path.endsWith('/stop')) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({session_id: 's'});
      return new Promise<Response>(resolve => { resolveStop = resolve; });
    }
    expect(init?.method).toBe('GET');
    ++reads;
    if (reads === 2) return new Promise<Response>(resolve => { resolvePoll = resolve; });
    return Promise.resolve(new Response(JSON.stringify(initial())));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<OverviewLoops workspace={null} onOpenWork={vi.fn()} />);
  await act(async () => {});
  const button = screen.getByRole('button', {name: 'Stop Loop s from overview'});
  button.focus();
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  fireEvent.click(button); fireEvent.click(button);
  await act(async () => { resolvePoll(new Response(JSON.stringify(initial()))); });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(reads).toBe(2);
  await act(async () => { resolveStop(new Response(JSON.stringify({...session, schema_version: 1, started_at: 0, expires_at: 1, state: 'stopped'}))); });
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByLabelText('Overview Loop stop outcome').textContent).toContain('not confirmed');
  fireEvent.click(button);
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith('/stop'))).toHaveLength(1);
  await act(async () => { fireEvent.click(screen.getByRole('button', {name: 'Inspect Loop sessions again'})); });
  expect(button.getAttribute('aria-disabled')).toBe('false');
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith('/stop'))).toHaveLength(1);
});

test.each(['race', 'ambiguous'])('%s stop failure never retries and refreshes authority before consent', async kind => {
  vi.useFakeTimers();
  let inspection = initial();
  const fetcher = vi.fn(async (path: string) => {
    if (!path.endsWith('/stop')) return new Response(JSON.stringify(inspection));
    if (kind === 'ambiguous') throw new Error('offline');
    inspection = {...initial(), control: {state: 'competing_owner', can_control: false, message: ''}};
    return new Response(JSON.stringify({error: 'Ownership changed', control: inspection.control}), {status: 409});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
  await act(async () => {});
  const button = screen.getByRole('button', {name: 'Stop Loop s from overview'});
  await act(async () => { fireEvent.click(button); });
  expect(screen.getByLabelText('Overview Loop stop outcome').textContent).toContain('not confirmed');
  expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(button.getAttribute('aria-disabled')).toBe(kind === 'race' ? 'true' : 'false');
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith('/stop'))).toHaveLength(1);
});

test('terminal, ungranted, stale and unavailable inspection prevents stop', async () => {
  vi.useFakeTimers();
  let value = initial();
  let fail = false;
  let hang = false;
  const fetcher = vi.fn(async (_path: string) => {
    if (fail) throw new Error('offline');
    if (hang) return new Promise<Response>(() => {});
    return new Response(JSON.stringify(value));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
  await act(async () => {});
  const button = screen.getByRole('button', {name: 'Stop Loop s from overview'});
  for (const state of ['complete', 'stopped', 'failed', 'expired', 'restarted', 'stale']) {
    value = {...initial(), sessions: [{...session, state}]};
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button);
  }
  value = {...initial(), control: {state: 'available', can_control: false, message: ''}};
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button);
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button);
  fail = false; value = initial();
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  hang = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
  expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button);
  expect(fetcher.mock.calls.every(call => !String(call[0]).endsWith('/stop'))).toBe(true);
});

test.each([null, {sessions: [null]}, {sessions: [{...session, preview: null}]},
  {sessions: [{...session, declared_source: {bad: true}}]},
  {attempts: [{session_id: 's', run_id: 'r', ordinal: 1, execution: {output: {bad: true}}}]}])('malformed inspection retains history, keyboard navigation and explicit stop safety: %j', async malformed => {
  let poll: () => void = () => {};
  const realInterval = globalThis.setInterval;
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) { poll = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }
    return realInterval(callback, delay, ...args);
  });
  let value: unknown = malformed === null ? null : {...initial(), ...malformed};
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    return new Response(JSON.stringify(value));
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText(/No session data loaded/)).toBeTruthy();
    value = initial(); await act(async () => poll());
    const stop = screen.getByRole('button', {name: 'Stop Loop s from overview'});
    stop.focus();
    value = malformed === null ? null : {...initial(), ...malformed};
    await act(async () => poll());
    expect(screen.getByText(/showing stale sessions/)).toBeTruthy();
    expect(document.activeElement).toBe(stop);
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(stop);
    expect(screen.getByRole('button', {name: /Open work:/})).toBeTruthy();
    value = initial(); await act(async () => poll());
    expect(stop.getAttribute('aria-disabled')).toBe('false');
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { interval.mockRestore(); }
});


test.each(['__proto__', 'constructor', 'toString'])('renders prototype-named session state %s without mutations', async state => {
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({...initial(), sessions: [{...session, state}]})));
  vi.stubGlobal('fetch', fetcher);
  render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
  expect(await screen.findByText(content => content.startsWith(`Unknown session state: ${state} ·`))).toBeTruthy();
  const stop = screen.getByRole('button', {name: 'Stop Loop s from overview'});
  expect(stop.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(stop);
  expect(fetcher.mock.calls.every(([path, init]) => path === '/api/loops/v1' && init?.method === 'GET' && init.body === undefined)).toBe(true);
});

test.each(['valid', 'null', 'malformed', 'unsupported', 'wrong-session'])('overview stop receipt %s retains records and recovers only through inspection', async kind => {
  vi.useFakeTimers();
  try {
    const receipt = {...session, schema_version: 1, started_at: 0, expires_at: 1, state: 'stopped'};
    const value = kind === 'valid' ? receipt : kind === 'null' ? null : kind === 'malformed' ? {} : kind === 'unsupported' ? {...receipt, schema_version: 2} : {...receipt, session_id: 'wrong'};
    const fetcher = vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith('/stop') ? value : initial())));
    vi.stubGlobal('fetch', fetcher);
    render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
    await act(async () => {});
    const stop = screen.getByRole('button', {name: 'Stop Loop s from overview'});
    stop.focus();
    await act(async () => { fireEvent.click(stop); fireEvent.click(stop); });
    expect(document.activeElement).toBe(stop);
    expect(screen.getByLabelText('Overview Loop stop outcome').textContent).toMatch(/not confirmed/);
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Admitted: 1 \/ 2/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', {name: 'Inspect Loop sessions again'})); });
    expect(stop.getAttribute('aria-disabled')).toBe('false');
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith('/stop'))).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

test.each(['confirmed', 'failed', 'malformed', 'stale'])('overview separates held receipt confirmation: %s and keyboard refresh never replays', async outcome => {
  let reads = 0;
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(async (path: string) => {
    if (path.endsWith('/stop')) return new Response(JSON.stringify({...session, schema_version: 1, started_at: 0, expires_at: 1, state: 'stopped'}));
    if (++reads === 2) return new Promise<Response>(r => { resolve = r; });
    return new Response(JSON.stringify(initial()));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<OverviewLoops workspace={{...workspace, work: []}} onOpenWork={vi.fn()} />);
  const stop = await screen.findByRole('button', {name: 'Stop Loop s from overview'});
  await act(async () => { fireEvent.click(stop); fireEvent.click(stop); });
  expect(screen.getByLabelText('Overview Loop stop outcome').textContent).toMatch(/response received/);
  expect(stop.getAttribute('aria-disabled')).toBe('true');
  await act(async () => resolve(new Response(JSON.stringify(outcome === 'malformed' ? null : {...initial(), sessions: [{...session, state: outcome === 'confirmed' ? 'stopped' : 'active'}]}), {status: outcome === 'failed' ? 503 : 200})));
  expect(screen.getByLabelText('Overview Loop stop outcome').textContent).toMatch(outcome === 'confirmed' ? /Saved stopped state confirmed/ : /not confirmed/);
  expect(screen.getByText(/Linked work is unavailable/)).toBeTruthy();
  const user = userEvent.setup();
  screen.getByRole('button', {name: 'Inspect Loop sessions again'}).focus();
  await user.keyboard('{Enter}');
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith('/stop'))).toHaveLength(1);
});
