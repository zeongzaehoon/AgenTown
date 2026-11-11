import { expect, test } from 'vitest';
import { classifyWork, workStatus, type Attempt, type Work, type WorkOutcome } from './api';

const attempt = (fields: Partial<Attempt>): Attempt => ({id: 'latest', state: 'finished', outcome: null, participants: [], ...fields});
const older = attempt({id: 'older', output: 'Previous result'});
test.each<[string, Attempt[], WorkOutcome, string]>([
  ['pending', [], 'pending', 'Pending — ready to execute'],
  ['cancelled', [], 'other', 'Cancelled'],
  ['blocked', [], 'other', 'Blocked'],
  ['in_progress', [], 'other', 'In progress — no provider result'],
  ['completed', [], 'other', 'Recorded work — no provider result'],
  ['future_state', [], 'other', 'Recorded work — no provider result'],
  ['pending', [older, attempt({state: 'active', provider: 'anthropic'})], 'active', 'Running — waiting for response'],
  ['pending', [older, attempt({state: 'active'})], 'active', 'Caller-reported active attempt — no provider request'],
  ['pending', [attempt({state: 'active', output: 'stale'})], 'active', 'Caller-reported active attempt — no provider request'],
  ['cancelled', [attempt({output: '', error: 'interrupted'})], 'results', 'Result available · Unverified'],
  ['pending', [older, attempt({outcome: 'interruption'})], 'failed', 'Interrupted — review before retry'],
  ['pending', [older, attempt({error: 'interrupted'})], 'failed', 'Interrupted — review before retry'],
  ['pending', [older, attempt({error: 'output_limit'})], 'failed', 'Failed — response reached the output limit'],
  ['pending', [older, attempt({error: 'network'})], 'failed', 'Failed — retry available'],
  ['pending', [older, attempt({outcome: 'failure'})], 'failed', 'Failed — retry available'],
  ['pending', [older, attempt({outcome: 'reported_success'})], 'other', 'Recorded attempt — no provider result'],
])('structured classification %s %j', (status, attempts, outcome, label) => {
  const work: Work = {id: 'w', input: 'Saved', status, assignees: [], attempts};
  expect(classifyWork(work)).toEqual({outcome, label});
  expect(workStatus(work)).toBe(label);
});
