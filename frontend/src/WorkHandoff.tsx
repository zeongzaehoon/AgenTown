import { useLayoutEffect, useRef, useState } from 'react';

export function workHandoff(taskId: string): string {
  return [
    'Read-only AgenTown MCP handoff',
    `Canonical Task ID: ${taskId}`,
    'Use the existing AgenTown MCP tools in this order:',
    `get_task(${JSON.stringify({task_id: taskId})})`,
    `get_work_history_v1(${JSON.stringify({task_id: taskId, read_only: true})})`,
    'inspect_loop_sessions_v1({})',
    `Filter Loop context to the work with Task ID ${JSON.stringify(taskId)}; exclude other Tasks.`,
    'Do not execute or retry work without separate explicit user consent. This handoff authorizes read-only inspection only.',
    'No result bodies or credentials are included. External-client connectivity is unverified.',
  ].join('\n');
}

export function WorkHandoff({taskId, connected}: {taskId: string | null; connected: boolean}) {
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [manual, setManual] = useState(false);
  const generation = useRef(0);
  const copying = useRef(false);
  useLayoutEffect(() => {
    generation.current++; copying.current = false;
    setFeedback(''); setPending(false); setManual(false);
    return () => { generation.current++; };
  }, [taskId, connected]);
  const valid = connected && !!taskId;
  const text = valid ? workHandoff(taskId) : '';
  async function copy() {
    if (!valid || copying.current) return;
    const operation = generation.current;
    copying.current = true; setPending(true); setFeedback('Copying selected-work handoff…');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (operation === generation.current) setFeedback(`Handoff copied for Task ID: ${taskId}. External-client connectivity remains unverified.`);
    } catch {
      if (operation === generation.current) {
        setManual(true);
        setFeedback('Could not copy: clipboard access is unavailable or denied. Select the manual handoff text and copy it using your device’s copy command, or try Copy again.');
      }
    } finally {
      if (operation === generation.current) { copying.current = false; setPending(false); }
    }
  }
  return <section aria-label="External MCP handoff">
    <h3>Share selected work with an MCP client</h3>
    <p>Copy read-only inspection instructions for your external client. Copying makes no MCP or provider requests and does not configure or connect a client.</p>
    {!connected ? <p role="status">Workspace disconnected or stale. Refresh saved history before copying a handoff.</p>
      : !taskId ? <p role="status">Select available saved work before copying a handoff.</p> : <p>Handoff Task ID: {taskId}</p>}
    <button type="button" disabled={!valid || pending} onClick={() => void copy()}>Copy read-only MCP handoff</button>
    <button type="button" disabled={!valid || pending} onClick={() => setManual(true)}>Show manual handoff</button>
    <p role="status" aria-live="polite" aria-atomic="true">{feedback}</p>
    {valid && manual && <label>Manual read-only MCP handoff
      <textarea readOnly rows={12} value={text} onFocus={event => event.currentTarget.select()} />
    </label>}
  </section>;
}
