import { expect, test } from 'vitest';
import type { LoopPreview, LoopSession } from './loop-response';
import { loopInspection, loopPreview, loopReceipt } from './loop-response';
const preview = {schema_version: 1, preview_id: 'p', policy_id: 'l', policy_name: 'Loop', task_id: 't', agent_id: 'a', input: 'Saved', max_iterations: 2, interval_seconds: 60, expected_runs: 0, policy_enabled: true};
const session = {schema_version: 1, session_id: 's', preview, state: 'future', admitted: 1, next_at: 0, provider: 'fixture', model: 'fixture', started_at: 0, expires_at: 1};
const attempt = {session_id: 's', run_id: 'r', ordinal: 1, admitted_at: 0, execution: {schema_version: 1, run_id: 'r', input: 'Saved', provider: 'fixture', model: 'fixture', deadline_unix_ms: 1, output: null, error: null, quality: 'unverified'}};
const inspection = {schema_version: 1, sessions: [session], attempts: [attempt], cancellation: ''};
test('accepts native records, legacy optional metadata, null execution and unknown session/authority states', () => {
  expect(loopInspection(inspection)).toBe(inspection);
  expect(loopInspection({...inspection, attempts: [{...attempt, execution: null}], control: {state: 'future', can_control: true}}).sessions[0].state).toBe('future');
  expect(loopPreview(preview)).toBe(preview);
});
test.each([null, [], {...preview, policy_name: {}}, {...preview, expected_runs: -1}, {...preview, created_at: []}])('rejects malformed preview %j', value => {
  expect(() => loopPreview(value)).toThrow();
});
test.each([
  {...inspection, control: {state: 'available', can_control: 'yes'}},
  {...inspection, attempts: [{...attempt, execution: []}]},
  {...inspection, attempts: [{...attempt, execution: {...attempt.execution, participants: [null]}}]},
  {...inspection, attempts: [{...attempt, execution: {...attempt.execution, deadline_unix_ms: {}}}]},
  {...inspection, sessions: [{...session, provider: {}}]},
  {...inspection, sessions: [session, session]},
])('rejects malformed nested record before rendering %j', value => {
  expect(() => loopInspection(value)).toThrow();
});

const receipt = {...session, state: 'active'};
test('current receipts correlate start preview and stopped session without claiming remote cancellation', () => {
  expect(loopReceipt(receipt, preview as LoopPreview, 'start', 'fixture', 'fixture')).toBe(receipt);
  expect(loopReceipt({...receipt, state: 'stopped'}, session as LoopSession, 'stop', 'fixture', 'fixture').state).toBe('stopped');
});
test.each([null, {}, [], {...receipt, schema_version: 2}, {...receipt, started_at: undefined},
  {...receipt, preview: {...preview, preview_id: 'other'}}, {...receipt, preview: {...preview, input: 'other'}},
  {...receipt, provider: 'other'}, {...receipt, admitted: 3}, {...receipt, state: 'future'}
])('rejects uncertain start receipt %j', value => {
  expect(() => loopReceipt(value, preview as LoopPreview, 'start', 'fixture', 'fixture')).toThrow(/not confirmed/);
});
test.each([null, {}, {...receipt, schema_version: 2, state: 'stopped'}, {...receipt, state: 'active'},
  {...receipt, session_id: 'wrong', state: 'stopped'}, {...receipt, state: 'stopped', preview: {...preview, task_id: 'other'}}
])('rejects uncertain stop receipt %j', value => {
  expect(() => loopReceipt(value, session as LoopSession, 'stop', 'fixture', 'fixture')).toThrow(/not confirmed/);
});
