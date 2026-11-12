import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { EXECUTION_DEADLINE_MS, REQUEST_DEADLINE_MS, type Workspace } from './api';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const state = (): Workspace => ({employees: [{id: 'e', name: 'Writer'}, {id: 'other', name: 'Editor'}],
  work: [{id: 'w', input: 'Original saved work', status: 'pending', assignees: ['e'], attempts: []}],
  configuration: null, provider: 'deterministic-test', model: 'test'});
const button = (name: string) => screen.getByRole('button', {name}) as HTMLButtonElement;
const draft = () => screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement;
const employee = () => screen.getByLabelText('Assign to') as HTMLSelectElement;
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

for (const path of ['/api/state', '/api/employees', '/api/work', '/api/work/w/execute']) {
  for (const phase of ['fetch', 'body']) {
    test(`${path} stalled ${phase} releases controls, retains draft, ignores late response and reconnects without replay`, async () => {
      vi.useFakeTimers();
      const snapshot = state();
      let stall = false;
      const late: Array<(value: never) => void> = [];
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
        if (url === '/api/teams') return new Response('{"teams":[]}');
        if (url === '/api/config/v1/loops') return new Response('{"loops":[]}');
        if (url === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
        if (url === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
        if (url === '/api/config/v1/skills') return new Response('{"skills":[]}');
        calls.push(url);
        if (stall && url === path) {
          if (url.endsWith('/execute')) expect(JSON.parse(options.body as string)).toEqual({expected_runs: 0});
          const pending = new Promise<never>(resolve => { late.push(resolve); });
          return phase === 'fetch' ? pending : {ok: true, json: () => pending};
        }
        return new Response(JSON.stringify(url === '/api/state' ? snapshot : {id: 'saved'}));
      }));
      const view = render(<StrictMode><App /></StrictMode>); await flush();
      fireEvent.change(draft(), {target: {value: 'Unsaved text'}});
      fireEvent.change(employee(), {target: {value: 'other'}});
      fireEvent.change(screen.getByLabelText('Employee name'), {target: {value: 'Unsaved employee'}});
      stall = true;
      const target = path === '/api/state' ? 'Refresh connection' : path === '/api/employees' ? 'Create employee' : path === '/api/work' ? 'Save work' : 'Execute work';
      fireEvent.click(button(target));
      if (path !== '/api/state') fireEvent.click(button(target));
      await flush();
      await advance(path.endsWith('/execute') ? EXECUTION_DEADLINE_MS : REQUEST_DEADLINE_MS);
      expect(document.body.textContent).toContain('timed out');
      expect(draft().disabled).toBe(false);
      expect(draft().value).toBe('Unsaved text');
      expect(employee().value).toBe('other');
      expect((screen.getByLabelText('Employee name') as HTMLInputElement).value).toBe('Unsaved employee');
      expect(screen.getByText('Original saved work', {selector: 'pre'})).toBeTruthy();
      if (path !== '/api/state') {
        expect(button(target).disabled).toBe(true);
        expect(document.body.textContent).toContain('does not prove provider cancellation');
        expect(calls.filter(url => url === path)).toHaveLength(1);
      }
      stall = false;
      fireEvent.click(button('Refresh connection')); await flush();
      expect(document.querySelector('#connection')!.textContent).toContain('Connected');
      if (path === '/api/employees' || path === '/api/work') {
        expect(button(target).disabled).toBe(true);
        expect(button('I inspected employees and saved work').disabled).toBe(false);
        expect(calls.filter(url => url === path)).toHaveLength(1);
        fireEvent.click(button('I inspected employees and saved work'));
        expect(button(target).disabled).toBe(false);
      }
      await act(async () => {
        for (const resolve of late) resolve((phase === 'fetch' ? new Response('{"id":"late","employees":[],"work":[]}') : {id: 'late', employees: [], work: []}) as never);
      });
      expect(draft().value).toBe('Unsaved text');
      expect(employee().value).toBe('other');
      expect(screen.getByText('Original saved work', {selector: 'pre'})).toBeTruthy();
      if (path !== '/api/state') expect(calls.filter(url => url === path)).toHaveLength(1);
      else expect(calls.every(url => url === '/api/state')).toBe(true);
      view.unmount(); await flush();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
}

for (const path of ['/api/employees', '/api/work', '/api/work/w/execute']) {
  test(`${path} followed by stalled history releases its lock within the additional history deadline`, async () => {
    vi.useFakeTimers();
    let stallHistory = false;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teams') return new Response('{"teams":[]}');
      if (url === '/api/config/v1/loops') return new Response('{"loops":[]}');
      if (url === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
      if (url === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
      if (url === '/api/config/v1/skills') return new Response('{"skills":[]}');
      calls.push(url);
      if (url === '/api/state') return stallHistory ? new Promise(() => {}) : new Response(JSON.stringify(state()));
      stallHistory = true;
      return new Response('{"id":"w"}');
    }));
    render(<App />); await flush();
    fireEvent.change(draft(), {target: {value: 'Save this'}});
    fireEvent.change(screen.getByLabelText('Employee name'), {target: {value: 'New employee'}});
    const target = path === '/api/employees' ? 'Create employee' : path === '/api/work' ? 'Save work' : 'Execute work';
    fireEvent.click(button(target)); await flush();
    expect(button(target).disabled).toBe(true);
    await advance(REQUEST_DEADLINE_MS);
    expect(document.querySelector('#connection')!.textContent).toContain('History refresh timed out');
    expect(draft().disabled).toBe(false);
    expect(employee().disabled).toBe(false);
    // Unsaved text survives execution and employee creation; confirmed work saving clears it.
    expect(draft().value).toBe(path === '/api/work' ? '' : 'Save this');
    stallHistory = false;
    fireEvent.click(button('Refresh connection')); await flush();
    expect(button(target).disabled).toBe(false);
    expect(calls.filter(url => url !== '/api/state')).toEqual([path]);
  });
}

test('unmount cancels pending mutation and history without starting a recovery request', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  let pending = false;
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    if (_url === '/api/teams') return new Response('{"teams":[]}');
    if (_url === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (_url === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
    if (_url === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (_url === '/api/config/v1/skills') return new Response('{"skills":[]}');
    signals.push(options.signal as AbortSignal);
    return pending ? new Promise(() => {}) : new Response(JSON.stringify(state()));
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<App />); await flush();
  pending = true;
  fireEvent.click(button('Execute work'));
  fireEvent.click(button('Refresh connection')); await flush();
  // Focus schedules jsdom's zero-delay selectionchange event. Drain it before
  // measuring unmount cleanup, without advancing any request deadline.
  await advance(0);
  expect(signals.slice(-2).every(signal => !signal.aborted)).toBe(true);
  // State, Skills, Hooks, saved-work Loops and overview Loop inspection each poll
  // independently; the pending mutation and history request add two deadlines.
  expect(vi.getTimerCount()).toBe(7);
  const count = fetcher.mock.calls.length;
  view.unmount(); await flush();
  expect(signals.slice(-2).every(signal => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(count);
});

for (const path of ['/api/work', '/api/work/w/execute']) {
  test(`${path} and its recovery both stall: lock is bounded by the sum of deadlines`, async () => {
    vi.useFakeTimers();
    let stalled = false;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teams') return new Response('{"teams":[]}');
      if (url === '/api/config/v1/loops') return new Response('{"loops":[]}');
      if (url === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
      if (url === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
      if (url === '/api/config/v1/skills') return new Response('{"skills":[]}');
      calls.push(url);
      return stalled ? new Promise(() => {}) : new Response(JSON.stringify(state()));
    }));
    render(<App />); await flush();
    fireEvent.change(draft(), {target: {value: 'Keep my draft'}});
    stalled = true;
    const target = path === '/api/work' ? 'Save work' : 'Execute work';
    fireEvent.click(button(target)); await flush();
    await advance(path.endsWith('/execute') ? EXECUTION_DEADLINE_MS : REQUEST_DEADLINE_MS);
    await advance(REQUEST_DEADLINE_MS);
    expect(draft().disabled).toBe(false);
    expect(draft().value).toBe('Keep my draft');
    expect(document.querySelector('#connection')!.textContent).toContain('timed out');
    stalled = false;
    fireEvent.click(button('Refresh connection')); await flush();
    if (path === '/api/work') fireEvent.click(button('I inspected employees and saved work'));
    expect(button(target).disabled).toBe(false);
    expect(calls.filter(url => url !== '/api/state')).toEqual([path]);
  });
}
