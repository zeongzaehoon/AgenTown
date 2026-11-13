import { api } from './api';
import { savedLoopPolicies, type LoopRecord } from './configuration-api';
import { loopInspection, loopPreview, type LoopInspection, type LoopPreview, type LoopSession } from './loop-response';

export type LocalLoopPreview = LoopPreview & {created_at: number; provider: string; model: string};
export type LoopOperation = 'list' | 'preview' | 'start' | 'inspect' | 'stop';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const samePreview = (a: LoopPreview, b: LoopPreview) => Object.keys(a).every(k => a[k as keyof LoopPreview] === b[k as keyof LoopPreview]) && Object.keys(b).every(k => a[k as keyof LoopPreview] === b[k as keyof LoopPreview]);
function validatePreview(v: unknown, task: string): LoopPreview {
  const p = loopPreview(v);
  if (!record(v) || p.task_id !== task || ![p.task_id, p.agent_id, p.policy_id].every(uuid) || !p.policy_enabled || !p.input.trim() || !integer(v.created_at)) throw new Error('Invalid Loop context');
  return p;
}
function session(v: unknown, task: string): LoopSession {
  if (!record(v) || v.schema_version !== 1 || !uuid(v.session_id) || !integer(v.started_at) || !integer(v.expires_at) || v.expires_at < v.started_at) throw new Error('Invalid session');
  const s = loopInspection({schema_version: 1, sessions: [v], attempts: [], cancellation: ''}).sessions[0];
  validatePreview(s.preview, task);
  if (!['active', 'complete', 'stopped', 'failed', 'expired', 'restarted', 'stale'].includes(s.state) || s.admitted > s.preview.max_iterations || !s.provider || !s.model) throw new Error('Invalid session state');
  return s;
}
export interface LocalLoopResult {status: string; code: string; recovery: string; policies?: LoopRecord[]; preview?: LocalLoopPreview; inspection?: LoopInspection; receipt?: LoopSession}
export function parseLocalLoop(value: unknown, task: string, operation: LoopOperation, expected?: string | LocalLoopPreview | LoopSession): LocalLoopResult {
  if (!record(value) || value.schema_version !== 1 || value.requested_task_id !== task || typeof value.recovery !== 'string' || !value.recovery.trim() || typeof value.code !== 'string' || typeof value.status !== 'string') throw new Error('Invalid Loop response');
  const result: LocalLoopResult = {status: value.status, code: value.code, recovery: value.recovery};
  if (value.status !== 'confirmed') {
    if (!['rejected', 'unavailable', 'uncertain'].includes(value.status) || (value.data !== null && value.code !== 'competing_owner')) throw new Error('Invalid failure');
    if (value.data !== null) result.inspection = inspect(value.data, task);
    return result;
  }
  if (value.code !== {list: 'loops_discovered', preview: 'loop_previewed', start: 'loop_started', inspect: 'loops_inspected', stop: 'loop_stopped'}[operation]) throw new Error('Unexpected operation');
  if (operation === 'list') {
    if (!record(value.data) || value.data.schema_version !== 1) throw new Error('Invalid policies');
    result.policies = savedLoopPolicies(value.data);
    if (result.policies.some(p => p.task_id !== task || !uuid(p.id))) throw new Error('Wrong policy selection');
  } else if (operation === 'preview') {
    const p = validatePreview(value.data, task);
    if (p.policy_id !== expected || !record(value.data) || typeof value.data.provider !== 'string' || !value.data.provider || typeof value.data.model !== 'string' || !value.data.model) throw new Error('Invalid preview selection');
    result.preview = value.data as unknown as LocalLoopPreview;
  } else if (operation === 'inspect') result.inspection = inspect(value.data, task);
  else {
    const s = session(value.data, task);
    if (!expected || typeof expected === 'string') throw new Error('Missing provenance');
    const p = 'session_id' in expected ? expected.preview : Object.fromEntries(Object.entries(expected).filter(([k]) => k !== 'provider' && k !== 'model')) as unknown as LoopPreview;
    if (!samePreview(s.preview, p) || s.provider !== expected.provider || s.model !== expected.model || (operation === 'start' && s.declared_source !== 'agentown-local-product') || (operation === 'stop' && (!('session_id' in expected) || s.session_id !== expected.session_id || s.state === 'active'))) throw new Error('Session provenance mismatch');
    result.receipt = s;
  }
  return result;
}
function inspect(v: unknown, task: string): LoopInspection {
  if (!record(v) || !record(v.control) || !['available', 'local_authority', 'competing_owner', 'storage_failure', 'closed'].includes(v.control.state as string) || typeof v.control.message !== 'string') throw new Error('Invalid authority');
  const data = loopInspection({...v, cancellation: 'Stop prevents new admissions and attempts local cancellation. Remote completion may remain unknown.'});
  data.sessions.forEach(s => session(s, task));
  if (data.attempts.some(a => !uuid(a.run_id) || !data.sessions.some(s => s.session_id === a.session_id && a.ordinal <= s.admitted))) throw new Error('Invalid attempt linkage');
  return data;
}
export async function localLoop(operation: LoopOperation, task: string, signal: AbortSignal, expected?: string | LocalLoopPreview | LoopSession) {
  const body = {task_id: task, ...(operation === 'preview' ? {policy_id: expected} : operation === 'start' ? {consent: expected, execution_consent: true} : operation === 'stop' ? {session_id: (expected as LoopSession).session_id} : {})};
  return parseLocalLoop(await api<unknown>(`/api/connections/v1/loops/${operation}`, body, signal), task, operation, expected);
}
