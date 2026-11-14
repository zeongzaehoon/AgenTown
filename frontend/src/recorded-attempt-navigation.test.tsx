import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { ConnectionActivity, type ActivityNavigation } from './ConnectionActivity';

// Isolate setup configuration; keep the real activity loading and navigation flow.
vi.mock('./Connections', async importOriginal => ({...await importOriginal<typeof import('./Connections')>(), Connections: (props: ActivityNavigation & {workspaceConnected: boolean}) =>
  <ConnectionActivity {...props} clientId="codex" connected={props.workspaceConnected} />}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('opens and refocuses an older recorded result, reports missing Runs, and guards disconnect without changing drafts', async () => {
  let disconnected = false;
  const calls: string[] = [];
  const state = {employees: [{id: 'writer', name: 'Writer'}], configuration: null,
    provider: 'deterministic-test', model: 'test-model', work: [{id: 'other', input: 'Initially selected request', status: 'pending', assignees: ['writer'], attempts: []}, {id: 'saved', input: 'Saved request',
      status: 'completed', assignees: ['writer'], attempts: ['older', 'latest'].map((id, i) => ({
        id, participants: ['writer'], state: 'finished', outcome: 'success', output: `${id} recorded result`, error: null,
        provider: 'deterministic-test', model: 'test-model', started: 10 + i, ended: 20 + i,
        declared_source: 'codex',
      }))}]};
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    calls.push(path);
    if (disconnected) throw new TypeError('network');
    if (path === '/api/state') return new Response(JSON.stringify(state));
    if (path === '/api/connections/v1/activity') return new Response(JSON.stringify({schema_version: 1, limit: 50,
      attempts: ['older', 'latest', 'absent'].map(run_id => ({task_id: 'saved', run_id, started_at: 10, ended_at: 20,
        state: 'finished', outcome: 'success', declared_source: 'codex', integration: 'codex'})),
      evidence: {read_only: true, source: 'persisted_run_records', source_labels: 'untrusted_historical_metadata',
        current_connection_verified: false, authenticated_client_identity_verified: false, quality_approved: false, local_product_attempts_excluded: true}}));
    if (path === '/api/teams') return new Response('{"teams":[]}');
    return new Response('{}');
  }));
  const user = userEvent.setup(); render(<App />);
  await screen.findByText('Initially selected request', {selector: 'pre'});
  const draft = screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement;
  fireEvent.change(draft, {target: {value: 'Keep my unsaved draft'}});
  await user.click(screen.getByRole('button', {name: 'Load recorded activity'}));
  const olderButton = await screen.findByRole('button', {name: 'Open saved Task: saved · Run: older'});
  let older = document.querySelector<HTMLDetailsElement>('[data-attempt-id="older"]')!;
  expect(older).toBeNull();
  olderButton.focus(); await user.keyboard('{Enter}');
  older = document.querySelector<HTMLDetailsElement>('[data-attempt-id="older"]')!;
  await waitFor(() => expect(document.activeElement).toBe(older.querySelector('summary')));
  expect(older.open).toBe(true);
  expect(older.querySelector('summary')!.textContent).toContain('Selected recorded attempt');
  expect(older.textContent).toContain('older recorded result');
  expect(older.textContent).toContain('Caller-declared source (unverified)');
  expect(older.textContent).toContain('Unverified');
  // Both native disclosures remain in the Tab order after exact-Run focus.
  const latest = document.querySelector<HTMLDetailsElement>('[data-attempt-id="latest"]')!;
  const latestSummary = latest.querySelector('summary')!;
  latestSummary.focus();
  await user.tab({shift: true});
  await user.tab();
  expect(document.activeElement).toBe(latestSummary);
  const olderSummary = older.querySelector('summary')!;
  olderSummary.focus();
  await user.tab({shift: true});
  await user.tab();
  expect(document.activeElement).toBe(olderSummary);
  // A new explicit request for the same identity must restore expansion and focus.
  fireEvent.click(olderSummary);
  await user.click(olderButton);
  await waitFor(() => expect(document.activeElement).toBe(older.querySelector('summary')));
  expect(older.open).toBe(true);
  await user.click(screen.getByRole('button', {name: 'Open saved Task: saved · Run: absent'}));
  const unavailable = screen.getByText(/Recorded attempt unavailable in the current workspace snapshot/);
  expect(unavailable.textContent).toContain('Run: absent');
  expect(document.activeElement).toBe(unavailable);
  expect(screen.queryByText(/Selected recorded attempt/)).toBeNull();
  expect(draft.value).toBe('Keep my unsaved draft');
  disconnected = true;
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await screen.findByText(/Workspace disconnected. Activity loading/);
  await user.click(olderButton);
  expect(screen.getByText(/Recorded attempt unavailable/)).toBe(unavailable);
  expect(screen.queryByText(/Selected recorded attempt/)).toBeNull();
  expect(draft.value).toBe('Keep my unsaved draft');
  expect(calls.filter(path => /execute|retry/.test(path))).toEqual([]);
  expect(calls.filter(path => path === '/api/connections/v1/activity')).toHaveLength(1);
});
