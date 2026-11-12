import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { Attempt, Workspace } from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const attempt = (fields: Partial<Attempt>): Attempt => ({id: 'run', state: 'finished', outcome: null, participants: ['e'], ...fields});
const savedInput = '  저장된 요청 🌍\nsecond line\t  ';
const output = ' Résultat 한글 👩🏽‍💻\n  exact output\t';
function setup() {
  const state: Workspace = {
    employees: [{id: 'e', name: '작가 Éva'}, {id: 'other', name: 'Editor'}],
    provider: 'deterministic-test', model: 'fixture', configuration: null,
    work: [
      {id: 'work/한글', input: savedInput, status: 'pending', assignees: ['e', 'missing'], attempts: [
        attempt({id: 'first', provider: 'anthropic', model: 'saved-model', started: 0, ended: 1000, output, outcome: 'reported_success'}),
        attempt({id: 'second', provider: 'deterministic-test', model: 'fixture', output: ''}),
        attempt({id: 'third', provider: 'anthropic', error: 'network', outcome: 'failure'}),
        attempt({id: 'fourth', outcome: 'interruption', error: 'interrupted', ended: 2000}),
        attempt({id: 'fifth', state: 'active'}),
      ]},
      {id: 'pending', input: 'Pending saved request', status: 'pending', assignees: [], attempts: []},
    ],
  };
  let disconnected = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/teams') return new Response('{"teams":[]}');
    if (url === '/api/config/v1/loops') return new Response('{"loops":[]}');
    if (url === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
    if (url === '/api/config/v1/hooks') return new Response('{"hooks":[]}');
    if (url === '/api/config/v1/skills') return new Response('{"skills":[]}');
    if (disconnected) throw new TypeError('network');
    return new Response(JSON.stringify(state));
  });
  vi.stubGlobal('fetch', fetcher);
  const blobs: Blob[] = [];
  const create = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:history'; });
  // Keep URL parsing available to Response/fetch while replacing download APIs.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = create;
    static revokeObjectURL = vi.fn();
  });
  const filenames: string[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
  render(<App />);
  return {state, fetcher, blobs, filenames, create, click, disconnect: () => { disconnected = true; }};
}
async function selectSaved(id = 'work/한글') {
  // Parallel product checks can delay the initial history render beyond 1s.
  await screen.findByRole('button', {name: 'Download saved history'}, {timeout: 5_000});
  fireEvent.change(screen.getByLabelText('Saved work'), {target: {value: id}});
}
const download = () => screen.getByRole('button', {name: 'Download saved history'});

test('switching saved work keeps one history export and one Skill panel', async () => {
  const f = setup();
  await selectSaved();
  for (const id of ['pending', 'work/한글', 'pending']) {
    fireEvent.change(screen.getByLabelText('Saved work'), {target: {value: id}});
    expect(screen.getAllByRole('button', {name: 'Download saved history'})).toHaveLength(1);
    expect(screen.getAllByRole('region', {name: 'Apply a Skill'})).toHaveLength(1);
  }
  fireEvent.click(download());
  expect(await f.blobs[0].text()).toContain('Work ID: pending');
});

test('keyboard download contains complete Unicode loaded history while disconnected, preserving drafts and selection', async () => {
  const user = userEvent.setup();
  const f = setup();
  await selectSaved();
  const before = JSON.stringify(f.state);
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'UNSAVED unrelated draft'}});
  fireEvent.change(screen.getByLabelText('Assign to'), {target: {value: 'other'}});
  f.disconnect();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh connection'}));
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
  const calls = f.fetcher.mock.calls.filter(([url]) => url !== '/api/state' && url !== '/api/config/v1/skills' && url !== '/api/config/v1/hooks' && url !== '/api/config/v1/loops' && url !== '/api/loops/v1').length;
  download().focus();
  await user.keyboard('{Enter}');
  expect(f.fetcher.mock.calls.filter(([url]) => url !== '/api/state' && url !== '/api/config/v1/skills' && url !== '/api/config/v1/hooks' && url !== '/api/config/v1/loops' && url !== '/api/loops/v1').length).toBe(calls);
  expect(document.activeElement).toBe(download());
  const feedback = screen.getByText('History download requested. Check your browser’s downloads.');
  expect(feedback.getAttribute('role')).toBe('status');
  expect(feedback.getAttribute('aria-live')).toBe('polite');
  expect(f.blobs[0].type).toBe('text/plain;charset=utf-8');
  const text = await f.blobs[0].text();
  for (const part of ['Work ID: work/한글', '작가 Éva (ID: e)', 'Name unavailable (ID: missing)',
    `--- BEGIN SAVED INPUT ---\n${savedInput}\n--- END SAVED INPUT ---`,
    `--- BEGIN OUTPUT ---\n${output}\n--- END OUTPUT ---`,
    'Loaded attempts: 5', 'Provider: anthropic', 'Model: saved-model',
    'Recorded start: 1970-01-01T00:00:00.000Z', 'Recorded end: 1970-01-01T00:00:01.000Z',
    'Output: Empty text · Unverified\n--- BEGIN OUTPUT ---\n\n--- END OUTPUT ---',
    'Failure: network', 'Outcome: failure', 'Output: Not recorded', 'Recorded start: Time unavailable',
    'Interruption recorded: 1970-01-01T00:00:02.000Z', 'not the precise process-stop time',
    'Test response — not live validation', 'Caller-reported attempt — no provider request',
    'No recorded end — attempt is active.', 'Disconnected — history may be stale']) expect(text).toContain(part);
  const ids = [...text.matchAll(/Attempt ID: (.+)/g)].map(match => match[1]);
  expect(ids).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
  expect(text).not.toContain('UNSAVED');
  expect(text).not.toContain('Pending saved request');
  expect(f.filenames).toEqual(['agentown-work-work___-history.txt']);
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('UNSAVED unrelated draft');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('work/한글');
  expect(JSON.stringify(f.state)).toBe(before);
  // Existing per-result download still exports only that result.
  fireEvent.click(screen.getAllByRole('button', {name: 'Download text', hidden: true}).at(-1)!);
  expect(await f.blobs[1].text()).toBe(output);
});

test('pending work exports saved input and explicitly has no loaded attempts', async () => {
  const f = setup();
  await selectSaved('pending');
  const calls = f.fetcher.mock.calls.filter(([url]) => url !== '/api/state' && url !== '/api/config/v1/skills' && url !== '/api/config/v1/hooks' && url !== '/api/config/v1/loops' && url !== '/api/loops/v1').length;
  fireEvent.click(download());
  const text = await f.blobs[0].text();
  expect(text).toContain('Work ID: pending');
  expect(text).toContain('Saved status: pending');
  expect(text).toContain('Pending saved request');
  expect(text).toContain('No employee assigned');
  expect(text).toContain('Loaded attempts: 0');
  expect(text).toContain('No loaded attempts. No execution is implied.');
  expect(text).not.toContain('Attempt ID:');
  expect(f.fetcher.mock.calls.filter(([url]) => url !== '/api/state' && url !== '/api/config/v1/skills' && url !== '/api/config/v1/hooks' && url !== '/api/config/v1/loops' && url !== '/api/loops/v1').length).toBe(calls);
});

test.each(['object URL', 'anchor click'])('download failure at %s gives accessible feedback and can be retried', async boundary => {
  const f = setup();
  await selectSaved();
  fireEvent.change(screen.getByLabelText('What would you like help with?'), {target: {value: 'Keep this unsaved draft 한글'}});
  fireEvent.change(screen.getByLabelText('Assign to'), {target: {value: 'other'}});
  const before = JSON.stringify(f.state);
  const calls = f.fetcher.mock.calls.filter(([url]) => url !== '/api/state' && url !== '/api/config/v1/skills' && url !== '/api/config/v1/hooks' && url !== '/api/config/v1/loops' && url !== '/api/loops/v1').length;
  if (boundary === 'object URL') f.create.mockImplementationOnce(() => { throw new Error('unavailable'); });
  else f.click.mockImplementationOnce(() => { throw new Error('denied'); });
  download().focus();
  fireEvent.click(download());
  const feedback = screen.getByText(/Could not start the history download/);
  expect(feedback.getAttribute('role')).toBe('status');
  expect(feedback.textContent).toContain('Try again');
  expect(document.activeElement).toBe(download());
  expect((screen.getByLabelText('What would you like help with?') as HTMLTextAreaElement).value).toBe('Keep this unsaved draft 한글');
  expect((screen.getByLabelText('Assign to') as HTMLSelectElement).value).toBe('other');
  expect((screen.getByLabelText('Saved work') as HTMLSelectElement).value).toBe('work/한글');
  fireEvent.click(download());
  expect(screen.getByText(/History download requested/).getAttribute('aria-live')).toBe('polite');
  expect(f.fetcher.mock.calls.filter(([url]) => url !== '/api/state' && url !== '/api/config/v1/skills' && url !== '/api/config/v1/hooks' && url !== '/api/config/v1/loops' && url !== '/api/loops/v1').length).toBe(calls);
  expect(JSON.stringify(f.state)).toBe(before);
  const text = await f.blobs.at(-1)!.text();
  expect(text).toContain(savedInput);
  expect(text).not.toContain('Keep this unsaved draft');
});
