import { useEffect, useRef, useState } from 'react';
import { classifyWork, listTeams, type Team, type Workspace, type WorkOutcome } from './api';

/** Membership is a persisted grouping, never an assignment or execution signal. */
export function TeamRooms({workspace, connected, selectedEmployee, onSelectEmployee, onOpenTeam, onOpenWork}: {
  workspace: Workspace | null; connected: boolean; selectedEmployee: string;
  onSelectEmployee?: (id: string) => void; onOpenTeam?: (id: string) => void; onOpenWork?: (id: string) => void;
}) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [membershipFresh, setMembershipFresh] = useState(false);
  const connection = useRef(connected);
  const request = useRef<AbortController | null>(null);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const result = await listTeams(controller.signal);
      if (!controller.signal.aborted) { setTeams(result.teams); setMembershipFresh(connected); }
    } catch (failure) {
      if (!controller.signal.aborted) { setError((failure as Error).message); setMembershipFresh(false); }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  useEffect(() => {
    if (connection.current === connected) return;
    connection.current = connected;
    request.current?.abort();
    setBusy(false);
    setMembershipFresh(false);
  }, [connected]);
  const stale = !membershipFresh || !connected;
  return <section className="team-rooms" aria-labelledby="team-rooms-title">
    <h3 id="team-rooms-title">Team rooms</h3>
    <p>Persistent teams group employees. Membership does not imply collaboration or execution. Member workload comes from recorded employee assignments, not team-owned work. Shared members and requests appear in each relevant room; counts must not be added across rooms.</p>
    <p role="status">{teams !== null && stale ? `Team rooms are stale — showing the last successful snapshot.${busy ? ' Refreshing team rooms…' : ' Refresh team rooms after reconnecting.'}` : !connected ? 'Disconnected — team rooms unavailable. Reconnect and refresh team rooms.' : busy ? 'Loading team rooms…' : teams === null ? 'Team rooms unavailable. Refresh to try again.' : teams.length ? 'Showing persisted team rooms.' : 'No team rooms yet. Create a team in Teams.'}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh team rooms</button>
    <div className="team-room-grid">{teams?.map(team => <section className="team-room" key={team.id} aria-label={`Team room: ${team.name} · ID: ${team.id}`}>
      <h4>{team.name}</h4><p>Team ID: {team.id}</p>
      {(stale || busy) && <p>{stale ? 'Stale team snapshot' : 'Refreshing team snapshot'}</p>}
      <button type="button" disabled={!onOpenTeam} aria-controls="teams-panel" onClick={() => onOpenTeam?.(team.id)}>Manage team: {team.name} · ID: {team.id}</button>
      {!team.members.length && <p>No members yet.</p>}
      <div className="office-floor">{[...new Set(team.members)].map((id, index) => {
        const employee = workspace?.employees.find(item => item.id === id);
        if (!workspace) return <p key={id}>Employee data unavailable · ID: {id}</p>;
        if (!employee) return <p key={id}>Unavailable employee · ID: {id}</p>;
        const assigned = workspace.work.filter(work => work.assignees.includes(id));
        const counts: Record<WorkOutcome, number> = {pending: 0, active: 0, results: 0, failed: 0, other: 0};
        assigned.forEach(work => { counts[classifyWork(work).outcome]++; });
        return <div className="office-desk" key={id}>
          <button type="button" className="office-character" disabled={!onSelectEmployee} aria-controls="employee-work"
            aria-pressed={selectedEmployee === id} aria-label={`Select team member: ${employee.name} · ID: ${id} · Team ID: ${team.id}`} onClick={() => onSelectEmployee?.(id)}>
            <span className={`character-body character-style-${index % 4}`} aria-hidden="true"><span className="character-head" /><span className="character-shirt" /></span>
            <strong>{employee.name}</strong><span>Employee ID: {id}</span>
          </button>
          <p>{!connected && 'Stale employee assignments · '}Member workload: {assigned.length} assigned requests · {counts.pending} pending · {counts.active} active · {counts.results} results (unverified) · {counts.failed} failed / interrupted · {counts.other} other recorded work.</p>
          <p>Active may include caller-reported attempts without a provider request. Other includes blocked and cancelled work.</p>
        </div>;
      })}</div>
      <h5>Saved member assignments</h5>
      <p>Cards are assigned to this room’s members, not owned by the team. Shared assignments appear in every relevant room. Opening a card only inspects saved work.</p>
      {!workspace ? <p>Member assignments unavailable — company data has not loaded.</p> : (() => {
        const members = new Set(team.members);
        const assigned = [...new Map(workspace.work.filter(work => work.assignees.some(id => members.has(id))).map(work => [work.id, work])).values()];
        return <>
          {!connected && <p>Stale member assignments — showing the last successful company snapshot.</p>}
          {!assigned.length ? <p>No saved work assigned to this room’s members.</p> : <ul className="room-work-cards" aria-label={`Member assignments · Team ID: ${team.id}`}>
            {assigned.map(work => <li key={work.id}>
              <button type="button" disabled={!onOpenWork} aria-controls="employee-work"
                aria-label={`Open member assignment: ${work.input.slice(0, 55)} · Task ID: ${work.id} · Team ID: ${team.id}`}
                onClick={() => onOpenWork?.(work.id)}>{work.input.slice(0, 120)} · Task ID: {work.id}</button>
              <p>Recorded status: {classifyWork(work).label}</p>
              <p>Assigned members in this room: {[...new Set(work.assignees)].filter(id => members.has(id)).map(id => `${workspace.employees.find(employee => employee.id === id)?.name ?? 'Unavailable employee'} · ID: ${id}`).join('; ')}</p>
            </li>)}
          </ul>}
        </>;
      })()}
    </section>)}</div>
  </section>;
}
