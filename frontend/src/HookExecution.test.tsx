import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { HookExecution } from './HookExecution';
import { App } from './App';
import type { Work, Workspace } from './api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const work: Work = {id: 'w', input: 'Saved request', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', participants: ['e']}]};
const workspace: Workspace = {work: [work], employees: [{id: 'e', name: 'Writer'}], configuration: null, provider: 'fixture', model: 'fixture'};
const hook = {id: 'h', name: 'Follow up', enabled: true, skill_id: 's', target_kind: 'agent', target_id: 'e', event: 'run_completed'};
const preview = {schema_version: 1, preview_id: 'p', task_id: 'w', hook_id: 'h', hook_name: 'Follow up', skill_id: 's', skill_name: 'Short', instructions: 'Concise', expected_runs: 1, input: 'SERVER COMPOSED INPUT', source_run_id: 'r', source_outcome: 'reported_success', event: 'run_completed', agent_id: 'e', hook_enabled: true, skill_enabled: true};
function setup() {
  const submit = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/teams' ? {teams: []} : path === '/api/config/v1/loops' ? {loops: []} : path === '/api/loops/v1' ? {schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [], attempts: [], cancellation: ''} : path.endsWith('/hooks') ? {hooks: [hook, {...hook, id: 'off', enabled: false}, {...hook, id: 'other', target_id: 'other'}, {...hook, id: 'missing', skill_id: 'missing'}]} : path.endsWith('/skills') ? {skills: [{id: 's', name: 'Short', instructions: 'Concise', enabled: true}]} : path === '/api/state' ? workspace : preview))));
  return {work, workspace, connected: true, draft: '', disabled: false, submit};
}
async function inspect(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('option', {name: /Follow up · h/});
  await user.selectOptions(screen.getByLabelText('Employee Hook'), 'h');
  await waitFor(() => expect((screen.getByRole('button', {name: 'Preview Hook with saved work'}) as HTMLButtonElement).disabled).toBe(false), {timeout: 3000});
  screen.getByRole('button', {name: 'Preview Hook with saved work'}).focus();
  await user.keyboard('{Enter}');
  return screen.findByRole('button', {name: 'Execute once with Hook'});
}
test('keyboard consent, source event, cancel focus and single submission', async () => {
  const props = setup(); const user = userEvent.setup(); render(<HookExecution {...props} />);
  let execute = await inspect(user);
  expect(document.activeElement).toBe(execute);
  expect(screen.getByText('SERVER COMPOSED INPUT')).toBeTruthy();
  expect(screen.getByText(/Source Run: r/)).toBeTruthy();
  expect(props.submit).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Preview Hook with saved work'}));
  execute = await inspect(user);
  act(() => { execute.click(); execute.click(); });
  expect(props.submit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
});
test.each(['draft', 'work', 'configuration', 'disconnect', 'disabled'])('invalidates consent and recovers focus on %s', async kind => {
  const props = setup(); const user = userEvent.setup(); const view = render(<HookExecution {...props} />);
  await inspect(user);
  view.rerender(<HookExecution {...props} draft={kind === 'draft' ? 'new' : ''} connected={kind !== 'disconnect'} disabled={kind === 'disabled'} work={kind === 'work' ? {...work, input: 'changed'} : work} workspace={kind === 'configuration' ? {...workspace, model: 'changed'} : workspace} />);
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull());
  expect(props.submit).not.toHaveBeenCalled();
  expect(document.activeElement?.textContent).toMatch(/Preview Hook|Apply an employee Hook/);
  expect(screen.getByRole('status').textContent).toMatch(/invalidated|Disconnected|unavailable/);
});
test('disabled, unmatched and unavailable Skills are separate choices', async () => {
  const props = setup(); render(<HookExecution {...props} />);
  expect((await screen.findByRole('option', {name: /off · Disabled/}) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole('option', {name: /other · Unmatched/}) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole('option', {name: /missing · Skill unavailable/}) as HTMLOptionElement).disabled).toBe(true);
});
test('unknown submission requires successful explicit history refresh before new consent', async () => {
  setup(); const original = globalThis.fetch; let refreshFails = false;
  const submissions = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    if (path.endsWith('/execute')) {
      submissions();
      expect(JSON.parse(options.body as string)).toEqual({hook_preview_id: 'p', expected_runs: 1});
      refreshFails = true; throw new Error('unknown delivery');
    }
    if (path === '/api/state' && refreshFails) throw new Error('offline');
    return original(path, options);
  }));
  const user = userEvent.setup(); render(<App />);
  await waitFor(() => expect((screen.getByRole('button', {name: 'Retry explicitly'}) as HTMLButtonElement).disabled).toBe(false), {timeout: 3000});
  await inspect(user); await user.click(screen.getByRole('button', {name: 'Execute once with Hook'}));
  await screen.findByText(/Submission needs inspection/);
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  expect((screen.getByRole('button', {name: 'Preview Hook with saved work'}) as HTMLButtonElement).disabled).toBe(true);
  refreshFails = false;
  await user.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect((screen.getByRole('button', {name: 'I inspected execution history'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('button', {name: 'Preview Hook with saved work'}) as HTMLButtonElement).disabled).toBe(true);
  screen.getByRole('button', {name: 'I inspected execution history'}).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect((screen.getByRole('button', {name: 'Retry explicitly'}) as HTMLButtonElement).disabled).toBe(false), {timeout: 3000});
  await waitFor(() => expect((screen.getByRole('button', {name: 'Preview Hook with saved work'}) as HTMLButtonElement).disabled).toBe(false), {timeout: 3000});
  expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
  expect(submissions).toHaveBeenCalledTimes(1);
  // Recovery only permits a new preview. It cannot reuse consumed consent.
  const execute = await inspect(user);
  expect(submissions).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(execute);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
  expect(submissions).toHaveBeenCalledTimes(1);
});

test('configuration unavailable is announced without offering execution', async () => {
  const props = setup(); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<HookExecution {...props} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Hooks unavailable/));
  expect((screen.getByRole('button', {name: 'Preview Hook with saved work'}) as HTMLButtonElement).disabled).toBe(true);
  expect(props.submit).not.toHaveBeenCalled();
});
test('admitted attempt displays persisted Hook, source Run and Skill provenance', async () => {
  setup(); const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => path === '/api/state'
    ? new Response(JSON.stringify({...workspace, work: [{...work, attempts: [...work.attempts, {id: 'admitted', state: 'finished', outcome: 'reported_success', participants: ['e'], hook: {...preview, run_id: 'admitted', admitted_at: 1}}]}]}))
    : original(path, options));
  render(<App />);
  const heading = await screen.findByText('Saved Hook provenance');
  const region = heading.parentElement!;
  expect(region.textContent).toContain('Hook ID: h');
  expect(region.textContent).toContain('Source Run: r');
  expect(region.textContent).toContain('Skill ID: s');
  expect(region.textContent).toContain('SERVER COMPOSED INPUT');
});


test.each(['cancel', 'escape'])('saved-work Hook %s clears consent locally and requires a fresh preview', async method => {
  // Hold configuration/session polling so zero-request assertions concern dismissal only.
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  try {
    const props = setup();
    const user = userEvent.setup();
    render(<><button>Outside preview</button><HookExecution {...props} /></>);
    await inspect(user);
    const previewButton = screen.getByRole('button', {name: 'Preview Hook with saved work'});
    const consent = screen.getByRole('button', {name: 'Execute once with Hook'});
    const fetcher = vi.mocked(globalThis.fetch);
    const requests = fetcher.mock.calls.length;
    await user.click(screen.getByRole('button', {name: 'Outside preview'}));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', {name: 'Execute once with Hook'})).toBe(consent);
    expect(screen.queryByText(/Consent cleared/)).toBeNull();
    if (method === 'cancel') {
      await user.click(screen.getByRole('button', {name: 'Cancel Hook preview'}));
    } else {
      consent.focus();
      await user.keyboard('{Escape}');
    }
    expect(screen.queryByRole('region', {name: 'Hook execution preview'})).toBeNull();
    expect(document.activeElement).toBe(previewButton);
    expect(screen.getByText('Hook preview dismissed. Consent cleared. No execution was requested. Preview again before executing.').getAttribute('role')).toBe('status');
    await user.keyboard('{Escape}');
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(props.submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
    await user.click(previewButton);
    await screen.findByRole('button', {name: 'Execute once with Hook'});
    expect(fetcher.mock.calls).toHaveLength(requests + 1);
    expect(props.submit).not.toHaveBeenCalled();
  } finally { interval.mockRestore(); }
});
