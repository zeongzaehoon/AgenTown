import { api, type HookPreview } from './api';
import { parseWorkExecution, type WorkExecutionResponse } from './work-execution-api';

export interface LocalHook {id: string; name: string; enabled: boolean; skill_id: string; target_kind: 'agent' | 'team'; target_id: string; event: string}
export interface LocalHookPreview extends HookPreview {target_kind: 'agent'; hook_name: string; skill_name: string; instructions: string}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const consentFields = ['task_id', 'hook_id', 'agent_id', 'skill_id', 'source_run_id', 'event', 'source_outcome', 'input', 'expected_runs'] as const;
function validContext(data: Record<string, unknown>) {
  return ['task_id', 'hook_id', 'agent_id', 'skill_id', 'source_run_id'].every(key => uuid(data[key])) &&
    data.hook_enabled === true && data.skill_enabled === true && data.target_kind === 'agent' &&
    ((data.event === 'run_completed' && data.source_outcome === 'reported_success') || (data.event === 'run_failed' && data.source_outcome === 'failure')) &&
    ['hook_name', 'skill_name', 'instructions'].every(key => typeof data[key] === 'string');
}
export function parseHookResponse(value: unknown, taskId: string | null, operation: 'list' | 'preview' | 'execute', hookId?: string, preview?: LocalHookPreview): LocalHook[] | LocalHookPreview | WorkExecutionResponse {
  const invalid = () => new Error('Hook response could not be confirmed. Inspect work before trying again.');
  if (!object(value) || value.schema_version !== 1 || value.requested_task_id !== taskId || typeof value.recovery !== 'string' || !value.recovery.trim()) throw invalid();
  const data = value.data;
  if (operation === 'execute') {
    const result = parseWorkExecution({...value, execution: object(data) ? data.execution : null}, taskId!);
    if (result.status === 'completed') {
      const hook = object(data) && object(data.hook) ? data.hook : null;
      if (!preview || !hook || !validContext(hook) || hook.schema_version !== 1 || hook.run_id !== result.execution?.run_id ||
          hook.preview_id !== preview.preview_id || result.execution?.input !== preview.input ||
          consentFields.filter(key => key !== 'expected_runs').some(key => hook[key] !== preview[key]) ||
          !Number.isSafeInteger(hook.admitted_at) || (hook.admitted_at as number) < 0) throw invalid();
    } else if (data !== null) throw invalid();
    return result;
  }
  if (value.status !== 'confirmed' || value.code !== (operation === 'list' ? 'hooks_discovered' : 'hook_previewed') || !object(data) || data.schema_version !== 1) throw invalid();
  if (operation === 'list') {
    if (!Array.isArray(data.hooks) || data.hooks.some(h => !object(h) || !uuid(h.id) || !uuid(h.skill_id) || !uuid(h.target_id) || typeof h.name !== 'string' || typeof h.enabled !== 'boolean' || !['agent', 'team'].includes(h.target_kind as string) || !['task_created', 'run_completed', 'run_failed'].includes(h.event as string)) || new Set(data.hooks.map(h => h.id)).size !== data.hooks.length) throw invalid();
    return data.hooks as LocalHook[];
  }
  if (!validContext(data) || data.task_id !== taskId || data.hook_id !== hookId || typeof data.preview_id !== 'string' || !data.preview_id.trim() || data.preview_id.length > 1000 || typeof data.input !== 'string' || !data.input || !Number.isSafeInteger(data.expected_runs) || (data.expected_runs as number) < 0) throw invalid();
  return data as unknown as LocalHookPreview;
}
export async function listLocalHooks(signal: AbortSignal) {
  return parseHookResponse(await api<unknown>('/api/connections/v1/hooks/list', {}, signal), null, 'list') as LocalHook[];
}
export async function previewLocalHook(taskId: string, hookId: string, signal: AbortSignal) {
  return parseHookResponse(await api<unknown>('/api/connections/v1/hooks/preview', {task_id: taskId, hook_id: hookId}, signal), taskId, 'preview', hookId) as LocalHookPreview;
}
export async function executeLocalHook(preview: LocalHookPreview, signal: AbortSignal) {
  const body = {...Object.fromEntries(consentFields.map(key => [key, preview[key]])), preview_id: preview.preview_id, execution_consent: true};
  return parseHookResponse(await api<unknown>('/api/connections/v1/hooks/execute', body, signal), preview.task_id, 'execute', preview.hook_id, preview) as WorkExecutionResponse;
}
