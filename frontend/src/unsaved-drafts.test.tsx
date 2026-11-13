import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';

const response = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function protectedLeave() {
  const event = new Event('beforeunload', {cancelable: true});
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), {target: {value}});
}
test('independent employee, team, configuration and work drafts protect leaving across hidden panels', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/state') return response({employees: [{id: 'a', name: 'Alex'}], work: [], configuration: null, provider: 'test', model: null});
    if (path === '/api/teams') return response({teams: [{id: 't', name: 'Editors', members: []}, {id: 'u', name: 'Other', members: []}]});
    if (path === '/api/loops/v1') return response({schema_version: 1, control: {state: 'available', can_control: true, message: ''}, sessions: [], attempts: [], cancellation: 'Stop prevents admissions'});
    const kind = path.split('/').pop()!;
    return response({[kind]: kind === 'skills' ? [{id: 's', name: 'Writer', instructions: 'Write', enabled: false}] : []});
  }));
  render(<App />);
  await screen.findByText('Alex', {selector: '#employees li'});
  expect(protectedLeave()).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  await screen.findByText('Team ID: t');
  fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
  await screen.findByText('Showing saved configuration.');
  expect(protectedLeave()).toBe(false);
  change('Saved record', 's');
  expect(protectedLeave()).toBe(false);
  change('Instructions', 'Changed'); expect(protectedLeave()).toBe(true);
  change('Instructions', 'Write'); expect(protectedLeave()).toBe(false);
  change('Employee name', 'New employee');
  change('Team name', 'New team');
  fireEvent.click(screen.getByLabelText('Alex · Employee ID: a'));
  change('Instructions', 'Changed');
  change('Record type', 'hooks');
  change('Event', 'run_failed');
  change('Record type', 'loops');
  change('Maximum iterations', '2');
  change('Saved team', 'u');
  fireEvent.click(screen.getByRole('button', {name: 'Close teams'}));
  fireEvent.click(screen.getByRole('button', {name: 'Close configuration'}));
  expect(screen.getByText(/Unsaved drafts: New team name; Team membership/).hidden).toBe(false);
  expect(screen.getByText(/Unsaved drafts: Skill · s; Hook · new record; Loop · new record/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Discard employee draft'}));
  expect(protectedLeave()).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'Browse teams'}));
  fireEvent.click(screen.getByRole('button', {name: 'Discard team name draft'}));
  change('Saved team', 't');
  fireEvent.click(screen.getByRole('button', {name: 'Discard membership draft'}));
  expect(protectedLeave()).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'Open configuration'}));
  expect((screen.getByLabelText('Maximum iterations') as HTMLInputElement).value).toBe('2');
  for (const kind of ['loops', 'hooks', 'skills']) {
    change('Record type', kind);
    fireEvent.click(screen.getByRole('button', {name: 'Discard configuration draft'}));
  }
  expect(protectedLeave()).toBe(false);
  change('What would you like help with?', 'Work draft');
  expect(protectedLeave()).toBe(true);
  change('Employee name', 'Another');
  change('What would you like help with?', '');
  expect(protectedLeave()).toBe(true);
  change('Employee name', '');
  expect(protectedLeave()).toBe(false);
});
