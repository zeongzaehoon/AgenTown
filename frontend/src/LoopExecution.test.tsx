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
  const data = {schema_version: 1, sessions: [] as LoopSession[], attempts: [], cancellation: 'Remote completion may remain unknown.'};
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
  expect(screen.getByRole('status').textContent).toMatch(/stale/);
  view.rerender(<LoopExecution {...f.props} disabled connected />);
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
test('polling recovers disconnected inspection without resubmitting consent', async () => {
  vi.useFakeTimers();
  try {
    const f = setup(); const original = globalThis.fetch; let offline = true;
    vi.stubGlobal('fetch', (path: string, options: RequestInit) => offline ? Promise.reject(new Error('offline')) : original(path, options));
    render(<LoopExecution {...f.props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('status').textContent).toMatch(/unavailable/);
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
