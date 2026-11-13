import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkInspection } from './WorkInspection';
import { WorkSkill } from './WorkSkill';
import { parseSkillResponse } from './work-skill-api';
const task = '11111111-1111-4111-8111-111111111111';
const skill = '22222222-2222-4222-8222-222222222222';
const preview = {schema_version: 1 as const, task_id: task, skill_id: skill, preview_id: 'preview-1', input: 'Exact instructions\n\nSaved work', expected_runs: 1};
const envelope = (data: unknown, code: string, requested_task_id: string | null = task, status = 'confirmed') => ({schema_version: 1, requested_task_id, status, code, data, recovery: 'Inspect again explicitly'});
const discovery = () => envelope({schema_version: 1, skills: [{id: skill, name: 'Summarize', enabled: true}]}, 'skills_discovered', null);
const receipt = () => envelope({execution: {schema_version: 1, run_id: task, input: preview.input, provider: 'fixture', model: 'fixture', deadline_unix_ms: 100, output: 'Saved result', error: null, quality: 'unverified'}, skill: {schema_version: 1, run_id: task, preview_id: preview.preview_id, skill_id: skill, skill_name: 'Summarize', instructions: 'Exact instructions', input: preview.input, admitted_at: 1}}, 'execution_recorded', task, 'completed');
const reply = (v: unknown) => new Response(JSON.stringify(v));
const previewButton = () => screen.getByRole('button', {name: 'Preview local Skill'});
async function discover() {
  await userEvent.click(screen.getByRole('button', {name: 'Find Skills through local MCP'}));
  await screen.findByRole('option', {name: /Summarize/});
  await userEvent.selectOptions(screen.getByRole('combobox', {name: 'Local enabled Skill'}), skill);
}
async function prepare() {
  await discover(); await userEvent.click(previewButton()); await screen.findByRole('checkbox');
}
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
test('preview never dispatches; keyboard consent sends exactly one complete tuple and restores recovery focus', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'skill_previewed'))).mockResolvedValueOnce(reply(receipt()));
  vi.stubGlobal('fetch', fetcher); render(<WorkSkill taskId={task} onInspect={vi.fn()} />);
  expect(fetcher).not.toHaveBeenCalled(); await prepare();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === preview.input)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Local Skill preview'}));
  const consent = screen.getByRole('checkbox'); consent.focus(); await userEvent.keyboard(' '); await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Execute local Skill once'}));
  await userEvent.keyboard('{Enter}'); await screen.findByText('Saved result');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({task_id: task, skill_id: skill, preview_id: 'preview-1', input: preview.input, expected_runs: 1, execution_consent: true});
  expect(screen.getByText('Quality unverified')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Inspect before another Skill execution'})));
  await userEvent.click(previewButton()); expect(fetcher).toHaveBeenCalledTimes(3);
});
test('selection and new previews discard consent and stale preview responses', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'skill_previewed')))
    .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})).mockResolvedValueOnce(reply(envelope({...preview, preview_id: 'fresh'}, 'skill_previewed')));
  vi.stubGlobal('fetch', fetcher); render(<WorkSkill taskId={task} onInspect={vi.fn()} />); await prepare();
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(previewButton()); expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(previewButton()); await screen.findByRole('checkbox');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  await act(async () => {finish(reply(envelope(preview, 'skill_previewed')));});
  expect(screen.getByText(/Preview ID: fresh/)).toBeTruthy();
  await userEvent.selectOptions(screen.getByRole('combobox', {name: 'Local enabled Skill'}), ''); expect(screen.queryByRole('checkbox')).toBeNull();
});
test.each(['uncertain', 'rejected', 'lost', 'malformed', 'provider-error'])('%s requires explicit inspection, consumes consent and never retries', async kind => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'skill_previewed')));
  if (kind === 'lost') fetcher.mockRejectedValueOnce(new Error('offline'));
  else if (kind === 'malformed') fetcher.mockResolvedValueOnce(reply({}));
  else if (kind === 'provider-error') {const r = receipt(); Object.assign((r.data as {execution: object}).execution, {output: null, error: 'rate_limit'}); fetcher.mockResolvedValueOnce(reply(r));}
  else fetcher.mockResolvedValueOnce(reply(envelope(null, kind === 'uncertain' ? 'delivery_uncertain' : 'configuration_unavailable', task, kind)));
  vi.stubGlobal('fetch', fetcher); const inspect = vi.fn(); render(<WorkSkill taskId={task} onInspect={inspect} />); await prepare();
  await userEvent.click(screen.getByRole('checkbox')); await userEvent.dblClick(screen.getByRole('button', {name: 'Execute local Skill once'}));
  const recovery = await screen.findByRole('button', {name: 'Inspect before another Skill execution'});
  await waitFor(() => expect((recovery as HTMLButtonElement).disabled).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(3); expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(recovery); expect(inspect).toHaveBeenCalledTimes(1);
});
test('unmount discards pending response on disconnect or selected-work change', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal('fetch', fetcher); const view = render(<WorkSkill taskId={task} onInspect={vi.fn()} />); await discover(); await userEvent.click(previewButton());
  view.unmount(); render(<WorkSkill taskId={skill} onInspect={vi.fn()} />);
  await act(async () => {finish(reply(envelope(preview, 'skill_previewed')));}); expect(screen.queryByRole('checkbox')).toBeNull();
});
test('rejects identity, count and provenance mismatches', () => {
  for (const patch of [{task_id: skill}, {skill_id: task}, {expected_runs: -1}, {expected_runs: 1.5}, {input: ''}, {preview_id: ''}]) expect(() => parseSkillResponse(envelope({...preview, ...patch}, 'skill_previewed'), task, 'preview', skill)).toThrow();
  const r = receipt(); (r.data as {skill: {preview_id: string}}).skill.preview_id = 'wrong';
  expect(() => parseSkillResponse(r, task, 'execute', skill, preview)).toThrow();
});

test.each(['selection', 'disconnect', 'inspection', 'navigation'])('%s invalidates Skill preview and consent in selected-work inspection', async reason => {
  const inspected = {schema_version: 1, requested_task_id: task, status: 'success', code: 'inspected', message: 'Inspected', recovery: 'Inspect again', inspection: {
    task: {id: task, title: 'Saved work', status: 'pending', assignees: [skill]}, attempts: [],
    readiness: {schema_version: 1, task_id: task, input: 'Saved work', employee_ids: [skill], expected_runs: 0, active_attempt: false, eligibility: 'eligible', resubmission_consent_required: false},
    evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'], read_only: true, external_client_verified: false},
  }};
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspected)).mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'skill_previewed'))).mockResolvedValue(reply(inspected));
  vi.stubGlobal('fetch', fetcher); const view = render(<WorkInspection taskId={task} />);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  await screen.findByRole('button', {name: 'Find Skills through local MCP'});
  await discover(); await userEvent.click(previewButton());
  const consent = await screen.findByLabelText(/I authorize one execution of this exact Skill preview/); await userEvent.click(consent);
  if (reason === 'selection') view.rerender(<WorkInspection taskId={skill} />);
  else if (reason === 'disconnect') view.rerender(<WorkInspection taskId={task} connected={false} />);
  else if (reason === 'navigation') view.rerender(<WorkInspection taskId={task} skillRequest={{taskId: task, skillId: skill}} />);
  else await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  expect(screen.queryByLabelText(/I authorize one execution of this exact Skill preview/)).toBeNull();
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/skills/execute'))).toBe(false);
});

test.each(['enabled', 'disabled', 'missing'])('requested Skill discovery uses exact ID among duplicate names: %s', async state => {
  const records = [{id: task, name: 'Summarize', enabled: true}, ...(state === 'missing' ? [] : [{id: skill, name: 'Summarize', enabled: state === 'enabled'}])];
  const fetcher = vi.fn().mockResolvedValue(reply(envelope({schema_version: 1, skills: records}, 'skills_discovered', null)));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkSkill taskId={task} navigation={{taskId: task, skillId: skill}} onInspect={vi.fn()} />);
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', {name: 'Find Skills through local MCP'}));
  const select = screen.getByRole('combobox', {name: 'Local enabled Skill'}) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe(state === 'enabled' ? skill : ''));
  if (state === 'enabled') await waitFor(() => expect(document.activeElement).toBe(select));
  else expect(await screen.findByText(new RegExp(`Requested Skill is ${state}`))).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('checkbox')).toBeNull();
});

test('same-Task Skill navigation discards pending inspection replies and focuses the fresh request', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkInspection taskId={task} skillRequest={{taskId: task, skillId: skill}} />);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Skill inspection'}));
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  view.rerender(<WorkInspection taskId={task} skillRequest={{taskId: task, skillId: task}} />);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Skill inspection'}));
  await act(async () => {finish(reply({}));});
  expect(screen.queryByRole('button', {name: 'Find Skills through local MCP'})).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
