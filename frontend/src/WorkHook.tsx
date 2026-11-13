import type { HookNavigation } from './HookDevices';
import { useLayoutEffect, useRef, useState } from 'react';
import type { LocalHookPreview } from './work-hook-api';
import { executeLocalHook, listLocalHooks, previewLocalHook, type LocalHook } from './work-hook-api';
import type { WorkExecutionResponse } from './work-execution-api';

/** Lifetime is one explicit local inspection; no automatic discovery or replay. */
export function WorkHook({taskId, onInspect, navigation, assignees}: {taskId: string; onInspect: () => void; navigation?: HookNavigation | null; assignees?: string[]}) {
  const [hooks, setHooks] = useState<LocalHook[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<LocalHookPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [consumed, setConsumed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<WorkExecutionResponse | null>(null);
  const request = useRef<AbortController | null>(null);
  const previewControl = useRef<HTMLButtonElement>(null);
  const previewRegion = useRef<HTMLElement>(null);
  const selection = useRef<HTMLSelectElement>(null);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {if (focused && !busy) selection.current?.focus();}, [focused, busy]);
  const recovery = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => () => {request.current?.abort(); request.current = null;}, []);
  useLayoutEffect(() => {if (preview) previewRegion.current?.focus();}, [preview]);
  useLayoutEffect(() => {if (consumed && !busy) recovery.current?.focus();}, [consumed, busy]);
  function invalidate() {
    request.current?.abort(); request.current = null;
    setPreview(null); setConsent(false); setMessage(''); setBusy(false);
  }
  function dismissPreview() {
    if (!preview || busy || consumed) return;
    setPreview(null); setConsent(false);
    setMessage('Local Hook preview dismissed. Consent cleared. No execution requested.');
    previewControl.current?.focus();
  }
  async function perform(operation: 'list' | 'preview' | 'execute') {
    if (request.current || consumed || (operation === 'execute' && (!preview || !consent))) return;
    const saved = preview;
    invalidate();
    const active = new AbortController(); request.current = active; setBusy(true);
    if (operation === 'execute') setConsumed(true);
    try {
      if (operation === 'list') {
        const records = await listLocalHooks(active.signal);
        if (request.current === active) {
          setHooks(records); setSelected(''); setFocused(false);
          if (navigation) {
            const found = records.find(h => h.id === navigation.hookId);
            const explanation = !found ? 'missing' : !found.enabled ? 'disabled' : found.target_kind !== 'agent' || !['run_completed', 'run_failed'].includes(found.event) ? 'unsupported' : found.target_id !== navigation.employeeId || !assignees?.includes(found.target_id) ? 'retargeted or no longer assigned to this work' : '';
            if (explanation) setMessage(`Requested Hook is ${explanation}. Nothing was previewed or executed. No other Hook was selected.`);
            else {setSelected(found!.id); setFocused(true); setMessage('Requested Hook selected. Preview explicitly to validate current server state.');}
          } else setMessage(records.some(s => s.enabled && s.target_kind === 'agent' && s.event !== 'task_created') ? 'Choose an enabled Hook.' : 'No enabled employee follow-up Hooks available. Configure a run-completed or run-failed employee Hook and Skill, then inspect again.');
        }
      } else if (operation === 'preview') {
        const value = await previewLocalHook(taskId, selected, active.signal);
        if (navigation && (value.hook_id !== navigation.hookId || value.agent_id !== navigation.employeeId || !assignees?.includes(value.agent_id))) throw new Error('Requested Hook target changed');
        if (request.current === active) setPreview(value);
      } else {
        const value = await executeLocalHook(saved!, active.signal);
        if (request.current === active) setResult(value);
      }
    } catch {
      if (request.current === active) setMessage(operation === 'execute'
        ? 'Delivery is uncertain. Work may have executed. Inspect before another attempt; nothing is automatically resent.'
        : 'Hook discovery or preview could not be confirmed. Inspect work or explicitly request a fresh preview. No execution requested.');
    } finally {if (request.current === active) {request.current = null; setBusy(false);}}
  }
  return <section aria-label="Apply Hook through local MCP" aria-busy={busy}>
    <h4>Apply a Hook through local MCP</h4>
    <p>Discovery and preview do not execute work. Enabled means configuration enabled; Hooks never dispatch automatically. Execution uses the server’s provider and model and may incur cost.</p>
    <button type="button" disabled={busy || consumed} onClick={() => void perform('list')}>Find Hooks through local MCP</button>
    <label>Local enabled Hook <select ref={selection} value={selected} disabled={consumed} onChange={event => {invalidate(); setSelected(event.target.value);}}>
      <option value="">Choose a Hook</option>{hooks.filter(s => (!navigation || s.id === selected) && s.enabled && s.target_kind === 'agent' && s.event !== 'task_created').map(s => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}
    </select></label>
    <button ref={previewControl} type="button" disabled={!selected || consumed} onClick={() => {invalidate(); void perform('preview');}}>Preview local Hook</button>
    <p role="status" aria-live="polite">{busy ? 'Waiting for local MCP…' : message}</p>
    {preview && <section ref={previewRegion} tabIndex={-1} aria-label="Local Hook preview" onKeyDown={event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); dismissPreview();}
    }}>
      <h5>Employee follow-up preview</h5><p>Hook: {preview.hook_name} · {preview.hook_id}</p><p>Employee: {preview.agent_id} · Skill: {preview.skill_name} · {preview.skill_id}</p><p>Source Run: {preview.source_run_id} · Event: {preview.event} · Outcome: {preview.source_outcome}</p><h5>Exact effective input</h5><pre>{preview.input}</pre>
      <p>Preview ID: {preview.preview_id} · Prior attempts: {preview.expected_runs}</p>
      <p>This creates one new attempt and preserves prior results. Quality remains unverified.</p>
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I authorize one execution of this exact Hook preview{preview.expected_runs > 0 ? ', after reviewing prior attempts' : ''}.</label>
      <button type="button" disabled={!consent || busy || consumed} onClick={() => void perform('execute')}>Execute local Hook once</button>
      <button type="button" onClick={dismissPreview}>Cancel local Hook preview</button>
    </section>}
    {result && <div role={result.status === 'completed' ? 'status' : 'alert'}>
      <p>Hook execution: {result.status} ({result.code}).</p><p>{result.recovery}</p>
      {result.execution && <><p>Run ID: {result.execution.run_id} · Provider: {result.execution.provider} · Model: {result.execution.model}</p><p>Quality unverified</p>{result.execution.output !== null && <pre>{result.execution.output}</pre>}{result.execution.error !== null && <p>Recorded provider error: {result.execution.error}</p>}</>}
    </div>}
    {consumed && <><p>Consent consumed. Inspect explicitly before another request.</p><button ref={recovery} type="button" disabled={busy} onClick={onInspect}>Inspect before another Hook execution</button></>}
  </section>;
}
