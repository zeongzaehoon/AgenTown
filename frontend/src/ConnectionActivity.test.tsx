import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ConnectionActivity, isActivity } from './ConnectionActivity';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
  link.focus(); await user.keyboard('{Enter}'); expect(open).toHaveBeenCalledWith('saved');
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
