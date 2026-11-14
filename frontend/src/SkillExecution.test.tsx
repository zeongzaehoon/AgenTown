import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { SkillExecution } from './SkillExecution';
import type { Work, Workspace } from './api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const work: Work = {id: 'w', input: 'Saved request', status: 'pending', assignees: ['e'], attempts: []};
const workspace: Workspace = {work: [work], employees: [], configuration: null, provider: 'fixture', model: 'fixture'};
function setup() {
  const submit = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith('skills') ? {skills: [{id: 's', name: 'Concise', instructions: 'Short', enabled: true}]} : {schema_version: 1, preview_id: 'p', task_id: 'w', skill_id: 's', expected_runs: 0, input: 'Short Saved request'}))));
  return {work, workspace, connected: true, draft: '', disabled: false, submit};
}
test('keyboard preview shows composed input and rapid clicks submit once', async () => {
  const props = setup(); const user = userEvent.setup(); render(<SkillExecution {...props} />);
  await screen.findByRole('option', {name: 'Concise · s'});
  await user.selectOptions(screen.getByLabelText('Enabled Skill'), 's');
  screen.getByRole('button', {name: 'Preview Skill with saved work'}).focus(); await user.keyboard('{Enter}');
  const execute = await screen.findByRole('button', {name: 'Execute once with Skill'});
  expect(document.activeElement).toBe(execute);
  expect(screen.getByText('Short Saved request')).toBeTruthy();
  expect(props.submit).not.toHaveBeenCalled();
  act(() => { execute.click(); execute.click(); });
  expect(props.submit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
});
test.each(['draft', 'configuration', 'work', 'disconnect', 'disabled'])('invalidates preview on %s', async kind => {
  const props = setup(); const user = userEvent.setup(); const view = render(<SkillExecution {...props} />);
  await screen.findByRole('option', {name: 'Concise · s'});
  await user.selectOptions(screen.getByLabelText('Enabled Skill'), 's');
  await user.click(screen.getByRole('button', {name: 'Preview Skill with saved work'}));
  await screen.findByRole('button', {name: 'Execute once with Skill'});
  view.rerender(<SkillExecution {...props} draft={kind === 'draft' ? 'changed' : ''} connected={kind !== 'disconnect'} disabled={kind === 'disabled'} work={kind === 'work' ? {...work, input: 'changed'} : work} workspace={kind === 'configuration' ? {...workspace, model: 'changed'} : workspace} />);
  expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole(kind === 'disconnect' || kind === 'disabled' ? 'region' : 'button', {name: kind === 'disconnect' || kind === 'disabled' ? 'Apply a Skill' : 'Preview Skill with saved work'}));
  expect(props.submit).not.toHaveBeenCalled();
});

test('preview failure needs another explicit request and never executes', async () => {
  const props = setup(); const fetcher = globalThis.fetch; let failing = true; let requests = 0;
  vi.stubGlobal('fetch', (path: string, options: RequestInit) => {
    if (path.endsWith('/skill-preview')) { requests++; if (failing) return Promise.reject(new Error('offline')); }
    return fetcher(path, options);
  });
  const user = userEvent.setup(); render(<SkillExecution {...props} />);
  await screen.findByRole('option', {name: 'Concise · s'});
  await user.selectOptions(screen.getByLabelText('Enabled Skill'), 's');
  await user.click(screen.getByRole('button', {name: 'Preview Skill with saved work'}));
  await screen.findByText(/Disconnected/);
  failing = false;
  expect(requests).toBe(1); expect(props.submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', {name: 'Preview Skill with saved work'}));
  await screen.findByRole('button', {name: 'Execute once with Skill'});
  expect(requests).toBe(2); expect(props.submit).not.toHaveBeenCalled();
});


test.each(['cancel', 'escape'])('saved-work Skill %s clears consent locally and requires a fresh preview', async method => {
  // Hold configuration/session polling so zero-request assertions concern dismissal only.
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  try {
    const props = setup();
    const user = userEvent.setup();
    render(<><button>Outside preview</button><SkillExecution {...props} /></>);
    await screen.findByRole('option', {name: 'Concise · s'});
    await user.selectOptions(screen.getByLabelText('Enabled Skill'), 's');
    await user.click(screen.getByRole('button', {name: 'Preview Skill with saved work'}));
    await screen.findByRole('button', {name: 'Execute once with Skill'});
    const previewButton = screen.getByRole('button', {name: 'Preview Skill with saved work'});
    const consent = screen.getByRole('button', {name: 'Execute once with Skill'});
    const fetcher = vi.mocked(globalThis.fetch);
    const requests = fetcher.mock.calls.length;
    await user.click(screen.getByRole('button', {name: 'Outside preview'}));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', {name: 'Execute once with Skill'})).toBe(consent);
    expect(screen.queryByText(/Consent cleared/)).toBeNull();
    if (method === 'cancel') {
      await user.click(screen.getByRole('button', {name: 'Cancel Skill preview'}));
    } else {
      consent.focus();
      await user.keyboard('{Escape}');
    }
    expect(screen.queryByRole('region', {name: 'Skill execution preview'})).toBeNull();
    expect(document.activeElement).toBe(previewButton);
    expect(screen.getByText('Skill preview dismissed. Consent cleared. No execution was requested. Preview again before executing.').getAttribute('role')).toBe('status');
    await user.keyboard('{Escape}');
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(props.submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
    await user.click(previewButton);
    await screen.findByRole('button', {name: 'Execute once with Skill'});
    expect(fetcher.mock.calls).toHaveLength(requests + 1);
    expect(props.submit).not.toHaveBeenCalled();
  } finally { interval.mockRestore(); }
});

// Freeze only product polling; keyboard helpers retain real timers.
test.each(['held', 'failed', 'disabled', 'changed', 'late configuration', 'late preview'])('current-connection Skill recovery: %s', async scenario => {
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
    if ((holdConfiguration && (path.endsWith('/skills') || path.endsWith('/hooks'))) || (holdPreview && path.endsWith('/skill-preview'))) {
      return new Promise<Response>((resolve, reject) => pending.push({path, resolve, reject}));
    }
    const response = await original(path, options);
    return response;
  });
  vi.stubGlobal('fetch', requests);
  const user = userEvent.setup();
  const view = render(<SkillExecution {...props} connected={false} />);
  expect(requests).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toMatch(/Disconnected/);
  view.rerender(<SkillExecution {...props} />);
  await screen.findByRole('option', {name: 'Concise · s'});
  await user.selectOptions(screen.getByLabelText('Enabled Skill'), 's');
  const button = () => screen.getByRole('button', {name: 'Preview Skill with saved work'}) as HTMLButtonElement;
  if (scenario === 'late preview') holdPreview = true;
  await user.click(button());
  if (scenario !== 'late preview') await screen.findByRole('button', {name: 'Execute once with Skill'});
  holdConfiguration = true;
  if (scenario === 'late configuration') {
    act(() => poll?.());
    expect(pending).toHaveLength(1);
  }
  view.rerender(<SkillExecution {...props} connected={false} />);
  expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
  expect(button().disabled).toBe(true);
  view.rerender(<SkillExecution {...props} />);
  expect((screen.getByLabelText('Enabled Skill') as HTMLSelectElement).value).toBe('s');
  expect(button().disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/Loading/);
  if (scenario === 'late configuration' || scenario === 'late preview') {
    // Resolve only the request(s) from the previous connection first.
    const oldCount = scenario === 'late preview' ? 1 : 1;
    const old = pending.splice(0, oldCount);
    await act(async () => { for (const request of old) request.resolve(await original(request.path)); });
    expect(button().disabled).toBe(true);
    expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
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
  if (scenario === 'changed') expect(screen.getByRole('option', {name: 'Updated Skill · s'})).toBeTruthy();
  await waitFor(() => expect(button().disabled).toBe(false));
  // No preview or execution is replayed by reconnect or polling.
  expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
  expect(props.submit).not.toHaveBeenCalled();
  button().focus(); await user.keyboard('{Enter}');
  const consent = await screen.findByRole('button', {name: 'Execute once with Skill'});
  expect(document.activeElement).toBe(consent);
  await user.keyboard('{Enter}');
  expect(props.submit).toHaveBeenCalledTimes(1);
});
