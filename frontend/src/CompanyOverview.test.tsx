import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
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
  expect(screen.getAllByRole('button')).toHaveLength(2);
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
  const fetcher = vi.fn(async (path: string) => {
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
  disconnected = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText(/Disconnected — showing stale/)).toBeTruthy();
  expect(within(overview).getByText('6 assigned requests')).toBeTruthy();
  disconnected = false;
  state = {...state, work: []};
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(within(overview).getByText('Showing recorded workload.')).toBeTruthy();
  expect(within(overview).getAllByText('No assigned work.')).toHaveLength(3);
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep draft');
  expect(fetcher).toHaveBeenCalledTimes(4);
});
