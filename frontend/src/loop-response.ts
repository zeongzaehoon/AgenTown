import type { Attempt } from './api';
import type { LoopControl } from './loop-control';

export interface LoopPreview {
  schema_version: 1; preview_id: string; policy_id: string; policy_name: string;
  task_id: string; agent_id: string; input: string; max_iterations: number;
  interval_seconds: number; expected_runs: number; policy_enabled: boolean;
}
export interface LoopSession {
  session_id: string; preview: LoopPreview; state: string; admitted: number;
  declared_source?: string | null; next_at: number; provider: string; model: string;
}
export interface LoopAttempt {session_id: string; run_id: string; ordinal: number; execution: Partial<Attempt> | null}
export interface LoopInspection {schema_version: number; control?: LoopControl; sessions: LoopSession[]; attempts: LoopAttempt[]; cancellation: string}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string';
const id = (v: unknown) => text(v) && !!(v as string).trim();
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const optional = (v: Record<string, unknown>, keys: string[], valid: (x: unknown) => boolean) => keys.every(k => v[k] === undefined || valid(v[k]));
const nullableText = (v: unknown) => v === null || text(v);
function previewValid(v: unknown): v is LoopPreview {
  return record(v) && v.schema_version === 1 && ['preview_id', 'policy_id', 'task_id', 'agent_id'].every(k => id(v[k])) &&
    text(v.policy_name) && text(v.input) && typeof v.policy_enabled === 'boolean' && integer(v.expected_runs) &&
    integer(v.max_iterations) && (v.max_iterations as number) >= 1 && (v.max_iterations as number) <= 100 &&
    integer(v.interval_seconds) && (v.interval_seconds as number) >= 60 && (v.interval_seconds as number) <= 86400 &&
    optional(v, ['created_at'], integer);
}
export function loopPreview(value: unknown): LoopPreview {
  if (!previewValid(value)) throw new Error('Loop preview unavailable. Inspect again before authorizing.');
  return value;
}
function executionValid(v: unknown): boolean {
  // API execution.record supplies run_id/input/provider/model/deadline/output/error.
  // Older inspection fixtures/records may supply only terminal fields or state.
  return v === null || (record(v) && optional(v, ['schema_version'], x => x === 1) &&
    optional(v, ['id', 'run_id', 'state', 'provider', 'model', 'input', 'quality'], text) &&
    optional(v, ['output', 'error', 'outcome', 'declared_source'], nullableText) &&
    optional(v, ['deadline_unix_ms', 'started', 'ended'], x => x === null || integer(x)) &&
    optional(v, ['participants'], x => Array.isArray(x) && x.every(id)));
}
export function loopInspection(value: unknown): LoopInspection {
  if (!record(value) || value.schema_version !== 1 || !text(value.cancellation) ||
    !(value.control == null || (record(value.control) && text(value.control.state) && typeof value.control.can_control === 'boolean' && optional(value.control, ['message'], text))) ||
    !Array.isArray(value.sessions) || !value.sessions.every(s => record(s) && id(s.session_id) && previewValid(s.preview) && text(s.state) && integer(s.admitted) && integer(s.next_at) && text(s.provider) && text(s.model) && optional(s, ['schema_version'], x => x === 1) && optional(s, ['declared_source'], nullableText) && optional(s, ['started_at', 'expires_at'], integer)) ||
    !Array.isArray(value.attempts) || !value.attempts.every(a => record(a) && id(a.session_id) && id(a.run_id) && integer(a.ordinal) && (a.ordinal as number) > 0 && optional(a, ['admitted_at'], integer) && executionValid(a.execution)) ||
    new Set(value.sessions.map(s => s.session_id)).size !== value.sessions.length ||
    new Set(value.attempts.map(a => a.run_id)).size !== value.attempts.length) {
    throw new Error('Loop inspection unavailable. Waiting for valid session and attempt records.');
  }
  return value as unknown as LoopInspection;
}

/** Mutation receipts require the current wire version, unlike legacy inspection rows. */
export function loopReceipt(value: unknown, expected: LoopPreview | LoopSession, action: 'start' | 'stop', provider: string, model: string | null): LoopSession {
  const fail = () => new Error(`Loop ${action} outcome is not confirmed. Inspect session and attempt records before another explicit attempt. Nothing is resent automatically. Remote completion may remain unknown.`);
  if (!record(value) || value.schema_version !== 1 || !integer(value.started_at) || !integer(value.expires_at)) throw fail();
  let session: LoopSession;
  try { session = loopInspection({schema_version: 1, sessions: [value], attempts: [], cancellation: ''}).sessions[0]; }
  catch { throw fail(); }
  const preview = 'session_id' in expected ? expected.preview : expected;
  if ((Object.keys(preview) as (keyof LoopPreview)[]).some(key => session.preview[key] !== preview[key]) ||
    session.provider !== provider || session.model !== model || session.admitted > preview.max_iterations ||
    (value.expires_at as number) < (value.started_at as number) ||
    (action === 'start' ? session.state !== 'active' : !('session_id' in expected) || session.session_id !== expected.session_id || session.state !== 'stopped' || session.admitted < expected.admitted)) throw fail();
  return session;
}

/** A receipt is delivery evidence; only a correlated read establishes saved state. */
export function confirmedLoop(value: unknown, receipt: LoopSession, action: 'start' | 'stop'): LoopInspection {
  const inspection = loopInspection(value);
  const saved = inspection.sessions.find(s => s.session_id === receipt.session_id);
  const states = ['active', 'complete', 'stopped', 'failed', 'expired', 'restarted', 'stale'];
  if (!saved || Object.keys(receipt.preview).some(key => saved.preview[key as keyof LoopPreview] !== receipt.preview[key as keyof LoopPreview]) ||
    saved.provider !== receipt.provider || saved.model !== receipt.model ||
    saved.admitted < receipt.admitted || saved.admitted > receipt.preview.max_iterations ||
    !states.includes(saved.state) || (action === 'stop' && saved.state !== 'stopped')) {
    throw new Error('Saved Loop state is not confirmed. Refresh and inspect records; nothing is resent automatically.');
  }
  return inspection;
}
