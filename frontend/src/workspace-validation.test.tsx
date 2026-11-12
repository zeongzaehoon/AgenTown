import { expect, test } from 'vitest';
import { validateWorkspace } from './workspace-validation';
const snapshot = () => ({employees: [{id: 'e', name: 'Writer'}], work: [{id: 'w', input: 'Text', status: 'pending', assignees: ['e'], attempts: [{id: 'a', state: 'finished', outcome: null, participants: ['e']}]}], configuration: null, provider: 'test', model: null});
const provenance = {run_id: 'a', preview_id: 'p', skill_id: 's', skill_name: 'Skill', instructions: '', input: '', admitted_at: 1};
test('retains legacy optional metadata, extension fields and unresolved historical employee references', () => {
  const value = snapshot();
  Object.assign(value.work[0].attempts[0], {started: null, ended: null, provider: null, model: null, declared_source: null, output: '', error: null, skill: null, hook: null, extension: {future: true}});
  value.work[0].assignees = ['historical-employee', 'historical-employee'];
  expect(validateWorkspace(value)).toBe(value);
  Object.assign(value.work[0].attempts[0], {skill: provenance, hook: {...provenance, hook_id: 'h', hook_name: 'Hook', event: 'run_succeeded', agent_id: 'e', source_run_id: 'old', source_outcome: 'reported_success'}});
  expect(validateWorkspace(value)).toBe(value);
});
const invalid: Array<[string, (value: ReturnType<typeof snapshot>) => void]> = [
  ['employee identity', v => { v.employees[0].id = ''; }],
  ['duplicate employees', v => { v.employees.push(v.employees[0]); }],
  ['employee name', v => { Object.assign(v.employees[0], {name: {}}); }],
  ['work identity', v => { Object.assign(v.work[0], {id: null}); }],
  ['duplicate work', v => { v.work.push(v.work[0]); }],
  ['assignees', v => { Object.assign(v.work[0], {assignees: [null]}); }],
  ['attempt list', v => { Object.assign(v.work[0], {attempts: {}}); }],
  ['attempt identity', v => { v.work[0].attempts[0].id = ''; }],
  ['duplicate attempts', v => { v.work[0].attempts.push(v.work[0].attempts[0]); }],
  ['participants', v => { Object.assign(v.work[0].attempts[0], {participants: [{}]}); }],
  ['state', v => { v.work[0].attempts[0].state = 'unknown'; }],
  ...['outcome', 'output', 'error', 'provider', 'model', 'declared_source', 'input', 'started', 'ended', 'quality'].map(key => [key, (v: ReturnType<typeof snapshot>) => { Object.assign(v.work[0].attempts[0], {[key]: {}}); }] as [string, (v: ReturnType<typeof snapshot>) => void]),
  ['skill', v => { Object.assign(v.work[0].attempts[0], {skill: {...provenance, instructions: {}}}); }],
  ['hook', v => { Object.assign(v.work[0].attempts[0], {hook: {...provenance}}); }],
];
for (const [name, corrupt] of invalid) test(`rejects malformed ${name} before rendering`, () => {
  const value = snapshot(); corrupt(value);
  expect(() => validateWorkspace(value)).toThrow('Workspace data unavailable');
});
for (const value of [null, [], {}, {employees: [], work: [null]}, {...snapshot(), configuration: {}}, {...snapshot(), model: []}]) test(`rejects malformed root ${JSON.stringify(value)}`, () => {
  expect(() => validateWorkspace(value)).toThrow('Workspace data unavailable');
});
