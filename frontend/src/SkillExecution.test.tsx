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
test.each(['draft', 'configuration', 'work', 'disconnect'])('invalidates preview on %s', async kind => {
  const props = setup(); const user = userEvent.setup(); const view = render(<SkillExecution {...props} />);
  await screen.findByRole('option', {name: 'Concise · s'});
  await user.selectOptions(screen.getByLabelText('Enabled Skill'), 's');
  await user.click(screen.getByRole('button', {name: 'Preview Skill with saved work'}));
  await screen.findByRole('button', {name: 'Execute once with Skill'});
  view.rerender(<SkillExecution {...props} draft={kind === 'draft' ? 'changed' : ''} connected={kind !== 'disconnect'} work={kind === 'work' ? {...work, input: 'changed'} : work} workspace={kind === 'configuration' ? {...workspace, model: 'changed'} : workspace} />);
  expect(screen.queryByRole('button', {name: 'Execute once with Skill'})).toBeNull();
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
