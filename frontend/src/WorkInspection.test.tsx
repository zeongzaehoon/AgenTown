import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkInspection } from './WorkInspection';
import { parseWorkInspection } from './work-inspection-api';

const success = (id = 'task-a') => ({
  schema_version: 1, requested_task_id: id, status: 'success', code: 'inspected',
  message: 'Inspected saved work.', recovery: 'Choose inspection again to refresh.',
  inspection: {
    task: {id, title: 'Recorded request', status: 'pending', assignees: ['employee-a']},
    attempts: [{id: 'run-a', task_id: id, stage: 'execution', reporting_source: 'product',
      started_at: 1, ended_at: 2, state: 'finished', outcome: 'success', participants: ['employee-a'],
      execution: {schema_version: 1, run_id: 'run-a', input: 'Recorded request', provider: 'fixture',
        model: 'deterministic', deadline_unix_ms: 3, output: 'Saved result', error: null, quality: 'unverified'}}],
    evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1'],
      read_only: true, external_client_verified: false},
  },
});
afterEach(() => {cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();});

test('explicit keyboard inspection reads only the selected Task and renders recorded evidence', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(success())));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  expect(fetcher).not.toHaveBeenCalled();
  screen.getByRole('button', {name: 'Inspect through local MCP'}).focus();
  await user.keyboard('{Enter}');
  await screen.findByText('Confirmed Task ID: task-a');
  expect(screen.getByText('Recorded assignment: employee-a')).toBeTruthy();
  expect(screen.getByText('Saved result')).toBeTruthy();
  expect(screen.getByText(/Confirmed local MCP inspection. External-client/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(['/api/connections/v1/inspect-work', expect.objectContaining({
    method: 'POST', body: JSON.stringify({task_id: 'task-a'}),
  })]);
});

test('pending inspection is invalidated by selection and cannot replace a newer result', async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => {complete = resolve;}))
    .mockResolvedValue(new Response(JSON.stringify(success('task-b'))));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); const view = render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button', {name: 'Inspect through local MCP'}));
  expect(screen.getByText('Inspecting selected work through local MCP…')).toBeTruthy();
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<WorkInspection taskId="task-b" />);
  expect(screen.queryByText(/Confirmed Task ID/)).toBeNull();
  await user.click(screen.getByRole('button'));
  await screen.findByText('Confirmed Task ID: task-b');
  await act(async () => {complete(new Response(JSON.stringify(success())));});
  expect(screen.queryByText('Confirmed Task ID: task-a')).toBeNull();
  expect(screen.getByText('Confirmed Task ID: task-b')).toBeTruthy();
  view.rerender(<WorkInspection taskId={null} />);
  expect(screen.queryByText(/Confirmed Task ID/)).toBeNull();
  expect(screen.getByText(/Select saved work before inspecting/)).toBeTruthy();
});

test.each(['busy', 'timeout', 'missing_work', 'failure'])('%s clears success and supports explicit recovery only', async code => {
  let response: unknown = success();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button')); await screen.findByText('Saved result');
  response = {schema_version: 1, requested_task_id: 'task-a', status: 'failure', code,
    message: `Inspection ${code}`, recovery: 'Check local server then inspect explicitly.', inspection: null};
  await user.click(screen.getByRole('button')); await screen.findByRole('alert');
  expect(screen.queryByText('Saved result')).toBeNull();
  expect(screen.queryByText(/Confirmed local MCP inspection/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  response = success();
  await user.click(screen.getByRole('button')); await screen.findByText('Saved result');
});

test('empty attempt and absent provider execution are distinct recorded states', async () => {
  const response = success(); response.inspection.attempts = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  await screen.findByText(/No recorded attempts/);
});

test.each([
  (r: ReturnType<typeof success>) => {r.requested_task_id = 'other';},
  (r: ReturnType<typeof success>) => {r.inspection.task.id = 'other';},
  (r: ReturnType<typeof success>) => {r.inspection.attempts[0].task_id = 'other';},
  (r: ReturnType<typeof success>) => {r.inspection.attempts[0].execution.run_id = 'other';},
  (r: ReturnType<typeof success>) => {r.inspection.evidence.read_only = false;},
  (r: ReturnType<typeof success>) => {r.inspection.evidence.external_client_verified = true;},
  (r: ReturnType<typeof success>) => {r.inspection.attempts.push(r.inspection.attempts[0]);},
  (r: ReturnType<typeof success>) => {r.inspection.attempts[0].execution.error = 'failed' as never;},
])('malformed or inconsistent response never displays success (%#)', async mutate => {
  const response = success(); mutate(response);
  expect(() => parseWorkInspection(response, 'task-a')).toThrow();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button')); await screen.findByRole('alert');
  expect(screen.queryByText(/Confirmed local MCP inspection/)).toBeNull();
  expect(screen.queryByText('Saved result')).toBeNull();
});

test('transport failure never retries or retains success', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button')); await screen.findByRole('alert');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Confirmed local MCP inspection/)).toBeNull();
});

test('attempt without a provider record is inspectable without claiming a result', async () => {
  const response = success();
  const raw = response as unknown as {inspection: {attempts: {execution: unknown}[]}};
  raw.inspection.attempts[0].execution = null;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  await screen.findByText('No provider execution recorded for this attempt.');
  expect(screen.queryByText('Saved result')).toBeNull();
});

test('bounded HTTP timeout releases the control without retrying', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkInspection taskId="task-a" />);
  await act(async () => {screen.getByRole('button').click();});
  await act(async () => {await vi.advanceTimersByTimeAsync(15_001);});
  expect(screen.getByRole('alert').textContent).toContain('Local inspection timed out');
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([null, {}, [], {status: 'success'}, {
  ...success(), status: 'failure',
}])('invalid envelope cannot be accepted (%#)', value => {
  expect(() => parseWorkInspection(value, 'task-a')).toThrow();
});
