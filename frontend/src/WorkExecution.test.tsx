import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkInspection } from './WorkInspection';
import { parseWorkExecution } from './work-execution-api';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const inspection = (count = 0, task = id) => ({schema_version: 1, requested_task_id: task,
  status: 'success', code: 'inspected', message: 'Inspected', recovery: 'Inspect again', inspection: {
    task: {id: task, title: 'Saved request', status: 'pending', assignees: [other]}, attempts: [],
    readiness: {schema_version: 1, task_id: task, input: 'Saved input', employee_ids: [other],
      expected_runs: count, active_attempt: false, eligibility: 'eligible', resubmission_consent_required: count > 0},
    evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'], read_only: true, external_client_verified: false},
  }});
const recorded = () => ({schema_version: 1, requested_task_id: id, status: 'completed', code: 'execution_recorded', recovery: 'Inspect again',
  execution: {schema_version: 1, run_id: other, input: 'Saved input', provider: 'fixture', model: 'fixture',
    deadline_unix_ms: 100, output: 'Recorded answer', error: null, quality: 'unverified'}});
const reply = (value: unknown) => new Response(JSON.stringify(value));
const inspect = () => screen.getByRole('button', {name: 'Inspect through local MCP'});
const execute = () => screen.getByRole('button', {name: 'Execute once through local MCP'});
async function authorize() {
  await screen.findByRole('checkbox');
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(execute());
}
afterEach(() => {cleanup(); vi.unstubAllGlobals(); vi.useRealTimers();});

test('keyboard consent, one execution, focus recovery and fresh consented resubmission', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection())).mockResolvedValueOnce(reply(recorded()))
    .mockResolvedValueOnce(reply(inspection(1))).mockResolvedValueOnce(reply({...recorded(), execution: {...recorded().execution, output: null, error: 'rate_limit'}}));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkInspection taskId={id} />);
  await userEvent.click(inspect());
  const consent = await screen.findByRole('checkbox');
  expect((execute() as HTMLButtonElement).disabled).toBe(true);
  consent.focus(); await userEvent.keyboard(' '); await userEvent.tab();
  expect(document.activeElement).toBe(execute()); await userEvent.keyboard('{Enter}');
  await screen.findByText('Recorded answer');
  expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({task_id: id, expected_runs: 0, resubmission_consent: false}));
  const recovery = screen.getByRole('button', {name: 'Inspect before another execution'});
  await waitFor(() => expect(document.activeElement).toBe(recovery));
  await userEvent.keyboard('{Enter}');
  await screen.findByLabelText(/I authorize one resubmission/);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  await authorize(); await screen.findByText('Recorded provider error: rate_limit');
  expect(screen.getByText('Quality unverified')).toBeTruthy();
  expect(fetcher.mock.calls[3][1].body).toBe(JSON.stringify({task_id: id, expected_runs: 1, resubmission_consent: true}));
});

test.each([
  ['rejected', 'configuration_unavailable'], ['rejected', 'execution_busy'], ['rejected', 'admission_rejected'],
  ['unavailable', 'transport_unavailable'], ['uncertain', 'delivery_uncertain'], ['completed', 'wrong_code'],
])('%s/%s consumes consent and requires inspection', async (status, code) => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection()))
    .mockResolvedValueOnce(reply({schema_version: 1, requested_task_id: id, status, code, recovery: 'Resolve then inspect', execution: null}));
  vi.stubGlobal('fetch', fetcher); render(<WorkInspection taskId={id} />);
  await userEvent.click(inspect()); await authorize(); await screen.findByRole('alert');
  expect((execute() as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('button', {name: 'Inspect before another execution'})).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('duplicate clicks are locked and selection changes discard late execution', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection()))
    .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}))
    .mockResolvedValue(reply(inspection(0, other)));
  vi.stubGlobal('fetch', fetcher); const view = render(<WorkInspection taskId={id} />);
  await userEvent.click(inspect()); await authorize();
  await userEvent.dblClick(execute()); expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<WorkInspection taskId={other} />);
  await userEvent.click(inspect()); await screen.findByRole('checkbox');
  await act(async () => {finish(reply(recorded()));});
  expect(screen.queryByText('Recorded answer')).toBeNull();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  view.rerender(<WorkInspection taskId={other} connected={false} />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  view.rerender(<WorkInspection taskId={other} connected />);
  expect(screen.queryByRole('checkbox')).toBeNull();
});

test.each(['lost', 'malformed', 'timeout'])('%s delivery never replays', async kind => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection()));
  if (kind === 'lost') fetcher.mockRejectedValueOnce(new Error('offline'));
  if (kind === 'malformed') fetcher.mockResolvedValueOnce(new Response('{broken'));
  if (kind === 'timeout') fetcher.mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher); render(<WorkInspection taskId={id} />);
  await userEvent.click(inspect()); await screen.findByRole('checkbox');
  if (kind === 'timeout') {
    vi.useFakeTimers();
    await act(async () => {screen.getByRole('checkbox').click();});
    await act(async () => {execute().click();});
    await act(async () => {await vi.advanceTimersByTimeAsync(75_001);});
    expect(screen.getByRole('alert').textContent).toContain('Delivery is uncertain');
  } else {await authorize(); await screen.findByRole('alert');}
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((execute() as HTMLButtonElement).disabled).toBe(true);
});

test.each([
  {requested_task_id: other}, {status: 'rejected'}, {execution: null},
  {execution: {...recorded().execution, quality: 'verified'}},
  {execution: {...recorded().execution, error: 'failure'}},
])('rejects mismatched or malformed execution records %#', patch => {
  expect(() => parseWorkExecution({...recorded(), ...patch}, id)).toThrow();
});

test.each(['active', 'unassigned', 'missing'])('%s readiness cannot grant execution consent', async kind => {
  const value = inspection();
  if (kind === 'missing') Object.assign(value.inspection.readiness, {eligibility: 'missing', input: null, employee_ids: []});
  else Object.assign(value.inspection.readiness, {eligibility: 'ineligible',
    active_attempt: kind === 'active', expected_runs: kind === 'active' ? 1 : 0,
    resubmission_consent_required: kind === 'active', employee_ids: kind === 'unassigned' ? [] : [other]});
  const fetcher = vi.fn().mockResolvedValue(reply(value)); vi.stubGlobal('fetch', fetcher);
  render(<WorkInspection taskId={id} />); await userEvent.click(inspect());
  const checkbox = await screen.findByRole('checkbox');
  expect((checkbox as HTMLInputElement).disabled).toBe(true);
  expect((execute() as HTMLButtonElement).disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});


test.each(['confirmed', 'rejected', 'uncertain', 'timeout'].flatMap(outcome =>
  ['submit', 'native blur', 'outside', 'outside then blur', 'outside during commit'].map(focus => ({outcome, focus}))))(
  'deferred completion $outcome with $focus focus', async ({outcome, focus}) => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(reply(inspection())).mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<><input aria-label="Outside draft" /><WorkInspection taskId={id} /></>);
  await userEvent.click(inspect()); await screen.findByRole('checkbox');
    await userEvent.click(screen.getByRole('checkbox'));
    const launch = execute();
    launch.focus();
    const nativeBlur = vi.fn();
    const original = launch.setAttribute.bind(launch);
    const attribute = vi.spyOn(launch, 'setAttribute').mockImplementation((name, value) => {
      if (focus === 'native blur' && name === 'disabled' && document.activeElement === launch) {
        launch.blur(); nativeBlur();
        expect(document.activeElement).toBe(document.body);
        document.body.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
      }
      original(name, value);
      if (focus === 'outside during commit' && name === 'disabled') {
        screen.getByLabelText('Outside draft').focus();
      }
    });
    try {
      vi.useFakeTimers();
      await act(async () => {launch.click();});
      if (focus === 'native blur') expect(nativeBlur).toHaveBeenCalledTimes(1);
      const outside = screen.getByLabelText('Outside draft');
      if (focus.startsWith('outside') && focus !== 'outside during commit') outside.focus();
      if (focus === 'outside during commit') expect(document.activeElement).toBe(outside);
      if (focus === 'outside then blur') outside.blur();
      const expectedFocus = document.activeElement;
      expect((launch as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
      await act(async () => {launch.click();});
      expect(fetcher).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(75001);
        else finish(reply(outcome === 'confirmed' ? recorded() : {schema_version: 1, requested_task_id: id, status: outcome, code: outcome === 'rejected' ? 'execution_busy' : 'delivery_uncertain', recovery: 'Inspect again', execution: null}));
      });
      const destination = screen.getByRole('button', {name: 'Inspect before another execution'});
      expect((destination as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement).toBe(focus.startsWith('outside') ? expectedFocus : destination);
      expect(screen.queryByText(/Execution requested/)).toBeNull();
      if (outcome === 'confirmed') expect(screen.getByText(/Transport completed/)).toBeTruthy();
      else expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      view.rerender(<><input aria-label="Outside draft" /><WorkInspection taskId={id} /></>);
      await act(async () => {launch.click();});
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    } finally {attribute.mockRestore(); vi.useRealTimers();}
  });
