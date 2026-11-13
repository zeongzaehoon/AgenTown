import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkLoop } from './WorkLoop';
import { parseLocalLoop } from './work-loop-api';
const task = '11111111-1111-4111-8111-111111111111';
const policy = '22222222-2222-4222-8222-222222222222';
const preview = {schema_version: 1 as const, preview_id: 'one', policy_id: policy, policy_name: 'Draft', task_id: task, agent_id: task, input: 'Exact saved input', max_iterations: 2, interval_seconds: 60, expected_runs: 0, created_at: 1, policy_enabled: true, provider: 'fixture', model: 'fixture'};
const {provider, model, ...savedPreview} = preview;
const session = {schema_version: 1, session_id: policy, preview: savedPreview, state: 'active', admitted: 0, next_at: 1, started_at: 1, expires_at: 100, provider, model, declared_source: 'agentown-local-product'};
const envelope = (data: unknown, code: string, status = 'confirmed') => ({schema_version: 1, requested_task_id: task, status, code, recovery: 'Inspect explicitly', data});
const reply = (data: unknown, code: string) => new Response(JSON.stringify(envelope(data, code)));
function setup() {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({schema_version: 1, loops: [{id: policy, name: 'Draft', task_id: task, max_iterations: 2, interval_seconds: 60, enabled: true}]}, 'loops_discovered')).mockResolvedValueOnce(reply(preview, 'loop_previewed'));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
async function prepare() {
  await userEvent.click(screen.getByRole('button', {name: 'Find matching Loops through local MCP'}));
  await userEvent.selectOptions(screen.getByRole('combobox', {name: 'Local enabled Loop'}), policy);
  await userEvent.click(screen.getByRole('button', {name: 'Preview local Loop'}));
  await screen.findByRole('checkbox');
}
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
test('keyboard preview, explicit complete consent, duplicate prevention and retained Stop after selection change', async () => {
  const fetcher = setup(); let finish!: (v: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})).mockResolvedValueOnce(reply({...session, state: 'stopped'}, 'loop_stopped')).mockResolvedValueOnce(reply(inspection([{...session, state: 'stopped'}]), 'loops_inspected'));
  const view = render(<WorkLoop taskId={task} connected inspected />);
  expect(fetcher).not.toHaveBeenCalled(); await prepare();
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Local Loop preview'}));
  screen.getByRole('checkbox').focus(); await userEvent.keyboard(' '); await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Authorize and activate local Loop'}));
  await userEvent.keyboard('{Enter}'); expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({task_id: task, consent: preview, execution_consent: true});
  view.rerender(<WorkLoop taskId={policy} connected inspected={false} />);
  await act(async () => finish(reply(session, 'loop_started')));
  await userEvent.click(await screen.findByRole('button', {name: `Stop local Loop ${policy}`}));
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({task_id: task, session_id: policy});
  expect(await screen.findByText(/Stopped · Admitted/)).toBeTruthy();
});
test.each(['selection', 'disconnect', 'replacement'])('%s invalidates consent', async reason => {
  const fetcher = setup(); fetcher.mockResolvedValueOnce(reply({...preview, preview_id: 'two'}, 'loop_previewed'));
  const view = render(<WorkLoop taskId={task} connected inspected />); await prepare(); await userEvent.click(screen.getByRole('checkbox'));
  if (reason === 'replacement') {await userEvent.click(screen.getByRole('button', {name: 'Preview local Loop'})); expect((await screen.findByRole('checkbox') as HTMLInputElement).checked).toBe(false);}
  else {view.rerender(<WorkLoop taskId={reason === 'selection' ? policy : task} connected={reason !== 'disconnect'} inspected />); expect(screen.queryByRole('checkbox')).toBeNull();}
  expect(fetcher.mock.calls.some(c => String(c[0]).endsWith('/start'))).toBe(false);
});
test('uncertain activation consumes consent and never retries; session inspection remains available', async () => {
  const fetcher = setup(); fetcher.mockRejectedValueOnce(new Error('offline'));
  render(<WorkLoop taskId={task} connected inspected />); await prepare(); await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.dblClick(screen.getByRole('button', {name: 'Authorize and activate local Loop'}));
  expect(await screen.findByText(/Delivery uncertain/)).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect((screen.getByRole('button', {name: 'Inspect local Loop sessions'}) as HTMLButtonElement).disabled).toBe(false);
});
test('late preview after selection change is discarded', async () => {
  const fetcher = setup(); let finish!: (v: Response) => void;
  fetcher.mockReset().mockResolvedValueOnce(reply({schema_version: 1, loops: [{id: policy, name: 'Draft', task_id: task, max_iterations: 2, interval_seconds: 60, enabled: true}]}, 'loops_discovered')).mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
  const view = render(<WorkLoop taskId={task} connected inspected />);
  await userEvent.click(screen.getByRole('button', {name: 'Find matching Loops through local MCP'}));
  await userEvent.selectOptions(screen.getByRole('combobox'), policy); await userEvent.click(screen.getByRole('button', {name: 'Preview local Loop'}));
  view.rerender(<WorkLoop taskId={policy} connected inspected />);
  await act(async () => finish(reply(preview, 'loop_previewed'))); expect(screen.queryByRole('checkbox')).toBeNull();
});
test('typed boundaries reject wrong selection, bounds, authority and immutable provenance', () => {
  for (const patch of [{task_id: policy}, {max_iterations: 101}, {expected_runs: -1}, {created_at: null}, {model: null}, {policy_enabled: false}]) expect(() => parseLocalLoop(envelope({...preview, ...patch}, 'loop_previewed'), task, 'preview', policy)).toThrow();
  expect(() => parseLocalLoop(envelope({...session, preview: {...savedPreview, input: 'changed'}}, 'loop_started'), task, 'start', preview)).toThrow();
  expect(() => parseLocalLoop(envelope({schema_version: 1, sessions: [session], attempts: [], control: {state: 'unknown', can_control: true, message: ''}}, 'loops_inspected'), task, 'inspect')).toThrow();
});

function inspection(sessions: unknown[] = [session], state = 'local_authority') {
  return {schema_version: 1, sessions, attempts: [], control: {state, can_control: state === 'local_authority', message: 'Recorded authority'}};
}
test('requested session requires explicit read, focuses exact session and confirms Stop with persisted inspection', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection(), 'loops_inspected'))
    .mockResolvedValueOnce(reply({...session, state: 'stopped'}, 'loop_stopped'))
    .mockResolvedValueOnce(reply(inspection([{...session, state: 'stopped'}]), 'loops_inspected'));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkLoop taskId={task} connected inspected={false} navigation={{taskId: task, sessionId: policy}} />);
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', {name: 'Inspect local Loop sessions'}));
  expect(document.activeElement).toBe(await screen.findByRole('region', {name: `Local Loop session ${policy}`}));
  await userEvent.click(screen.getByRole('button', {name: `Stop local Loop ${policy}`}));
  expect(await screen.findByText(/Saved stopped state confirmed/)).toBeTruthy();
  expect(fetcher.mock.calls.map(c => c[0])).toEqual(['/api/connections/v1/loops/inspect', '/api/connections/v1/loops/stop', '/api/connections/v1/loops/inspect']);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({task_id: task, session_id: policy});
});
test('missing requested session and competing owner never grant Stop from declared source', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection([]), 'loops_inspected'))
    .mockResolvedValueOnce(new Response(JSON.stringify(envelope(inspection([session], 'competing_owner'), 'competing_owner', 'rejected'))));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkLoop taskId={task} connected inspected={false} navigation={{taskId: task, sessionId: policy}} />);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect local Loop sessions'}));
  expect(await screen.findByText(/Requested Loop session is missing/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', {name: 'Inspect local Loop sessions'}));
  expect((await screen.findByRole('button', {name: `Stop local Loop ${policy}`} ) as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('late navigation read cannot steal focus or populate obsolete records', async () => {
  let finish!: (v: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {finish = resolve;})));
  const view = render(<WorkLoop taskId={task} connected inspected={false} navigation={{taskId: task, sessionId: policy}} />);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect local Loop sessions'}));
  view.rerender(<WorkLoop taskId={policy} connected inspected={false} navigation={{taskId: policy, sessionId: task}} />);
  await act(async () => finish(reply(inspection(), 'loops_inspected')));
  expect(screen.queryByRole('region', {name: `Local Loop session ${policy}`})).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
});
test('uncertain Stop is unconfirmed and is not replayed automatically', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection(), 'loops_inspected')).mockRejectedValueOnce(new Error('lost receipt'));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkLoop taskId={task} connected inspected />);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect local Loop sessions'}));
  await userEvent.click(await screen.findByRole('button', {name: `Stop local Loop ${policy}`}));
  expect(await screen.findByText(/Delivery uncertain/)).toBeTruthy();
  expect((screen.getByRole('button', {name: `Stop local Loop ${policy}`} ) as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each(['enabled', 'disabled', 'missing'])('policy navigation selects exact ID after explicit discovery: %s', async state => {
  const duplicate = '33333333-3333-4333-8333-333333333333';
  const row = {id: policy, name: 'Draft', task_id: task, max_iterations: 2, interval_seconds: 60, enabled: state !== 'disabled'};
  const fetcher = vi.fn().mockResolvedValue(reply({schema_version: 1, loops: [{...row, id: duplicate, enabled: true}, ...(state === 'missing' ? [] : [row])]}, 'loops_discovered'));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkLoop taskId={task} connected inspected navigation={{taskId: task, policyId: policy}} />);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
  expect(fetcher).not.toHaveBeenCalled();
  const discovery = screen.getByRole('button', {name: 'Find matching Loops through local MCP'});
  discovery.focus(); await userEvent.keyboard('{Enter}');
  const select = screen.getByRole('combobox', {name: 'Local enabled Loop'}) as HTMLSelectElement;
  expect(select.value).toBe(state === 'enabled' ? policy : '');
  if (state === 'enabled') expect(document.activeElement).toBe(select);
  else expect(screen.getByText(state === 'disabled' ? /Requested Loop policy is disabled/ : /Requested Loop policy is missing or no longer matches/)).toBeTruthy();
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({task_id: task});
  expect(fetcher.mock.calls.map(c => c[0])).toEqual(['/api/connections/v1/loops/list']);
  expect(screen.queryByRole('checkbox')).toBeNull();
});

test('same-Task policy navigation clears prior consent and ignores obsolete discovery', async () => {
  const fetcher = setup();
  const view = render(<WorkLoop taskId={task} connected inspected />);
  await prepare(); await userEvent.click(screen.getByRole('checkbox'));
  view.rerender(<WorkLoop taskId={task} connected inspected navigation={{taskId: task, policyId: policy}} />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
  await userEvent.click(screen.getByRole('button', {name: 'Find matching Loops through local MCP'}));
  const other = '33333333-3333-4333-8333-333333333333';
  view.rerender(<WorkLoop taskId={task} connected inspected navigation={{taskId: task, policyId: other}} />);
  await act(async () => finish(reply({schema_version: 1, loops: [{id: policy, name: 'Draft', task_id: task, enabled: true, max_iterations: 2, interval_seconds: 60}]}, 'loops_discovered')));
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Loop inspection'}));
  expect(fetcher.mock.calls.some(c => /\/(start|stop)$/.test(String(c[0])))).toBe(false);
});


test('discovery rejects changed Task linkage and does not select an alternative policy', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({schema_version: 1, loops: [{id: policy, name: 'Draft', task_id: policy, enabled: true, max_iterations: 2, interval_seconds: 60}]}, 'loops_discovered')));
  render(<WorkLoop taskId={task} connected inspected navigation={{taskId: task, policyId: policy}} />);
  await userEvent.click(screen.getByRole('button', {name: 'Find matching Loops through local MCP'}));
  expect(await screen.findByText(/Local MCP response could not be confirmed/)).toBeTruthy();
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  expect((screen.getByRole('button', {name: 'Preview local Loop'}) as HTMLButtonElement).disabled).toBe(true);
});
