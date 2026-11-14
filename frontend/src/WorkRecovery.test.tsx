import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkInspection } from './WorkInspection';
import { parseWorkRecovery } from './work-recovery-api';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const evidence = {source: 'installed_local_mcp', tool: 'get_work_history_v1', read_only: false, mutation_scope: 'snapshot_expired_leases', external_client_verified: false};
const receipt = () => ({schema_version: 1, requested_task_id: id, status: 'confirmed', code: 'reconciliation_confirmed', recovery: 'Inspect again', evidence,
  inspection: {task: {id, title: 'Saved work', status: 'pending', assignees: []}, attempts: [], readiness: null}});
const reply = (value: unknown) => new Response(JSON.stringify(value));
const review = () => screen.getByRole('button', {name: 'Review recovery scope'});
const submit = () => screen.getByRole('button', {name: 'Reconcile expired attempts once'});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

test('keyboard review and explicit consent, pending lock, receipt and focus; zero automatic execution', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkInspection taskId={id} />);
  expect(fetcher).not.toHaveBeenCalled();
  review().focus(); await userEvent.keyboard('{Enter}');
  const consent = screen.getByRole('checkbox');
  expect(document.activeElement).toBe(consent);
  expect((submit() as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard(' '); await userEvent.tab();
  expect(document.activeElement).toBe(submit()); await userEvent.keyboard('{Enter}');
  await userEvent.dblClick(submit());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Recovery requested. Waiting for confirmation…')).toBeTruthy();
  expect(fetcher.mock.calls[0]).toBeTruthy();
  await act(async () => {finish(reply(receipt()));});
  await screen.findByText(/Reconciliation confirmed/);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Inspect after recovery'})));
  expect(screen.queryByRole('button', {name: 'Execute once through local MCP'})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('uncertain delivery preserves recovery access and does not replay on rerender', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('lost')); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkInspection taskId={id} />);
  await userEvent.click(review()); await userEvent.click(screen.getByRole('checkbox')); await userEvent.click(submit());
  await screen.findByText(/Recovery delivery is uncertain/);
  view.rerender(<WorkInspection taskId={id} />);
  expect((review() as HTMLButtonElement).disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('late receipt cannot affect a changed selection', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {finish = resolve;})));
  const view = render(<WorkInspection taskId={id} />);
  await userEvent.click(review()); await userEvent.click(screen.getByRole('checkbox')); await userEvent.click(submit());
  view.rerender(<WorkInspection taskId={other} />);
  await act(async () => {finish(reply(receipt()));});
  expect(screen.queryByText(/Reconciliation confirmed/)).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getByText(`Selected Task ID: ${other}`)).toBeTruthy();
});

test.each([{requested_task_id: other}, {evidence: {...evidence, read_only: true}}, {code: 'wrong'}, {inspection: null}, {status: 'uncertain'}])('invalid receipt is never confirmation %#', patch => {
  expect(() => parseWorkRecovery({...receipt(), ...patch}, id)).toThrow();
});

test('recovery consumes existing execution consent and requires fresh inspection', async () => {
  const inspected = {schema_version: 1, requested_task_id: id, status: 'success', code: 'inspected', message: 'Inspected', recovery: 'Inspect again', inspection: {
    task: receipt().inspection.task, attempts: [], readiness: {schema_version: 1, task_id: id, input: 'Saved input', employee_ids: [other], expected_runs: 0, active_attempt: false, eligibility: 'eligible', resubmission_consent_required: false},
    evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'], read_only: true, external_client_verified: false},
  }};
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspected)).mockResolvedValueOnce(reply(receipt())).mockResolvedValueOnce(reply(inspected));
  vi.stubGlobal('fetch', fetcher); render(<WorkInspection taskId={id} />);
  await userEvent.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  await userEvent.click(await screen.findByLabelText('I authorize one execution of this saved input.'));
  await userEvent.click(review());
  await userEvent.click(screen.getByLabelText('I authorize reconciliation of expired attempts across the database history snapshot.'));
  await userEvent.click(submit()); await screen.findByText(/Reconciliation confirmed/);
  expect(screen.queryByRole('button', {name: 'Execute once through local MCP'})).toBeNull();
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({task_id: id, recovery_consent: true});
  await userEvent.click(screen.getByRole('button', {name: 'Inspect after recovery'}));
  const fresh = await screen.findByLabelText('I authorize one execution of this saved input.');
  expect((fresh as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', {name: 'Execute once through local MCP'}) as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher.mock.calls.every(call => !call[0].includes('execute-work'))).toBe(true);
});

const authorization = () => screen.getByRole('checkbox', {name: 'I authorize reconciliation of expired attempts across the database history snapshot.'});
const destination = () => screen.getByRole('region', {name: 'Local MCP work inspection'});
const transitions = [
  {name: 'disconnect', taskId: id, connected: false},
  {name: 'changed selection', taskId: other, connected: true},
  {name: 'missing selection', taskId: null, connected: true},
  {name: 'saved work omitted while inspection ID is retained', taskId: id, connected: true, recoveryAvailable: false},
];

test.each(transitions)('focused consent recovers to inspection on $name without requests', async transition => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkInspection taskId={id} />);
  await userEvent.click(review()); await userEvent.click(authorization());
  expect(document.activeElement).toBe(authorization());
  view.rerender(<WorkInspection taskId={transition.taskId} connected={transition.connected} recoveryAvailable={transition.recoveryAvailable} />);
  expect(document.activeElement).toBe(destination());
  expect(screen.getByText(/The previous recovery review is unavailable/).getAttribute('aria-live')).toBe('polite');
  expect(screen.queryByRole('checkbox')).toBeNull();
  view.rerender(<WorkInspection taskId={id} connected />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(review());
  expect((authorization() as HTMLInputElement).checked).toBe(false);
  expect((submit() as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(transitions)('post-recovery control recovers on $name with no automatic requests', async transition => {
  const fetcher = vi.fn().mockResolvedValue(reply(receipt())); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkInspection taskId={id} />);
  await userEvent.click(review()); await userEvent.click(authorization()); await userEvent.click(submit());
  const inspect = await screen.findByRole('button', {name: 'Inspect after recovery'});
  await waitFor(() => expect(document.activeElement).toBe(inspect));
  view.rerender(<WorkInspection taskId={transition.taskId} connected={transition.connected} recoveryAvailable={transition.recoveryAvailable} />);
  expect(document.activeElement).toBe(destination());
  expect(screen.getByText(/The previous recovery review is unavailable/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(transitions)('outside focus survives recovery invalidation on $name', async transition => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const content = (taskId: string | null, connected = true, recoveryAvailable = true) => <><input aria-label="Outside draft" /><WorkInspection taskId={taskId} connected={connected} recoveryAvailable={recoveryAvailable} /></>;
  const view = render(content(id));
  await userEvent.click(review()); await userEvent.click(authorization());
  const outside = screen.getByRole('textbox', {name: 'Outside draft'}); outside.focus();
  view.rerender(content(transition.taskId, transition.connected, transition.recoveryAvailable));
  expect(document.activeElement).toBe(outside);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(transitions)('late recovery receipt cannot restore review or move outside focus after $name', async transition => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;})); vi.stubGlobal('fetch', fetcher);
  const content = (taskId: string | null, connected = true, recoveryAvailable = true) => <><input aria-label="Outside draft" /><WorkInspection taskId={taskId} connected={connected} recoveryAvailable={recoveryAvailable} /></>;
  const view = render(content(id));
  await userEvent.click(review()); await userEvent.click(authorization()); await userEvent.click(submit());
  // Focus a pending recovery control before replacement.
  authorization().focus();
  view.rerender(content(transition.taskId, transition.connected, transition.recoveryAvailable));
  expect(document.activeElement).toBe(destination());
  view.rerender(content(id));
  await userEvent.click(review());
  const outside = screen.getByRole('textbox', {name: 'Outside draft'}); outside.focus();
  await act(async () => {finish(reply(receipt()));});
  expect(document.activeElement).toBe(outside);
  expect(screen.queryByText(/Reconciliation confirmed/)).toBeNull();
  expect((authorization() as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('button', {name: 'Inspect after recovery'})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('explicit Skill navigation keeps its requested destination when recovery is removed', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkInspection taskId={id} />);
  await userEvent.click(review());
  view.rerender(<WorkInspection taskId={other} skillRequest={{taskId: other, skillId: id}} />);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Skill inspection'}));
  expect(screen.getByText(/The previous recovery review is unavailable/)).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

test('completed recovery replacement preserves outside focus and explicit Hook navigation', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply(receipt())); vi.stubGlobal('fetch', fetcher);
  const content = (connected: boolean) => <><button>Outside control</button><WorkInspection taskId={id} connected={connected} /></>;
  const view = render(content(true));
  await userEvent.click(review()); await userEvent.click(authorization()); await userEvent.click(submit());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Inspect after recovery'})));
  const outside = screen.getByRole('button', {name: 'Outside control'}); outside.focus();
  view.rerender(content(false));
  expect(document.activeElement).toBe(outside);
  view.rerender(content(true));
  await userEvent.click(review());
  view.rerender(<WorkInspection taskId={other} hookRequest={{taskId: other, hookId: id, employeeId: id}} />);
  expect(document.activeElement).toBe(screen.getByRole('region', {name: 'Requested Hook inspection'}));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
