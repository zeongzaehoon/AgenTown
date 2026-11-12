export interface HookPreview extends SkillPreview {
  hook_id: string; hook_name: string; event: string; agent_id: string;
  source_run_id: string; source_outcome: string; hook_enabled: true; skill_enabled: true;
}
export interface HookProvenance extends SkillProvenance {
  hook_id: string; hook_name: string; event: string; agent_id: string; source_run_id: string; source_outcome: string;
}
export interface SkillPreview {
  schema_version: 1; preview_id: string; task_id: string; skill_id: string;
  input: string; expected_runs: number;
}
export interface SkillProvenance {
  run_id: string; preview_id: string; skill_id: string; skill_name: string;
  instructions: string; input: string; admitted_at: number;
}
export interface Employee { id: string; name: string }
export interface Attempt {
  id: string; state: 'active' | 'finished'; outcome: string | null;
  started?: number | null; ended?: number | null; participants: string[]; provider?: string; model?: string;
  hook?: HookProvenance; skill?: SkillProvenance; input?: string;
  output?: string | null; error?: string | null; quality?: 'unverified';
}
export interface Work {
  id: string; input: string; status: string; assignees: string[]; attempts: Attempt[];
}
export interface Workspace {
  employees: Employee[]; work: Work[]; configuration: string | null;
  provider: string; model: string | null;
}
export class WorkInputError extends Error {}
export function workInputError(input: string, employee: string): string {
  // Unicode White_Space matches Rust str::trim (JS trim differs for NEL/BOM).
  if (/^\p{White_Space}*$/u.test(input)) return 'Enter a request with some nonblank text.';
  if (/[\uD800-\uDFFF]/u.test(input)) return 'Replace the invalid Unicode character before saving.';
  const encoder = new TextEncoder();
  if (encoder.encode(input).length > 100_000) return 'Request text exceeds 100,000 UTF-8 bytes. Shorten it or split it into separate requests; your full draft is still here.';
  if (encoder.encode(JSON.stringify({input, employee})).length > 120_000) return 'The serialized request exceeds 120,000 bytes after text escaping. Shorten it or split it into separate requests; your full draft is still here.';
  return '';
}
// One deadline covers both headers and JSON body consumption.
export const REQUEST_DEADLINE_MS = 15_000;
export const EXECUTION_DEADLINE_MS = 75_000;
export class RequestTimeoutError extends Error {}
export async function api<T>(path: string, data: object, signal?: AbortSignal, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  const controller = new AbortController();
  const execution = path.endsWith('/execute');
  const timeout = execution ? EXECUTION_DEADLINE_MS : REQUEST_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(signal?.reason ?? new DOMException('Request cancelled', 'AbortError'));
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, {once: true});
    timer = setTimeout(() => {
      reject(new RequestTimeoutError(path === '/api/state'
        ? 'History refresh timed out. Check the server connection, then choose Refresh connection to inspect current history. Loaded history and unsaved input are retained.'
        : 'The response timed out. Saving or execution may already have occurred. A client timeout does not prove provider cancellation. Choose Refresh connection and inspect history before explicitly retrying; nothing is automatically resent.'));
      controller.abort();
    }, timeout);
  });
  try {
    // Race explicitly: an uncooperative fetch/body reader must not hold UI locks.
    return await Promise.race([cancelled, (async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      let response: Response;
      try {
        response = await fetch(path, {method, headers: {'Content-Type': 'application/json'},
          body: method === 'GET' ? undefined : JSON.stringify(data), cache: 'no-store', signal: controller.signal});
      } catch {
        throw new Error('Disconnected. Reconnect and inspect history before retrying; your request may have been saved or sent.');
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const value = await response.json();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        if (value.code === 'request_too_large' || value.code === 'invalid_work_text') throw new WorkInputError(value.error);
        throw new Error(value.error || 'Request failed. Refresh history before retrying.');
      }
      return value as T;
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
export type WorkOutcome = 'pending' | 'active' | 'results' | 'failed' | 'other';
// Keep filtering and the work badge on the same latest-attempt precedence.
export function classifyWork(work: Work): {outcome: WorkOutcome; label: string} {
  const last = work.attempts.at(-1);
  if (last?.state === 'active') return {outcome: 'active', label: last.provider ? 'Running — waiting for response' : 'Caller-reported active attempt — no provider request'};
  if (last?.output != null) return {outcome: 'results', label: 'Result available · Unverified'};
  if (last?.error === 'interrupted' || last?.outcome === 'interruption') return {outcome: 'failed', label: 'Interrupted — review before retry'};
  if (last?.error === 'output_limit') return {outcome: 'failed', label: 'Failed — response reached the output limit'};
  if (last?.error || last?.outcome === 'failure') return {outcome: 'failed', label: 'Failed — retry available'};
  if (last) return {outcome: 'other', label: 'Recorded attempt — no provider result'};
  if (work.status === 'pending') return {outcome: 'pending', label: 'Pending — ready to execute'};
  return {outcome: 'other', label: ({cancelled: 'Cancelled', blocked: 'Blocked', in_progress: 'In progress — no provider result'} as Record<string, string>)[work.status] || 'Recorded work — no provider result'};
}
export function workStatus(work: Work): string {
  return classifyWork(work).label;
}
export const advice: Record<string, string> = {
  authentication: 'Check the server API key and account access, then restart the server.',
  rate_limit: 'Wait for provider capacity, then retry explicitly.',
  timeout: 'The provider may have received the work. Review before retrying.',
  network: 'Check the server connection. The provider may have received the work.',
  interrupted: 'The process stopped or the attempt expired. No automatic resend occurred. Review before retrying.',
  malformed_response: 'The provider returned an unsupported or incomplete response. Retry explicitly.',
  output_limit: 'The response reached the output limit. This attempt’s partial response was not retained. Use as new draft to request a shorter answer or split the work into separate requests. Retry resends unchanged input and may hit the same limit.',
  empty_response: 'The provider returned no text. Retry explicitly.',
  refusal: 'The provider declined this work. Save revised work if appropriate.',
  provider_error: 'Provider request failed. Check configuration and service availability.',
};

export interface Team { id: string; name: string; members: string[] }
export const listTeams = (signal?: AbortSignal) => api<{teams: Team[]}>('/api/teams', {}, signal, 'GET');
export const createTeam = (name: string, signal?: AbortSignal) => api<Team>('/api/teams', {name}, signal);
export const addTeamMembers = (id: string, members: string[], signal?: AbortSignal) => api<Team>(`/api/teams/${encodeURIComponent(id)}/members`, {members}, signal);
