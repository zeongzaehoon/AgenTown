import type { SkillNavigation } from './SkillBooks';
import { useLayoutEffect, useRef, useState } from 'react';
import type { SkillPreview } from './api';
import { executeLocalSkill, listLocalSkills, previewLocalSkill, type LocalSkill } from './work-skill-api';
import type { WorkExecutionResponse } from './work-execution-api';

/** Lifetime is one explicit local inspection; no automatic discovery or replay. */
export function WorkSkill({taskId, onInspect, navigation}: {navigation?: SkillNavigation | null; taskId: string; onInspect: () => void}) {
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
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
    setMessage('Local Skill preview dismissed. Consent cleared. No execution requested.');
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
        const records = await listLocalSkills(active.signal);
        if (request.current === active) {
          setSkills(records); setSelected(''); setFocused(false);
          if (navigation) {
            const found = records.find(skill => skill.id === navigation.skillId);
            if (!found || !found.enabled) setMessage(`Requested Skill is ${found ? 'disabled' : 'missing'}. Nothing was previewed or executed. No other Skill was selected.`);
            else {setSelected(found.id); setFocused(true); setMessage('Requested Skill selected. Preview explicitly to validate current server state.');}
          } else setMessage(records.some(s => s.enabled) ? 'Choose an enabled Skill.' : 'No enabled Skills available. Enable a Skill in configuration, then inspect again.');
        }
      } else if (operation === 'preview') {
        const value = await previewLocalSkill(taskId, selected, active.signal);
        if (request.current === active) setPreview(value);
      } else {
        const value = await executeLocalSkill(saved!, active.signal);
        if (request.current === active) setResult(value);
      }
    } catch {
      if (request.current === active) setMessage(operation === 'execute'
        ? 'Delivery is uncertain. Work may have executed. Inspect before another attempt; nothing is automatically resent.'
        : 'Skill discovery or preview could not be confirmed. Inspect work or explicitly request a fresh preview. No execution requested.');
    } finally {if (request.current === active) {request.current = null; setBusy(false);}}
  }
  return <section aria-label="Apply Skill through local MCP" aria-busy={busy}>
    <h4>Apply a Skill through local MCP</h4>
    <p>Discovery and preview do not execute work. Enabled means configuration enabled. Execution uses the server’s provider and model and may incur cost.</p>
    <button type="button" disabled={busy || consumed} onClick={() => void perform('list')}>Find Skills through local MCP</button>
    <label>Local enabled Skill <select ref={selection} value={selected} disabled={consumed} onChange={event => {invalidate(); setSelected(event.target.value);}}>
      <option value="">Choose a Skill</option>{skills.filter(s => s.enabled).map(s => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}
    </select></label>
    <button ref={previewControl} type="button" disabled={!selected || consumed} onClick={() => {invalidate(); void perform('preview');}}>Preview local Skill</button>
    <p role="status" aria-live="polite">{busy ? 'Waiting for local MCP…' : message}</p>
    {preview && <section ref={previewRegion} tabIndex={-1} aria-label="Local Skill preview" onKeyDown={event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); dismissPreview();}
    }}>
      <h5>Exact effective input</h5><pre>{preview.input}</pre>
      <p>Preview ID: {preview.preview_id} · Prior attempts: {preview.expected_runs}</p>
      <p>This creates one new attempt and preserves prior results. Quality remains unverified.</p>
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I authorize one execution of this exact Skill preview{preview.expected_runs > 0 ? ', after reviewing prior attempts' : ''}.</label>
      <button type="button" disabled={!consent || busy || consumed} onClick={() => void perform('execute')}>Execute local Skill once</button>
      <button type="button" onClick={dismissPreview}>Cancel local Skill preview</button>
    </section>}
    {result && <div role={result.status === 'completed' ? 'status' : 'alert'}>
      <p>Skill execution: {result.status} ({result.code}).</p><p>{result.recovery}</p>
      {result.execution && <><p>Run ID: {result.execution.run_id} · Provider: {result.execution.provider} · Model: {result.execution.model}</p><p>Quality unverified</p>{result.execution.output !== null && <pre>{result.execution.output}</pre>}{result.execution.error !== null && <p>Recorded provider error: {result.execution.error}</p>}</>}
    </div>}
    {consumed && <><p>Consent consumed. Inspect explicitly before another request.</p><button ref={recovery} type="button" disabled={busy} onClick={onInspect}>Inspect before another Skill execution</button></>}
  </section>;
}
