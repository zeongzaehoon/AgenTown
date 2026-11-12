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

test('App uses existing polling, retains stale counts and drafts, reconnects and opens unassigned history', async () => {
  vi.useFakeTimers();
  let state = workspace();
  let disconnected = false;
  let loopUnavailable = false;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/teams') return new Response('{"teams":[]}');
    if (path === '/api/config/v1/loops') return new Response('{"loops":[]}');
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
  expect(within(overview).getByText('6 assigned requests')).toBeTruthy();
  disconnected = false; loopUnavailable = false;
  state = {...state, work: []};
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText('Showing recorded workload.')).toBeTruthy();
  expect(within(within(overview).getByRole('list', {name: 'Employee workload'})).getAllByText('No assigned work.')).toHaveLength(3);
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep draft');
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
