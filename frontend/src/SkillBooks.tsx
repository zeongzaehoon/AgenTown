import type { Workspace } from './api';
export interface SkillNavigation {taskId: string; skillId: string}
import { useEffect, useRef, useState } from 'react';
import { configurationRequest, type ConfigurationRecord } from './configuration-api';

/** Office inspection is read-only and independent of provider availability. */
export function SkillBooks({onOpenSkill, onOpenWork, workspace, connected = true}: {onOpenSkill?: (id: string) => void; onOpenWork?: (request: SkillNavigation) => void; workspace?: Workspace | null; connected?: boolean}) {
  const [books, setBooks] = useState<ConfigurationRecord[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    try {
      const result = await configurationRequest<{skills: ConfigurationRecord[]}>('skills', '', undefined, controller.signal);
      if (!Array.isArray(result.skills) || result.skills.some(book => !book || typeof book.id !== 'string' || typeof book.name !== 'string' || typeof book.enabled !== 'boolean')) throw new Error('Saved Skill data unavailable. Refresh to try again.');
      if (!controller.signal.aborted) setBooks(result.skills);
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  return <section className="skill-library" aria-labelledby="skill-library-title">
    <h3 id="skill-library-title">Skill library</h3>
    <p>Open a book to inspect its saved Skill in Configuration. Opening never saves, enables or executes work.</p>
    <p role="status">{busy ? 'Loading Skill books…' : error ? books ? 'Skill books are stale — showing the last successful snapshot.' : 'Skill books unavailable.' : books?.length ? 'Showing saved Skill books.' : 'No saved Skills yet. Create a Skill in Configuration.'}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh Skill books</button>
    <div className="skill-shelf">{books?.map(book => <article key={book.id}><button type="button" className="skill-book" key={book.id}
      disabled={!onOpenSkill} aria-controls="configuration-panel"
      aria-label={`Open Skill book: ${book.name} · ID: ${book.id}`} onClick={() => onOpenSkill?.(book.id)}>
      <span aria-hidden="true">▤</span><strong>{book.name}</strong><span>Skill manual</span><span>ID: {book.id}</span>
      <span>Configuration {book.enabled ? 'enabled' : 'disabled'}</span>
      {(busy || error) && <span>{busy ? 'Refreshing snapshot' : 'Stale snapshot'}</span>}
    </button>
      <p>Choose loaded saved work for this exact Skill. Opening does not inspect, discover, preview or execute.</p>
      {!workspace?.work.length && <p>No saved work in the loaded history. Refresh saved history or save work first.</p>}
      {workspace?.work.map(work => <button type="button" key={work.id}
        disabled={!connected || busy || !!error || !onOpenWork} aria-controls="selected-work-inspection"
        aria-label={`Open work for Skill: ${book.name} · Skill ID: ${book.id} · Task ID: ${work.id}`}
        onClick={() => onOpenWork?.({taskId: work.id, skillId: book.id})}>Open work: {work.input.slice(0, 55)} · Task ID: {work.id} · local MCP</button>)}
    </article>)}</div>
  </section>;
}
