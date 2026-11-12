import { useEffect, useRef, useState } from 'react';
import { api, type SkillPreview, type Work, type Workspace } from './api';
import { configurationRequest, type SkillFields } from './configuration-api';

type Skill = SkillFields & {id: string; enabled: boolean};
export function SkillExecution({work, workspace, connected, draft, disabled, submit}: {
  work: Work; workspace: Workspace; connected: boolean; draft: string; disabled: boolean;
  submit: (preview: SkillPreview) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [available, setAvailable] = useState(false);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{value: SkillPreview; snapshot: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const previewFocused = useRef(false);
  const snapshot = JSON.stringify([work, workspace.configuration, workspace.provider, workspace.model, draft, selected, skills, connected, available, disabled]);
  const current = useRef(snapshot); current.current = snapshot;
  const valid = preview?.snapshot === snapshot;
  useEffect(() => {
    let live = true;
    let pending = false;
    const controller = new AbortController();
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const value = await configurationRequest<{skills: Skill[]}>('skills', '', undefined, controller.signal);
        if (!Array.isArray(value.skills)) throw new Error('Invalid Skills response');
        if (live) { setSkills(value.skills); setAvailable(true); }
      } catch { if (live) { setAvailable(false); setMessage('Skills unavailable. Waiting to reconnect before previewing.'); } }
      finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 800);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (preview && !valid) {
      if (previewFocused.current) { button.current?.focus(); previewFocused.current = false; }
      setPreview(null); setMessage('Preview invalidated. Review saved work and configuration, then preview again.');
    }
  }, [preview, valid]);
  async function inspect() {
    if (lock.current || !connected || !available || !skills.some(s => s.id === selected && s.enabled)) return;
    lock.current = true; setBusy(true); setPreview(null); setMessage('Preparing preview…');
    const captured = snapshot;
    try {
      const value = await api<SkillPreview>(`/api/work/${encodeURIComponent(work.id)}/skill-preview`, {skill_id: selected});
      if (current.current !== captured) { setMessage('Work or configuration changed. Preview again.'); return; }
      if (value.schema_version !== 1 || value.task_id !== work.id || value.skill_id !== selected || value.expected_runs !== work.attempts.length || typeof value.input !== 'string' || !value.preview_id) throw new Error('Unsupported preview. Refresh history before trying again.');
      setPreview({value, snapshot: captured}); setMessage('Preview ready. Review the effective input before executing.');
    } catch (error) { setMessage((error as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  const executeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (valid) executeButton.current?.focus(); }, [valid]);
  return <section aria-label="Apply a Skill">
    <h4>Apply a Skill</h4>
    <p>Optional. Enabled is a configuration setting, not execution. Preview combines the saved work with one Skill; it does not call a provider. Ordinary execution below uses no Skill.</p>
    <label htmlFor="execution-skill">Enabled Skill</label>
    <select id="execution-skill" value={selected} disabled={busy || disabled} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a Skill</option>
      {skills.filter(s => s.enabled).map(s => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}
    </select>
    <button type="button" ref={button} disabled={busy || !connected || !available || !skills.some(s => s.id === selected && s.enabled) || disabled} onClick={() => void inspect()}>Preview Skill with saved work</button>
    <p role="status" aria-live="polite">{message}</p>
    {preview && valid && <section aria-label="Skill execution preview" onFocusCapture={() => { previewFocused.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) previewFocused.current = false; }}>
      <h4>Effective instructions and saved work</h4><pre>{preview.value.input}</pre>
      <p>This creates one new attempt, preserving earlier results. Unsaved draft text is not submitted.</p>
      <button type="button" onClick={() => { setPreview(null); button.current?.focus(); }}>Cancel Skill preview</button>
      <button type="button" ref={executeButton} disabled={disabled || busy} onClick={() => {
        if (lock.current || disabled || current.current !== preview.snapshot) return;
        lock.current = true;
        setPreview(null); setMessage('Submission requested. Inspect the resulting attempt before retrying.');
        submit(preview.value);
        // Consent is consumed synchronously. A new preview is required for any retry.
        queueMicrotask(() => { lock.current = false; });
        button.current?.focus();
      }}>Execute once with Skill</button>
    </section>}
  </section>;
}
