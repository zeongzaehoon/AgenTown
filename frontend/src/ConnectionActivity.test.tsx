import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ConnectionActivity, isActivity } from './ConnectionActivity';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const attempt = {task_id: 'saved', run_id: 'run-1', started_at: 10, ended_at: 20, state: 'finished', outcome: 'reported_success', declared_source: 'codex', integration: 'codex'};
const snapshot = {schema_version: 1, limit: 50, attempts: [attempt], evidence: {
  read_only: true, source: 'persisted_run_records', source_labels: 'untrusted_historical_metadata',
  current_connection_verified: false, authenticated_client_identity_verified: false, quality_approved: false, local_product_attempts_excluded: true,
}};

test('explicit keyboard loading presents separate records, retains focus and only explicitly navigates saved work', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(snapshot)));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn(); const user = userEvent.setup();
  const view = render(<ConnectionActivity clientId="codex" connected savedTaskIds={['saved']} onOpenRecordedTask={open} />);
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByText('Recorded activity not loaded.')).toBeTruthy();
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  load.focus(); await user.keyboard('{Enter}');
  await screen.findByText(/Recorded outcome: reported_success/);
  expect(document.activeElement).toBe(load);
  expect(screen.getByText('Declared source (untrusted): codex')).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  const link = screen.getByRole('button', {name: /Open saved Task/});
  link.focus(); await user.keyboard('{Enter}'); expect(open).toHaveBeenCalledWith({taskId: 'saved', runId: 'run-1'});
  view.rerender(<ConnectionActivity clientId="cursor" connected savedTaskIds={['saved']} onOpenRecordedTask={open} />);
  expect(screen.getByText(/No recorded activity for this declared client/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toBeDefined();
});

test('disconnect cancels late results without replay; retained records stay stale and removed Tasks cannot navigate', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot))).mockImplementationOnce(() => new Promise<Response>(r => {resolve = r;}));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn(); const user = userEvent.setup();
  const view = render(<ConnectionActivity clientId="codex" connected savedTaskIds={['saved']} onOpenRecordedTask={open} />);
  await user.click(screen.getByRole('button', {name: 'Load recorded activity'}));
  await screen.findByText(/^Run: run-1 · Task: saved$/);
  await user.click(screen.getByRole('button', {name: 'Load recorded activity'}));
  expect(screen.getByText('Loading recorded activity…')).toBeTruthy();
  view.rerender(<ConnectionActivity clientId="codex" connected={false} savedTaskIds={['saved']} onOpenRecordedTask={open} />);
  await act(async () => resolve(new Response(JSON.stringify({...snapshot, attempts: []}))));
  view.rerender(<ConnectionActivity clientId="codex" connected savedTaskIds={[]} onOpenRecordedTask={open} />);
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  expect(screen.getByText(/^Run: run-1 · Task: saved$/)).toBeTruthy();
  const button = screen.getByRole('button', {name: /Open saved Task/});
  expect(button.getAttribute('aria-disabled')).toBe('true');
  await user.click(button); expect(open).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [path, options] of fetcher.mock.calls) {
    expect(path).toBe('/api/connections/v1/activity');
    expect(options.method).toBe('POST'); expect(JSON.parse(options.body)).toEqual({limit: 50});
  }
});

test('empty and unavailable are distinct and failed refresh retains stale records', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({...snapshot, attempts: []})))
    .mockResolvedValueOnce(new Response(JSON.stringify(snapshot))).mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher); const user = userEvent.setup();
  render(<ConnectionActivity clientId="codex" connected />);
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  await user.click(load); await screen.findByText(/No recorded activity for this declared client/);
  await user.click(load); await screen.findByText(/^Run: run-1 · Task: saved$/);
  await user.click(load); await screen.findByText(/Recorded activity unavailable/);
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  expect(screen.getByText(/^Run: run-1 · Task: saved$/)).toBeTruthy();
});

test('malformed records or dishonest evidence rejected atomically; unknown source stays unattributed', async () => {
  expect(isActivity(snapshot)).toBe(true);
  for (const invalid of [null, {}, {...snapshot, attempts: [attempt, attempt]}, {...snapshot, attempts: [{...attempt, integration: 'cursor'}]}, {...snapshot, evidence: {...snapshot.evidence, quality_approved: true}}, {...snapshot, attempts: [{...attempt, started_at: '10'}]}]) expect(isActivity(invalid)).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({...snapshot, attempts: [{...attempt, declared_source: '<untrusted>', integration: null}]}))));
  render(<ConnectionActivity clientId="codex" connected />);
  await userEvent.setup().click(screen.getByRole('button', {name: 'Load recorded activity'}));
  await waitFor(() => expect(screen.getByText('Declared source (untrusted): <untrusted>')).toBeTruthy());
  expect(screen.getByRole('list', {name: 'Unclassified recorded attempts'})).toBeTruthy();
  expect(screen.queryByRole('list', {name: 'Selected client recorded attempts'})).toBeNull();
});

test('late snapshot follows current client without replay or duplicate loading', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(r => {resolve = r;}));
  vi.stubGlobal('fetch', fetcher); const user = userEvent.setup();
  const view = render(<ConnectionActivity clientId="codex" connected />);
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  await user.click(load); await user.click(load);
  expect(fetcher).toHaveBeenCalledTimes(1);
  view.rerender(<ConnectionActivity clientId="cursor" connected />);
  await act(async () => resolve(new Response(JSON.stringify(snapshot))));
  expect(screen.getByText(/No recorded activity for this declared client/)).toBeTruthy();
  expect(screen.queryByText('Declared source (untrusted): codex')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('refresh removing a focused record recovers focus to activity heading', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
    .mockImplementationOnce(() => new Promise<Response>(r => {resolve = r;}));
  vi.stubGlobal('fetch', fetcher); const user = userEvent.setup();
  render(<ConnectionActivity clientId="codex" connected savedTaskIds={['saved']} onOpenRecordedTask={vi.fn()} />);
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  await user.click(load); await screen.findByText(/^Run: run-1 · Task: saved$/);
  await user.click(load);
  screen.getByRole('button', {name: /Open saved Task/}).focus();
  await act(async () => resolve(new Response(JSON.stringify({...snapshot, attempts: []}))));
  expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Recorded integration activity'}));
});

test('client filtering recovers only removed activity focus, retaining surviving, outside and hidden focus without requests or navigation', async () => {
  const fetcher = vi.fn(async (_path: string) => new Response(JSON.stringify({...snapshot, attempts: [attempt,
    {...attempt, run_id: 'unknown-run', declared_source: 'unknown', integration: null}]})));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  const props = {connected: true, savedTaskIds: ['saved'], onOpenRecordedTask: open};
  const ui = (clientId: string, hidden = false) => <><input aria-label="Outside draft" /><div hidden={hidden}>
    <ConnectionActivity {...props} clientId={clientId} />
  </div></>;
  const view = render(ui('codex'));
  await userEvent.setup().click(screen.getByRole('button', {name: 'Load recorded activity'}));
  const removed = await screen.findByRole('button', {name: 'Open saved Task: saved · Run: run-1'});
  removed.focus();
  view.rerender(ui('cursor'));
  expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Recorded integration activity'}));
  expect(screen.getByRole('status').textContent).toContain('no longer shown for the selected integration');
  expect(screen.queryByRole('button', {name: 'Open saved Task: saved · Run: run-1'})).toBeNull();
  const unclassified = screen.getByRole('button', {name: 'Open saved Task: saved · Run: unknown-run'});
  unclassified.focus();
  view.rerender(ui('codex'));
  expect(document.activeElement).toBe(unclassified);
  expect(screen.queryByText(/no longer shown for the selected integration/)).toBeNull();
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  load.focus(); view.rerender(ui('cursor'));
  expect(document.activeElement).toBe(load);
  view.rerender(ui('codex'));
  const outside = screen.getByLabelText('Outside draft');
  outside.focus(); view.rerender(ui('cursor'));
  expect(document.activeElement).toBe(outside);
  expect(screen.queryByText(/no longer shown for the selected integration/)).toBeNull();
  view.rerender(ui('codex'));
  screen.getByRole('button', {name: 'Open saved Task: saved · Run: run-1'}).focus();
  view.rerender(ui('cursor', true));
  expect(document.activeElement).toBe(document.body);
  expect(screen.queryByText(/no longer shown for the selected integration/)).toBeNull();
  view.rerender(ui('cursor'));
  expect(document.activeElement).toBe(document.body);
  view.rerender(ui('codex'));
  expect(document.activeElement).toBe(document.body);
  expect(screen.queryByText(/no longer shown for the selected integration/)).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/connections/v1/activity');
});


test.each(['success', 'failure'])('keyboard cancellation releases initial loading and isolates immediate reload from late %s', async late => {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  let resolveReload!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((yes, no) => {resolve = yes; reject = no;}))
    .mockImplementationOnce(() => new Promise<Response>(yes => {resolveReload = yes;}));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<ConnectionActivity clientId="codex" connected />);
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  await user.click(load);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: /Cancel waiting/}));
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(load);
  expect(screen.getByRole('status').textContent).toContain('Stopped waiting for recorded activity');
  expect(screen.getByRole('status').textContent).toContain('does not confirm that the server stopped');
  expect(screen.getByText('Recorded activity not loaded.')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  fireEvent.click(load);
  await act(async () => {
    if (late === 'success') resolve(new Response(JSON.stringify(snapshot)));
    else reject(new Error('late failure'));
  });
  expect(screen.getByText('Loading recorded activity…')).toBeTruthy();
  fireEvent.click(load);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => resolveReload(new Response(JSON.stringify(snapshot))));
  expect(screen.getByText(/^Run: run-1/)).toBeTruthy();
  expect(screen.queryByText(/potentially stale/)).toBeNull();

});

test.each(['success', 'failure'])('retained cancellation protects a pending reload against late %s and disconnect', async late => {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
    .mockImplementationOnce(() => new Promise<Response>((yes, no) => {resolve = yes; reject = no;}))
    .mockImplementationOnce(() => new Promise<Response>(yes => {finish = yes;}));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ConnectionActivity clientId="codex" connected />);
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  await userEvent.setup().click(load);
  await screen.findByText(/^Run: run-1/);
  fireEvent.click(load);
  act(() => {
    fireEvent.click(screen.getByRole('button', {name: /Cancel waiting/}));
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    fireEvent.click(load);
  });
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  await act(async () => {
    if (late === 'success') resolve(new Response(JSON.stringify({...snapshot, attempts: []})));
    else reject(new Error('late failure'));
  });
  expect(screen.getByText('Loading recorded activity…')).toBeTruthy();
  expect(screen.queryByText(/Recorded activity unavailable/)).toBeNull();
  expect(screen.getByText(/^Run: run-1/)).toBeTruthy();
  fireEvent.click(load);
  expect(fetcher).toHaveBeenCalledTimes(3);
  screen.getByRole('button', {name: /Cancel waiting/}).focus();
  view.rerender(<ConnectionActivity clientId="codex" connected={false} />);
  expect(document.activeElement).toBe(load);
  expect(screen.queryByRole('button', {name: /Cancel waiting/})).toBeNull();
  await act(async () => finish(new Response(JSON.stringify({...snapshot, attempts: []}))));
  view.rerender(<ConnectionActivity clientId="codex" connected />);
  expect(screen.getByText(/^Run: run-1/)).toBeTruthy();
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test.each(['cancel', 'success', 'failure', 'disconnect'])('%s recovers disappearing cancel focus only while visible and still owned', async ending => {
  const requests: {resolve: (response: Response) => void; reject: (reason: Error) => void}[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => requests.push({resolve, reject}))));
  const ui = (hidden = false, connected = true) => <><input aria-label="Outside" /><div hidden={hidden}>
    <ConnectionActivity clientId="codex" connected={connected} />
  </div></>;
  const view = render(ui());
  async function end(hidden = false) {
    if (ending === 'cancel') fireEvent.click(screen.getByRole('button', {name: /Cancel waiting/, hidden}));
    else if (ending === 'disconnect') view.rerender(ui(hidden, false));
    else await act(async () => {
      const request = requests[requests.length - 1];
      if (ending === 'success') request.resolve(new Response(JSON.stringify(snapshot)));
      else request.reject(new Error('failure'));
    });
  }
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  fireEvent.click(load);
  screen.getByRole('button', {name: /Cancel waiting/}).focus();
  await end();
  expect(document.activeElement).toBe(load);
  view.rerender(ui());
  fireEvent.click(load);
  const outside = screen.getByLabelText('Outside'); outside.focus();
  await end();
  expect(document.activeElement).toBe(outside);
  view.rerender(ui());
  fireEvent.click(load);
  screen.getByRole('button', {name: /Cancel waiting/}).focus();
  view.rerender(ui(true));
  await end(true);
  expect(document.activeElement).not.toBe(load);
  view.rerender(ui());
  expect(document.activeElement).not.toBe(load);
});


test.each(['cancel', 'disconnect', 'malformed', 'failure'])('snapshot receipt time and records survive %s and update together only on explicit success', async ending => {
  const first = Date.parse('2026-01-01T12:00:00Z');
  const second = Date.parse('2026-01-01T13:00:00Z');
  const now = vi.spyOn(Date, 'now').mockReturnValue(first);
  const requests: {resolve: (response: Response) => void; reject: (reason: Error) => void}[] = [];
  const fetcher = vi.fn(() => new Promise<Response>((resolve, reject) => requests.push({resolve, reject})));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ConnectionActivity clientId="codex" connected />);
  const receipt = () => screen.queryByText(/Entire recorded activity snapshot received by this browser/)?.querySelector('time') ?? null;
  const load = screen.getByRole('button', {name: 'Load recorded activity'});
  expect(receipt()).toBeNull();
  fireEvent.click(load);
  expect(receipt()).toBeNull();
  await act(async () => requests[0].resolve(new Response(JSON.stringify(snapshot))));
  expect(receipt()?.getAttribute('datetime')).toBe(new Date(first).toISOString());
  expect(receipt()?.textContent).toBe(new Date(first).toLocaleString());
  expect(screen.getByText(/Receipt time is distinct from recorded Run start\/end times and does not verify current client connectivity/)).toBeTruthy();
  expect(screen.getByText(/Recorded Run start:/).querySelector('time')?.getAttribute('datetime')).toBe(new Date(10).toISOString());
  expect(screen.getByText(/Recorded Run end:/).querySelector('time')?.getAttribute('datetime')).toBe(new Date(20).toISOString());
  now.mockReturnValue(second);
  fireEvent.click(load);
  expect(receipt()?.getAttribute('datetime')).toBe(new Date(first).toISOString());
  expect(screen.getByText(/^Run: run-1/)).toBeTruthy();
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  if (ending === 'cancel') fireEvent.click(screen.getByRole('button', {name: /Cancel waiting/}));
  else if (ending === 'disconnect') view.rerender(<ConnectionActivity clientId="codex" connected={false} />);
  else await act(async () => {
    if (ending === 'malformed') requests[1].resolve(new Response('{}'));
    else requests[1].reject(new Error('unavailable'));
  });
  expect(receipt()?.getAttribute('datetime')).toBe(new Date(first).toISOString());
  expect(screen.getByText(/^Run: run-1/)).toBeTruthy();
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  view.rerender(<ConnectionActivity clientId="codex" connected />);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(load);
  if (ending === 'cancel' || ending === 'disconnect') {
    await act(async () => requests[1].resolve(new Response(JSON.stringify({...snapshot, attempts: []}))));
    expect(screen.getByText('Loading recorded activity…')).toBeTruthy();
    expect(receipt()?.getAttribute('datetime')).toBe(new Date(first).toISOString());
    expect(screen.getByText(/^Run: run-1/)).toBeTruthy();
  }
  await act(async () => requests[2].resolve(new Response(JSON.stringify({...snapshot, attempts: []}))));
  expect(receipt()?.getAttribute('datetime')).toBe(new Date(second).toISOString());
  expect(screen.queryByText(/^Run: run-1/)).toBeNull();
  expect(screen.getByText(/No recorded activity for this declared client/)).toBeTruthy();
  expect(screen.queryByText(/potentially stale/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('an initial validated empty snapshot has a browser receipt time', async () => {
  const received = Date.parse('2026-02-01T12:00:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(received);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({...snapshot, attempts: []}))));
  const view = render(<ConnectionActivity clientId="codex" connected />);
  fireEvent.click(screen.getByRole('button', {name: 'Load recorded activity'}));
  await screen.findByText(/No recorded activity for this declared client/);
  expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe(new Date(received).toISOString());
});


test('recorded Run times localize completed and active attempts, preserve zero and range limits across filtering and failed refresh', async () => {
  const records = {...snapshot, attempts: [
    {...attempt, started_at: 0, ended_at: 20},
    {...attempt, run_id: 'active', started_at: 1000, ended_at: null, state: 'active', outcome: null},
    {...attempt, run_id: 'outside', started_at: Number.MAX_SAFE_INTEGER, ended_at: 8640000000000001},
    {...attempt, run_id: 'cursor', declared_source: 'cursor', integration: 'cursor', started_at: 2000, ended_at: 3000},
  ]};
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(records)))
    .mockRejectedValueOnce(new Error('refresh failed'));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ConnectionActivity clientId="codex" connected />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', {name: 'Load recorded activity'}));
  await screen.findByText(/^Run: run-1/);
  const row = (id: string) => within(screen.getByText(`Run: ${id} · Task: saved`).closest('li')!);
  const completed = row('run-1');
  for (const [label, value] of [['start', 0], ['end', 20]] as const) {
    const field = completed.getByText(new RegExp(`Recorded Run ${label}:`));
    expect(field.querySelector('time')?.getAttribute('datetime')).toBe(new Date(value).toISOString());
    expect(field.querySelector('time')?.textContent).toBe(new Date(value).toLocaleString());
    expect(field.textContent).toContain(`Unix milliseconds: ${value}`);
  }
  expect(row('active').getByText(/Recorded Run end:/).textContent).toBe('Recorded Run end: Not recorded');
  expect(row('active').getByText(/Recorded Run end:/).querySelector('time')).toBeNull();
  expect(row('active').getByText(/Recorded Run start:/).querySelector('time')?.getAttribute('datetime')).toBe(new Date(1000).toISOString());
  for (const label of ['start', 'end']) {
    const field = row('outside').getByText(new RegExp(`Recorded Run ${label}:`));
    expect(field.textContent).toContain('Local date unavailable (outside supported date range)');
    expect(field.textContent).toContain(label === 'start' ? '9007199254740991' : '8640000000000001');
    expect(field.querySelector('time')).toBeNull();
  }
  const retained = screen.getByRole('list', {name: 'Selected client recorded attempts'}).innerHTML;
  await user.click(screen.getByRole('button', {name: 'Load recorded activity'}));
  await screen.findByText(/Recorded activity unavailable/);
  expect(screen.getByText(/potentially stale/)).toBeTruthy();
  expect(screen.getByRole('list', {name: 'Selected client recorded attempts'}).innerHTML).toBe(retained);
  view.rerender(<ConnectionActivity clientId="cursor" connected />);
  expect(screen.queryByText(/^Run: run-1/)).toBeNull();
  expect(row('cursor').getByText(/Recorded Run start:/).querySelector('time')?.getAttribute('datetime')).toBe(new Date(2000).toISOString());
  view.rerender(<ConnectionActivity clientId="codex" connected />);
  expect(screen.getByRole('list', {name: 'Selected client recorded attempts'}).innerHTML).toBe(retained);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Declared source is untrusted historical metadata/)).toBeTruthy();
});
