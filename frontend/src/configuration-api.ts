import { REQUEST_DEADLINE_MS } from './api';
export type ConfigurationKind = 'skills' | 'hooks' | 'loops';
export interface ConfigurationNavigation { kind: ConfigurationKind; id: string }
export type LoopRecord = LoopFields & {id: string; enabled: boolean};
export type SkillRecord = SkillFields & {id: string; enabled: boolean};
export type HookRecord = HookFields & {id: string; enabled: boolean};
export interface SkillFields { name: string; instructions: string }
export interface HookFields { name: string; skill_id: string; target_kind: 'agent' | 'team'; target_id: string; event: 'task_created' | 'run_completed' | 'run_failed' }
export interface LoopFields { name: string; task_id: string; max_iterations: number; interval_seconds: number }
export type ConfigurationFields = SkillFields | HookFields | LoopFields;
export type ConfigurationRecord = ConfigurationFields & {id: string; enabled: boolean};
export async function configurationRequest<T>(kind: ConfigurationKind, suffix = '', data?: ConfigurationFields | {enabled: boolean}, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Configuration request timed out.')); }, REQUEST_DEADLINE_MS);
    }), (async () => {
      if (signal?.aborted) throw new Error('Cancelled');
      const response = await fetch(`/api/config/v1/${kind}${suffix}`, {method: data ? suffix ? 'PUT' : 'POST' : 'GET',
        headers: {'Content-Type': 'application/json'}, cache: 'no-store', signal: controller.signal,
        body: data ? JSON.stringify(data) : undefined});
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Configuration request failed.');
      return value as T;
    })()]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Validate the saved-policy snapshot before replacing any render state. */
export function savedLoopPolicies(result: unknown): LoopRecord[] {
  const value = result as {loops: LoopRecord[]} | null;
  if (!value || !Array.isArray(value.loops) || value.loops.some(device => !device || typeof device.id !== 'string' || !device.id || typeof device.name !== 'string' || typeof device.enabled !== 'boolean' || typeof device.task_id !== 'string' || !device.task_id || !Number.isInteger(device.max_iterations) || device.max_iterations < 1 || device.max_iterations > 100 || !Number.isInteger(device.interval_seconds) || device.interval_seconds < 60 || device.interval_seconds > 86400) || new Set(value.loops.map(device => device.id)).size !== value.loops.length) throw new Error('Saved Loop data unavailable. Refresh to try again.');
  return value.loops;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function savedRecords<T>(response: unknown, key: string, valid: (item: Record<string, unknown>) => boolean): T[] {
  const rows = record(response) ? response[key] : undefined;
  if (!Array.isArray(rows) || rows.some(item => !record(item) ||
    typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' ||
    typeof item.enabled !== 'boolean' || !valid(item)) ||
    new Set(rows.map(item => item.id)).size !== rows.length) {
    throw new Error(`Saved ${key} data unavailable. Waiting for valid configuration.`);
  }
  return rows as T[];
}
export function savedSkills(response: unknown): SkillRecord[] {
  return savedRecords(response, 'skills', item => typeof item.instructions === 'string');
}
export function savedHooks(response: unknown): HookRecord[] {
  return savedRecords(response, 'hooks', item =>
    typeof item.skill_id === 'string' && !!item.skill_id.trim() &&
    typeof item.target_id === 'string' && !!item.target_id.trim() &&
    (item.target_kind === 'agent' || item.target_kind === 'team') &&
    (item.event === 'task_created' || item.event === 'run_completed' || item.event === 'run_failed'));
}
