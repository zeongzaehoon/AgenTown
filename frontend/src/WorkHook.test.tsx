import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkInspection } from './WorkInspection';
import { WorkHook } from './WorkHook';
import { parseHookResponse } from './work-hook-api';
const task = '11111111-1111-4111-8111-111111111111';
const hook = '22222222-2222-4222-8222-222222222222';
const preview = {schema_version: 1 as const, task_id: task, hook_id: hook, preview_id: 'preview-1', input: 'Exact instructions\n\nSaved work', expected_runs: 1, agent_id: task, skill_id: hook, source_run_id: task, event: 'run_completed', source_outcome: 'reported_success', hook_enabled: true as const, skill_enabled: true as const, target_kind: 'agent' as const, hook_name: 'Summarize', skill_name: 'Summarize', instructions: 'Exact instructions'};
const envelope = (data: unknown, code: string, requested_task_id: string | null = task, status = 'confirmed') => ({schema_version: 1, requested_task_id, status, code, data, recovery: 'Inspect again explicitly'});
const discovery = () => envelope({schema_version: 1, hooks: [{id: hook, name: 'Summarize', enabled: true, skill_id: hook, target_id: task, target_kind: 'agent', event: 'run_completed'}]}, 'hooks_discovered', null);
const receipt = () => envelope({execution: {schema_version: 1, run_id: task, input: preview.input, provider: 'fixture', model: 'fixture', deadline_unix_ms: 100, output: 'Saved result', error: null, quality: 'unverified'}, hook: {...preview, run_id: task, admitted_at: 1}}, 'execution_recorded', task, 'completed');
const reply = (v: unknown) => new Response(JSON.stringify(v));
const previewButton = () => screen.getByRole('button', {name: 'Preview local Hook'});
async function discover() {
  await userEvent.click(screen.getByRole('button', {name: 'Find Hooks through local MCP'}));
  await screen.findByRole('option', {name: /Summarize/});
  await userEvent.selectOptions(screen.getByRole('combobox', {name: 'Local enabled Hook'}), hook);
}
async function prepare() {
  await discover(); await userEvent.click(previewButton()); await screen.findByRole('checkbox');
}
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
test('preview never dispatches; keyboard consent sends exactly one complete tuple and restores recovery focus', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed'))).mockResolvedValueOnce(reply(receipt()));
  vi.stubGlobal('fetch', fetcher); render(<WorkHook taskId={task} onInspect={vi.fn()} />);
  expect(fetcher).not.toHaveBeenCalled(); await prepare();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === preview.input)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Local Hook preview'}));
  const consent = screen.getByRole('checkbox'); consent.focus(); await userEvent.keyboard(' '); await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Execute local Hook once'}));
  await userEvent.keyboard('{Enter}'); await screen.findByText('Saved result');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({task_id: task, hook_id: hook, agent_id: task, skill_id: hook, source_run_id: task, event: 'run_completed', source_outcome: 'reported_success', preview_id: 'preview-1', input: preview.input, expected_runs: 1, execution_consent: true});
  expect(screen.getByText('Quality unverified')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Inspect before another Hook execution'})));
  await userEvent.click(previewButton()); expect(fetcher).toHaveBeenCalledTimes(3);
});
test('selection and new previews discard consent and stale preview responses', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed')))
    .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})).mockResolvedValueOnce(reply(envelope({...preview, preview_id: 'fresh'}, 'hook_previewed')));
  vi.stubGlobal('fetch', fetcher); render(<WorkHook taskId={task} onInspect={vi.fn()} />); await prepare();
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(previewButton()); expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(previewButton()); await screen.findByRole('checkbox');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  await act(async () => {finish(reply(envelope(preview, 'hook_previewed')));});
  expect(screen.getByText(/Preview ID: fresh/)).toBeTruthy();
  await userEvent.selectOptions(screen.getByRole('combobox', {name: 'Local enabled Hook'}), ''); expect(screen.queryByRole('checkbox')).toBeNull();
});
test.each(['uncertain', 'rejected', 'lost', 'malformed', 'provider-error'])('%s requires explicit inspection, consumes consent and never retries', async kind => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed')));
  if (kind === 'lost') fetcher.mockRejectedValueOnce(new Error('offline'));
  else if (kind === 'malformed') fetcher.mockResolvedValueOnce(reply({}));
  else if (kind === 'provider-error') {const r = receipt(); Object.assign((r.data as {execution: object}).execution, {output: null, error: 'rate_limit'}); fetcher.mockResolvedValueOnce(reply(r));}
  else fetcher.mockResolvedValueOnce(reply(envelope(null, kind === 'uncertain' ? 'delivery_uncertain' : 'configuration_unavailable', task, kind)));
  vi.stubGlobal('fetch', fetcher); const inspect = vi.fn(); render(<WorkHook taskId={task} onInspect={inspect} />); await prepare();
  await userEvent.click(screen.getByRole('checkbox')); await userEvent.dblClick(screen.getByRole('button', {name: 'Execute local Hook once'}));
  const recovery = await screen.findByRole('button', {name: 'Inspect before another Hook execution'});
  await waitFor(() => expect((recovery as HTMLButtonElement).disabled).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(3); expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(recovery); expect(inspect).toHaveBeenCalledTimes(1);
});
test('unmount discards pending response on disconnect or selected-work change', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal('fetch', fetcher); const view = render(<WorkHook taskId={task} onInspect={vi.fn()} />); await discover(); await userEvent.click(previewButton());
  view.unmount(); render(<WorkHook taskId={hook} onInspect={vi.fn()} />);
  await act(async () => {finish(reply(envelope(preview, 'hook_previewed')));}); expect(screen.queryByRole('checkbox')).toBeNull();
});
test('rejects identity, count and provenance mismatches', () => {
  for (const patch of [{task_id: hook}, {hook_id: task}, {agent_id: 'bad'}, {skill_enabled: false}, {source_outcome: 'failure'}, {target_kind: 'team'}, {expected_runs: -1}, {expected_runs: 1.5}, {input: ''}, {preview_id: ''}]) expect(() => parseHookResponse(envelope({...preview, ...patch}, 'hook_previewed'), task, 'preview', hook)).toThrow();
  const r = receipt(); (r.data as {hook: {preview_id: string}}).hook.preview_id = 'wrong';
  expect(() => parseHookResponse(r, task, 'execute', hook, preview)).toThrow();
});

test.each(['selection', 'disconnect', 'inspection', 'navigation'])('%s invalidates Hook preview and consent in selected-work inspection', async reason => {
  const inspected = {schema_version: 1, requested_task_id: task, status: 'success', code: 'inspected', message: 'Inspected', recovery: 'Inspect again', inspection: {
    task: {id: task, title: 'Saved work', status: 'pending', assignees: [hook]}, attempts: [],
    readiness: {schema_version: 1, task_id: task, input: 'Saved work', employee_ids: [hook], expected_runs: 0, active_attempt: false, eligibility: 'eligible', resubmission_consent_required: false},
    evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'], read_only: true, external_client_verified: false},
  }};
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspected)).mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed'))).mockResolvedValue(reply(inspected));
  vi.stubGlobal('fetch', fetcher); const view = render(<WorkInspection taskId={task} />);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  await screen.findByRole('button', {name: 'Find Hooks through local MCP'});
  await discover(); await userEvent.click(previewButton());
  const consent = await screen.findByLabelText(/I authorize one execution of this exact Hook preview/); await userEvent.click(consent);
  if (reason === 'selection') view.rerender(<WorkInspection taskId={hook} />);
  else if (reason === 'navigation') view.rerender(<WorkInspection taskId={task} hookRequest={{taskId: task, hookId: hook, employeeId: task}} />);
  else if (reason === 'disconnect') view.rerender(<WorkInspection taskId={task} connected={false} />);
  else await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  expect(screen.queryByLabelText(/I authorize one execution of this exact Hook preview/)).toBeNull();
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/hooks/execute'))).toBe(false);
});

test('every persisted consent field must match, including source event and employee', () => {
  for (const patch of [{task_id: hook}, {hook_id: task}, {agent_id: hook}, {skill_id: task}, {source_run_id: hook}, {event: 'run_failed'}, {source_outcome: 'failure'}, {input: 'different'}, {preview_id: 'different'}, {hook_enabled: false}, {skill_enabled: false}, {target_kind: 'team'}]) {
    const value = receipt(); Object.assign((value.data as {hook: object}).hook, patch);
    expect(() => parseHookResponse(value, task, 'execute', hook, preview)).toThrow();
  }
});

test('late execution receipt is discarded; reinspection requires discovery, fresh preview and fresh consent', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed')))
    .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}))
    .mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope({...preview, preview_id: 'fresh'}, 'hook_previewed')));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkHook key="first-inspection" taskId={task} onInspect={vi.fn()} />);
  await prepare(); await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', {name: 'Execute local Hook once'}));
  view.rerender(<WorkHook key="fresh-inspection" taskId={task} onInspect={vi.fn()} />);
  await act(async () => {finish(reply(receipt()));});
  expect(screen.queryByText('Saved result')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull();
  await prepare();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', {name: 'Execute local Hook once'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Preview ID: fresh/)).toBeTruthy();
  expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/hooks/execute'))).toHaveLength(1);
});

test.each(['eligible', 'missing', 'disabled', 'retargeted', 'unsupported'])('requested Hook %s never substitutes a duplicate name', async state => {
  const record = {id: hook, name: 'Summarize', enabled: state !== 'disabled', skill_id: hook, target_id: state === 'retargeted' ? hook : task, target_kind: 'agent', event: state === 'unsupported' ? 'task_created' : 'run_completed'};
  const fetcher = vi.fn().mockResolvedValue(reply(envelope({schema_version: 1, hooks: [...(state === 'missing' ? [] : [record]), {...record, id: task, enabled: true, event: 'run_completed'}]}, 'hooks_discovered', null)));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkHook taskId={task} assignees={[task]} navigation={{taskId: task, hookId: hook, employeeId: task}} onInspect={vi.fn()} />);
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', {name: 'Find Hooks through local MCP'}));
  const select = screen.getByRole('combobox', {name: 'Local enabled Hook'}) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe(state === 'eligible' ? hook : ''));
  if (state === 'eligible') await waitFor(() => expect(document.activeElement).toBe(select));
  else expect(await screen.findByText(/Requested Hook is/)).toBeTruthy();
  expect(screen.queryByRole('option', {name: `Summarize · ${task}`})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('same-Task navigation invalidates pending inspection and discards its late reply', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal('fetch', fetcher);
  const navigation = {taskId: task, hookId: hook, employeeId: task};
  const view = render(<WorkInspection taskId={task} hookRequest={navigation} />);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Hook inspection'}));
  await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  view.rerender(<WorkInspection taskId={task} hookRequest={{...navigation}} />);
  await act(async () => {finish(reply({}));});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', {name: 'Find Hooks through local MCP'})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['Escape', 'Cancel'])('%s dismisses checked Hook preview locally and requires fresh consent', async method => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery()))
    .mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed')))
    .mockResolvedValueOnce(reply(envelope({...preview, preview_id: 'fresh'}, 'hook_previewed')));
  vi.stubGlobal('fetch', fetcher); const inspect = vi.fn();
  render(<WorkHook taskId={task} onInspect={inspect} />); await prepare();
  await userEvent.click(screen.getByRole('checkbox'));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  if (method === 'Escape') await userEvent.keyboard('{Escape}');
  else {screen.getByRole('button', {name: 'Cancel local Hook preview'}).focus(); await userEvent.keyboard('{Enter}');}
  expect(screen.queryByRole('region', {name: 'Local Hook preview'})).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Local Hook preview dismissed. Consent cleared. No execution requested.');
  expect(document.activeElement).toBe(previewButton());
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(hook);
  expect(fetcher).toHaveBeenCalledTimes(2); expect(inspect).not.toHaveBeenCalled();
  await userEvent.keyboard('{Enter}'); await screen.findByText(/Preview ID: fresh/);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', {name: 'Execute local Hook once'}) as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('Escape after dispatch preserves pending execution and uncertain recovery', async () => {
  let finish!: () => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(discovery())).mockResolvedValueOnce(reply(envelope(preview, 'hook_previewed')))
    .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {finish = () => reject(new Error('offline'));}));
  vi.stubGlobal('fetch', fetcher); render(<WorkHook taskId={task} onInspect={vi.fn()} />); await prepare();
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', {name: 'Execute local Hook once'}));
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('button', {name: 'Cancel local Hook preview'})).toBeNull();
  expect((fetcher.mock.calls[2][1].signal as AbortSignal).aborted).toBe(false);
  await act(async () => finish());
  await screen.findByText(/Delivery is uncertain/); await userEvent.keyboard('{Escape}');
  expect(screen.getByText(/Consent consumed/)).toBeTruthy();
  expect((previewButton() as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
