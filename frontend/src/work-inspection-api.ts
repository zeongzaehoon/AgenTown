import { api } from './api';
import { loopInspection, type LoopSession } from './loop-response';

export interface InspectedTask {
  id: string; title: string; status: 'pending' | 'in_progress' | 'blocked' | 'cancelled'; assignees: string[];
}
export interface InspectedExecution {
  schema_version: 1; run_id: string; input: string; provider: string; model: string;
  deadline_unix_ms: number; output: string | null; error: string | null; quality: 'unverified';
}
export interface InspectedSkill {
  schema_version: 1; run_id: string; preview_id: string; skill_id: string; skill_name: string;
  instructions: string; input: string; admitted_at: number;
}
export interface InspectedHook extends InspectedSkill {
  task_id: string; hook_id: string; hook_name: string; hook_enabled: true;
  target_kind: 'agent'; agent_id: string; event: 'run_completed' | 'run_failed';
  source_run_id: string; source_outcome: 'reported_success' | 'failure'; skill_enabled: true;
}
/** Session fields are observations from a separate read, not an atomic Run snapshot. */
export type InspectedLoop = {
  linkage: 'confirmed'; session: LoopSession & {schema_version: 1; started_at: number; expires_at: number};
  ordinal: number; admitted_at: number;
} | {linkage: 'absent' | 'uncertain'; session: null; ordinal: null; admitted_at: null};
export interface InspectedRun {
  id: string; task_id: string; stage: string; reporting_source: string; declared_source?: string | null;
  started_at: number; ended_at: number | null; state: 'active' | 'finished'; outcome: string | null;
  participants: string[]; execution: InspectedExecution | null;
  skill?: InspectedSkill | null; hook?: InspectedHook | null; loop: InspectedLoop;
}
export interface WorkReadiness {
  schema_version: 1; task_id: string; input: string | null; employee_ids: string[];
  expected_runs: number; active_attempt: boolean; eligibility: 'missing' | 'ineligible' | 'eligible';
  resubmission_consent_required: boolean;
}
export interface WorkInspection {
  task: InspectedTask; attempts: InspectedRun[]; readiness: WorkReadiness;
  evidence: {
    source: 'installed_local_mcp'; tools: ['get_task', 'get_work_history_v1', 'inspect_loop_sessions_v1', 'preflight_text_work_v1'];
    read_only: true; external_client_verified: false;
  };
}
export interface InspectionResponse {
  schema_version: 1; requested_task_id: string; status: 'success' | 'failure';
  code: string; message: string; recovery: string; inspection: WorkInspection | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const stableId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;

export function parseWorkInspection(value: unknown, requested: string, historyOnly = false): InspectionResponse {
  const invalid = () => new Error('Local inspection could not be confirmed: invalid or mismatched response. Choose Inspect through local MCP to try again.');
  if (!object(value) || value.schema_version !== 1 || value.requested_task_id !== requested ||
      !text(value.code) || !text(value.message) || !text(value.recovery)) throw invalid();
  if (value.status === 'failure') {
    if (value.inspection !== null) throw invalid();
    return value as unknown as InspectionResponse;
  }
  if (value.status !== 'success' || !object(value.inspection)) throw invalid();
  const {task, attempts, evidence, readiness} = value.inspection;
  if (!object(task) || task.id !== requested || !text(task.title) ||
      typeof task.status !== 'string' || !['pending', 'in_progress', 'blocked', 'cancelled'].includes(task.status) || !ids(task.assignees) ||
      !Array.isArray(attempts) || !object(evidence) || evidence.source !== 'installed_local_mcp' ||
      evidence.read_only !== true || evidence.external_client_verified !== false ||
      !Array.isArray(evidence.tools) || evidence.tools.length !== 4 ||
      evidence.tools[0] !== 'get_task' || evidence.tools[1] !== 'get_work_history_v1' || evidence.tools[2] !== 'inspect_loop_sessions_v1' || evidence.tools[3] !== 'preflight_text_work_v1') throw invalid();
  // Validate this observation independently: other tools may have read earlier state.
  if (!(historyOnly && readiness === null) && (!object(readiness) || readiness.schema_version !== 1 || readiness.task_id !== requested ||
      !nullableText(readiness.input) || !ids(readiness.employee_ids) || !readiness.employee_ids.every(stableId) ||
      !Number.isSafeInteger(readiness.expected_runs) || (readiness.expected_runs as number) < 0 ||
      typeof readiness.active_attempt !== 'boolean' || typeof readiness.resubmission_consent_required !== 'boolean' ||
      typeof readiness.eligibility !== 'string' ||
      !['missing', 'ineligible', 'eligible'].includes(readiness.eligibility))) throw invalid();
  if (object(readiness)) {
  if (!ids(readiness.employee_ids)) throw invalid();
  const count = readiness.expected_runs as number;
  if (readiness.resubmission_consent_required !== (count > 0) ||
      (readiness.active_attempt && count === 0) ||
      (readiness.eligibility === 'missing'
        ? readiness.input !== null || readiness.employee_ids.length !== 0 || count !== 0 || readiness.active_attempt
        : typeof readiness.input !== 'string') ||
      (readiness.eligibility === 'eligible' && (readiness.active_attempt || readiness.employee_ids.length !== 1))) throw invalid();
  }
  const seen = new Set<string>();
  for (const run of attempts) {
    if (!object(run) || !text(run.id) || seen.has(run.id) || run.task_id !== requested ||
        !text(run.stage) || !text(run.reporting_source) || !timestamp(run.started_at) ||
        !(run.ended_at === null || timestamp(run.ended_at) && run.ended_at >= run.started_at) ||
        typeof run.state !== 'string' || !['active', 'finished'].includes(run.state) || !nullableText(run.outcome) || !ids(run.participants) ||
        (run.declared_source !== undefined && !nullableText(run.declared_source)) ||
        (run.state === 'active' && (run.ended_at !== null || run.outcome !== null)) ||
        (run.state === 'finished' && (run.ended_at === null || !text(run.outcome)))) throw invalid();
    seen.add(run.id);
    const execution = run.execution;
    if (execution !== null && (!object(execution) || execution.schema_version !== 1 || execution.run_id !== run.id ||
        typeof execution.input !== 'string' || !text(execution.provider) || !text(execution.model) ||
        !timestamp(execution.deadline_unix_ms) || !nullableText(execution.output) || !nullableText(execution.error) ||
        execution.quality !== 'unverified' || (execution.output !== null && execution.error !== null) ||
        (run.state === 'active' && (execution.output !== null || execution.error !== null)))) throw invalid();
  }
  const sessions = new Map<string, string>();
  const ordinals = new Set<string>();
  for (const run of attempts) {
    const loop = historyOnly && run.loop === null
      ? {linkage: 'uncertain', session: null, ordinal: null, admitted_at: null} : run.loop;
    if (!object(loop) || !['confirmed', 'absent', 'uncertain'].includes(String(loop.linkage))) throw invalid();
    if (loop.linkage !== 'confirmed') {
      if (loop.session !== null || loop.ordinal !== null || loop.admitted_at !== null) throw invalid();
    } else {
      if (!object(loop.session)) throw invalid();
      const session = loop.session;
      // Reuse the existing Loop wire parser, then check the immutable admission links.
      try { loopInspection({schema_version: 1, sessions: [session], attempts: [], cancellation: ''}); }
      catch { throw invalid(); }
      const preview = session.preview as Record<string, unknown>;
      if (session.schema_version !== 1 || !stableId(session.session_id) ||
          !timestamp(session.started_at) || !timestamp(session.expires_at) || session.expires_at < session.started_at ||
          !timestamp(preview.created_at) || preview.created_at > session.started_at ||
          !stableId(preview.policy_id) || !text(preview.policy_name) || !text(preview.preview_id) ||
          preview.policy_enabled !== true || preview.task_id !== requested ||
          !Number.isSafeInteger(loop.ordinal) || (loop.ordinal as number) < 1 ||
          (loop.ordinal as number) > (preview.max_iterations as number) ||
          !timestamp(loop.admitted_at) || loop.admitted_at !== run.started_at ||
          loop.admitted_at < session.started_at || loop.admitted_at >= session.expires_at ||
          run.participants.length !== 1 || run.participants[0] !== preview.agent_id ||
          !object(run.execution) || run.execution.input !== preview.input ||
          run.execution.provider !== session.provider || run.execution.model !== session.model ||
          run.skill != null || run.hook != null ||
          !['active', 'complete', 'stopped', 'failed', 'expired', 'stale', 'restarted'].includes(String(session.state)) ||
          (session.admitted as number) > (preview.max_iterations as number)) throw invalid();
      const key = `${session.session_id}:${loop.ordinal}`;
      if (ordinals.has(key)) throw invalid();
      ordinals.add(key);
      // A session observation may lag this attempt's ordinal. Never compare mutable progress.
      const identity = JSON.stringify([['schema_version', 'preview_id', 'policy_id', 'policy_name', 'policy_enabled', 'task_id', 'agent_id', 'input', 'max_iterations', 'interval_seconds', 'expected_runs', 'created_at'].map(key => preview[key]), session.provider, session.model, session.started_at, session.expires_at]);
      if (sessions.has(session.session_id) && sessions.get(session.session_id) !== identity) throw invalid();
      sessions.set(session.session_id, identity);
    }
    const validSnapshot = (saved: unknown): saved is InspectedSkill => object(saved) &&
      saved.schema_version === 1 && saved.run_id === run.id && text(saved.preview_id) &&
      stableId(saved.skill_id) && text(saved.skill_name) && text(saved.instructions) &&
      typeof saved.input === 'string' && timestamp(saved.admitted_at) && saved.admitted_at === run.started_at &&
      object(run.execution) && saved.input === run.execution.input;
    const {skill, hook} = run;
    if (skill != null && (hook != null || !validSnapshot(skill))) throw invalid();
    if (hook != null) {
      if (!validSnapshot(hook) || !object(hook) || hook.task_id !== requested ||
          !stableId(hook.hook_id) || !text(hook.hook_name) || hook.hook_enabled !== true ||
          hook.skill_enabled !== true || hook.target_kind !== 'agent' || !text(hook.agent_id) ||
          (run.participants.length !== 1 || run.participants[0] !== hook.agent_id) || !text(hook.source_run_id) ||
          hook.source_run_id === run.id ||
          !((hook.event === 'run_completed' && hook.source_outcome === 'reported_success') ||
            (hook.event === 'run_failed' && hook.source_outcome === 'failure'))) throw invalid();
      const source = attempts.find(candidate => candidate.id === hook.source_run_id);
      if (!source || source.state !== 'finished' || source.outcome !== hook.source_outcome ||
          source.ended_at > hook.admitted_at) throw invalid();
    }
  }
  return value as unknown as InspectionResponse;
}

export async function inspectSelectedWork(taskId: string, signal?: AbortSignal): Promise<InspectionResponse> {
  return parseWorkInspection(await api<unknown>('/api/connections/v1/inspect-work', {task_id: taskId}, signal), taskId);
}
