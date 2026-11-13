import { afterEach, expect, test, vi } from 'vitest';
import { api, EXECUTION_DEADLINE_MS, REQUEST_DEADLINE_MS, RequestTimeoutError } from './api';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const phase of ['fetch', 'body']) {
  test(`deadline bounds stalled ${phase}, aborts transport and ignores late completion`, async () => {
    vi.useFakeTimers();
    let finish!: (value: never) => void;
    let signal!: AbortSignal;
    const stalled = new Promise<never>(resolve => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn((_path, options) => {
      signal = options.signal;
      return phase === 'fetch' ? stalled : Promise.resolve({ok: true, json: () => stalled});
    }));
    const request = api('/api/work', {input: 'Draft'});
    const rejected = expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    await rejected;
    expect(signal.aborted).toBe(true);
    finish((phase === 'fetch' ? new Response('{}') : {id: 'late'}) as never);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

test('execution allows the full provider boundary but still expires', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  let settled = false;
  const request = api('/api/work/w/execute', {expected_runs: 0});
  void request.then(() => { settled = true; }, () => { settled = true; });
  const rejected = expect(request).rejects.toThrow('does not prove provider cancellation');
  await vi.advanceTimersByTimeAsync(65_000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(EXECUTION_DEADLINE_MS - 65_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

for (const phase of ['fetch', 'body', 'before request']) {
  test(`caller cancellation during ${phase} retains reason and cleans up`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('Caller stopped');
    vi.stubGlobal('fetch', vi.fn(() => phase === 'body'
      ? Promise.resolve({ok: true, json: () => new Promise(() => {})})
      : new Promise(() => {})));
    if (phase === 'before request') controller.abort(reason);
    const request = api('/api/state', {}, controller.signal);
    const rejected = expect(request).rejects.toBe(reason);
    await Promise.resolve();
    controller.abort(reason);
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    if (phase === 'before request') expect(fetch).not.toHaveBeenCalled();
  });
}

test('successful body reading removes timer and caller listener', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"saved"}')));
  await expect(api('/api/employees', {}, controller.signal)).resolves.toEqual({id: 'saved'});
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

// List replacement is atomic: one invalid record invalidates the entire snapshot.
for (const teams of [null, [null], [{id: '', name: 'Editors', members: []}],
  [{id: 't', name: '', members: []}], [{id: 't', name: 'Editors', members: ['']}],
  [{id: 't', name: 'Editors', members: ['a', 'a']}],
  [{id: 't', name: 'Editors', members: []}, {id: 't', name: 'Other', members: []}]]) {
  test(`rejects invalid team snapshot ${JSON.stringify(teams)}`, async () => {
    const {listTeams} = await import('./api');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({teams}))));
    await expect(listTeams()).rejects.toThrow('invalid team response');
  });
}

test('valid team receipts allow duplicate names and retain unavailable member IDs', async () => {
  const {listTeams, createTeam, addTeamMembers} = await import('./api');
  const first = {id: 't', name: 'Editors', members: ['unavailable']};
  const second = {id: 'new', name: 'Editors', members: []};
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({teams: [first, second]})))
    .mockResolvedValueOnce(new Response(JSON.stringify(second)))
    .mockResolvedValueOnce(new Response(JSON.stringify({...first, members: ['unavailable', 'a']}))));
  await expect(listTeams()).resolves.toEqual({teams: [first, second]});
  await expect(createTeam(' Editors ', undefined, ['t'])).resolves.toEqual(second);
  await expect(addTeamMembers('t', ['a'], undefined, first)).resolves.toEqual({...first, members: ['unavailable', 'a']});
});

for (const saved of [
  {id: 'other', name: 'Editors', members: ['old', 'a']},
  {id: 't', name: 'Renamed', members: ['old', 'a']},
  {id: 't', name: 'Editors', members: ['old']},
  {id: 't', name: 'Editors', members: ['a']},
]) {
  test(`rejects uncorrelated membership receipt ${JSON.stringify(saved)}`, async () => {
    const {addTeamMembers} = await import('./api');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(saved))));
    await expect(addTeamMembers('t', ['a'], undefined, {id: 't', name: 'Editors', members: ['old']})).rejects.toThrow('could not be confirmed');
  });
}
