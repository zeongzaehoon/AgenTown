import { useEffect, useRef, useState } from 'react';
import { addTeamMembers, createTeam, listTeams, type Team, type Workspace } from './api';

export function Teams(props: {workspace: Workspace | null; connected: boolean; onSelectEmployee: (id: string) => void}) {
  const [open, setOpen] = useState(false);
  return <section aria-labelledby="teams-title">
    <h2 id="teams-title">Teams</h2>
    <p>Membership does not assign work or start collaboration. Nothing executes when you create a team, add members or browse their work.</p>
    <button type="button" aria-expanded={open} aria-controls="teams-panel" onClick={() => setOpen(true)}>Browse teams</button>
    <div id="teams-panel">{open && <TeamPanel {...props} />}</div>
  </section>;
}

function TeamPanel({workspace, connected, onSelectEmployee}: {workspace: Workspace | null; connected: boolean; onSelectEmployee: (id: string) => void}) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  // Separate drafts per team: switching or refreshing never discards selections.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const selector = useRef<HTMLSelectElement>(null);
  const team = teams?.find(item => item.id === selected);
  const draft = (drafts[selected] ?? []).filter(id => !team?.members.includes(id));
  const employees = workspace?.employees ?? [];

  async function refresh(signal: AbortSignal) {
    try {
      const result = await listTeams(signal);
      if (signal.aborted) return;
      setTeams(result.teams); setStale(false); setError('');
      setSelected(previous => previous || result.teams[0]?.id || '');
    } catch (failure) {
      if (!signal.aborted) { setStale(true); setError((failure as Error).message); }
    }
  }
  async function perform(action?: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const request = new AbortController(); controller.current = request;
    try {
      if (action) await action(request.signal);
      else await refresh(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) {
        setStale(true);
        setError(`${(failure as Error).message} Refresh teams and inspect membership before explicitly retrying. Your drafts are retained; nothing is automatically resent.`);
      }
    } finally {
      lock.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    setBusy(true);
    void refresh(request.signal).finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => controller.current?.abort();
  }, []);
  const unavailable = !connected || stale || teams === null || busy;
  return <>
    <p role="status">{busy ? 'Loading or saving teams…' : teams === null ? 'Team data unavailable.' : stale || !connected ? 'Showing stale team data. Refresh teams before making changes.' : 'Showing persisted teams.'}</p>
    {error && <p role="alert">{error}</p>}
    <p role="status">{notice}</p>
    <button type="button" disabled={busy} onClick={() => void perform()}>Refresh teams</button>
    <form onSubmit={event => {
      event.preventDefault(); if (unavailable || !name.trim()) return;
      void perform(async signal => {
        const saved = await createTeam(name, signal);
        if (signal.aborted) return;
        setTeams(previous => [...(previous ?? []), saved]); setSelected(saved.id); setName('');
        setNotice(`Team saved · ID: ${saved.id}`); selector.current?.focus();
      });
    }}>
      <label htmlFor="team-name">Team name</label>
      <input id="team-name" disabled={busy} value={name} maxLength={200} required onChange={event => setName(event.target.value)} />
      <button type="submit" disabled={unavailable || !name.trim()}>Create team</button>
    </form>
    {teams?.length === 0 && <p>No teams yet. Create a named team to group existing employees.</p>}
    <label htmlFor="team-select">Saved team</label>
    <select id="team-select" ref={selector} value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a team</option>
      {teams?.map(item => <option key={item.id} value={item.id}>{item.name} · ID: {item.id}</option>)}
    </select>
    {selected && !team && <p>The selected team is unavailable. Choose a saved team. Its draft is retained.</p>}
    {team && <>
      <h3>{team.name}</h3><p>Team ID: {team.id}</p>
      {!team.members.length && <p>No members yet.</p>}
      <ul aria-label="Team members">{team.members.map(id => {
        const employee = employees.find(item => item.id === id);
        return <li key={id}>{employee ? <button type="button" onClick={() => onSelectEmployee(id)}>View member work: {employee.name} · ID: {id}</button> : <p>Unavailable employee · ID: {id}</p>}</li>;
      })}</ul>
      <form onSubmit={event => {
        event.preventDefault(); if (unavailable || !draft.length || draft.length > 100) return;
        const id = team.id;
        void perform(async signal => {
          const saved = await addTeamMembers(id, draft, signal);
          if (signal.aborted) return;
          setTeams(previous => previous?.map(item => item.id === id ? saved : item) ?? [saved]);
          setDrafts(previous => ({...previous, [id]: []}));
          setNotice(`Membership saved · Team ID: ${id}`); selector.current?.focus();
        });
      }}>
        <fieldset disabled={unavailable}><legend>Add existing employees (1–100 per save)</legend>
          {!employees.length && <p>No employees available. Create an employee first.</p>}
          {employees.map(employee => <label key={employee.id}>
            <input type="checkbox" disabled={team.members.includes(employee.id)} checked={team.members.includes(employee.id) || draft.includes(employee.id)} onChange={event => {
              const checked = event.target.checked;
              setDrafts(previous => ({...previous, [team.id]: checked ? [...draft, employee.id] : draft.filter(id => id !== employee.id)}));
            }} />{employee.name} · Employee ID: {employee.id}{team.members.includes(employee.id) ? ' · Already a member' : ''}
          </label>)}
        </fieldset>
        <p>{draft.length} selected to add. Selections are retained when switching teams or refreshing; review them before saving.</p>
        <button type="submit" disabled={unavailable || !draft.length || draft.length > 100}>Add members</button>
      </form>
    </>}
  </>;
}
