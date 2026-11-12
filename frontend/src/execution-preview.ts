import type { HookPreview, SkillPreview, Work } from './api';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validSkillPreview(value: unknown, work: Work, skillId: string): value is SkillPreview {
  return record(value) && value.schema_version === 1
    && typeof value.preview_id === 'string' && value.preview_id.trim().length > 0
    && value.task_id === work.id && value.skill_id === skillId
    && typeof value.input === 'string'
    && typeof value.expected_runs === 'number' && Number.isSafeInteger(value.expected_runs)
    && value.expected_runs === work.attempts.length;
}

export function validHookPreview(value: unknown, work: Work, hookId: string, skillId: string | undefined, event: string): value is HookPreview {
  const source = work.attempts.at(-1);
  return record(value) && typeof skillId === 'string' && validSkillPreview(value, work, skillId)
    && value.hook_id === hookId && value.agent_id === work.assignees[0]
    && typeof value.hook_name === 'string'
    && value.source_run_id === source?.id && value.source_outcome === source?.outcome
    && value.event === event && value.hook_enabled === true && value.skill_enabled === true;
}
