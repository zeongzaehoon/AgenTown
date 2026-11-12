import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { Workspace } from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (name: string) => screen.getByRole('button', {name}) as HTMLButtonElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const requestLabel = 'What would you like help with?';
function fixture() {
  const polls: (() => void)[] = [];
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
    if (ms === 800) { polls.push(callback); return 0; }
    return interval(callback, ms);
  }) as typeof setInterval);
  const state: Workspace = {employees: [{id: 'e', name: 'Writer'}, {id: 'other', name: 'Editor'}],
    work: [{id: 'old', input: 'Saved history', status: 'pending', assignees: ['e'], attempts: []}],
    configuration: null, provider: 'deterministic-test', model: 'test'};
  const mutations: string[] = [];
  let response = async () => new Response('null');
  let failRefresh = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/state') {
      if (failRefresh) throw new Error('offline');
      return new Response(JSON.stringify(state));
    }
    if (url === '/api/employees' || url === '/api/work') { mutations.push(url); return response(); }
    if (url === '/api/teams') return new Response('{"teams":[]}');
    if (url === '/api/loops/v1') return new Response('{"schema_version":1,"control":{"state":"available","can_control":true,"message":""},"sessions":[],"attempts":[],"cancellation":"Stop prevents admissions"}');
    return new Response(JSON.stringify({skills: [], hooks: [], loops: []}));
  }));
  return {state, mutations, polls, respond: (fn: typeof response) => { response = fn; }, failRefresh: (fail: boolean) => { failRefresh = fail; }};
}
async function setup() {
  const f = fixture();
  render(<App />);
  await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Connected'));
  fireEvent.change(field('Employee name'), {target: {value: 'Draft employee'}});
  fireEvent.change(field(requestLabel), {target: {value: 'Draft request'}});
  fireEvent.change(field('Assign to'), {target: {value: 'other'}});
  return f;
}
function retained() {
  expect(field('Employee name').value).toBe('Draft employee');
  expect(field(requestLabel).value).toBe('Draft request');
  expect(field('Assign to').value).toBe('other');
  expect(screen.getByText('Saved history', {selector: 'pre'})).toBeTruthy();
}
for (const target of ['Create employee', 'Save work']) {
  for (const [kind, body] of [
    ['null', 'null'], ['array', '[]'], ['array with ID', '[{"id":"x"}]'], ['missing ID', '{}'],
    ['number ID', '{"id":1}'], ['boolean ID', '{"id":true}'], ['object ID', '{"id":{}}'],
    ['empty ID', '{"id":""}'], ['blank ID', '{"id":"  "}'], ['unreadable', 'not json'],
  ]) {
    test(`${target}: ${kind} retains drafts and requires explicit read-only recovery`, async () => {
      const f = await setup();
      f.respond(async () => new Response(body));
      act(() => { button(target).click(); button(target).click(); });
      await screen.findByRole('region', {name: 'Creation recovery'});
      await waitFor(() => expect(field(requestLabel).disabled).toBe(false));
      retained();
      expect(f.mutations).toHaveLength(1);
      expect(button('Create employee').disabled).toBe(true);
      expect(button('Save work').disabled).toBe(true);
      expect(button('I inspected employees and saved work').disabled).toBe(true);
      await act(async () => { f.polls.forEach(poll => poll()); });
      retained();
      expect(button('I inspected employees and saved work').disabled).toBe(true);
      // Even direct form submission cannot bypass the persistent guard.
      fireEvent.submit(document.querySelector(target === 'Save work' ? '#work-form' : '#employee-form')!);
      expect(f.mutations).toHaveLength(1);
      f.failRefresh(true);
      fireEvent.click(button('Refresh connection'));
      await waitFor(() => expect(document.querySelector('#connection')!.textContent).toContain('Disconnected'));
      expect(button('I inspected employees and saved work').disabled).toBe(true);
      f.failRefresh(false);
      const user = userEvent.setup();
      button('Refresh connection').focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(button('I inspected employees and saved work').disabled).toBe(false));
      await user.tab();
      expect(document.activeElement).toBe(button('I inspected employees and saved work'));
      await user.keyboard('{Enter}');
      retained();
      expect(f.mutations).toHaveLength(1);
      f.respond(async () => {
        if (target === 'Save work') f.state.work.push({id: 'new', input: 'Draft request', status: 'pending', assignees: ['other'], attempts: []});
        else f.state.employees.push({id: 'new', name: 'Draft employee'});
        return new Response('{"id":"new"}');
      });
      act(() => { button(target).click(); button(target).click(); });
      await waitFor(() => expect(target === 'Save work' ? field(requestLabel).value : field('Employee name').value).toBe(''));
      expect(f.mutations).toHaveLength(2);
    });
  }
}

test('successful employee creation preserves name edits made while the request is pending', async () => {
  const f = await setup();
  let finish!: (response: Response) => void;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  act(() => { button('Create employee').click(); button('Create employee').click(); });
  fireEvent.change(field('Employee name'), {target: {value: 'Next employee'}});
  f.state.employees.push({id: 'new', name: 'Draft employee'});
  await act(async () => finish(new Response('{"id":"new"}')));
  await waitFor(() => expect(button('Create employee').disabled).toBe(false));
  expect(field('Employee name').value).toBe('Next employee');
  expect(field('Assign to').value).toBe('new');
  expect(field(requestLabel).value).toBe('Draft request');
  expect(f.mutations).toEqual(['/api/employees']);
});
