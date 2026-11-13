import { api, type SkillPreview } from './api';
import { parseWorkExecution, type WorkExecutionResponse } from './work-execution-api';

export interface LocalSkill {id: string; name: string; enabled: boolean}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function parseSkillResponse(value: unknown, taskId: string | null, operation: 'list' | 'preview' | 'execute', skillId?: string, preview?: SkillPreview): LocalSkill[] | SkillPreview | WorkExecutionResponse {
  const invalid = () => new Error('Skill response could not be confirmed. Inspect work before trying again.');
  if (!object(value) || value.schema_version !== 1 || value.requested_task_id !== taskId || typeof value.recovery !== 'string' || !value.recovery.trim()) throw invalid();
  if (operation === 'execute') {
    const data = value.data;
    const result = parseWorkExecution({...value, execution: object(data) ? data.execution : null}, taskId!);
    if (result.status === 'completed') {
      const skill = object(data) && object(data.skill) ? data.skill : null;
      if (!preview || result.execution?.input !== preview.input || !skill || skill.schema_version !== 1 || skill.run_id !== result.execution.run_id || skill.preview_id !== preview.preview_id || skill.skill_id !== skillId || skill.input !== preview.input || typeof skill.skill_name !== 'string' || typeof skill.instructions !== 'string' || !Number.isSafeInteger(skill.admitted_at)) throw invalid();
    } else if (data !== null) throw invalid();
    return result;
  }
  if (value.status !== 'confirmed' || value.code !== (operation === 'list' ? 'skills_discovered' : 'skill_previewed') || !object(value.data)) throw invalid();
  const data = value.data;
  if (data.schema_version !== 1) throw invalid();
  if (operation === 'list') {
    if (!Array.isArray(data.skills) || data.skills.some(s => !object(s) || !uuid(s.id) || typeof s.name !== 'string' || typeof s.enabled !== 'boolean') || new Set(data.skills.map(s => s.id)).size !== data.skills.length) throw invalid();
    return data.skills as LocalSkill[];
  }
  if (data.task_id !== taskId || data.skill_id !== skillId || typeof data.preview_id !== 'string' || !data.preview_id.trim() || typeof data.input !== 'string' || !data.input || !Number.isSafeInteger(data.expected_runs) || (data.expected_runs as number) < 0) throw invalid();
  return data as unknown as SkillPreview;
}
export async function listLocalSkills(signal: AbortSignal) {
  return parseSkillResponse(await api<unknown>('/api/connections/v1/skills/list', {}, signal), null, 'list') as LocalSkill[];
}
export async function previewLocalSkill(taskId: string, skillId: string, signal: AbortSignal) {
  return parseSkillResponse(await api<unknown>('/api/connections/v1/skills/preview', {task_id: taskId, skill_id: skillId}, signal), taskId, 'preview', skillId) as SkillPreview;
}
export async function executeLocalSkill(preview: SkillPreview, signal: AbortSignal) {
  return parseSkillResponse(await api<unknown>('/api/connections/v1/skills/execute', {task_id: preview.task_id, skill_id: preview.skill_id, preview_id: preview.preview_id, input: preview.input, expected_runs: preview.expected_runs, execution_consent: true}, signal), preview.task_id, 'execute', preview.skill_id, preview) as WorkExecutionResponse;
}
