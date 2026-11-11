import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { Connections, type ConnectionSetup } from './Connections';

afterEach(() => {cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
const setup: ConnectionSetup = {
  schema_version: 1, workflow_version: 1, transport: 'stdio', evidence: 'Copying does not verify a client.',
  preparation: 'Replace both paths.', actions: ['Inspect saved work', 'Execute only with consent'], consent: 'Explicit consent required before spending.', recovery: 'Inspect history before retrying.',
  clients: ['codex', 'claude-code'].map(id => ({id, name: id === 'codex' ? 'Codex' : 'Claude Code', readiness: 'unknown', platforms: ['macos', 'windows'].map(p => ({id: p, name: p, destination: `${id}-${p}`, configuration: `config-${id}-${p}`, inspection: 'Inspect /mcp'}))})),
};

test('keyboard selection copies exact instructions without establishing readiness or mutating work', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(setup)));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<Connections workspaceConnected />);
  expect(fetcher).not.toHaveBeenCalled();
  screen.getByRole('button', {name: 'Open connections'}).focus();
  await user.keyboard('{Enter}');
  await screen.findByLabelText('Client');
  await user.selectOptions(screen.getByLabelText('Client'), 'claude-code');
  await user.selectOptions(screen.getByLabelText('Platform'), 'windows');
  const text = screen.getByLabelText('Setup instructions') as HTMLTextAreaElement;
  expect(text.value).toContain('config-claude-code-windows');
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  screen.getByRole('button', {name: 'Copy setup instructions'}).focus();
  await user.keyboard('{Enter}');
  expect(copy).toHaveBeenCalledWith(text.value);
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
  expect(await screen.findByText(/Setup instructions copied/)).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
});

test('clipboard denial and disconnected setup retain selection and instructions with explicit recovery', async () => {
  let offline = false;
  vi.stubGlobal('fetch', vi.fn(async () => {if (offline) throw new Error('offline'); return new Response(JSON.stringify(setup));}));
  const user = userEvent.setup();
  const view = render(<Connections workspaceConnected />);
  await user.click(screen.getByRole('button', {name: 'Open connections'}));
  await screen.findByLabelText('Client');
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  await user.click(screen.getByRole('button', {name: 'Copy setup instructions'}));
  expect(await screen.findByText(/Could not copy/)).toBeTruthy();
  const instructions = (screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value;
  offline = true; view.rerender(<Connections workspaceConnected={false} />);
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  expect(await screen.findByText(/Setup service disconnected/)).toBeTruthy();
  expect((screen.getByLabelText('Setup instructions') as HTMLTextAreaElement).value).toBe(instructions);
  expect(screen.getByText(/Workspace: Disconnected/)).toBeTruthy();
  offline = false;
  await user.click(screen.getByRole('button', {name: 'Refresh setup'}));
  await waitFor(() => expect(screen.getByText('Setup service available.')).toBeTruthy());
  expect(screen.getByText('Client readiness: Unknown')).toBeTruthy();
});
