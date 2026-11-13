import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkHandoff } from './WorkHandoff';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const copyButton = () => screen.getByRole('button', {name: 'Copy read-only MCP handoff'});
const expected = (id: string) => [
  'Read-only AgenTown MCP handoff',
  `Canonical Task ID: ${id}`,
  'Use the existing AgenTown MCP tools in this order:',
  `get_task({"task_id":"${id}"})`,
  `get_work_history_v1({"task_id":"${id}","read_only":true})`,
  'inspect_loop_sessions_v1({})',
  `Filter Loop context to the work with Task ID "${id}"; exclude other Tasks.`,
  'Do not execute or retry work without separate explicit user consent. This handoff authorizes read-only inspection only.',
  'No result bodies or credentials are included. External-client connectivity is unverified.',
].join('\n');

function setup() {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkHandoff taskId="task-a" connected />);
  return {user, write, fetcher, view};
}

test('keyboard copy includes exact selected identities and read-only calls, with zero requests', async () => {
  const {user, write, fetcher, view} = setup();
  expect(write).not.toHaveBeenCalled();
  await user.tab(); expect(document.activeElement).toBe(copyButton());
  await user.keyboard('{Enter}');
  expect(write.mock.calls).toEqual([[expected('task-a')]]);
  expect(screen.getByText(/Handoff copied for Task ID: task-a/).getAttribute('role')).toBe('status');
  view.rerender(<WorkHandoff taskId="task-b" connected />);
  expect(screen.queryByText(/Handoff copied/)).toBeNull();
  await user.click(copyButton());
  expect(write.mock.calls).toEqual([[expected('task-a')], [expected('task-b')]]);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['denied', 'unavailable'])('%s clipboard offers selectable manual text and explicit recovery', async kind => {
  const {user, write, fetcher} = setup();
  if (kind === 'denied') write.mockRejectedValueOnce(new Error('denied'));
  else Object.defineProperty(navigator, 'clipboard', {configurable: true, value: undefined});
  await user.click(copyButton());
  expect(screen.getByText(/Could not copy: clipboard/).getAttribute('role')).toBe('status');
  const manual = screen.getByRole('textbox', {name: 'Manual read-only MCP handoff'}) as HTMLTextAreaElement;
  expect(manual.value).toBe(expected('task-a')); expect(manual.readOnly).toBe(true);
  await user.click(manual);
  expect(manual.selectionStart).toBe(0); expect(manual.selectionEnd).toBe(manual.value.length);
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: write}});
  write.mockResolvedValue(); await user.click(copyButton());
  expect(screen.getByText(/Handoff copied for Task ID: task-a/)).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['resolve', 'reject'])('A → B → A invalidates pending clipboard %s', async outcome => {
  const {user, write, view, fetcher} = setup();
  let resolve!: () => void; let reject!: (e: Error) => void;
  write.mockImplementationOnce(() => new Promise<void>((yes, no) => {resolve = yes; reject = no;}));
  await user.click(copyButton());
  expect((copyButton() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Copying selected-work handoff…')).toBeTruthy();
  view.rerender(<WorkHandoff taskId="task-b" connected />);
  view.rerender(<WorkHandoff taskId="task-a" connected />);
  await user.click(copyButton());
  await act(async () => {if (outcome === 'resolve') resolve(); else reject(new Error('late'));});
  expect(screen.getByText(/Handoff copied for Task ID: task-a/)).toBeTruthy();
  expect(screen.queryByText(/Could not copy/)).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(write).toHaveBeenCalledTimes(2); expect(fetcher).not.toHaveBeenCalled();
});

test.each(['missing', 'disconnected'])('%s work removes manual text and invalidates in-flight confirmation', async state => {
  const {user, write, view, fetcher} = setup();
  await user.click(screen.getByRole('button', {name: 'Show manual handoff'}));
  expect(screen.getByRole('textbox')).toBeTruthy();
  let finish!: () => void;
  write.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
  await user.click(copyButton());
  view.rerender(<WorkHandoff taskId={state === 'missing' ? null : 'task-a'} connected={state !== 'disconnected'} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect((copyButton() as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {finish();});
  expect(screen.queryByText(/Handoff copied/)).toBeNull();
  view.rerender(<WorkHandoff taskId="task-a" connected />);
  expect(screen.queryByText(/Handoff copied/)).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
