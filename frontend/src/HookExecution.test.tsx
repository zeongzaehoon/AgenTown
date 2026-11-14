import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { HookExecution } from './HookExecution';
import { App } from './App';
import type { Work, Workspace } from './api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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

// Freeze only product polling; keyboard helpers retain real timers.
test.each(['held', 'failed', 'disabled', 'changed', 'late configuration', 'late preview', 'disabled Hook', 'failed Hook'])('current-connection Hook recovery: %s', async scenario => {
  let poll: (() => void) | undefined;
  const realInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 800) {
      poll = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }
    return realInterval(callback, delay, ...args);
  });
  const props = setup();
  const original = globalThis.fetch;
  const pending: Array<{path: string; resolve: (response: Response) => void; reject: (error: Error) => void}> = [];
  let holdConfiguration = false;
  let holdPreview = false;
  const requests = vi.fn(async (path: string, options?: RequestInit) => {
    if ((holdConfiguration && (path.endsWith('/skills') || path.endsWith('/hooks'))) || (holdPreview && path.endsWith('/hook-preview'))) {
      return new Promise<Response>((resolve, reject) => pending.push({path, resolve, reject}));
    }
    const response = await original(path, options);
    return response;
  });
  vi.stubGlobal('fetch', requests);
  const user = userEvent.setup();
  const view = render(<HookExecution {...props} connected={false} />);
  expect(requests).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toMatch(/Disconnected/);
  view.rerender(<HookExecution {...props} />);
  await screen.findByRole('option', {name: /Follow up · h/});
  await user.selectOptions(screen.getByLabelText('Employee Hook'), 'h');
  const button = () => screen.getByRole('button', {name: 'Preview Hook with saved work'}) as HTMLButtonElement;
  if (scenario === 'late preview') holdPreview = true;
  await user.click(button());
  if (scenario !== 'late preview') await screen.findByRole('button', {name: 'Execute once with Hook'});
  holdConfiguration = true;
  if (scenario === 'late configuration') {
    act(() => poll?.());
    expect(pending).toHaveLength(2);
  }
  view.rerender(<HookExecution {...props} connected={false} />);
  expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
  expect(button().disabled).toBe(true);
  view.rerender(<HookExecution {...props} />);
  expect((screen.getByLabelText('Employee Hook') as HTMLSelectElement).value).toBe('h');
  expect(button().disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/Loading/);
  if (scenario === 'late configuration' || scenario === 'late preview') {
    // Resolve only the request(s) from the previous connection first.
    const oldCount = scenario === 'late preview' ? 1 : 2;
    const old = pending.splice(0, oldCount);
    await act(async () => { for (const request of old) request.resolve(await original(request.path)); });
    expect(button().disabled).toBe(true);
    expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
  }
  if (scenario === 'held') {
    const first = pending.shift()!;
    await act(async () => first.resolve(await original(first.path)));
    expect(button().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/Loading/);
  }
  if (scenario === 'failed' || scenario === 'failed Hook') {
    await act(async () => { for (const request of pending.splice(0)) {
      if (scenario === 'failed Hook' && request.path.endsWith('/skills')) request.resolve(await original(request.path));
      else request.reject(new Error('offline'));
    } });
    expect(screen.getByRole('status').textContent).toMatch(/refresh failed/);
    expect(button().disabled).toBe(true);
    holdConfiguration = false;
    act(() => poll?.());
  } else {
    await act(async () => {
      for (const request of pending.splice(0)) {
        const response = await original(request.path);
        if (scenario === 'changed' && request.path.endsWith('/skills')) {
          const body = await response.json();
          request.resolve(new Response(JSON.stringify({...body, skills: body.skills.map((record: object) => ({...record, name: 'Updated Skill', instructions: 'Updated instructions'}))})));
        } else if (scenario === 'disabled Hook' && request.path.endsWith('/hooks')) {
          const body = await response.json();
          request.resolve(new Response(JSON.stringify({...body, hooks: body.hooks.map((record: object) => ({...record, enabled: false}))})));
        } else if (scenario === 'disabled' && request.path.endsWith('/skills')) {
          const body = await response.json();
          request.resolve(new Response(JSON.stringify({...body, skills: body.skills.map((record: object) => ({...record, enabled: false}))})));
        } else request.resolve(response);
      }
    });
  }
  holdConfiguration = false; holdPreview = false;
  if (scenario === 'disabled' || scenario === 'disabled Hook') {
    expect(button().disabled).toBe(true);
    act(() => poll?.());
  }
  await waitFor(() => expect(button().disabled).toBe(false));
  // No preview or execution is replayed by reconnect or polling.
  expect(screen.queryByRole('button', {name: 'Execute once with Hook'})).toBeNull();
  expect(props.submit).not.toHaveBeenCalled();
  button().focus(); await user.keyboard('{Enter}');
  const consent = await screen.findByRole('button', {name: 'Execute once with Hook'});
  expect(document.activeElement).toBe(consent);
  await user.keyboard('{Enter}');
  expect(props.submit).toHaveBeenCalledTimes(1);
});
