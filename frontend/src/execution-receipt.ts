import type { HookPreview, SkillPreview, Work, Workspace } from './api';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// execution.record / web.execute return a finalized v1 receipt, not a history
// snapshot. Validate it before releasing submission controls; never render it as
// history or infer that a missing receipt means the request was not delivered.
export function validateExecutionReceipt(value: unknown, work: Work, workspace: Workspace, preview?: SkillPreview | HookPreview): void {
  const invalid = () => { throw new Error('Execution receipt unavailable or unsupported. Work may already have run. Choose Refresh connection and inspect history before explicitly retrying. Your draft and selection are retained; Skill and Hook execution requires a fresh preview.'); };
  if (!record(value) || value.schema_version !== 1 || value.quality !== 'unverified'
    || !identity(value.run_id) || work.attempts.some(attempt => attempt.id === value.run_id)
    || value.input !== (preview?.input ?? work.input) || value.provider !== workspace.provider || value.model !== workspace.model
    || !time(value.deadline_unix_ms)
    || !((typeof value.output === 'string' && value.output.trim().length > 0 && value.error === null)
      || (value.output === null && identity(value.error)))) return invalid();
  const kind = preview ? ('hook_id' in preview ? 'hook' : 'skill') : null;
  if (kind === null) {
    if (value.skill != null || value.hook != null) invalid();
    return;
  }
  const saved = value[kind];
  if (!record(saved) || saved.schema_version !== 1 || saved.run_id !== value.run_id
    || saved.preview_id !== preview!.preview_id || saved.skill_id !== preview!.skill_id
    || typeof saved.skill_name !== 'string' || typeof saved.instructions !== 'string'
    || saved.input !== preview!.input || !time(saved.admitted_at)
    || value[kind === 'hook' ? 'skill' : 'hook'] != null) return invalid();
  if (preview && 'hook_id' in preview && ['hook_id', 'hook_name', 'event', 'agent_id', 'source_run_id', 'source_outcome']
    .some(key => saved[key] !== (preview as unknown as RecordValue)[key])) invalid();
  if (kind === 'hook' && (saved.task_id !== work.id || saved.hook_enabled !== true
    || saved.skill_enabled !== true || saved.target_kind !== 'agent')) invalid();
}

// Called only after receipt validation and a fresh, validated workspace read.
export function confirmExecutionHistory(receipt: unknown, work: Work, workspace: Workspace | undefined): void {
  const value = receipt as RecordValue;
  const saved = workspace?.work.find(item => item.id === work.id);
  const attempt = saved?.attempts.find(item => item.id === value.run_id);
  const matchesProvenance = (kind: 'skill' | 'hook') => {
    const expected = value[kind];
    const actual = attempt?.[kind];
    if (expected == null) return actual == null;
    if (!record(expected) || !actual) return false;
    // Compare persisted provenance fields; transport-only receipt fields are
    // already validated against the preview by validateExecutionReceipt.
    const fields = ['run_id', 'preview_id', 'skill_id', 'skill_name', 'instructions', 'input', 'admitted_at',
      ...(kind === 'hook' ? ['hook_id', 'hook_name', 'event', 'agent_id', 'source_run_id', 'source_outcome'] : [])];
    return fields.every(key => (actual as unknown as RecordValue)[key] === expected[key]);
  };
  if (!saved || saved.input !== work.input || !attempt || attempt.state !== 'finished'
    || attempt.outcome !== (value.error === null ? 'reported_success' : 'failure')
    || attempt.input !== value.input || attempt.provider !== value.provider || attempt.model !== value.model
    || attempt.output !== value.output || attempt.error !== value.error || attempt.quality !== value.quality
    || !matchesProvenance('skill') || !matchesProvenance('hook')) {
    throw new Error('Execution delivery is uncertain: the acknowledged Run could not be confirmed in refreshed history. Work may already have run. Your draft and selection are retained. Choose Refresh connection, inspect history, then explicitly retry only if needed. Nothing is automatically resent.');
  }
}
