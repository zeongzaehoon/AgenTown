import { useEffect, useRef, useState } from 'react';
import { type Workspace, listTeams, type Team } from './api';
import { configurationRequest, type ConfigurationFields, type ConfigurationKind, type ConfigurationRecord } from './configuration-api';

type Draft = Record<string, string>;
const labels = {skills: 'Skill', hooks: 'Hook', loops: 'Loop'};
const defaults: Record<ConfigurationKind, Draft> = {
  skills: {name: '', instructions: ''},
  hooks: {name: '', skill_id: '', target_kind: 'agent', target_id: '', event: 'task_created'},
  loops: {name: '', task_id: '', max_iterations: '1', interval_seconds: '60'},
};
function draftOf(record: ConfigurationRecord): Draft {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'id' && key !== 'enabled').map(([key, value]) => [key, String(value)]));
}
export function Configuration({workspace}: {workspace: Workspace | null}) {
  const [open, setOpen] = useState(false);
  return <section aria-labelledby="configuration-title"><h2 id="configuration-title">Configuration</h2>
    <p>Manage Skills, Hooks and Loop policies. Configuration does not execute work. Runtime execution of these policies is unavailable, even when enabled.</p>
    <button type="button" aria-expanded={open} aria-controls="configuration-panel" onClick={() => setOpen(true)}>Open configuration</button>
    <div id="configuration-panel">{open && <ConfigurationPanel workspace={workspace} />}</div>
  </section>;
}
function ConfigurationPanel({workspace}: {workspace: Workspace | null}) {
  const [kind, setKind] = useState<ConfigurationKind>('skills');
  const [records, setRecords] = useState<Record<ConfigurationKind, ConfigurationRecord[]> | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selection, setSelection] = useState<Record<ConfigurationKind, string>>({skills: '', hooks: '', loops: ''});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const selector = useRef<HTMLSelectElement>(null);
  const focusSelection = useRef(false);
  const selected = selection[kind];
  const record = records?.[kind].find(item => item.id === selected);
  const key = `${kind}/${selected}`;
  const draft = drafts[key] ?? (record ? draftOf(record) : defaults[kind]);
  const blocked = busy || stale || !records || (!!selected && !record);
  function change(field: string, value: string) { setDrafts(previous => ({...previous, [key]: {...draft, [field]: value}})); }
  async function perform(action?: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const request = new AbortController(); controller.current = request;
    try {
      if (action) await action(request.signal);
      else {
        const [skills, hooks, loops, teamList] = await Promise.all([
          configurationRequest<{skills: ConfigurationRecord[]}>('skills', '', undefined, request.signal),
          configurationRequest<{hooks: ConfigurationRecord[]}>('hooks', '', undefined, request.signal),
          configurationRequest<{loops: ConfigurationRecord[]}>('loops', '', undefined, request.signal), listTeams(request.signal),
        ]);
        if (request.signal.aborted) return;
        setRecords({skills: skills.skills, hooks: hooks.hooks, loops: loops.loops}); setTeams(teamList.teams); setStale(false);
        setNotice('Saved values refreshed. Inspect them before explicitly retrying any uncertain save; refresh never resends changes.');
      }
    } catch (failure) {
      if (!request.signal.aborted) { setStale(true); setError(`${(failure as Error).message} Disconnected or unavailable. Drafts retained. A mutation may have been saved. Refresh configuration and inspect saved values before explicitly retrying. Nothing is automatically resent.`); }
    } finally { if (controller.current === request) { lock.current = false; if (!request.signal.aborted) setBusy(false); } }
  }
  useEffect(() => { void perform(); return () => { controller.current?.abort(); lock.current = false; }; }, []);
  useEffect(() => {
    if (!busy && focusSelection.current) {
      focusSelection.current = false;
      selector.current?.focus();
    }
  }, [busy]);
  function remember(saved: ConfigurationRecord) {
    setRecords(previous => previous && ({...previous, [kind]: [...previous[kind].filter(item => item.id !== saved.id), saved]}));
    setNotice(`${labels[kind]} saved · ID: ${saved.id}`);
  }
  const targets = draft.target_kind === 'team' ? teams : workspace?.employees ?? [];
  const validation = !draft.name.trim() || [...draft.name.trim()].length > 120 ? 'Enter a name of 1–120 characters.'
    : kind === 'skills' && (!draft.instructions.trim() || [...draft.instructions].length > 16000) ? 'Enter nonblank instructions of at most 16000 characters.'
    : kind === 'hooks' && (!draft.skill_id || !draft.target_id) ? 'Choose an existing Skill and target.'
    : kind === 'loops' && (!draft.task_id || !Number.isInteger(Number(draft.max_iterations)) || Number(draft.max_iterations) < 1 || Number(draft.max_iterations) > 100 || !Number.isInteger(Number(draft.interval_seconds)) || Number(draft.interval_seconds) < 60 || Number(draft.interval_seconds) > 86400) ? 'Choose saved work, 1–100 iterations and an interval of 60–86400 whole seconds.' : '';
  function selectField(field: string, label: string, options: {id: string; name: string}[]) {
    return <label>{label}<select value={draft[field]} disabled={busy} onChange={event => change(field, event.target.value)}>
      <option value="">Choose {label.toLowerCase()}</option>
      {draft[field] && !options.some(item => item.id === draft[field]) && <option value={draft[field]}>Unavailable · ID: {draft[field]}</option>}
      {options.map(item => <option key={item.id} value={item.id}>{item.name} · ID: {item.id}</option>)}
    </select></label>;
  }
  return <>
    <p role="status">{busy ? 'Loading or saving configuration…' : stale ? 'Configuration disconnected: loaded values are stale.' : records ? 'Showing saved configuration.' : 'Configuration unavailable.'}</p>
    {error && <p role="alert">{error}</p>}<p role="status">{notice}</p>
    <button type="button" disabled={busy} onClick={() => void perform()}>Refresh configuration</button>
    <label>Record type<select disabled={busy} value={kind} onChange={event => setKind(event.target.value as ConfigurationKind)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Saved record<select ref={selector} disabled={busy} value={selected} onChange={event => setSelection(previous => ({...previous, [kind]: event.target.value}))}>
      <option value="">Create new {labels[kind]}</option>{records?.[kind].map(item => <option key={item.id} value={item.id}>{item.name} · ID: {item.id}</option>)}
    </select></label>
    {records?.[kind].length === 0 && <p>No saved {kind} yet.</p>}
    {selected && !record && <p>Selected record unavailable · ID: {selected}. Its draft is retained.</p>}
    {record && <><h3>Saved values · ID: {record.id}</h3><pre aria-label="Saved values">{JSON.stringify(record, null, 2)}</pre>
      <p>Configuration {record.enabled ? 'enabled' : 'disabled'}. Runtime execution unavailable.</p>
      <button type="button" disabled={blocked} onClick={() => void perform(async signal => {
        const saved = await configurationRequest<ConfigurationRecord>(kind, `/${encodeURIComponent(record.id)}/enabled`, {enabled: !record.enabled}, signal);
        if (!signal.aborted) remember(saved);
      })}>{record.enabled ? 'Disable configuration' : 'Enable configuration'}</button></>}
    <form onSubmit={event => {
      event.preventDefault(); if (blocked || validation) return;
      const fields = kind === 'loops' ? {...draft, max_iterations: Number(draft.max_iterations), interval_seconds: Number(draft.interval_seconds)} : draft;
      void perform(async signal => {
        const saved = await configurationRequest<ConfigurationRecord>(kind, selected ? `/${encodeURIComponent(selected)}` : '', fields as unknown as ConfigurationFields, signal);
        if (signal.aborted) return;
        remember(saved); setSelection(previous => ({...previous, [kind]: saved.id}));
        setDrafts(previous => { const next = {...previous}; delete next[key]; delete next[`${kind}/${saved.id}`]; return next; });
        focusSelection.current = true;
      });
    }}>
      <label>Name<input disabled={busy} value={draft.name} onChange={event => change('name', event.target.value)} /></label>
      {kind === 'skills' && <label>Instructions<textarea disabled={busy} value={draft.instructions} onChange={event => change('instructions', event.target.value)} /></label>}
      {kind === 'hooks' && <>
        {selectField('skill_id', 'Skill', records?.skills ?? [])}
        <label>Target type<select disabled={busy} value={draft.target_kind} onChange={event => setDrafts(previous => ({...previous, [key]: {...draft, target_kind: event.target.value, target_id: ''}}))}><option value="agent">Employee</option><option value="team">Team</option></select></label>
        {selectField('target_id', 'Target', targets)}
        <label>Event<select disabled={busy} value={draft.event} onChange={event => change('event', event.target.value)}><option value="task_created">Work created</option><option value="run_completed">Run completed</option><option value="run_failed">Run failed</option></select></label>
      </>}
      {kind === 'loops' && <>
        {selectField('task_id', 'Saved work', (workspace?.work ?? []).map(item => ({id: item.id, name: item.input})))}
        <label>Maximum iterations<input disabled={busy} type="number" min="1" max="100" step="1" value={draft.max_iterations} onChange={event => change('max_iterations', event.target.value)} /></label>
        <label>Interval seconds<input disabled={busy} type="number" min="60" max="86400" step="1" value={draft.interval_seconds} onChange={event => change('interval_seconds', event.target.value)} /></label>
      </>}
      <p id="config-validation">{validation || 'Ready to save configuration only.'}</p>
      <button type="submit" aria-describedby="config-validation" disabled={blocked || !!validation}>{selected ? 'Save changes' : `Create ${labels[kind]}`}</button>
    </form>
    <p>Drafts are retained while switching records and refreshing in this session. Reloading discards unsaved drafts. The server validates references and fields when saving.</p>
  </>;
}
