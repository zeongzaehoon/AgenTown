import { api } from './api';
import { parseWorkInspection, type WorkInspection } from './work-inspection-api';

export interface WorkRecoveryResponse {
  schema_version: 1; requested_task_id: string;
  status: 'confirmed' | 'uncertain' | 'unavailable' | 'rejected';
  code: string; recovery: string;
  inspection: {task: WorkInspection['task']; attempts: WorkInspection['attempts']; readiness: null} | null;
}
export function parseWorkRecovery(value: unknown, taskId: string): WorkRecoveryResponse {
  const invalid = () => new Error('Recovery receipt could not be confirmed');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const r = value as WorkRecoveryResponse & {evidence: Record<string, unknown>};
  const codes: Record<string, string> = {confirmed: 'reconciliation_confirmed', uncertain: 'delivery_uncertain', unavailable: 'transport_unavailable', rejected: 'recovery_busy'};
  const e = r.evidence;
  if (r.schema_version !== 1 || r.requested_task_id !== taskId || !Object.hasOwn(codes, r.status) || codes[r.status] !== r.code ||
      typeof r.recovery !== 'string' || !r.recovery.trim() || !e ||
      e.source !== 'installed_local_mcp' || e.tool !== 'get_work_history_v1' || e.read_only !== false ||
      e.mutation_scope !== 'snapshot_expired_leases' || e.external_client_verified !== false) throw invalid();
  if (r.status !== 'confirmed') {if (r.inspection !== null) throw invalid();}
  else {
    if (!r.inspection || r.inspection.readiness !== null) throw invalid();
    parseWorkInspection({schema_version: 1, requested_task_id: taskId, status: 'success', code: 'inspected', message: 'Receipt', recovery: r.recovery,
      inspection: {...r.inspection, evidence: {source: 'installed_local_mcp', tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'], read_only: true, external_client_verified: false}}}, taskId, true);
  }
  return r;
}
export async function reconcileSelectedWork(taskId: string, signal: AbortSignal) {
  return parseWorkRecovery(await api<unknown>('/api/connections/v1/reconcile-work', {task_id: taskId, recovery_consent: true}, signal), taskId);
}
