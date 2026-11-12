import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { SkillExecution } from './SkillExecution';
import { HookExecution } from './HookExecution';
import { savedSkills, savedHooks } from './configuration-api';
import type { Work, Workspace } from './api';

const skill = {id: 's', name: 'Short', instructions: 'Concise', enabled: true};
const hook = {id: 'h', name: 'Follow up', enabled: true, skill_id: 's', target_kind: 'agent', target_id: 'e', event: 'run_completed'};
const work: Work = {id: 'w', input: 'Saved request', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', participants: ['e']}]};
const workspace: Workspace = {work: [work], employees: [{id: 'e', name: 'Writer'}], configuration: null, provider: 'fixture', model: 'fixture'};
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each([null, {}, {skills: [null]}, {skills: [skill, skill]}, {skills: [{...skill, enabled: 'true'}]}, {skills: [{...skill, instructions: null}]}, {skills: [{...skill, name: {}}]}, {skills: [{...skill, id: 1}]}])('rejects malformed Skill snapshot %j', value => {
  expect(() => savedSkills(value)).toThrow();
});
test.each([null, {hooks: [null]}, {hooks: [hook, hook]}, ...['enabled', 'name', 'id', 'skill_id', 'target_id', 'target_kind', 'event'].map(field => ({hooks: [{...hook, [field]: field === 'enabled' ? 1 : null}]})), {hooks: [{...hook, target_kind: 'unknown'}]}, {hooks: [{...hook, event: 'unknown'}]}])('rejects malformed Hook snapshot %j', value => {
  expect(() => savedHooks(value)).toThrow();
});

test.each([{kind: 'Skill', broken: 'skills'}, {kind: 'Hook', broken: 'skills'}, {kind: 'Hook', broken: 'hooks'}] as const)('$kind malformed $broken load, stale preview and recovery preserve drafts and selection', async ({kind, broken}) => {
  // Control polling while letting user-event and Testing Library drain their
  // real timeout queues between keyboard interactions.
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
  const user = userEvent.setup();
  let malformed = true;
  const submit = vi.fn();
  const fetcher = vi.fn(async (path: string) => new Response(JSON.stringify(
    path.endsWith('/skills') ? {skills: malformed && broken === 'skills' ? [null] : [skill]} :
    path.endsWith('/hooks') ? {hooks: malformed && broken === 'hooks' ? [{...hook, enabled: 'yes'}] : [hook]} :
    {schema_version: 1, preview_id: 'p', task_id: 'w', skill_id: 's', hook_id: 'h', agent_id: 'e', expected_runs: 1, input: 'Concise Saved request', source_run_id: 'r', source_outcome: 'reported_success', event: 'run_completed', hook_enabled: true, skill_enabled: true}
  )));
  vi.stubGlobal('fetch', fetcher);
  const Component = kind === 'Skill' ? SkillExecution : HookExecution;
  render(<><textarea aria-label="Unsaved request" defaultValue="Keep my draft" /><Component work={work} workspace={workspace} connected draft="Keep my draft" disabled={false} submit={submit} /></>);
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toMatch(/unavailable/);
  const preview = screen.getByRole('button', {name: `Preview ${kind} with saved work`}) as HTMLButtonElement;
  expect(preview.disabled).toBe(true);
  malformed = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  const select = screen.getByLabelText(kind === 'Skill' ? 'Enabled Skill' : 'Employee Hook');
  await user.selectOptions(select, kind === 'Skill' ? 's' : 'h');
  preview.focus(); await user.keyboard('{Enter}');
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByRole('button', {name: `Execute once with ${kind}`}));
  malformed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(screen.getByRole('status').textContent).toMatch(/stale/);
  expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('region', {name: kind === 'Skill' ? 'Apply a Skill' : 'Apply an employee Hook'}));
  expect(preview.disabled).toBe(true);
  malformed = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect((select as HTMLSelectElement).value).toBe(kind === 'Skill' ? 's' : 'h');
  expect((screen.getByLabelText('Unsaved request') as HTMLTextAreaElement).value).toBe('Keep my draft');
  expect(work.input).toBe('Saved request');
  expect(preview.disabled).toBe(false);
  expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith('-preview'))).toHaveLength(1);
  preview.focus(); await user.keyboard('{Enter}');
  await act(async () => {});
  expect(screen.getByRole('button', {name: `Execute once with ${kind}`})).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.every(([path]) => !path.endsWith('/execute'))).toBe(true);
});
