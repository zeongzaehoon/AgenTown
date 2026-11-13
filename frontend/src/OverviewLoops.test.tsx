import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
  expect(screen.getByText(/Requested Task: t · Loop: s/)).toBeTruthy();
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

test('keyboard navigation carries exact Task and session without mutation', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(initial())));
  vi.stubGlobal('fetch', fetcher);
  const navigate = vi.fn();
  const open = vi.fn();
  render(<OverviewLoops workspace={workspace} onOpenWork={open} onOpenSession={navigate} />);
  const button = await screen.findByRole('button', {name: /Open work: Saved request/});
  button.focus(); await userEvent.keyboard('{Enter}');
  expect(navigate).toHaveBeenCalledWith({taskId: 't', sessionId: 's'});
  expect(open).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function companySession(n: number) {
  return {...session, schema_version: 1, session_id: uid(n), started_at: 1, expires_at: 100,
    preview: {...session.preview, task_id: uid(n + 10), agent_id: uid(20), policy_id: uid(n + 30), created_at: 1}};
}
function companyReply(sessions = [companySession(1), companySession(2)], state = 'competing_owner') {
  return {schema_version: 1, scope: 'company', status: 'confirmed', code: 'company_loops_inspected', recovery: 'Inspect explicitly',
    data: {schema_version: 1, sessions, attempts: [], control: {state, can_control: state === 'local_authority', message: 'Saved authority'}}};
}
test('explicit company read preserves multiple Tasks and keyboard navigation without mutations', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(path);
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    expect(path).toBe('/api/connections/v1/loops/inspect-company');
    expect(JSON.parse(init!.body as string)).toEqual({});
    return new Response(JSON.stringify(companyReply()));
  }));
  const open = vi.fn();
  render(<OverviewLoops workspace={{...workspace, work: [{...workspace.work[0], id: uid(11)}]}} onOpenWork={vi.fn()} onOpenSession={open} />);
  await act(async () => {});
  expect(requests).toEqual(['/api/loops/v1']);
  const inspect = screen.getByRole('button', {name: 'Inspect company Loops through local MCP'});
  inspect.focus(); await userEvent.keyboard('{Enter}');
  expect(await screen.findByText(`Task: ${uid(12)} · Session: ${uid(2)} · Persisted state: active`)).toBeTruthy();
  expect(screen.getByLabelText('Retained MCP owner authority').textContent).toContain('another server owns execution');
  expect(screen.getByText(/Session records remain inspectable here/)).toBeTruthy();
  const navigation = screen.getByRole('button', {name: `Inspect local MCP session ${uid(1)} in work`});
  navigation.focus(); await userEvent.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith({taskId: uid(11), sessionId: uid(1)});
  expect(requests).toEqual(['/api/loops/v1', '/api/connections/v1/loops/inspect-company']);
});
test('company inspection discards superseded responses and distinguishes empty, stale and unavailable', async () => {
  vi.useFakeTimers();
  let resolve!: (v: Response) => void;
  let companyCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    companyCalls++;
    if (companyCalls === 1) return new Promise<Response>(r => {resolve = r;});
    if (companyCalls === 2) return new Response(JSON.stringify(companyReply([])));
    throw new Error('unavailable');
  }));
  render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
  const inspect = screen.getByRole('button', {name: 'Inspect company Loops through local MCP'});
  await act(async () => {fireEvent.click(inspect);});
  await act(async () => {fireEvent.click(inspect);});
  expect(screen.getByText('No recorded local MCP sessions.')).toBeTruthy();
  await act(async () => resolve(new Response(JSON.stringify(companyReply()))));
  expect(screen.queryByText(/Persisted state:/)).toBeNull();
  await act(async () => {await vi.advanceTimersByTimeAsync(2400);});
  expect(screen.getByText(/Local MCP inspection stale/)).toBeTruthy();
  await act(async () => {fireEvent.click(inspect);});
  expect(screen.getByText(/Retained local MCP inspection unavailable/)).toBeTruthy();
});

test('company navigation keeps draft and focuses existing selected-work inspection without preview or consent', async () => {
  const {App} = await import('./App');
  const requests: string[] = [];
  const saved = {...workspace, employees: [{id: uid(20), name: 'Alex'}], work: [{...workspace.work[0], id: uid(11), assignees: [uid(20)]}]};
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(path);
    if (path === '/api/state') return new Response(JSON.stringify(saved));
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    if (path === '/api/connections/v1/loops/inspect-company') {
      expect(JSON.parse(init!.body as string)).toEqual({});
      return new Response(JSON.stringify(companyReply([companySession(1)], 'local_authority')));
    }
    if (path === '/api/connections/v1/loops/inspect') {
      expect(JSON.parse(init!.body as string)).toEqual({task_id: uid(11)});
      return new Response(JSON.stringify({schema_version: 1, requested_task_id: uid(11), status: 'confirmed', code: 'loops_inspected', recovery: 'Read only', data: companyReply([companySession(1)], 'local_authority').data}));
    }
    if (path.startsWith('/api/config/v1/')) return new Response(JSON.stringify({[path.split('/').at(-1)!]: []}));
    throw new Error(`Unexpected request ${path}`);
  }));
  render(<App />); await screen.findByRole('button', {name: 'Inspect company Loops through local MCP'});
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep company draft'}});
  await userEvent.click(screen.getByRole('button', {name: 'Inspect company Loops through local MCP'}));
  const navigation = await screen.findByRole('button', {name: `Inspect local MCP session ${uid(1)} in work`});
  navigation.focus(); await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe(uid(11));
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep company draft');
  expect(requests.filter(p => p.startsWith('/api/connections/v1/loops/'))).toEqual(['/api/connections/v1/loops/inspect-company']);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect local Loop sessions'}));
  expect(document.activeElement).toBe(await screen.findByRole('region', {name: `Local Loop session ${uid(1)}`}));
  expect(screen.getByRole('button', {name: `Stop local Loop ${uid(1)}`})).toBeTruthy();
  expect(requests.filter(p => p.startsWith('/api/connections/v1/loops/'))).toEqual(['/api/connections/v1/loops/inspect-company', '/api/connections/v1/loops/inspect']);
  expect(screen.queryByRole('checkbox', {name: /consent/i})).toBeNull();
});

test.each(['confirmed', 'offline', 'active', 'preview', 'timestamp', 'provider'])('company Stop uses exact identity and persisted confirmation: %s', async outcome => {
  const expected = companySession(1);
  const stopped = {...expected, state: 'stopped'};
  const requests: {path: string; body: unknown}[] = [];
  let deliver!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    requests.push({path, body: JSON.parse(init!.body as string)});
    if (path.endsWith('/inspect-company')) return new Response(JSON.stringify(companyReply([expected], 'local_authority')));
    if (path.endsWith('/stop')) {
      if (outcome === 'offline') throw new Error('delivery unknown');
      return new Promise<Response>(resolve => {deliver = resolve;});
    }
    expect(path).toBe('/api/connections/v1/loops/inspect');
    const saved = outcome === 'active' ? expected : outcome === 'preview' ? {...stopped, preview: {...stopped.preview, input: 'Changed'}}
      : outcome === 'timestamp' ? {...stopped, started_at: 2} : outcome === 'provider' ? {...stopped, provider: 'other'} : {...stopped, admitted: 2};
    return new Response(JSON.stringify({schema_version: 1, requested_task_id: uid(11), status: 'confirmed', code: 'loops_inspected', recovery: 'Read persisted records', data: companyReply([saved], 'local_authority').data}));
  }));
  render(<OverviewLoops workspace={{...workspace, work: []}} onOpenWork={vi.fn()} />);
  const inspect = screen.getByRole('button', {name: 'Inspect company Loops through local MCP'});
  inspect.focus(); await userEvent.keyboard('{Enter}');
  const stop = await screen.findByRole('button', {name: `Stop local MCP Loop ${uid(1)} from overview`});
  expect(screen.getByText(/Session records remain inspectable here/)).toBeTruthy();
  stop.focus(); await userEvent.keyboard('{Enter}');
  fireEvent.click(stop);
  if (outcome !== 'offline') {
    // Inspection must not supersede an in-flight mutation or re-enable dispatch.
    fireEvent.click(inspect);
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    await act(async () => deliver(new Response(JSON.stringify({schema_version: 1, requested_task_id: uid(11), status: 'confirmed', code: 'loop_stopped', recovery: 'Read persisted records', data: stopped}))));
  }
  expect(document.activeElement).toBe(stop);
  expect(screen.getByText(outcome === 'confirmed' ? /Saved stopped state confirmed for local MCP/ : /Stop outcome for local MCP session/)).toBeTruthy();
  expect(stop.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(stop);
  expect(requests.filter(r => r.path.endsWith('/stop'))).toEqual([{path: '/api/connections/v1/loops/stop', body: {task_id: uid(11), session_id: uid(1)}}]);
  expect(requests.filter(r => r.path.endsWith('/inspect'))).toHaveLength(outcome === 'offline' ? 0 : 1);
  await userEvent.click(inspect);
  expect(stop.getAttribute('aria-disabled')).toBe('false');
  expect(requests.filter(r => r.path.endsWith('/stop'))).toHaveLength(1);
});

test('company Stop requires fresh explicit granted authority and an active session', async () => {
  vi.useFakeTimers();
  let state = 'local_authority';
  let sessions = [companySession(1)];
  let unavailable = false;
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    paths.push(path);
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    if (unavailable) throw new Error('offline');
    return new Response(JSON.stringify(companyReply(sessions, state)));
  }));
  render(<OverviewLoops workspace={workspace} onOpenWork={vi.fn()} />);
  const inspect = screen.getByRole('button', {name: 'Inspect company Loops through local MCP'});
  await act(async () => { fireEvent.click(inspect); });
  const stop = screen.getByRole('button', {name: `Stop local MCP Loop ${uid(1)} from overview`});
  await act(async () => {await vi.advanceTimersByTimeAsync(2400);});
  expect(stop.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(stop);
  for (state of ['competing_owner', 'storage_failure', 'closed', 'available']) {
    await act(async () => { fireEvent.click(inspect); });
    expect(stop.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(stop);
  }
  state = 'local_authority';
  for (const terminal of ['stopped', 'complete', 'failed', 'expired', 'restarted', 'stale']) {
    sessions = [{...companySession(1), state: terminal}];
    await act(async () => { fireEvent.click(inspect); });
    expect(stop.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(stop);
  }
  sessions = [companySession(1)];
  await act(async () => { fireEvent.click(inspect); });
  unavailable = true;
  await act(async () => { fireEvent.click(inspect); });
  expect(stop.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(stop);
  expect(paths.some(p => p.endsWith('/stop'))).toBe(false);
});

test('company attempt details are session-scoped, keyboard accessible and read retained data without requests', async () => {
  // Freeze background polling while leaving user-event and React's async
  // wrapper free to settle their timeout-based keyboard interactions.
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
  const user = userEvent.setup();
  const sessions = [companySession(1), {...companySession(2), state: 'stopped', admitted: 2}];
  let attempts: LoopInspection['attempts'] = [
    {session_id: uid(1), run_id: uid(101), ordinal: 1, execution: {state: 'active', output: null, error: null}},
    {session_id: uid(2), run_id: uid(102), ordinal: 1, execution: {state: 'finished', outcome: 'failure', output: 'Partial fixture output', error: 'Fixture failure'}},
    {session_id: uid(2), run_id: uid(103), ordinal: 2, execution: null},
  ];
  const requests: string[] = [];
  const open = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(path);
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    expect(path).toBe('/api/connections/v1/loops/inspect-company');
    expect(JSON.parse(init!.body as string)).toEqual({});
    const reply = companyReply(sessions);
    return new Response(JSON.stringify({...reply, data: {...reply.data, attempts}}));
  }));
  render(<OverviewLoops workspace={{...workspace, work: []}} onOpenWork={open} onOpenSession={open} />);
  await act(async () => {});
  const inspect = screen.getByRole('button', {name: 'Inspect company Loops through local MCP'});
  await act(async () => { fireEvent.click(inspect); });
  const first = screen.getByRole('button', {name: `Attempt details for local MCP Loop ${uid(1)}`});
  const second = screen.getByRole('button', {name: `Attempt details for local MCP Loop ${uid(2)}`});
  const beforeExpand = [...requests];
  first.focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(first);
  expect(first.getAttribute('aria-expanded')).toBe('true');
  const firstDetails = screen.getByRole('region', {name: `Attempts for local MCP Loop ${uid(1)}`});
  expect(first.getAttribute('aria-controls')).toBe(firstDetails.id);
  expect(within(firstDetails).getByText(`Attempt 1 · Run ID: ${uid(101)} · Active · Waiting for provider response`)).toBeTruthy();
  expect(within(firstDetails).queryByText(/Fixture failure/)).toBeNull();
  second.focus(); await user.keyboard(' ');
  expect(document.activeElement).toBe(second);
  const secondDetails = screen.getByRole('region', {name: `Attempts for local MCP Loop ${uid(2)}`});
  expect(within(secondDetails).getByText(`Attempt 1 · Run ID: ${uid(102)} · Finished · Provider execution failed`)).toBeTruthy();
  expect(within(secondDetails).getByText('Partial fixture output')).toBeTruthy();
  expect(within(secondDetails).getByText('Fixture failure')).toBeTruthy();
  expect(within(secondDetails).getByText(`Attempt 2 · Run ID: ${uid(103)} · Execution record unavailable · Provider completion unknown`)).toBeTruthy();
  expect(within(secondDetails).queryByText(/Waiting for provider response/)).toBeNull();
  expect(within(firstDetails).getByText('Quality unverified')).toBeTruthy();
  expect(within(secondDetails).getByText('Quality unverified')).toBeTruthy();
  await user.keyboard(' ');
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('region', {name: `Attempts for local MCP Loop ${uid(2)}`})).toBeNull();
  expect(requests).toEqual(beforeExpand); // Fake clock isolates overview background polling.
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox', {name: /consent/i})).toBeNull();

  attempts = [{...attempts[0], execution: {state: 'finished', outcome: 'reported_success', output: 'Refreshed fixture result', error: null}}, ...attempts.slice(1)];
  // Reinspection leaves an already-focused disclosure mounted and expanded.
  first.focus();
  await act(async () => {fireEvent.click(inspect);});
  expect(document.activeElement).toBe(first);
  expect(first.getAttribute('aria-expanded')).toBe('true');
  expect(within(firstDetails).getByText(`Attempt 1 · Run ID: ${uid(101)} · Finished · Provider execution succeeded`)).toBeTruthy();
  expect(within(firstDetails).getByText('Refreshed fixture result')).toBeTruthy();
  expect(within(firstDetails).getByText('Quality unverified')).toBeTruthy();
  expect(requests).toEqual([...beforeExpand, '/api/connections/v1/loops/inspect-company']);
});

test.each(['expired', 'failed', 'unavailable'])('retained company attempt details visibly become stale after %s inspection', async reason => {
  vi.useFakeTimers();
  let failed = false;
  const companyPaths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/loops/v1') return new Response(JSON.stringify({...initial(), sessions: [], attempts: []}));
    companyPaths.push(path);
    expect(path).toBe('/api/connections/v1/loops/inspect-company');
    if (failed && reason === 'failed') throw new Error('offline');
    if (failed && reason === 'unavailable') return new Response(JSON.stringify({schema_version: 1, scope: 'company', status: 'unavailable', code: 'owner_unavailable', recovery: 'Inspect again', data: null}));
    const reply = companyReply([companySession(1)]);
    return new Response(JSON.stringify({...reply, data: {...reply.data, attempts: [{session_id: uid(1), run_id: uid(101), ordinal: 1, execution: {output: 'Retained fixture output', error: null}}]}}));
  }));
  render(<OverviewLoops workspace={{...workspace, work: []}} onOpenWork={vi.fn()} />);
  const inspect = screen.getByRole('button', {name: 'Inspect company Loops through local MCP'});
  await act(async () => {fireEvent.click(inspect);});
  const toggle = screen.getByRole('button', {name: `Attempt details for local MCP Loop ${uid(1)}`});
  fireEvent.click(toggle); toggle.focus();
  if (reason === 'expired') await act(async () => {await vi.advanceTimersByTimeAsync(2400);});
  else {failed = true; await act(async () => {fireEvent.click(inspect);});}
  const details = screen.getByRole('region', {name: `Attempts for local MCP Loop ${uid(1)}`});
  expect(within(details).getByText(/Stale attempt details/)).toBeTruthy();
  expect(within(details).getByText('Retained fixture output')).toBeTruthy();
  expect(within(details).getByText(/Execution state: unavailable · Provider completion unknown/)).toBeTruthy();
  expect(document.activeElement).toBe(toggle);
  const beforeToggle = [...companyPaths];
  fireEvent.click(toggle); fireEvent.click(toggle);
  expect(companyPaths).toEqual(beforeToggle);
  expect(within(screen.getByRole('region', {name: `Attempts for local MCP Loop ${uid(1)}`})).getByText(/Stale attempt details/)).toBeTruthy();
  failed = false;
  await act(async () => {fireEvent.click(inspect);});
  expect(screen.queryByText(/Stale attempt details/)).toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});
