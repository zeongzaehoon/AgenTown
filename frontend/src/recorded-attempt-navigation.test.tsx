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

test.each(['web', 'local MCP'])('Company %s Loop opens exact attempts, refocuses repeated selections and preserves drafts', async owner => {
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const taskId = uid(1), agentId = uid(2), sessionId = uid(3);
  const runs = [uid(10), uid(11), uid(12)];
  let disconnected = false;
  let missingTask = false;
  const calls: string[] = [];
  const saved = {id: taskId, input: 'Saved Loop work', assignees: [agentId], status: 'completed', attempts: runs.slice(0, 2).map(id => ({
    id, participants: [agentId], state: 'finished', outcome: 'success', output: `Result ${id}`, error: null,
    provider: 'test', model: 'test', started: 10, ended: 20,
  }))};
  const session = {schema_version: 1, session_id: sessionId, started_at: 1, expires_at: 100, state: 'complete', admitted: 3, next_at: 0, provider: 'test', model: 'test',
    preview: {schema_version: 1, preview_id: uid(4), policy_id: uid(5), policy_name: 'Recorded Loop', task_id: taskId, agent_id: agentId,
      input: 'Saved Loop work', max_iterations: 3, interval_seconds: 60, expected_runs: 0, policy_enabled: true, created_at: 1}};
  const inspection = {schema_version: 1, control: {state: 'competing_owner', can_control: false, message: 'Recorded only'}, sessions: [session],
    attempts: runs.map((run_id, i) => ({session_id: sessionId, run_id, ordinal: i + 1, execution: null})), cancellation: ''};
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    calls.push(path);
    if (disconnected) throw new TypeError('network');
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: agentId, name: 'Writer'}], configuration: null,
      provider: 'test', model: 'test', work: [{id: 'other', input: 'Other work', assignees: [agentId], status: 'pending', attempts: []}, ...(missingTask ? [] : [saved])]}));
    if (path === '/api/loops/v1') return new Response(JSON.stringify(owner === 'web' ? inspection : {...inspection, sessions: [], attempts: []}));
    if (path === '/api/connections/v1/loops/inspect-company') return new Response(JSON.stringify({schema_version: 1, scope: 'company', status: 'confirmed', code: 'company_loops_inspected', recovery: 'Inspect explicitly', data: inspection}));
    if (path === '/api/teams') return new Response('{"teams":[]}');
    return new Response('{}');
  }));
  const user = userEvent.setup(); render(<App />);
  await screen.findByText('Other work', {selector: 'pre'});
  const draft = screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement;
  fireEvent.change(draft, {target: {value: 'Retain this Loop navigation draft'}});
  if (owner === 'local MCP') await user.click(screen.getByRole('button', {name: 'Inspect company Loops through local MCP'}));
  await user.click(await screen.findByRole('button', {name: `Attempt details for ${owner === 'local MCP' ? 'local MCP ' : ''}Loop ${sessionId}`}));
  const action = (id: string) => screen.getByRole('button', {name: `Open saved Task: ${taskId} · Run: ${id}`});
  const detail = (id: string) => document.querySelector<HTMLDetailsElement>(`[data-attempt-id="${id}"]`)!;
  for (const [i, key] of [[0, '{Enter}'], [1, ' ']] as const) {
    action(runs[i]).focus(); await user.keyboard(key);
    await waitFor(() => expect(document.activeElement).toBe(detail(runs[i]).querySelector('summary')));
    expect(detail(runs[i]).open).toBe(true);
    expect(detail(runs[i]).textContent).toContain('Selected recorded attempt');
  }
  fireEvent.click(detail(runs[1]).querySelector('summary')!);
  await user.click(action(runs[1]));
  await waitFor(() => expect(document.activeElement).toBe(detail(runs[1]).querySelector('summary')));
  expect(detail(runs[1]).open).toBe(true);
  await user.click(action(runs[2]));
  const unavailable = screen.getByText(/Recorded attempt unavailable in the current workspace snapshot/);
  expect(unavailable.textContent).toContain(`Task: ${taskId}`);
  expect(unavailable.textContent).toContain(`Run: ${runs[2]}`);
  expect(document.activeElement).toBe(unavailable);
  expect(screen.queryByText(/Selected recorded attempt/)).toBeNull();
  missingTask = true;
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect(action(runs[0]).getAttribute('aria-disabled')).toBe('true'));
  await user.click(action(runs[0]));
  expect(screen.queryByText(/Selected recorded attempt/)).toBeNull();
  missingTask = false; disconnected = true;
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect(screen.getByText(/Disconnected — retained Loop records/)).toBeTruthy());
  await user.click(action(runs[0]));
  expect(action(runs[0]).getAttribute('aria-disabled')).toBe('true');
  expect(draft.value).toBe('Retain this Loop navigation draft');
  expect(calls.filter(path => /preview|execute|retry|stop|acknowledge|start/.test(path))).toEqual([]);
});

test.each(['Skill use', 'Hook execution', 'Hook source'])('Company %s keyboard navigation opens exact older Runs without mutations', async surface => {
  let disconnected = false;
  let missingTask = false;
  const calls: {path: string; method: string}[] = [];
  const provenance = {run_id: 'execution', preview_id: 'preview', skill_id: 'manual', skill_name: 'Saved manual',
    instructions: 'Retained instructions', input: 'Effective saved input', admitted_at: 1};
  const hook = {...provenance, hook_id: 'trigger', hook_name: 'Saved trigger', event: 'run_completed', agent_id: 'writer',
    source_run_id: 'older', source_outcome: 'success'};
  const saved = {id: 'saved', input: 'Saved Skill and Hook work', status: 'completed', assignees: ['writer'], attempts: [
    {id: 'older', state: 'finished', outcome: 'success', participants: ['writer'], output: 'Older source result'},
    {id: 'execution', state: 'finished', outcome: 'success', participants: ['writer'], output: 'Hook result', skill: provenance, hook},
    {id: 'latest', state: 'finished', outcome: 'success', participants: ['writer'], output: 'Latest result'},
    {id: 'missing-source-execution', state: 'finished', outcome: 'failure', participants: ['writer'], hook: {...hook, run_id: 'missing-source-execution', source_run_id: 'absent'}},
  ]};
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    calls.push({path, method: options?.method ?? 'GET'});
    if (disconnected) throw new TypeError('network');
    if (path === '/api/state') return new Response(JSON.stringify({employees: [{id: 'writer', name: 'Writer'}], configuration: null,
      provider: 'test', model: 'test', work: [{id: 'other', input: 'Other request', status: 'pending', assignees: [], attempts: []}, ...(missingTask ? [] : [saved])]}));
    if (path === '/api/config/v1/skills') return new Response(JSON.stringify({skills: [{id: 'manual', name: 'Manual', enabled: true, instructions: 'Current configuration'}]}));
    if (path === '/api/config/v1/hooks') return new Response(JSON.stringify({hooks: [{id: 'trigger', name: 'Trigger', enabled: true, event: 'run_completed', target_kind: 'agent', target_id: 'writer', skill_id: 'manual'}]}));
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/teams') return new Response('{"teams":[]}');
    return new Response('{}');
  }));
  const user = userEvent.setup(); render(<App />);
  await screen.findByText('Other request', {selector: 'pre'});
  const draft = screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement;
  fireEvent.change(draft, {target: {value: 'Preserve unsaved work'}});
  // A configuration draft also survives exact-attempt navigation.
  await user.click(await screen.findByRole('button', {name: 'Open Skill book: Manual · ID: manual'}));
  const instructions = await screen.findByLabelText('Instructions') as HTMLTextAreaElement;
  await waitFor(() => expect(instructions.value).toBe('Current configuration'));
  fireEvent.change(instructions, {target: {value: 'Unsaved manual draft'}});
  await user.click(await screen.findByRole('button', {name: surface === 'Skill use'
    ? 'Recorded use for Skill: Manual · Skill ID: manual' : 'Recorded attempts for Hook: Trigger · Hook ID: trigger'}));
  const runId = surface === 'Hook source' ? 'older' : 'execution';
  const action = screen.getByRole('button', {name: `Open saved Task: saved · Run: ${runId}`});
  const before = calls.length;
  action.focus(); await user.keyboard('{Enter}');
  const detail = document.querySelector<HTMLDetailsElement>(`[data-attempt-id="${runId}"]`)!;
  await waitFor(() => expect(document.activeElement).toBe(detail.querySelector('summary')));
  expect(detail.open).toBe(true);
  expect(detail.querySelector('summary')!.textContent).toContain('Selected recorded attempt');
  expect(document.querySelector('[data-attempt-id="latest"] summary')!.textContent).not.toContain('Selected recorded attempt');
  fireEvent.click(detail.querySelector('summary')!);
  action.focus(); await user.keyboard(' ');
  await waitFor(() => expect(document.activeElement).toBe(detail.querySelector('summary')));
  expect(detail.open).toBe(true);
  // Saved-work selection and periodic polling retain their configuration reads.
  // Every request during navigation must stay inside this read-only boundary.
  const allowedReads = ['/api/config/v1/skills', '/api/config/v1/hooks', '/api/config/v1/loops', '/api/loops/v1'];
  expect(calls.slice(before).filter(({path, method}) =>
    !(method === 'GET' && allowedReads.includes(path)) && !(method === 'POST' && path === '/api/state'))).toEqual([]);
  expect(draft.value).toBe('Preserve unsaved work');
  expect(instructions.value).toBe('Unsaved manual draft');
  if (surface !== 'Skill use') {
    await user.click(screen.getByRole('button', {name: 'Open saved Task: saved · Run: absent'}));
    const unavailable = screen.getByText(/Recorded attempt unavailable in the current workspace snapshot/);
    expect(unavailable.textContent).toContain('Run: absent');
    expect(document.activeElement).toBe(unavailable);
    expect(screen.queryByText(/Selected recorded attempt/)).toBeNull();
  }
  disconnected = true;
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect(action.getAttribute('aria-disabled')).toBe('true'));
  const requestCount = calls.length;
  action.focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(action);
  expect(screen.getAllByText('Retained instructions').length).toBeGreaterThan(0);
  expect(calls).toHaveLength(requestCount);
  disconnected = false; missingTask = true;
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect(screen.queryByRole('button', {name: `Open saved Task: saved · Run: ${runId}`})).toBeNull());
  expect(draft.value).toBe('Preserve unsaved work');
  expect(instructions.value).toBe('Unsaved manual draft');
  expect(calls.filter(({path}) => /preview|execute|retry|stop|acknowledge|start/.test(path))).toEqual([]);
  expect(calls.filter(({path, method}) => path.startsWith('/api/config/') && method !== 'GET')).toEqual([]);
});
