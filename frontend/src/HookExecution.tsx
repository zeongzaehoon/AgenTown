import { validHookPreview } from './execution-preview';
import { useEffect, useRef, useState } from 'react';
import { api, type HookPreview, type Work, type Workspace } from './api';
import { configurationRequest, savedSkills, savedHooks, type HookRecord, type SkillRecord } from './configuration-api';

type Skill = SkillRecord;
type Hook = HookRecord;
export function HookExecution({work, workspace, connected, draft, disabled, submit}: {
  work: Work; workspace: Workspace; connected: boolean; draft: string; disabled: boolean;
  submit: (preview: HookPreview) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const connection = useRef({connected, generation: 0});
  if (connection.current.connected !== connected) {
    connection.current = {connected, generation: connection.current.generation + 1};
  }
  const generation = connection.current.generation;
  const [freshGeneration, setFreshGeneration] = useState<number | null>(null);
  const [configurationError, setConfigurationError] = useState(false);
  const available = connected && freshGeneration === generation && !configurationError;
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{value: HookPreview; snapshot: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  function recoverFocus() { if (button.current && !button.current.disabled) button.current.focus(); else region.current?.focus(); }
  const previewFocused = useRef(false);
  const snapshot = JSON.stringify([work, workspace.configuration, workspace.provider, workspace.model, draft, selected, hooks, skills, connected, generation, available, disabled]);
  const current = useRef(snapshot);
  const revision = useRef(0);
  if (current.current !== snapshot) { ++revision.current; current.current = snapshot; }
  const valid = preview?.snapshot === snapshot;
  function dismissPreview() {
    previewFocused.current = false;
    setPreview(null);
    setMessage('Hook preview dismissed. Consent cleared. No execution was requested. Preview again before executing.');
    recoverFocus();
  }
  useEffect(() => {
    setFreshGeneration(null);
    setConfigurationError(false);
    lock.current = false;
    setBusy(false);
    if (!connected) return;
    let live = true;
    let pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const [value, records] = await Promise.all([configurationRequest<unknown>('skills', '', undefined, controller.signal), configurationRequest<unknown>('hooks', '', undefined, controller.signal)]);
        const skills = savedSkills(value);
        const hooks = savedHooks(records);
        if (live && connection.current.generation === generation) { setSkills(skills); setHooks(hooks); setSelected(id => hooks.some(h => h.id === id) ? id : ''); setFreshGeneration(generation); setConfigurationError(false); setLoaded(true); setMessage('Configuration refreshed. Preview again before executing.'); }
      } catch { if (live && connection.current.generation === generation) { ++revision.current; setConfigurationError(true); setFreshGeneration(null); } }
      finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 800);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [connected, generation]);
  useEffect(() => {
    if (preview && !valid) {
      if (previewFocused.current) { recoverFocus(); previewFocused.current = false; }
      setPreview(null); setMessage('Preview invalidated. Review saved work and configuration, then preview again.');
    }
  }, [preview, valid]);
  const source = work.attempts.at(-1);
  const event = source?.state === 'finished' ? source.outcome === 'reported_success' ? 'run_completed' : source.outcome === 'failure' ? 'run_failed' : '' : '';
  function eligible(h: Hook) { return h.enabled && h.target_kind === 'agent' && work.assignees.length === 1 && h.target_id === work.assignees[0] && h.event === event && skills.some(s => s.id === h.skill_id && s.enabled); }
  async function inspect() {
    if (lock.current || disabled || !connected || !available || !hooks.some(h => h.id === selected && eligible(h))) return;
    lock.current = true; setBusy(true); setPreview(null); setMessage('Preparing preview…');
    const captured = snapshot;
    const capturedRevision = revision.current;
    const capturedGeneration = generation;
    try {
      const value = await api<unknown>(`/api/work/${encodeURIComponent(work.id)}/hook-preview`, {hook_id: selected});
      if (connection.current.generation !== capturedGeneration) return;
      if (current.current !== captured || revision.current !== capturedRevision) { setMessage('Work or configuration changed. Preview again.'); return; }
      if (!validHookPreview(value, work, selected, hooks.find(h => h.id === selected)?.skill_id, event)) throw new Error('Preview response is invalid or unsupported. Refresh history and configuration, then preview again.');
      setPreview({value, snapshot: captured}); setMessage('Preview ready. Review the effective input before executing.');
    } catch (error) { if (connection.current.generation === capturedGeneration) setMessage((error as Error).message); }
    finally { if (connection.current.generation === capturedGeneration) { lock.current = false; setBusy(false); } }
  }
  const executeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (valid) executeButton.current?.focus(); }, [valid]);
  return <section ref={region} tabIndex={-1} aria-label="Apply an employee Hook">
    <h4>Apply an employee Hook</h4>
    <p>Optional. Hooks never dispatch automatically. Preview uses the latest terminal attempt and saved work; no provider is called. Consent creates only one attempt, with no Loop activation.</p>
    <label htmlFor="execution-hook">Employee Hook</label>
    <select id="execution-hook" value={selected} disabled={busy || disabled} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a Hook</option>
      {hooks.map(h => <option key={h.id} value={h.id} disabled={!eligible(h)}>{h.name} · {h.id} · {!h.enabled ? 'Disabled' : !skills.some(s => s.id === h.skill_id && s.enabled) ? 'Skill unavailable or disabled' : !eligible(h) ? 'Unmatched' : h.event}</option>)}
    </select>
    <button type="button" ref={button} disabled={busy || !connected || !available || !hooks.some(h => h.id === selected && eligible(h)) || disabled} onClick={() => void inspect()}>Preview Hook with saved work</button>
    <p role="status" aria-live="polite">{!connected ? 'Disconnected. Hooks stale. Reconnect to refresh configuration; preview consent is cleared.' : !available ? configurationError ? 'Hooks unavailable; retained configuration is stale. Configuration refresh failed; retrying. Preview blocked.' : loaded ? 'Hooks stale. Loading current configuration before previewing.' : 'Loading Hooks configuration before previewing.' : disabled ? 'Execution unavailable. Inspect history and work configuration.' : message || (hooks.some(eligible) ? 'Eligible Hooks available. Choose one to preview.' : 'Unmatched: no enabled employee Hook matches the latest terminal event.')}</p>
    {preview && valid && <section aria-label="Hook execution preview" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismissPreview(); } }} onFocusCapture={() => { previewFocused.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) previewFocused.current = false; }}>
      <p>Source event: {preview.value.event} · Source Run: {preview.value.source_run_id} · Outcome: {preview.value.source_outcome}</p>
      <h4>Effective instructions and saved work</h4><pre>{preview.value.input}</pre>
      <p>This creates one new attempt, preserving earlier results. Unsaved draft text is not submitted.</p>
      <button type="button" onClick={dismissPreview}>Cancel Hook preview</button>
      <button type="button" ref={executeButton} disabled={disabled || busy} onClick={() => {
        if (lock.current || disabled || current.current !== preview.snapshot) return;
        lock.current = true;
        setPreview(null); setMessage('Submission requested. Inspect the resulting attempt before retrying.');
        submit(preview.value);
        // Consent is consumed synchronously. A new preview is required for any retry.
        queueMicrotask(() => { lock.current = false; });
        recoverFocus();
      }}>Execute once with Hook</button>
    </section>}
  </section>;
}
