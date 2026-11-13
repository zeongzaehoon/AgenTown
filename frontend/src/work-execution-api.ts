import { api } from './api';
import type { InspectedExecution } from './work-inspection-api';

export interface WorkExecutionResponse {
  schema_version: 1; requested_task_id: string;
  status: 'completed' | 'rejected' | 'unavailable' | 'uncertain';
  code: string; recovery: string; execution: InspectedExecution | null;
}
export function parseWorkExecution(value: unknown, taskId: string): WorkExecutionResponse {
  const invalid = () => new Error('Execution response could not be confirmed. Inspect before requesting again.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const r = value as WorkExecutionResponse;
  const pairs: Record<string, string[]> = {
    completed: ['execution_recorded'], rejected: ['configuration_unavailable', 'execution_busy', 'admission_rejected'],
    unavailable: ['transport_unavailable'], uncertain: ['delivery_uncertain'],
  };
  if (r.schema_version !== 1 || r.requested_task_id !== taskId ||
      !Object.hasOwn(pairs, r.status) || !pairs[r.status].includes(r.code) ||
      typeof r.recovery !== 'string' || !r.recovery.trim()) throw invalid();
  if (r.status !== 'completed') { if (r.execution !== null) throw invalid(); }
  else {
    const e = r.execution;
    if (!e || typeof e !== 'object' || Array.isArray(e) || e.schema_version !== 1 ||
        typeof e.run_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.run_id) ||
        typeof e.input !== 'string' || typeof e.provider !== 'string' || !e.provider.trim() ||
        typeof e.model !== 'string' || !e.model.trim() || !Number.isSafeInteger(e.deadline_unix_ms) ||
        e.deadline_unix_ms < 0 || e.deadline_unix_ms > 253402300799999 || e.quality !== 'unverified' ||
        !((typeof e.output === 'string' && e.error === null) || (e.output === null && typeof e.error === 'string' && !!e.error.trim()))) throw invalid();
  }
  return r;
}
export async function executeSelectedWork(taskId: string, count: number, signal: AbortSignal) {
  return parseWorkExecution(await api<unknown>('/api/connections/v1/execute-work', {
    task_id: taskId, expected_runs: count, resubmission_consent: count > 0,
  }, signal), taskId);
}
