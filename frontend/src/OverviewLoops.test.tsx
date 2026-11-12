import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { OverviewLoops } from './OverviewLoops';
import type { LoopInspection, LoopSession } from './LoopExecution';
import type { Workspace } from './api';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const workspace: Workspace = {employees: [{id: 'a', name: 'Alex'}], work: [{id: 't', input: 'Saved request', assignees: ['a'], status: 'pending', attempts: []}], configuration: null, provider: 'test', model: 'test'};
const session: LoopSession = {session_id: 's', state: 'active', admitted: 1, next_at: 0, provider: 'test', model: 'test', preview: {schema_version: 1, preview_id: 'p', policy_id: 'l', policy_name: 'Follow up', task_id: 't', agent_id: 'a', input: 'Saved request', max_iterations: 2, interval_seconds: 60, expected_runs: 0, policy_enabled: true}};
const initial = (): LoopInspection => ({schema_version: 1, sessions: [session], attempts: [{session_id: 's', run_id: 'r', ordinal: 1, execution: {output: null, error: null}}], cancellation: ''});

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
  expect(screen.queryByRole('button')).toBeNull();
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
