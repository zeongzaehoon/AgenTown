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
