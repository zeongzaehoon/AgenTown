import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { SkillExecution } from './SkillExecution';
import type { Work, Workspace } from './api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
