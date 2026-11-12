import { HookDevices } from './HookDevices';
import { workstationClients, type ConnectionClientId } from './Connections';
import { TeamRooms } from './TeamRooms';
import { SkillBooks } from './SkillBooks';
import { OverviewLoops } from './OverviewLoops';
import { classifyWork, type WorkOutcome, type Workspace } from './api';

const categories: {key: WorkOutcome; label: string}[] = [
  {key: 'pending', label: 'Pending'}, {key: 'active', label: 'Active'},
  {key: 'results', label: 'Results · Unverified'}, {key: 'failed', label: 'Failed / interrupted'},
  {key: 'other', label: 'Other recorded work'},
];

export function CompanyOverview({workspace, connected, error, onOpenWork, selectedEmployee = '', onSelectEmployee, onOpenHook, onOpenSkill, onOpenClient, onOpenTeam, onSelectTeamMember}: {
  onSelectTeamMember?: (id: string) => void;
  onOpenTeam?: (id: string) => void;
  onOpenClient?: (id: ConnectionClientId) => void;
  onOpenHook?: (id: string) => void;
  onOpenSkill?: (id: string) => void; workspace: Workspace | null; connected: boolean; error: string; onOpenWork: (id: string) => void; selectedEmployee?: string; onSelectEmployee?: (id: string) => void;
}) {
  const employees = workspace?.employees ?? [];
  // Both presentations use the same persisted identities and latest-attempt classification.
  const desks = employees.map(employee => {
    const assigned = workspace!.work.filter(work => work.assignees.includes(employee.id));
    const counts: Record<WorkOutcome, number> = {pending: 0, active: 0, results: 0, failed: 0, other: 0};
    assigned.forEach(work => { counts[classifyWork(work).outcome]++; });
    const callerActive = assigned.filter(work => classifyWork(work).outcome === 'active' && !work.attempts.at(-1)?.provider).length;
    const blocked = assigned.filter(work => classifyWork(work).outcome === 'other' && work.status === 'blocked').length;
    const activity = assigned.length
      ? `${counts.pending} pending · ${counts.active} active · ${counts.failed} failed / interrupted · ${blocked} blocked · ${counts.results} results (unverified) · ${counts.other} other recorded work`
      : 'No assigned work.';
    return {employee, assigned, counts, callerActive, blocked, activity};
  });
  const employeeIds = new Set(employees.map(employee => employee.id));
  const unassigned = workspace?.work.filter(work => !work.assignees.some(id => employeeIds.has(id))) ?? [];
  return <section className="company-overview" aria-labelledby="company-title">
    <h2 id="company-title">Company overview</h2>
    <p role="status">{!workspace
      ? error ? 'Company data unavailable. Refresh connection to try again.' : 'Loading company overview…'
      : connected ? 'Showing recorded workload.' : 'Disconnected — showing stale company data from the last successful refresh.'}</p>
    <section aria-labelledby="workstations-title">
      <h3 id="workstations-title">Client workstations</h3>
      <p>Choose a workstation to open Connections setup and inspect detected, configured, connected and exercised evidence. These desks do not indicate an active client or provider execution.</p>
      <div className="office-floor">{workstationClients.map(client => <button type="button" className="office-desk client-workstation" key={client.id}
        aria-label={`Open ${client.name} workstation setup`} aria-controls="connections-content" disabled={!onOpenClient}
        onClick={() => onOpenClient?.(client.id)}>
        <span className="workstation-monitor" aria-hidden="true">▣</span><strong>{client.name}</strong><span>Open client setup</span>
      </button>)}</div>
    </section>
    <TeamRooms onOpenWork={onOpenWork} workspace={workspace} connected={connected} selectedEmployee={selectedEmployee} onSelectEmployee={onSelectTeamMember ?? onSelectEmployee} onOpenTeam={onOpenTeam} />
    <SkillBooks onOpenSkill={onOpenSkill} />
    <HookDevices onOpenHook={onOpenHook} />
    <OverviewLoops workspace={workspace} onOpenWork={onOpenWork} />
    {workspace && <>
      {workspace.configuration && <p>Execution setup needed: {workspace.configuration} Employees and saved assignments are still shown.</p>}
      <p>Each request counts once per assigned employee. Shared work appears for each employee, so employee counts may exceed the number of requests.</p>
      <p>Active includes caller-reported attempts, which do not imply a provider request. Results are unverified. Other includes blocked, cancelled and other recorded states. Nothing runs automatically.</p>
      {!employees.length && <p>No employees yet. Create an employee below to start assigning work.</p>}
      <section className="company-office" aria-labelledby="office-title">
        <h3 id="office-title">Employee office</h3>
        <p>Choose a character to view assigned work. Desks show recorded assignments, not live presence.</p>
        {!employees.length && <p>The office is empty.</p>}
        <div className="office-floor">
          {desks.map(({employee, activity, callerActive, blocked}, index) => <div className="office-desk" key={employee.id}>
            <button type="button" className="office-character" disabled={!onSelectEmployee}
              aria-label={`Select office character: ${employee.name} · ID: ${employee.id}`}
              aria-pressed={selectedEmployee === employee.id} aria-controls="employee-work"
              onClick={() => onSelectEmployee?.(employee.id)}>
              <span className={`character-body character-style-${index % 4}`} aria-hidden="true"><span className="character-head" /><span className="character-shirt" /></span>
              <strong>{employee.name}</strong><span>ID: {employee.id}</span>
              {selectedEmployee === employee.id && <span>Selected</span>}
            </button>
            <p>{!connected && 'Stale snapshot · '}{activity}</p>
            {!!blocked && <p>{blocked} blocked requests</p>}
            {!!callerActive && <p>{callerActive} caller-reported active · no provider request</p>}
          </div>)}
        </div>
      </section>
      <h3>Employee workload list</h3>
      <ul className="employee-grid" aria-label="Employee workload">
        {desks.map(({employee, assigned, counts, callerActive, blocked}) => {
          return <li key={employee.id} className="employee-card">
            <h3>{onSelectEmployee ? <button type="button" aria-pressed={selectedEmployee === employee.id} aria-controls="employee-work"
              onClick={() => onSelectEmployee(employee.id)} aria-label={`View assigned work: ${employee.name} · ID: ${employee.id}`}>{employee.name}</button> : employee.name}</h3><p className="employee-id">Employee ID: {employee.id}</p>
            <p>{assigned.length ? `${assigned.length} assigned requests` : 'No assigned work.'}</p>
            <dl className="workload-counts">{categories.map(category => <div key={category.key}>
              <dt>{category.label}</dt><dd>{counts[category.key]}</dd>
            </div>)}</dl>
            {!!blocked && <p>{blocked} blocked requests</p>}
            {!!callerActive && <p>{callerActive} caller-reported active · no provider request</p>}
          </li>;
        })}
      </ul>
      <h3>Work without a current employee</h3>
      <p>{unassigned.length} requests with no assignment to a current employee. Includes unassigned work and assignments to unavailable employees.</p>
      {!!unassigned.length && <ul>{unassigned.map(work => <li key={work.id}>
        <button type="button" onClick={() => onOpenWork(work.id)}>Open work: {work.input.slice(0, 55)} · ID: {work.id}</button>
        <p>{classifyWork(work).label}</p>
      </li>)}</ul>}
    </>}
  </section>;
}
