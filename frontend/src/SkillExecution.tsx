import { validSkillPreview } from './execution-preview';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type SkillPreview, type Work, type Workspace } from './api';
import { configurationRequest, savedSkills, type SkillRecord } from './configuration-api';

type Skill = SkillRecord;
export function SkillExecution({work, workspace, connected, draft, disabled, submit}: {
  work: Work; workspace: Workspace; connected: boolean; draft: string; disabled: boolean;
  submit: (preview: SkillPreview) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
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
  const [preview, setPreview] = useState<{value: SkillPreview; snapshot: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  const selector = useRef<HTMLSelectElement>(null);
  const refreshFocusedButton = useRef(false);
  // Inspect focus at acceptance, then recover only after React commits disabled state.
  useLayoutEffect(() => {
    const recover = refreshFocusedButton.current;
    refreshFocusedButton.current = false;
    const active = document.activeElement;
    const browserBlurredDisabledButton = active === document.body || active === null;
    if (recover && (active === button.current || browserBlurredDisabledButton) && button.current?.disabled) {
      if (selector.current && !selector.current.disabled) selector.current.focus();
      else region.current?.focus();
      setMessage('The selected Skill is no longer available for preview after configuration refreshed. Choose an eligible Skill before previewing. No execution was requested.');
    }
  });
  function recoverFocus() { if (button.current && !button.current.disabled) button.current.focus(); else region.current?.focus(); }
  const previewFocused = useRef(false);
  const snapshot = JSON.stringify([work, workspace.configuration, workspace.provider, workspace.model, draft, selected, skills, connected, generation, available, disabled]);
  const current = useRef(snapshot);
  const revision = useRef(0);
  if (current.current !== snapshot) { ++revision.current; current.current = snapshot; }
  const valid = preview?.snapshot === snapshot;
  function dismissPreview() {
    previewFocused.current = false;
    setPreview(null);
    setMessage('Skill preview dismissed. Consent cleared. No execution was requested. Preview again before executing.');
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
        const response = await configurationRequest<unknown>('skills', '', undefined, controller.signal);
        const records = savedSkills(response);
        if (live && connection.current.generation === generation) { refreshFocusedButton.current = document.activeElement === button.current && !button.current?.disabled; setSkills(records); setSelected(id => records.some(s => s.id === id) ? id : ''); setFreshGeneration(generation); setConfigurationError(false); setLoaded(true); setMessage('Configuration refreshed. Preview again before executing.'); }
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
  async function inspect() {
    if (lock.current || disabled || !connected || !available || !skills.some(s => s.id === selected && s.enabled)) return;
    lock.current = true; setBusy(true); setPreview(null); setMessage('Preparing preview…');
    const captured = snapshot;
    const capturedRevision = revision.current;
    const capturedGeneration = generation;
    try {
      const value = await api<unknown>(`/api/work/${encodeURIComponent(work.id)}/skill-preview`, {skill_id: selected});
      if (connection.current.generation !== capturedGeneration) return;
      if (current.current !== captured || revision.current !== capturedRevision) { setMessage('Work or configuration changed. Preview again.'); return; }
      if (!validSkillPreview(value, work, selected)) throw new Error('Preview response is invalid or unsupported. Refresh history and configuration, then preview again.');
      setPreview({value, snapshot: captured}); setMessage('Preview ready. Review the effective input before executing.');
    } catch (error) { if (connection.current.generation === capturedGeneration) setMessage((error as Error).message); }
    finally { if (connection.current.generation === capturedGeneration) { lock.current = false; setBusy(false); } }
  }
  const executeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (valid) executeButton.current?.focus(); }, [valid]);
  return <section ref={region} tabIndex={-1} aria-label="Apply a Skill">
    <h4>Apply a Skill</h4>
    <p>Optional. Enabled is a configuration setting, not execution. Preview combines the saved work with one Skill; it does not call a provider. Ordinary execution below uses no Skill.</p>
    <label htmlFor="execution-skill">Enabled Skill</label>
    <select ref={selector} id="execution-skill" value={selected} disabled={busy || disabled} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a Skill</option>
      {skills.filter(s => s.enabled).map(s => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}
    </select>
    <button type="button" ref={button} disabled={busy || !connected || !available || !skills.some(s => s.id === selected && s.enabled) || disabled} onClick={() => void inspect()}>Preview Skill with saved work</button>
    <p role="status" aria-live="polite">{!connected ? 'Disconnected. Skills stale. Reconnect to refresh configuration; preview consent is cleared.' : !available ? configurationError ? 'Skills unavailable; retained configuration is stale. Configuration refresh failed; retrying. Preview blocked.' : loaded ? 'Skills stale. Loading current configuration before previewing.' : 'Loading Skills configuration before previewing.' : message}</p>
    {preview && valid && <section aria-label="Skill execution preview" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismissPreview(); } }} onFocusCapture={() => { previewFocused.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) previewFocused.current = false; }}>
      <h4>Effective instructions and saved work</h4><pre>{preview.value.input}</pre>
      <p>This creates one new attempt, preserving earlier results. Unsaved draft text is not submitted.</p>
      <button type="button" onClick={dismissPreview}>Cancel Skill preview</button>
      <button type="button" ref={executeButton} disabled={disabled || busy} onClick={() => {
        if (lock.current || disabled || current.current !== preview.snapshot) return;
        lock.current = true;
        setPreview(null); setMessage('Submission requested. Inspect the resulting attempt before retrying.');
        submit(preview.value);
        // Consent is consumed synchronously. A new preview is required for any retry.
        queueMicrotask(() => { lock.current = false; });
        recoverFocus();
      }}>Execute once with Skill</button>
    </section>}
  </section>;
}
