import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkInspection } from './WorkInspection';
import { parseWorkInspection } from './work-inspection-api';

const success = (id = 'task-a') => ({
  schema_version: 1, requested_task_id: id, status: 'success', code: 'inspected',
  message: 'Inspected saved work.', recovery: 'Choose inspection again to refresh.',
  inspection: {
    readiness: {schema_version: 1, task_id: id, input: 'Exact preflight input',
      employee_ids: ['11111111-1111-4111-8111-111111111111'], expected_runs: 0,
      active_attempt: false, eligibility: 'eligible', resubmission_consent_required: false},
    task: {id, title: 'Recorded request', status: 'pending', assignees: ['employee-a']},
    attempts: [{id: 'run-a', task_id: id, stage: 'execution', reporting_source: 'product',
      loop: {linkage: 'absent', session: null, ordinal: null, admitted_at: null},
      started_at: 1, ended_at: 2, state: 'finished', outcome: 'success', participants: ['employee-a'],
      execution: {schema_version: 1, run_id: 'run-a', input: 'Recorded request', provider: 'fixture',
        model: 'deterministic', deadline_unix_ms: 3, output: 'Saved result', error: null, quality: 'unverified'}}],
    evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'],
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
  expect(screen.getByText('No recorded Loop linkage for this attempt.')).toBeTruthy();
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
  await act(async () => {complete(new Response(JSON.stringify(savedContext())));});
  expect(screen.queryByText('Confirmed Task ID: task-a')).toBeNull();
  expect(screen.queryByText('Saved Hook: Original follow-up')).toBeNull();
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

test('returning to the same Task cannot revive an aborted inspection or its error', async () => {
  let rejectOld!: (reason: Error) => void;
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((_, reject) => {rejectOld = reject;}))
    .mockResolvedValue(new Response(JSON.stringify(success())));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); const view = render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  const signal = (fetcher.mock.calls[0][1] as RequestInit).signal!;
  view.rerender(<WorkInspection taskId="task-b" />);
  expect(signal.aborted).toBe(true);
  view.rerender(<WorkInspection taskId="task-a" />);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Confirmed Task ID/)).toBeNull();
  screen.getByRole('button').focus(); await user.keyboard('{Enter}');
  await screen.findByText('Confirmed Task ID: task-a');
  await act(async () => {rejectOld(new Error('late failure for old task-a request'));});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Saved result')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([path]) => path === '/api/connections/v1/inspect-work')).toBe(true);
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

// Saved snapshots intentionally differ from current work text/configuration.
function savedContext() {
  const response = success();
  const skill = {schema_version: 1, run_id: 'run-a', preview_id: 'preview-skill',
    skill_id: '33333333-3333-4333-8333-333333333333', skill_name: 'Original manual', instructions: 'Saved instructions',
    input: 'Recorded request', admitted_at: 1};
  const source = response.inspection.attempts[0];
  source.outcome = 'reported_success';
  const hook = {...skill, run_id: 'run-hook', preview_id: 'preview-hook', admitted_at: 3,
    task_id: 'task-a', hook_id: '44444444-4444-4444-8444-444444444444', hook_name: 'Original follow-up', hook_enabled: true,
    target_kind: 'agent', agent_id: 'employee-a', event: 'run_completed', source_run_id: 'run-a',
    source_outcome: 'reported_success', skill_enabled: true};
  return {...response, inspection: {...response.inspection, attempts: [
    {...source, skill, hook: null},
    {...source, id: 'run-hook', started_at: 3, ended_at: 4, skill: null, hook,
      execution: {...source.execution, run_id: 'run-hook'}},
    {...source, id: 'run-ordinary', skill: null, hook: null,
      execution: {...source.execution, run_id: 'run-ordinary'}},
  ]}};
}

test('saved Skill and Hook context belongs to its attempt and inspection never executes', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(savedContext())));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); const view = render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  const first = await screen.findByRole('article', {name: 'Inspected attempt 1'});
  expect(within(first).getByText('Skill ID: 33333333-3333-4333-8333-333333333333')).toBeTruthy();
  expect(within(first).getByText('Saved instructions', {selector: 'pre'})).toBeTruthy();
  expect(within(first).getByText('Recorded request')).toBeTruthy();
  expect(within(first).queryByText(/Hook ID/)).toBeNull();
  const second = screen.getByRole('article', {name: 'Inspected attempt 2'});
  expect(within(second).getByText('Saved Hook: Original follow-up')).toBeTruthy();
  expect(within(second).getByText('Saved Skill: Original manual')).toBeTruthy();
  expect(within(second).getByText(/Source Run ID: run-a/)).toBeTruthy();
  expect(within(screen.getByRole('article', {name: 'Inspected attempt 3'}))
    .getByText(/No saved Skill or Hook context/)).toBeTruthy();
  view.rerender(<WorkInspection taskId="task-b" />);
  expect(screen.queryByText('Saved Hook: Original follow-up')).toBeNull();
  expect(fetcher.mock.calls).toEqual([['/api/connections/v1/inspect-work', expect.anything()]]);
});

test.each([
  (r: any) => {r[0].skill.run_id = 'other';},
  (r: any) => {r[0].skill.input = 'Different input';},
  (r: any) => {r[0].skill.skill_name = '';},
  (r: any) => {delete r[0].skill.instructions;},
  (r: any) => {r[0].skill.admitted_at = -1;},
  (r: any) => {r[0].skill.admitted_at = 99;},
  (r: any) => {r[0].skill.skill_id = 'invalid';},
  (r: any) => {r[1].hook.hook_id = 'invalid';},
  (r: any) => {r[1].participants.push('other');},
  (r: any) => {const {task_id, hook_id, ...saved} = r[1].hook; r[1].skill = saved;},
  (r: any) => {r[0].execution = null;},
  (r: any) => {r[1].hook.task_id = 'other';},
  (r: any) => {r[1].hook.agent_id = 'other';},
  (r: any) => {r[1].hook.hook_enabled = false;},
  (r: any) => {r[1].hook.source_run_id = 'run-hook';},
  (r: any) => {r[1].hook.source_run_id = 'missing';},
  (r: any) => {r[1].hook.event = 'run_failed';},
  (r: any) => {r[1].hook.skill_enabled = false;},
  (r: any) => {r[1].skill = {...r[1].hook, skill_id: 'contradictory'};},
])('invalid saved provenance prevents confirmation and permits explicit recovery (%#)', async mutate => {
  const broken = savedContext(); mutate(broken.inspection.attempts);
  expect(() => parseWorkInspection(broken, 'task-a')).toThrow();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(broken)))
    .mockResolvedValueOnce(new Response(JSON.stringify(savedContext())));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button')); await screen.findByRole('alert');
  expect(screen.queryByText(/Confirmed local MCP inspection/)).toBeNull();
  expect(screen.queryByText('Saved Hook: Original follow-up')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button'));
  await screen.findByText('Saved Hook: Original follow-up');
  expect(fetcher.mock.calls.every(([path]) => path === '/api/connections/v1/inspect-work')).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

function loopContext(): any {
  const response = success();
  response.inspection.task.title = 'Edited work input';
  const run: any = response.inspection.attempts[0];
  run.loop = {linkage: 'confirmed', ordinal: 1, admitted_at: 1, session: {
    schema_version: 1, session_id: '55555555-5555-4555-8555-555555555555',
    preview: {schema_version: 1, preview_id: 'saved-preview',
      policy_id: '66666666-6666-4666-8666-666666666666', policy_name: 'Original bounded policy',
      task_id: 'task-a', agent_id: 'employee-a', input: 'Recorded request', policy_enabled: true,
      max_iterations: 2, interval_seconds: 60, expected_runs: 0, created_at: 0},
    state: 'active', provider: 'fixture', model: 'deterministic',
    started_at: 1, expires_at: 1000, admitted: 0, next_at: 1,
  }};
  return response;
}

test('Loop display retains saved policy/input/limits and labels separately observed progress', async () => {
  const response = loopContext();
  // The separately read session predates attempt admission; it need not agree with finished history.
  expect(() => parseWorkInspection(response, 'task-a')).not.toThrow();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response))));
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  const saved = await screen.findByRole('region', {name: 'Saved Loop context'});
  expect(within(saved).getByText('Saved Loop policy: Original bounded policy')).toBeTruthy();
  expect(within(saved).getByText('Recorded request')).toBeTruthy();
  expect(within(saved).queryByText('Edited work input')).toBeNull();
  expect(within(saved).getByText(/55555555-5555-4555-8555-555555555555 · Ordinal: 1/)).toBeTruthy();
  expect(within(saved).getByText('Saved limits: 2 attempts · 60 seconds between attempts')).toBeTruthy();
  expect(within(saved).getByText(/Observed session state: active · Observed admitted attempts: 0/)).toBeTruthy();
  expect(screen.getByText(/Evidence:.*inspect_loop_sessions_v1/)).toBeTruthy();
});

test('uncertain Loop linkage never claims absence and explicit inspection can resolve it', async () => {
  const uncertain = success(); uncertain.inspection.attempts[0].loop.linkage = 'uncertain';
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(uncertain)))
    .mockResolvedValueOnce(new Response(JSON.stringify(loopContext())));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  await screen.findByText(/Loop linkage is uncertain/);
  expect(screen.queryByText('No recorded Loop linkage for this attempt.')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button'));
  await screen.findByText('Saved Loop policy: Original bounded policy');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([
  (r: any) => {delete r.loop;},
  (r: any) => {r.loop.linkage = 'unknown';},
  (r: any) => {r.loop.linkage = 'absent';},
  (r: any) => {r.loop.ordinal = 0;},
  (r: any) => {r.loop.ordinal = 3;},
  (r: any) => {r.loop.admitted_at = 2;},
  (r: any) => {r.loop.session.session_id = 'invalid';},
  (r: any) => {r.loop.session.preview.task_id = 'other';},
  (r: any) => {r.loop.session.preview.agent_id = 'other';},
  (r: any) => {r.loop.session.preview.input = 'Edited policy input';},
  (r: any) => {r.loop.session.preview.policy_enabled = false;},
  (r: any) => {r.loop.session.preview.interval_seconds = 1;},
  (r: any) => {r.loop.session.preview.created_at = 2;},
  (r: any) => {r.loop.session.provider = 'other';},
  (r: any) => {r.loop.session.model = 'other';},
  (r: any) => {r.loop.session.admitted = 3;},
  (r: any) => {r.loop.session.state = 'invented';},
  (r: any) => {r.loop.session.expires_at = 0;},
])('malformed Loop context is rejected (%#)', mutate => {
  const response = loopContext(); mutate(response.inspection.attempts[0]);
  expect(() => parseWorkInspection(response, 'task-a')).toThrow();
});

test('duplicate session ordinals and conflicting immutable session snapshots are rejected', () => {
  const response = loopContext();
  const second = structuredClone(response.inspection.attempts[0]);
  second.id = 'run-b'; second.execution.run_id = 'run-b';
  response.inspection.attempts.push(second);
  expect(() => parseWorkInspection(response, 'task-a')).toThrow();
  second.loop.ordinal = 2;
  expect(() => parseWorkInspection(response, 'task-a')).not.toThrow();
  second.loop.session.preview.policy_name = 'Edited policy';
  expect(() => parseWorkInspection(response, 'task-a')).toThrow();
});

test('a late Loop inspection is discarded after selected work changes', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}))
    .mockResolvedValue(new Response(JSON.stringify(success('task-b'))));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); const view = render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  view.rerender(<WorkInspection taskId="task-b" />);
  await user.click(screen.getByRole('button'));
  await screen.findByText('Confirmed Task ID: task-b');
  await act(async () => {finish(new Response(JSON.stringify(loopContext())));});
  expect(screen.queryByRole('region', {name: 'Saved Loop context'})).toBeNull();
  expect(screen.getByText('Confirmed Task ID: task-b')).toBeTruthy();
});


test('two-tool or reordered evidence cannot confirm Loop inspection', () => {
  const response = loopContext();
  response.inspection.evidence.tools.pop();
  expect(() => parseWorkInspection(response, 'task-a')).toThrow();
  response.inspection.evidence.tools = ['get_task', 'inspect_loop_sessions_v1', 'get_work_history_v1'];
  expect(() => parseWorkInspection(response, 'task-a')).toThrow();
});

test.each(['eligible', 'ineligible', 'missing'] as const)('readiness displays the separate %s preflight observation', async eligibility => {
  const response: any = success();
  response.inspection.readiness = eligibility === 'missing'
    ? {schema_version: 1, task_id: 'task-a', input: null, employee_ids: [], expected_runs: 0,
      active_attempt: false, eligibility, resubmission_consent_required: false}
    : {...response.inspection.readiness, eligibility, expected_runs: 7,
      active_attempt: eligibility === 'ineligible', resubmission_consent_required: true};
  // History contains one finished attempt and different text/assignment; none is overwritten.
  expect(() => parseWorkInspection(response, 'task-a')).not.toThrow();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  const panel = await screen.findByRole('region', {name: 'Ordinary-text execution readiness'});
  expect(within(panel).getByText(`Advisory eligibility: ${eligibility}`)).toBeTruthy();
  expect(within(panel).getByText(/does not validate provider configuration, grant consent or authorize execution/)).toBeTruthy();
  expect(within(panel).getByText(/Each tool is a separate observation/)).toBeTruthy();
  if (eligibility === 'missing') {
    expect(within(panel).getByText(/Saved work was missing at preflight/)).toBeTruthy();
  } else {
    expect(within(panel).getByText('Exact preflight input')).toBeTruthy();
    expect(within(panel).getByText('Observed attempt count: 7')).toBeTruthy();
    expect(within(panel).getByText('Preflight assigned employee IDs: 11111111-1111-4111-8111-111111111111')).toBeTruthy();
    expect(within(panel).getByText(`Active attempt observed: ${eligibility === 'ineligible' ? 'Yes' : 'No'}`)).toBeTruthy();
    expect(within(panel).getByText('Resubmission consent required: Yes')).toBeTruthy();
  }
  expect(screen.getByText('Saved result')).toBeTruthy();
  expect(fetcher.mock.calls).toEqual([['/api/connections/v1/inspect-work', expect.anything()]]);
});

test.each([
  (r: any) => {delete r.inspection.readiness;},
  (r: any) => {r.inspection.readiness = null;},
  (r: any) => {r.inspection.readiness.task_id = 'other';},
  (r: any) => {r.inspection.readiness.schema_version = 2;},
  (r: any) => {r.inspection.readiness.input = 5;},
  (r: any) => {r.inspection.readiness.employee_ids = ['invalid'];},
  (r: any) => {r.inspection.readiness.employee_ids = ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'];},
  (r: any) => {r.inspection.readiness.expected_runs = -1;},
  (r: any) => {r.inspection.readiness.expected_runs = 0.5;},
  (r: any) => {r.inspection.readiness.expected_runs = true;},
  (r: any) => {r.inspection.readiness.active_attempt = 'false';},
  (r: any) => {r.inspection.readiness.eligibility = 'ready';},
  ...[['eligible'], ['ineligible'], ['missing'], null, true, 1, {}].map(eligibility =>
    (r: any) => {r.inspection.readiness.eligibility = eligibility;}),
  (r: any) => {r.inspection.readiness.resubmission_consent_required = null;},
  (r: any) => {r.inspection.readiness.resubmission_consent_required = true;},
  (r: any) => {r.inspection.readiness.eligibility = 'missing';},
])('malformed readiness clears prior observation and permits explicit recovery (%#)', async mutate => {
  let response: any = success();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); render(<WorkInspection taskId="task-a" />);
  await user.click(screen.getByRole('button'));
  await screen.findByRole('region', {name: 'Ordinary-text execution readiness'});
  response = success(); mutate(response);
  await user.click(screen.getByRole('button')); await screen.findByRole('alert');
  expect(screen.queryByRole('region', {name: 'Ordinary-text execution readiness'})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  response = success(); await user.click(screen.getByRole('button'));
  await screen.findByRole('region', {name: 'Ordinary-text execution readiness'});
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('disconnect clears readiness, aborts pending reads and requires explicit recovery after reconnect', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(success())))
    .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}))
    .mockResolvedValue(new Response(JSON.stringify(success())));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup(); const view = render(<WorkInspection taskId="task-a" connected />);
  await user.click(screen.getByRole('button'));
  await screen.findByRole('region', {name: 'Ordinary-text execution readiness'});
  view.rerender(<WorkInspection taskId="task-a" connected={false} />);
  expect(screen.queryByRole('region', {name: 'Ordinary-text execution readiness'})).toBeNull();
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<WorkInspection taskId="task-a" connected />);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button'));
  const signal = (fetcher.mock.calls[1][1] as RequestInit).signal!;
  view.rerender(<WorkInspection taskId="task-a" connected={false} />);
  expect(signal.aborted).toBe(true);
  view.rerender(<WorkInspection taskId="task-a" connected />);
  await act(async () => {finish(new Response(JSON.stringify(success())));});
  expect(screen.queryByRole('region', {name: 'Ordinary-text execution readiness'})).toBeNull();
  await user.click(screen.getByRole('button'));
  await screen.findByRole('region', {name: 'Ordinary-text execution readiness'});
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('timeout clears prior readiness and ignores late completion before explicit retry', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(success())))
    .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}))
    .mockResolvedValue(new Response(JSON.stringify(success())));
  vi.stubGlobal('fetch', fetcher);
  render(<WorkInspection taskId="task-a" />);
  await act(async () => {screen.getByRole('button').click();});
  expect(screen.getByRole('region', {name: 'Ordinary-text execution readiness'})).toBeTruthy();
  vi.useFakeTimers();
  await act(async () => {screen.getByRole('button').click();});
  expect(screen.queryByRole('region', {name: 'Ordinary-text execution readiness'})).toBeNull();
  await act(async () => {await vi.advanceTimersByTimeAsync(15_001);});
  expect(screen.getByRole('alert').textContent).toContain('Local inspection timed out');
  await act(async () => {finish(new Response(JSON.stringify(success())));});
  expect(screen.queryByRole('region', {name: 'Ordinary-text execution readiness'})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
  await act(async () => {screen.getByRole('button').click();});
  expect(screen.getByRole('region', {name: 'Ordinary-text execution readiness'})).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(3);
});
