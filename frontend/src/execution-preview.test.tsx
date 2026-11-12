import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { SkillExecution } from './SkillExecution';
import { HookExecution } from './HookExecution';
import type { Work, Workspace } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const work: Work = {id: 'w', input: 'Saved request', status: 'pending', assignees: ['e'], attempts: [{id: 'r', state: 'finished', outcome: 'reported_success', participants: ['e']}]};
const workspace: Workspace = {work: [work], employees: [], configuration: null, provider: 'fixture', model: 'fixture'};
const skill = {id: 's', name: 'Short', instructions: 'Concise', enabled: true};
const hook = {id: 'h', name: 'Follow up', enabled: true, skill_id: 's', target_kind: 'agent', target_id: 'e', event: 'run_completed'};
const valid = {schema_version: 1, preview_id: 'consent', task_id: 'w', skill_id: 's', expected_runs: 1, input: 'Concise Saved request', hook_id: 'h', hook_name: 'Follow up', agent_id: 'e', source_run_id: 'r', source_outcome: 'reported_success', event: 'run_completed', hook_enabled: true, skill_enabled: true};
const common: [string, unknown][] = [
  ['null', null], ['array', []], ['missing ID', {...valid, preview_id: undefined}],
  ...[0, 1, true, {}, [], '', ' \n\t'].map(id => ['malformed ID', {...valid, preview_id: id}] as [string, unknown]),
  ['schema', {...valid, schema_version: '1'}], ['unsupported schema', {...valid, schema_version: 2}],
  ['input', {...valid, input: {text: 'unsafe'}}], ['count type', {...valid, expected_runs: '1'}],
  ['count mismatch', {...valid, expected_runs: 0}], ['work identity', {...valid, task_id: 'other'}],
  ['Skill identity', {...valid, skill_id: 'other'}],
];
const hookOnly: [string, unknown][] = [
  ...['hook_id', 'agent_id', 'source_run_id', 'source_outcome', 'event'].map(key => [key, {...valid, [key]: 'other'}] as [string, unknown]),
  ...['hook_enabled', 'skill_enabled'].flatMap(key => [false, 'true', 1, {}, null].map(flag => [key, {...valid, [key]: flag}] as [string, unknown])),
  ['Hook name type', {...valid, hook_name: {}}],
];
for (const kind of ['Skill', 'Hook'] as const) {
  test.each(kind === 'Hook' ? [...common, ...hookOnly] : common)(`${kind} rejects %s and recovers only through fresh consent (%#)`, async (_name, invalid) => {
    // Stop only product polls; Testing Library and user-event timers still run.
    const interval = globalThis.setInterval;
    vi.stubGlobal('setInterval', ((callback: TimerHandler, delay?: number, ...args: unknown[]) => delay === 800 ? 0 : interval(callback, delay, ...args)));
    let response: unknown = invalid;
    let previews = 0;
    const submit = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/skills')) return new Response(JSON.stringify({skills: [skill]}));
      if (path.endsWith('/hooks')) return new Response(JSON.stringify({hooks: [hook]}));
      previews++;
      return new Response(JSON.stringify(response));
    }));
    const Component = kind === 'Hook' ? HookExecution : SkillExecution;
    const user = userEvent.setup();
    render(<><textarea aria-label="Unsaved draft" defaultValue="Keep this draft" /><Component work={work} workspace={workspace} connected draft="Keep this draft" disabled={false} submit={submit} /></>);
    await screen.findByRole('option', {name: kind === 'Hook' ? /Follow up · h/ : 'Short · s'});
    await user.selectOptions(screen.getByLabelText(kind === 'Hook' ? 'Employee Hook' : 'Enabled Skill'), kind === 'Hook' ? 'h' : 's');
    const previewButton = screen.getByRole('button', {name: `Preview ${kind} with saved work`});
    await user.click(previewButton);
    await screen.findByText(/Preview response is invalid or unsupported/);
    expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    response = valid;
    await act(async () => { await Promise.resolve(); });
    expect(previews).toBe(1);
    expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
    expect((screen.getByLabelText('Unsaved draft') as HTMLTextAreaElement).value).toBe('Keep this draft');
    expect(work.input).toBe('Saved request');
    expect(work.attempts).toHaveLength(1);
    await user.click(previewButton);
    const execute = await screen.findByRole('button', {name: `Execute once with ${kind}`});
    expect(previews).toBe(2);
    expect(submit).not.toHaveBeenCalled();
    act(() => { execute.click(); execute.click(); });
    expect(submit).toHaveBeenCalledExactlyOnceWith(valid);
    expect(screen.queryByRole('button', {name: `Execute once with ${kind}`})).toBeNull();
  });
}
