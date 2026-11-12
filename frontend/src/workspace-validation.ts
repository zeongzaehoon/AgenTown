import { ApiError, type Workspace } from './api';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string';
const identity = (value: unknown) => text(value) && (value as string).trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(identity);
const optionalText = (value: unknown) => value == null || text(value);
const optionalTime = (value: unknown) => value == null || (typeof value === 'number' && Number.isFinite(value));
const unique = (values: string[]) => new Set(values).size === values.length;
function provenance(value: unknown, hook: boolean): boolean {
  if (value == null) return true;
  return record(value) && ['run_id', 'preview_id', 'skill_id', 'skill_name', 'instructions', 'input',
    ...(hook ? ['hook_id', 'hook_name', 'event', 'agent_id', 'source_run_id', 'source_outcome'] : [])]
    .every(key => text(value[key])) && typeof value.admitted_at === 'number' && Number.isFinite(value.admitted_at);
}
function attempt(value: unknown): boolean {
  return record(value) && identity(value.id) && ['active', 'finished'].includes(value.state as string)
    && (value.outcome === null || text(value.outcome)) && strings(value.participants)
    && ['provider', 'model', 'declared_source', 'input', 'output', 'error'].every(key => optionalText(value[key]))
    && optionalTime(value.started) && optionalTime(value.ended)
    && (value.quality == null || value.quality === 'unverified')
    && provenance(value.skill, false) && provenance(value.hook, true);
}

// Validate the complete render boundary atomically. Unknown extension fields and
// omitted/null legacy metadata are retained; no mutation or normalization occurs.
export function validateWorkspace(value: unknown): Workspace {
  if (!record(value) || !Array.isArray(value.employees) || !Array.isArray(value.work)
    || !optionalText(value.configuration) || !text(value.provider) || !optionalText(value.model)
    || !value.employees.every(employee => record(employee) && identity(employee.id) && text(employee.name))
    || !unique(value.employees.map(employee => employee.id))
    || !value.work.every(work => record(work) && identity(work.id) && text(work.input) && text(work.status)
      && strings(work.assignees) && Array.isArray(work.attempts)
      && work.attempts.every(attempt) && unique(work.attempts.map(item => item.id)))
    || !unique(value.work.map(work => work.id))) {
    throw new ApiError('Workspace data unavailable: the server returned an invalid snapshot. Check the local server, then choose Refresh connection. Loaded history and unsaved drafts are retained; nothing is automatically resent.');
  }
  return value as unknown as Workspace;
}
