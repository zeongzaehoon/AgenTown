import { REQUEST_DEADLINE_MS } from './api';
export type ConfigurationKind = 'skills' | 'hooks' | 'loops';
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
