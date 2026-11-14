import { SkillBooks } from './SkillBooks';
import { HookDevices } from './HookDevices';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { CompanyOverview } from './CompanyOverview';
import { App } from './App';
import type { Work, Workspace } from './api';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const request = (id: string, extra: Partial<Work> = {}): Work => ({id, input: id, status: 'pending', assignees: ['a'], attempts: [], ...extra});
const workspace = (): Workspace => ({employees: [{id: 'a', name: 'Alex'}, {id: 'b', name: 'Alex'}, {id: 'c', name: 'Idle'}], configuration: 'Choose a model.', provider: 'anthropic', model: null, work: [
  request('shared', {assignees: ['a', 'a', 'b']}),
  request('caller', {attempts: [{id: 'r1', state: 'active', outcome: null, participants: ['a']}]}),
  request('result', {attempts: [{id: 'r2', state: 'finished', outcome: 'reported_success', output: '', participants: ['a']}]}),
  request('failed', {attempts: [{id: 'r3', state: 'finished', outcome: 'failure', error: 'timeout', participants: ['a']}]}),
  request('blocked', {status: 'blocked'}), request('unassigned', {assignees: []}),
  request('missing-employee', {assignees: ['deleted']}),
]});
function count(card: HTMLElement, label: string) {
  return within(card).getByText(label).nextElementSibling?.textContent;
}
test('mixed recorded categories count by ID, deduplicate assignments and retain semantics', () => {
  const open = vi.fn();
  render(<CompanyOverview workspace={workspace()} connected error="" onOpenWork={open} />);
  const cards = within(screen.getByRole('list', {name: 'Employee workload'})).getAllByRole('listitem');
  expect(cards).toHaveLength(3);
  expect(cards[0].textContent).toContain('Employee ID: a');
  expect(cards[1].textContent).toContain('Employee ID: b');
  expect(count(cards[0], 'Pending')).toBe('1');
  expect(count(cards[0], 'Active')).toBe('1');
  expect(count(cards[0], 'Results · Unverified')).toBe('1');
  expect(count(cards[0], 'Failed / interrupted')).toBe('1');
  expect(count(cards[0], 'Other recorded work')).toBe('1');
  expect(count(cards[1], 'Pending')).toBe('1');
  expect(cards[0].textContent).toContain('5 assigned requests');
  expect(cards[0].textContent).toContain('1 caller-reported active · no provider request');
  expect(cards[2].textContent).toContain('No assigned work.');
  expect(screen.getByText(/Execution setup needed/)).toBeTruthy();
  expect(screen.getByText(/Shared work appears for each employee/)).toBeTruthy();
  expect(screen.getAllByRole('button', {name: /^Open work:/})).toHaveLength(2);
  expect(screen.getByRole('button', {name: 'Inspect Loop sessions again'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: /Open work: unassigned/}));
  expect(open).toHaveBeenCalledWith('unassigned');
});

test('loading, unavailable, empty and stale snapshots are distinct', () => {
  const props = {connected: false, error: '', onOpenWork: vi.fn()};
  const view = render(<CompanyOverview {...props} workspace={null} />);
  expect(screen.getByText('Loading company overview…')).toBeTruthy();
  expect(screen.queryByText('No assigned work.')).toBeNull();
  view.rerender(<CompanyOverview {...props} error="Disconnected" workspace={null} />);
  expect(screen.getByText(/Company data unavailable/)).toBeTruthy();
  view.rerender(<CompanyOverview {...props} workspace={{...workspace(), employees: [], work: []}} connected />);
  expect(screen.getByText(/No employees yet/)).toBeTruthy();
  view.rerender(<CompanyOverview {...props} workspace={workspace()} />);
  expect(screen.getByText(/Disconnected — showing stale company data/)).toBeTruthy();
  expect(screen.getByText('Employee ID: a')).toBeTruthy();
});

test.each([true, false])('App retains Loop freshness through polling recovery and preserves drafts (populated: %s)', async populated => {
  vi.useFakeTimers();
  let state = workspace();
  let disconnected = false;
  let loopUnavailable = false;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/config/v1/loops') return new Response(JSON.stringify({loops: populated ? [{id: 'policy', name: 'Saved policy', task_id: 'unassigned', max_iterations: 2, interval_seconds: 60, enabled: true}] : []}));
    if (path === '/api/loops/v1' && loopUnavailable) throw new Error('Loop inspection offline');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/skills') {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({skills: []}));
    }
    expect(path).toBe('/api/state');
    if (disconnected) throw new TypeError('network');
    return new Response(JSON.stringify(state));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await act(async () => {});
  const overview = screen.getByRole('region', {name: 'Company overview'});
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep draft'}});
  fireEvent.change(screen.getByLabelText('Search saved work'), {target: {value: 'no match'}});
  fireEvent.click(within(overview).getByRole('button', {name: /Open work: unassigned/}));
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('unassigned');
  expect(document.activeElement).toBe(screen.getByLabelText('Saved work'));
  state = {...state, work: [...state.work, request('new')]};
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText('6 assigned requests')).toBeTruthy();
  loopUnavailable = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText('Showing recorded workload.')).toBeTruthy();
  expect(within(overview).getByText(/Loop inspection unavailable — showing stale/)).toBeTruthy();
  expect((screen.getByLabelText('Search saved work') as HTMLInputElement).value).toBe('');
  disconnected = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText(/Disconnected — showing stale/)).toBeTruthy();
  const devices = within(overview).getByRole('heading', {name: 'Saved Loop policy devices'}).parentElement!;
  expect(within(devices).getByRole('status').textContent).toContain('Disconnected');
  if (populated) expect(within(devices).getByText('Disconnected — potentially stale configuration snapshot')).toBeTruthy();
  else expect(within(devices).getByRole('status').textContent).toContain('current Loops are unknown');
  expect(within(overview).getByText('6 assigned requests')).toBeTruthy();
  disconnected = false; loopUnavailable = false;
  state = {...state, work: []};
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText('Showing recorded workload.')).toBeTruthy();
  expect(within(within(overview).getByRole('list', {name: 'Employee workload'})).getAllByText('No assigned work.')).toHaveLength(3);
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep draft');
  expect(within(devices).getByRole('status').textContent).toContain('may still be stale');
  // Other panels poll the same endpoint; device freshness is independently retained.
  expect(within(devices).getByRole('status').textContent).not.toContain('Loading');
  if (populated) {
    const card = within(devices).getByRole('button', {name: 'Open Loop device: Saved policy · ID: policy'});
    fireEvent.click(card);
    await act(async () => {});
    expect((screen.getByLabelText('Saved record') as HTMLSelectElement).value).toBe('policy');
    expect(document.activeElement).toBe(screen.getByLabelText('Saved record'));
  }
  fireEvent.click(within(devices).getByRole('button', {name: 'Refresh Loop devices'}));
  await act(async () => {});
  expect(within(devices).getByRole('status').textContent).toBe(populated ? 'Showing saved Loop devices.' : 'No saved Loops yet. Create a Loop in Configuration.');
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep draft');
  expect(screen.queryByRole('checkbox', {name: /I authorize/})).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/state')).toHaveLength(5);
  expect(fetcher.mock.calls.every(([path]) => path === '/api/state' || path === '/api/teams' || (path === '/api/config/v1/skills' || path === '/api/config/v1/hooks' || path === '/api/config/v1/loops' || path === '/api/loops/v1'))).toBe(true);
});


test('office characters and list share selection by identity with keyboard and stale polling', async () => {
  const user = userEvent.setup();
  function Office({data, connected = true}: {data: Workspace; connected?: boolean}) {
    const [selected, select] = useState('');
    return <CompanyOverview workspace={data} connected={connected} error="" onOpenWork={vi.fn()} selectedEmployee={selected} onSelectEmployee={select} />;
  }
  const view = render(<Office data={workspace()} />);
  const character = screen.getByRole('button', {name: 'Select office character: Alex · ID: b'});
  character.focus(); await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(character);
  expect(character.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', {name: 'View assigned work: Alex · ID: b'}).getAttribute('aria-pressed')).toBe('true');
  const list = screen.getByRole('button', {name: 'View assigned work: Alex · ID: a'});
  list.focus(); await user.keyboard(' ');
  expect(screen.getByRole('button', {name: 'Select office character: Alex · ID: a'}).getAttribute('aria-pressed')).toBe('true');
  expect(character.getAttribute('aria-pressed')).toBe('false');
  view.rerender(<Office data={{...workspace(), work: []}} connected={false} />);
  expect(screen.getByRole('button', {name: 'Select office character: Alex · ID: a'}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getAllByText('Stale snapshot · No assigned work.')).toHaveLength(3);
  expect(document.activeElement).toBe(list);
});

test('team room cards forward the exact saved Task identity through overview navigation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/teams') return new Response(JSON.stringify({teams: [{id: 'team', name: 'Editors', members: ['a', 'b']}]}));
    if (path === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (path === '/api/config/v1/skills') return new Response('{"skills":[]}');
    if (path === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":""}');
    throw new Error(`Unexpected request ${path}`);
  }));
  const open = vi.fn(); const user = userEvent.setup();
  render(<CompanyOverview workspace={workspace()} connected error="" onOpenWork={open} />);
  const card = await screen.findByRole('button', {name: 'Open member assignment: shared · Task ID: shared · Team ID: team'});
  card.focus(); await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledExactlyOnceWith('shared');
});


test.each(['skills', 'hooks'])('configuration sections recover independently when %s refresh fails', async failed => {
  const records = {skills: [{id: 's', name: 'Guide', instructions: 'Saved', enabled: true}],
    hooks: [{id: 'h', name: 'Follow up', skill_id: 's', target_kind: 'agent', target_id: 'a', event: 'run_completed', enabled: true}]};
  let failing = false;
  const fetcher = vi.fn(async (path: string) => {
    const kind = path.endsWith('/skills') ? 'skills' : 'hooks';
    if (failing && kind === failed) throw new Error(`${kind} refresh failed`);
    return new Response(JSON.stringify({[kind]: records[kind]}));
  });
  vi.stubGlobal('fetch', fetcher);
  const sections = (connected: boolean) => <><SkillBooks connected={connected} /><HookDevices connected={connected} /></>;
  const view = render(sections(true));
  await screen.findByText('Showing saved Skill books.');
  await screen.findByText('Showing saved Hook devices.');
  view.rerender(sections(false));
  expect(screen.getAllByText('Disconnected — potentially stale configuration snapshot')).toHaveLength(2);
  view.rerender(sections(true));
  expect(fetcher).toHaveBeenCalledTimes(2);
  failing = true;
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Skill books'}));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh Hook devices'}));
  expect((await screen.findByRole('alert')).textContent).toBe(`${failed} refresh failed`);
  const successful = failed === 'skills' ? 'Hook devices' : 'Skill books';
  await screen.findByText(`Showing saved ${successful}.`);
  expect(screen.getAllByText('Potentially stale configuration snapshot — refresh to check')).toHaveLength(1);
  view.rerender(sections(false));
  view.rerender(sections(true));
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(screen.getByRole('alert').textContent).toBe(`${failed} refresh failed`);
});

test.each(['Select office character', 'View assigned work'])('%s removal recovers by ID, including the last employee', async presentation => {
  const user = userEvent.setup();
  const props = {connected: true, error: '', onOpenWork: vi.fn(), onSelectEmployee: vi.fn()};
  const view = render(<CompanyOverview {...props} workspace={workspace()} />);
  const control = screen.getByRole('button', {name: `${presentation}: Alex · ID: b`});
  control.focus();
  // Removing a namesake must not replace the surviving keyed control.
  const renamed = {...workspace(), employees: [{id: 'c', name: 'Idle'}, {id: 'b', name: 'Renamed'}]};
  view.rerender(<CompanyOverview {...props} workspace={renamed} />);
  expect(document.activeElement).toBe(control);
  expect(screen.getByRole('button', {name: `${presentation}: Renamed · ID: b`})).toBe(control);
  expect(screen.queryByText(/was removed from this view/)).toBeNull();
  view.rerender(<CompanyOverview {...props} workspace={{...renamed, employees: [{id: 'c', name: 'Idle'}]}} />);
  const heading = screen.getByRole('heading', {name: 'Company overview'});
  expect(document.activeElement).toBe(heading);
  const announcement = screen.getByText(/Employee Renamed · ID: b was removed/);
  expect(announcement.getAttribute('aria-live')).toBe('polite');
  await user.tab();
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).not.toBe(heading);
  screen.getByRole('button', {name: `${presentation}: Idle · ID: c`}).focus();
  view.rerender(<CompanyOverview {...props} workspace={{...renamed, employees: []}} />);
  expect(document.activeElement).toBe(heading);
  expect(screen.getByText(/No employees remain/)).toBeTruthy();
  await user.tab();
  expect(document.activeElement).not.toBe(document.body);
});

test.each(['Select office character', 'View assigned work'])('%s removal leaves outside focus alone', presentation => {
  const props = {connected: true, error: '', onOpenWork: vi.fn(), onSelectEmployee: vi.fn()};
  const content = (data: Workspace) => <><input aria-label="Outside draft" /><CompanyOverview {...props} workspace={data} /></>;
  const view = render(content(workspace()));
  screen.getByRole('button', {name: `${presentation}: Alex · ID: a`}).focus();
  const outside = screen.getByLabelText('Outside draft'); outside.focus();
  view.rerender(content({...workspace(), employees: []}));
  expect(document.activeElement).toBe(outside);
  expect(screen.queryByText(/was removed from this view/)).toBeNull();
});

test('failed-work action remains available for an empty stale workload and forwards employee identity', async () => {
  const openFailed = vi.fn();
  const user = userEvent.setup();
  render(<CompanyOverview workspace={{...workspace(), work: []}} connected={false} error="Disconnected"
    onOpenWork={vi.fn()} onOpenFailedWork={openFailed} />);
  const action = screen.getByRole('button', {name: 'View failed or interrupted work: Alex · ID: b'});
  expect(action.textContent).toBe('View failed or interrupted work (0)');
  expect(action.getAttribute('aria-controls')).toBe('employee-work');
  expect((action as HTMLButtonElement).disabled).toBe(false);
  action.focus(); await user.keyboard('{Enter}');
  expect(openFailed).toHaveBeenCalledExactlyOnceWith('b');
  expect(screen.getByText(/Disconnected — showing stale company data/)).toBeTruthy();
});


test.each([
  ['pending', 'View pending work'], ['active', 'View active work'], ['results', 'View unverified results'],
  ['other', 'Other recorded work'],
] as const)('%s action forwards typed identity and remains browsable with zero stale matches', async (outcome, label) => {
  const open = vi.fn();
  const user = userEvent.setup();
  const props = {connected: false, error: 'Disconnected', onOpenWork: vi.fn(), onOpenEmployeeOutcome: open};
  const view = render(<CompanyOverview {...props} workspace={workspace()} />);
  const action = () => screen.getByRole('button', {name: `${label}: Alex · ID: a`});
  expect(action().textContent).toBe(`${label} (1)`);
  action().focus(); await user.keyboard('{Enter}');
  expect(open).toHaveBeenLastCalledWith({employeeId: 'a', outcome});
  view.rerender(<CompanyOverview {...props} workspace={{...workspace(), work: []}} />);
  expect(action().textContent).toBe(`${label} (0)`);
  expect((action() as HTMLButtonElement).disabled).toBe(false);
  action().focus(); await user.keyboard(' ');
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenLastCalledWith({employeeId: 'a', outcome});
  expect(screen.getByText(/Disconnected — showing stale company data/)).toBeTruthy();
});


test.each(['{Enter}', ' '])('Give work forwards employee ID by keyboard (%s)', async key => {
  const give = vi.fn(); const select = vi.fn(); const open = vi.fn();
  const props = {workspace: workspace(), connected: true, error: '', onOpenWork: open, onSelectEmployee: select, onGiveWork: give};
  const view = render(<CompanyOverview {...props} />);
  const user = userEvent.setup();
  const control = screen.getByRole('button', {name: 'Give work: Alex · ID: b'});
  control.focus(); await user.keyboard(key);
  expect(give.mock.calls).toEqual([['b']]);
  expect(select).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  view.rerender(<CompanyOverview {...props} connected={false} />);
  expect((control as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(control); expect(give).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Giving work is unavailable while disconnected/)).toBeTruthy();
  view.rerender(<CompanyOverview {...props} workspace={{...workspace(), employees: []}} />);
  expect(screen.queryByRole('button', {name: /^Give work:/})).toBeNull();
});
