import { classifyWork, type WorkOutcome, type Workspace } from './api';

const categories: {key: WorkOutcome; label: string}[] = [
  {key: 'pending', label: 'Pending'}, {key: 'active', label: 'Active'},
  {key: 'results', label: 'Results · Unverified'}, {key: 'failed', label: 'Failed / interrupted'},
  {key: 'other', label: 'Other recorded work'},
];

export function CompanyOverview({workspace, connected, error, onOpenWork, selectedEmployee = '', onSelectEmployee}: {
  workspace: Workspace | null; connected: boolean; error: string; onOpenWork: (id: string) => void; selectedEmployee?: string; onSelectEmployee?: (id: string) => void;
}) {
  const employees = workspace?.employees ?? [];
  const employeeIds = new Set(employees.map(employee => employee.id));
  const unassigned = workspace?.work.filter(work => !work.assignees.some(id => employeeIds.has(id))) ?? [];
  return <section className="company-overview" aria-labelledby="company-title">
    <h2 id="company-title">Company overview</h2>
    <p role="status">{!workspace
      ? error ? 'Company data unavailable. Refresh connection to try again.' : 'Loading company overview…'
      : connected ? 'Showing recorded workload.' : 'Disconnected — showing stale company data from the last successful refresh.'}</p>
    {workspace && <>
      {workspace.configuration && <p>Execution setup needed: {workspace.configuration} Employees and saved assignments are still shown.</p>}
      <p>Each request counts once per assigned employee. Shared work appears for each employee, so employee counts may exceed the number of requests.</p>
      <p>Active includes caller-reported attempts, which do not imply a provider request. Results are unverified. Other includes blocked, cancelled and other recorded states. Nothing runs automatically.</p>
      {!employees.length && <p>No employees yet. Create an employee below to start assigning work.</p>}
      <ul className="employee-grid" aria-label="Employee workload">
        {employees.map(employee => {
          const assigned = workspace.work.filter(work => work.assignees.includes(employee.id));
          const counts: Record<WorkOutcome, number> = {pending: 0, active: 0, results: 0, failed: 0, other: 0};
          assigned.forEach(work => { counts[classifyWork(work).outcome]++; });
          const callerActive = assigned.filter(work => classifyWork(work).outcome === 'active' && !work.attempts.at(-1)?.provider).length;
          return <li key={employee.id} className="employee-card">
            <h3>{onSelectEmployee ? <button type="button" aria-pressed={selectedEmployee === employee.id} aria-controls="employee-work"
              onClick={() => onSelectEmployee(employee.id)} aria-label={`View assigned work: ${employee.name} · ID: ${employee.id}`}>{employee.name}</button> : employee.name}</h3><p className="employee-id">Employee ID: {employee.id}</p>
            <p>{assigned.length ? `${assigned.length} assigned requests` : 'No assigned work.'}</p>
            <dl className="workload-counts">{categories.map(category => <div key={category.key}>
              <dt>{category.label}</dt><dd>{counts[category.key]}</dd>
            </div>)}</dl>
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
