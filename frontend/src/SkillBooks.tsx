import type { Workspace } from './api';
export interface SkillNavigation {taskId: string; skillId: string}
import { useEffect, useId, useRef, useState } from 'react';
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
      <SavedWorkChooser book={book} workspace={workspace} connected={connected} busy={busy} stale={!!error} onOpenWork={onOpenWork} />
    </article>)}</div>
  </section>;
}

/** Selection is local intent, never navigation or consent. */
function SavedWorkChooser({book, workspace, connected, busy, stale, onOpenWork}: {
  book: ConfigurationRecord; workspace?: Workspace | null; connected: boolean;
  busy: boolean; stale: boolean; onOpenWork?: (request: SkillNavigation) => void;
}) {
  const id = useId();
  const [taskId, setTaskId] = useState('');
  const [removed, setRemoved] = useState(false);
  const work = workspace?.work ?? [];
  const valid = !!taskId && work.some(item => item.id === taskId);
  useEffect(() => {
    if (taskId && !work.some(item => item.id === taskId)) {
      setTaskId(''); setRemoved(true);
    }
  }, [workspace, taskId]);
  const unavailable = !connected ? 'Disconnected. Refresh connection before opening saved work.'
    : busy ? 'Refreshing Skill books. Wait before opening saved work.'
    : stale ? 'Skill books are stale. Refresh Skill books before opening saved work.'
    : !work.length ? 'No saved work in the loaded history. Refresh saved history or save work first.'
    : !onOpenWork ? 'Saved-work navigation is unavailable here.' : '';
  return <div className="skill-work-chooser">
    <label htmlFor={id}>Saved work for Skill: {book.name} · Skill ID: {book.id}</label>
    <select id={id} value={valid ? taskId : ''} aria-describedby={`${id}-help`}
      disabled={!!unavailable} onChange={event => { setTaskId(event.target.value); setRemoved(false); }}>
      <option value="">Choose saved work…</option>
      {work.map(item => <option key={item.id} value={item.id}>{item.input.slice(0, 55)} · Task ID: {item.id}</option>)}
    </select>
    <p id={`${id}-help`}>{unavailable || (removed ? 'Previously chosen work is no longer available. Choose saved work again.' : 'Choose saved work, then Open. Choosing and opening grant no consent and make no local MCP request.')}</p>
    <button type="button" disabled={!!unavailable || !valid} aria-controls="selected-work-inspection"
      aria-label={`Open saved work for Skill: ${book.name} · Skill ID: ${book.id}`}
      onClick={() => { if (valid && !unavailable) onOpenWork?.({taskId, skillId: book.id}); }}>Open</button>
  </div>;
}
