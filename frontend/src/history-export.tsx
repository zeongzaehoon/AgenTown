import { useState } from 'react';
import type { Employee, Work } from './api';

function timestamp(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999
    ? new Date(value).toISOString() : 'Time unavailable';
}

export function savedHistoryText(work: Work, employees: Employee[], connected: boolean): string {
  const employee = (id: string) => `${employees.find(item => item.id === id)?.name ?? 'Name unavailable'} (ID: ${id})`;
  const lines = [
    'AgenTown — saved work history',
    'Loaded history only; it may be stale while disconnected. This is not a fresh server snapshot.',
    `Connection at download: ${connected ? 'Connected' : 'Disconnected — history may be stale'}`,
    `Work ID: ${work.id}`, `Saved status: ${work.status}`,
    'Assigned employees:', ...work.assignees.map(employee),
    ...(work.assignees.length ? [] : ['No employee assigned']),
    'Saved input (exact text between markers):', '--- BEGIN SAVED INPUT ---', work.input, '--- END SAVED INPUT ---',
    `Loaded attempts: ${work.attempts.length} (in recorded array order)`,
  ];
  if (!work.attempts.length) lines.push('No loaded attempts. No execution is implied.');
  work.attempts.forEach((attempt, index) => {
    const interrupted = attempt.outcome === 'interruption' || attempt.error === 'interrupted';
    lines.push('', `Attempt ${index + 1}`, `Attempt ID: ${attempt.id}`, `State: ${attempt.state}`,
      `Outcome: ${attempt.outcome ?? 'Not recorded'}`,
      `Provider: ${attempt.provider ?? 'Not recorded'}`, `Model: ${attempt.model ?? 'Not recorded'}`,
      !attempt.provider ? 'Caller-reported attempt — no provider request'
        : ['anthropic', 'openai', 'bedrock', 'xai'].includes(attempt.provider)
          ? (attempt.output != null ? 'Real provider response' : 'Real provider request')
          : 'Test response — not live validation',
      `Participants: ${attempt.participants.map(employee).join(', ') || 'None recorded'}`,
      `Recorded start: ${timestamp(attempt.started)}`,
      `${interrupted ? 'Interruption recorded' : 'Recorded end'}: ${timestamp(attempt.ended)}`);
    if (interrupted) lines.push('This is when interruption was recorded, not the precise process-stop time.');
    if (attempt.state === 'active' && attempt.ended == null) lines.push('No recorded end — attempt is active.');
    lines.push(`Failure: ${attempt.error ?? 'None recorded'}`);
    if (attempt.output == null) lines.push('Output: Not recorded');
    else lines.push(`Output: ${attempt.output === '' ? 'Empty text' : 'Recorded text'} · Unverified`,
      '--- BEGIN OUTPUT ---', attempt.output, '--- END OUTPUT ---');
  });
  return lines.join('\n') + '\n';
}

export function HistoryExport({work, employees, connected}: {work: Work; employees: Employee[]; connected: boolean}) {
  const [feedback, setFeedback] = useState('');
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([savedHistoryText(work, employees, connected)], {type: 'text/plain;charset=utf-8'}));
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const link = document.createElement('a');
      link.href = url;
      link.download = `agentown-work-${work.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-history.txt`;
      link.click();
      setFeedback('History download requested. Check your browser’s downloads.');
    } catch {
      setFeedback('Could not start the history download. Try again; your saved history and draft are unchanged.');
    }
  }
  return <div>
    <button type="button" onClick={download} aria-describedby="history-export-help">Download saved history</button>
    <p id="history-export-help">Downloads saved input and every loaded attempt. Loaded history may be stale while disconnected.</p>
    <p role="status" aria-live="polite" aria-atomic="true">{feedback}</p>
  </div>;
}
