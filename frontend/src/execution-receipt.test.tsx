import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { confirmExecutionHistory, validateExecutionReceipt } from './execution-receipt';
import type { Workspace } from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const state: Workspace = {employees: [{id: 'e', name: 'Writer'}], configuration: null, provider: 'fixture', model: 'test',
  work: [{id: 'w', input: 'Saved request', status: 'pending', assignees: ['e'], attempts: [{id: 'prior', state: 'finished', outcome: 'reported_success', participants: ['e']}]}]};
const preview = {schema_version: 1 as const, preview_id: 'p', task_id: 'w', skill_id: 's', expected_runs: 1, input: 'Composed request',
  hook_id: 'h', hook_name: 'Follow up', agent_id: 'e', source_run_id: 'prior', source_outcome: 'reported_success', event: 'run_completed', hook_enabled: true as const, skill_enabled: true as const};
function receipt(kind: string) {
  return {schema_version: 1, quality: 'unverified', run_id: 'new', input: kind === 'ordinary' ? 'Saved request' : preview.input,
    provider: 'fixture', model: 'test', deadline_unix_ms: 100, output: 'Test result', error: null,
    ...(kind === 'ordinary' ? {} : {[kind.toLowerCase()]: {...preview, schema_version: 1, run_id: 'new', skill_name: 'Short', instructions: 'Concise', admitted_at: 1, target_kind: 'agent'}})};
}
const button = (name: string) => screen.getByRole('button', {name}) as HTMLButtonElement;

for (const kind of ['ordinary', 'Skill', 'Hook']) {
  test.each(['valid', 'provider failure', 'delayed', 'missing', 'mismatch', 'provenance mismatch', 'malformed history', 'failed history', 'malformed', 'unsupported'])(`${kind}: %s receipt, single submission and explicit refresh recovery`, async responseKind => {
    const polls: (() => void)[] = [];
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 800) { polls.push(callback); return 0; }
      return interval(callback, ms);
    }) as typeof setInterval);
    let failRefresh = false;
    let sent = false;
    let releaseHistory: (() => void) | undefined;
    const valid = ['valid', 'provider failure', 'delayed'].includes(responseKind);
    const result = {...receipt(kind), ...(responseKind === 'provider failure' ? {output: null, error: 'timeout'} : {})};
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      let body: unknown = {};
      if (path === '/api/state') {
        if (failRefresh || (sent && responseKind === 'failed history')) throw new Error('offline');
        body = state;
        if (sent && !['missing', 'malformed', 'unsupported'].includes(responseKind)) {
          if (responseKind === 'delayed') await new Promise<void>(resolve => { releaseHistory = resolve; });
          const attempt = {id: result.run_id, state: 'finished', outcome: result.error ? 'failure' : 'reported_success', participants: ['e'],
            input: result.input, provider: result.provider, model: result.model, output: result.output, error: result.error, quality: result.quality,
            ...(kind === 'ordinary' ? {} : {[kind.toLowerCase()]: (result as unknown as Record<string, unknown>)[kind.toLowerCase()]})};
          if (responseKind === 'mismatch') attempt.input = 'Contradiction';
          if (responseKind === 'provenance mismatch') {
            if (kind === 'ordinary') Object.assign(attempt, {skill: {}});
            else Object.assign(attempt, {[kind.toLowerCase()]: {...(result as unknown as Record<string, object>)[kind.toLowerCase()], instructions: 'Changed'}});
          }
          body = {...state, work: [{...state.work[0], attempts: [...state.work[0].attempts, attempt]}]};
          if (responseKind === 'malformed history') body = {work: null};
        }
      }
      else if (path.endsWith('/execute')) {
        calls++; sent = true;
        expect(JSON.parse(options.body as string)).toEqual(kind === 'ordinary' ? {expected_runs: 1} : kind === 'Skill' ? {expected_runs: 1, preview_id: 'p'} : {expected_runs: 1, hook_preview_id: 'p'});
        body = responseKind === 'malformed' ? null : responseKind === 'unsupported' ? {...result, schema_version: 2} : result;
      } else if (path.endsWith('-preview')) body = kind === 'Hook' ? preview : {schema_version: 1, preview_id: 'p', task_id: 'w', skill_id: 's', expected_runs: 1, input: preview.input};
      else if (path.endsWith('/skills')) body = {skills: [{id: 's', name: 'Short', instructions: 'Concise', enabled: true}]};
      else if (path.endsWith('/hooks')) body = {hooks: [{id: 'h', name: 'Follow up', enabled: true, skill_id: 's', target_kind: 'agent', target_id: 'e', event: 'run_completed'}]};
      else if (path === '/api/teams') body = {teams: []};
      else if (path === '/api/loops/v1') body = {schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [], attempts: [], cancellation: ''};
      else body = {loops: []};
      return new Response(JSON.stringify(body));
    }));
    render(<App />);
    // Initial admission waits for both workspace and Loop inspection effects.
    // Allow their startup under the consolidated DOM-heavy verification run.
    await waitFor(() => expect(button('Retry explicitly').disabled).toBe(false), {timeout: 3000});
    fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep draft'}});
    const user = userEvent.setup();
    async function submit() {
      if (kind !== 'ordinary') {
        await user.selectOptions(screen.getByLabelText(kind === 'Skill' ? 'Enabled Skill' : 'Employee Hook'), kind === 'Skill' ? 's' : 'h');
        await user.click(button(`Preview ${kind} with saved work`));
        await screen.findByRole('button', {name: `Execute once with ${kind}`});
      }
      const execute = button(kind === 'ordinary' ? 'Retry explicitly' : `Execute once with ${kind}`);
      act(() => { execute.click(); execute.click(); });
    }
    await submit();
    await waitFor(() => expect(calls).toBe(1));
    if (responseKind === 'delayed') {
      await waitFor(() => expect(releaseHistory).toBeTypeOf('function'));
      expect(button('Retry explicitly').disabled).toBe(true);
      fireEvent.click(button('Retry explicitly'));
      expect(calls).toBe(1);
      await act(async () => { releaseHistory!(); });
    }
    await waitFor(() => expect(button('Retry explicitly').disabled).toBe(!valid));
    expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep draft');
    expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('w');
    expect(screen.getByText(/Attempt 1 ·/)).toBeTruthy();
    if (kind !== 'ordinary') expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
    if (valid) { expect(screen.queryByText(/Submission needs inspection/)).toBeNull(); return; }
    await screen.findByText(/Submission needs inspection/);
    await act(async () => { polls.forEach(poll => poll()); });
    expect(button('Retry explicitly').disabled).toBe(true);
    failRefresh = true;
    await user.click(button('Refresh connection'));
    await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
    expect(button('Retry explicitly').disabled).toBe(true);
    failRefresh = false; sent = false;
    await act(async () => { polls.forEach(poll => poll()); });
    expect(button('Retry explicitly').disabled).toBe(true);
    button('Refresh connection').focus(); await user.keyboard('{Enter}');
    await waitFor(() => expect(button('I inspected execution history').disabled).toBe(false));
    expect(button('Retry explicitly').disabled).toBe(true);
    button('I inspected execution history').focus(); await user.keyboard('{Enter}');
    await waitFor(() => expect(button('Retry explicitly').disabled).toBe(false));
    expect(calls).toBe(1);
    if (kind !== 'ordinary') expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
    await submit();
    await waitFor(() => expect(calls).toBe(2));
  });
}

test.each([null, [], {}, {run_id: 'new'}, ...['run_id', 'input', 'provider', 'model', 'deadline_unix_ms', 'output', 'error', 'quality'].map(key => ({...receipt('ordinary'), [key]: false})), {...receipt('ordinary'), run_id: 'prior'}, {...receipt('ordinary'), error: 'timeout'}])('rejects invalid finalized receipt %j', value => {
  expect(() => validateExecutionReceipt(value, state.work[0], state)).toThrow(/receipt/);
});
test.each(['Skill', 'Hook'])('%s receipt requires matching saved provenance', kind => {
  const valid = receipt(kind);
  // SkillPreview has no Hook discriminator in the actual Skill flow.
  const skillPreview = {schema_version: 1 as const, preview_id: 'p', task_id: 'w', skill_id: 's', expected_runs: 1, input: preview.input};
  const consent = kind === 'Hook' ? preview : skillPreview;
  expect(() => validateExecutionReceipt(valid, state.work[0], state, consent)).not.toThrow();
  for (const key of ['schema_version', 'run_id', 'preview_id', 'skill_id', 'input', 'admitted_at', ...(kind === 'Hook' ? ['hook_id', 'task_id', 'source_run_id', 'source_outcome', 'agent_id', 'event'] : [])]) {
    const saved = (valid as unknown as Record<string, Record<string, unknown>>)[kind.toLowerCase()];
    expect(() => validateExecutionReceipt({...valid, [kind.toLowerCase()]: {...saved, [key]: null}}, state.work[0], state, consent)).toThrow();
  }
});
test('provider failure is a valid receipt, not delivery uncertainty', () => {
  expect(() => validateExecutionReceipt({...receipt('ordinary'), output: null, error: 'timeout'}, state.work[0], state)).not.toThrow();
});

test('a refresh begun before uncertain delivery cannot clear the recovery requirement', async () => {
  let releaseExecution!: (response: Response) => void;
  let releaseRefresh!: (response: Response) => void;
  let holdRefresh = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/execute')) return new Promise<Response>(resolve => { releaseExecution = resolve; });
    if (path === '/api/state') {
      if (holdRefresh) return new Promise<Response>(resolve => { releaseRefresh = resolve; });
      return new Response(JSON.stringify(state));
    }
    return new Response(JSON.stringify(path === '/api/loops/v1'
      ? {schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [], attempts: [], cancellation: ''}
      : {teams: [], skills: [], hooks: [], loops: []}));
  }));
  render(<App />);
  await waitFor(() => expect(button('Retry explicitly').disabled).toBe(false));
  fireEvent.click(button('Retry explicitly'));
  await waitFor(() => expect(releaseExecution).toBeTypeOf('function'));
  holdRefresh = true;
  fireEvent.click(button('Refresh connection'));
  await waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));
  const staleRefresh = releaseRefresh;
  await act(async () => { releaseExecution(new Response('null')); });
  await screen.findByText(/Submission needs inspection/);
  await act(async () => { staleRefresh(new Response(JSON.stringify(state))); });
  expect(button('Retry explicitly').disabled).toBe(true);
  // Finish the automatic post-submission refresh too; it cannot release the latch.
  await act(async () => { releaseRefresh(new Response(JSON.stringify(state))); });
  expect(button('Retry explicitly').disabled).toBe(true);
  holdRefresh = false;
  fireEvent.click(button('Refresh connection'));
  await waitFor(() => expect(button('I inspected execution history').disabled).toBe(false));
  fireEvent.click(button('I inspected execution history'));
  await waitFor(() => expect(button('Retry explicitly').disabled).toBe(false));
});

test.each(['id', 'state', 'outcome', 'input', 'provider', 'model', 'output', 'error', 'quality'])('history confirmation rejects contradictory %s', field => {
  const value = receipt('ordinary');
  const attempt = {id: value.run_id, state: 'finished', outcome: 'reported_success', participants: ['e'],
    input: value.input, provider: value.provider, model: value.model, output: value.output, error: value.error, quality: value.quality};
  const confirmed = {...state, work: [{...state.work[0], attempts: [attempt]}]} as Workspace;
  expect(() => confirmExecutionHistory(value, state.work[0], confirmed)).not.toThrow();
  Object.assign(attempt, {[field]: 'contradiction'});
  expect(() => confirmExecutionHistory(value, state.work[0], confirmed)).toThrow(/uncertain/);
});

test('history confirmation rejects a missing submitted work record', () => {
  expect(() => confirmExecutionHistory(receipt('ordinary'), state.work[0], {...state, work: []})).toThrow(/uncertain/);
});
