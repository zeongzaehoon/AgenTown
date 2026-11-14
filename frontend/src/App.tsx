import type { SkillNavigation } from './SkillBooks';
import type { HookNavigation } from './HookDevices';
import type { LoopNavigation } from './OverviewLoops';
import { DraftStatus, useUnsavedDrafts } from './unsaved-drafts';
import { confirmExecutionHistory, validateExecutionReceipt } from './execution-receipt';
import { validateWorkspace } from './workspace-validation';
import { type ConfigurationNavigation } from './configuration-api';
import { LoopExecution } from './LoopExecution';
import { HookExecution } from './HookExecution';
import { SkillExecution } from './SkillExecution';
import { Configuration } from './Configuration';
import { Teams } from './Teams';
import { CompanyOverview } from './CompanyOverview';
import { Connections, type OpenClientRequest } from './Connections';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WorkInspection } from './WorkInspection';
import { WorkHandoff } from './WorkHandoff';
import { HistoryExport } from './history-export';
import { advice, api, classifyWork, type WorkOutcome, workStatus, workInputError, WorkInputError, type Attempt, type Work, type Workspace } from './api';

// Native timestamps are integral Unix milliseconds from 1970 through year 9999.
// Fix UTC explicitly so saved dates do not depend on the device time zone.
function RecordedTime({ value }: { value: number | null | undefined }) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 253402300799999) {
    return <span>Time unavailable</span>;
  }
  const iso = new Date(value).toISOString();
  return <time dateTime={iso}>{iso.slice(0, 10)} {iso.slice(11, 23)} UTC</time>;
}

function AttemptResult({ attempt, work, number, latest }: {attempt: Attempt; work: Work; number: number; latest: boolean}) {
  // Keep an expanded historical result expanded across polling updates.
  const [open, setOpen] = useState(latest);
  const [feedback, setFeedback] = useState('');
  const copying = useRef(false);
  async function copy() {
    if (copying.current || attempt.output == null) return;
    copying.current = true;
    setFeedback('Copying result…');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(attempt.output);
      setFeedback('Result copied.');
    } catch {
      setFeedback('Could not copy. Clipboard access is unavailable or denied. Use Download text instead.');
    } finally { copying.current = false; }
  }
  function download() {
    if (attempt.output == null) return;
    try {
      const blob = new Blob([attempt.output], {type: 'text/plain;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      // Allow the browser to consume the URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const link = document.createElement('a');
      link.href = url;
      link.download = `agentown-attempt-${attempt.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
      link.click();
      setFeedback('Text download requested. Check your browser’s downloads.');
    } catch {
      setFeedback('Could not start the download. Try again or select and save the result text.');
    }
  }
  return <details data-attempt-id={attempt.id} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Attempt {number} · {attempt.output != null ? 'Result available · Unverified' : attempt.error === 'output_limit' ? 'Failed — response reached the output limit' : attempt.error || attempt.state}</summary>
    <p>{['anthropic', 'openai', 'bedrock', 'xai'].includes(attempt.provider || '') ? (attempt.output != null ? 'Real provider response' : 'Real provider request') : attempt.provider ? 'Test response — not live validation' : 'Caller-reported attempt — no provider request'} · {attempt.model || 'No model'}</p>
    <p>Caller-declared source (unverified): {attempt.declared_source ?? 'Unknown / not recorded'}</p>
    <p>This caller-declared attribution does not establish authenticated identity, Loop ownership or provider verification.</p>
    <p>Recorded start: <RecordedTime value={attempt.started} /></p>
    <p>{attempt.outcome === 'interruption' || attempt.error === 'interrupted' ? 'Interruption recorded: ' : 'Recorded end: '}
      {attempt.state === 'active' && attempt.ended == null ? 'No recorded end — attempt is active.' : <RecordedTime value={attempt.ended} />}
    </p>
    {(attempt.outcome === 'interruption' || attempt.error === 'interrupted') && <p>This is when interruption was recorded, not the precise process-stop time.</p>}
    {attempt.output != null && <>
      <pre>{attempt.output}</pre>
      <div className="result-actions" role="group" aria-label={`Attempt ${number} result actions`}>
        <button type="button" onClick={() => void copy()}>Copy result</button>
        <button type="button" onClick={download}>Download text</button>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true">{feedback}</p>
    </>}
    {attempt.error && <p>{Object.hasOwn(advice, attempt.error) ? advice[attempt.error] : 'Refresh history before retrying.'}</p>}
    {attempt.state === 'active' && !attempt.provider && <p>Caller-reported active attempt; no provider request is recorded.</p>}
    {attempt.state === 'active' && !!attempt.provider && <p>Waiting for the provider. After an unexpected stop, recovery can take up to 120 seconds. No work is automatically resent.</p>}
    {attempt.hook && <section aria-label={`Attempt ${number} saved Hook provenance`}>
      <h4>Saved Hook provenance</h4>
      <p>{attempt.hook.hook_name} · Hook ID: {attempt.hook.hook_id}</p>
      <p>Source event: {attempt.hook.event} · Source Run: {attempt.hook.source_run_id} · Outcome: {attempt.hook.source_outcome}</p>
      <p>Employee ID: {attempt.hook.agent_id} · Preview ID: {attempt.hook.preview_id}</p>
      <p>{attempt.hook.skill_name} · Skill ID: {attempt.hook.skill_id}</p>
      <p>Instructions saved at execution</p><pre>{attempt.hook.instructions}</pre>
      <p>Effective input saved at execution</p><pre>{attempt.hook.input}</pre>
    </section>}
    {attempt.skill && <section aria-label={`Attempt ${number} saved Skill provenance`}>
      <h4>Saved Skill provenance</h4>
      <p>{attempt.skill.skill_name} · Skill ID: {attempt.skill.skill_id}</p>
      <p>Preview ID: {attempt.skill.preview_id}</p>
      <p>Instructions saved at execution</p><pre>{attempt.skill.instructions}</pre>
      <p>Effective input saved at execution</p><pre>{attempt.skill.input}</pre>
    </section>}
    <p>Work ID: {work.id} · Attempt ID: {attempt.id}</p>
  </details>;
}

function creationId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('id' in value) || typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error('Invalid creation response.');
  }
  return value.id;
}

export function App() {
  const [state, setState] = useState<Workspace | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [skillRequest, setSkillRequest] = useState<SkillNavigation | null>(null);
  const [hookRequest, setHookRequest] = useState<HookNavigation | null>(null);
  const [loopRequest, setLoopRequest] = useState<LoopNavigation | null>(null);
  const [inspectionRequired, setInspectionRequired] = useState(false);
  const executionBlocked = useRef(false);
  const [executionInspectionReady, setExecutionInspectionReady] = useState(false);
  const executionRecoveryVersion = useRef(0);
  const [creationRecovery, setCreationRecovery] = useState<'refresh' | 'inspect' | null>(null);
  const creationBlocked = useRef(false);
  const recoveryVersion = useRef(0);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [clientRequest, setClientRequest] = useState<OpenClientRequest | null>(null);
  const [teamRequest, setTeamRequest] = useState<{id: string} | null>(null);
  const [configurationRequest, setConfigurationRequest] = useState<ConfigurationNavigation | null>(null);
  const [viewEmployee, setViewEmployee] = useState('');
  const [outcome, setOutcome] = useState<WorkOutcome | 'all'>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const focusedRequest = useRef<{id: string; input: string; element: HTMLButtonElement} | null>(null);
  const [matchingAnnouncement, setMatchingAnnouncement] = useState('');
  const matchingContext = useRef({state, search, outcome, viewEmployee});
  const [employee, setEmployee] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [input, setInput] = useState('');
  const [inputTouched, setInputTouched] = useState(false);
  const [serverInputError, setServerInputError] = useState('');
  const [replacement, setReplacement] = useState<Work | null>(null);
  const [draftNotice, setDraftNotice] = useState('');
  const draftActionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const locks = useRef(new Set<string>());
  const [loopAvailabilityState, setLoopAvailability] = useState({id: '', blocked: true});
  const loopAvailability = useCallback((blocked: boolean) => setLoopAvailability({id: selected, blocked}), [selected]);
  const pendingFocus = useRef<'input' | 'execute' | 'draft' | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const executeRef = useRef<HTMLButtonElement>(null);
  const [resubmission, setResubmission] = useState<string | null>(null);
  const resubmissionToken = useRef<string | null>(null);
  const resubmissionRef = useRef<HTMLElement>(null);
  const resendCancelRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLSelectElement>(null);
  const generation = useRef(0);
  const poll = useRef<AbortController | null>(null);
  const mutations = useRef(new Set<AbortController>());
  const work = state?.work.find(w => w.id === selected);
  const matches = state?.work.filter(w => (!viewEmployee || w.assignees.includes(viewEmployee)) && w.input.toLowerCase().includes(search.toLowerCase()) && (outcome === 'all' || classifyWork(w).outcome === outcome)) ?? [];
  const selectedExcluded = !!work && !matches.some(w => w.id === work.id);
  const assignee = employee === null ? state?.employees[0]?.id ?? '' : state?.employees.some(e => e.id === employee) ? employee : '';

  useEffect(() => {
    const trackFocus = (event: FocusEvent) => {
      if (event.target !== focusedRequest.current?.element) focusedRequest.current = null;
    };
    document.addEventListener('focusin', trackFocus);
    return () => document.removeEventListener('focusin', trackFocus);
  }, []);
  useLayoutEffect(() => {
    const previous = matchingContext.current;
    matchingContext.current = {state, search, outcome, viewEmployee};
    const focused = focusedRequest.current;
    if (!focused) return;
    // Filter edits are user navigation, not a refresh removing a control.
    if (previous.search !== search || previous.outcome !== outcome || previous.viewEmployee !== viewEmployee) {
      focusedRequest.current = null;
      return;
    }
    if (previous.state === state) return;
    const surviving = matches.find(request => request.id === focused.id);
    if (surviving) { focused.input = surviving.input; return; }
    focusedRequest.current = null;
    if (!focused.element.isConnected && document.activeElement === document.body) {
      searchRef.current?.focus();
      setMatchingAnnouncement(`Saved request “${focused.input.slice(0, 55)}” · ID: ${focused.id} left Matching requests after the workspace refreshed. This does not mean it was deleted. ${matches.length ? 'Other matching requests remain.' : 'No requests match the current filters.'} Your filters and selected detail are retained.`);
    }
  }, [state, search, outcome, viewEmployee]);

  const inputError = serverInputError || (inputTouched ? workInputError(input, assignee) : '');
  const hasUnsavedDraft = input.length > 0;

  useUnsavedDrafts(hasUnsavedDraft);

  const refresh = useCallback(async () => {
    // Cancel superseded snapshots so an older poll cannot overwrite a mutation refresh.
    poll.current?.abort();
    const controller = new AbortController();
    poll.current = controller;
    const current = ++generation.current;
    try {
      const next = validateWorkspace(await api<unknown>('/api/state', {}, controller.signal));
      if (current !== generation.current) return;
      setState(next);
      if (!creationBlocked.current && !locks.current.has('employee') && !locks.current.has('work')) setSelected(previous => previous || next.work[0]?.id || '');
      setConnected(true); setConnectionError(''); return next;
    } catch (error) {
      if (current !== generation.current) return;
      if (executionBlocked.current) setExecutionInspectionReady(false);
      setConnected(false); setConnectionError(error instanceof SyntaxError
        ? 'Workspace data unavailable: the server returned unreadable data. Check the local server, then choose Refresh connection. Loaded history and unsaved drafts are retained; nothing is automatically resent.'
        : (error as Error).message);
    } finally {
      if (current === generation.current) poll.current = null;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      // Employee/work creation confirms against one stable pre-mutation
      // snapshot. Executions persist an active attempt before provider I/O,
      // so keep reading history while they run and expose that saved state.
      if (!poll.current && !locks.current.has('employee') && !locks.current.has('work')) void refresh();
    }, 800);
    return () => {
      clearInterval(timer); ++generation.current; poll.current?.abort(); poll.current = null;
      mutations.current.forEach(controller => controller.abort());
      mutations.current.clear();
    };
  }, [refresh]);
  useLayoutEffect(() => {
    if (pendingFocus.current === 'draft' && !replacement) {
      draftActionRef.current?.focus(); pendingFocus.current = null;
    } else if (pendingFocus.current === 'input' && !busy.has('employee') && !busy.has('work')) {
      inputRef.current?.focus(); pendingFocus.current = null;
    } else if (pendingFocus.current === 'execute' && executeRef.current && !executeRef.current.disabled && !busy.has('work')) {
      executeRef.current.focus(); pendingFocus.current = null;
    }
  });

  useLayoutEffect(() => { if (replacement) cancelRef.current?.focus(); }, [replacement]);

  function loadDraft(source: Work) {
    if (locks.current.has('work')) return;
    const available = source.assignees.length === 1 && state?.employees.some(e => e.id === source.assignees[0]);
    setInput(source.input); setServerInputError(''); setInputTouched(true);
    setEmployee(available ? source.assignees[0] : '');
    setReplacement(null);
    setDraftNotice(`Saved input loaded as an editable new draft. ${available ? 'Review the text and employee, then Save work.' : 'Select an employee before saving.'} Saving creates separate work; original history stays unchanged.`);
    inputRef.current?.focus();
  }
  function cancelReplacement() {
    setReplacement(null);
    setDraftNotice('Replacement cancelled. Your draft and employee selection are unchanged.');
    pendingFocus.current = 'draft';
  }

  async function mutate(key: string, action: (signal: AbortSignal) => Promise<void>, confirmsHistory = false) {
    if (!connected || locks.current.has(key) || (executionBlocked.current && key !== 'employee' && key !== 'work' && !key.startsWith('stop/')) || ((key === 'employee' || key === 'work') && creationBlocked.current)) return;
    locks.current.add(key); setBusy(new Set(locks.current)); setNotice('');
    const controller = new AbortController();
    mutations.current.add(controller);
    try { await action(controller.signal); }
    catch (error) {
      if (controller.signal.aborted) return;
      if (key === 'work' && error instanceof WorkInputError) { setServerInputError(error.message); pendingFocus.current = 'input'; }
      else if (key === 'employee' || key === 'work') {
        creationBlocked.current = true; ++recoveryVersion.current;
        setCreationRecovery('refresh');
        setNotice((error as Error).message);
      } else {
        executionBlocked.current = true; ++executionRecoveryVersion.current; setExecutionInspectionReady(false);
        setNotice((error as Error).message); setInspectionRequired(true);
      }
    }
    finally {
      // Always inspect server state after uncertain delivery, never replay a request.
      if (!controller.signal.aborted && (!confirmsHistory || executionBlocked.current) && key !== 'employee' && key !== 'work') await refresh();
      mutations.current.delete(controller);
      locks.current.delete(key);
      if (!controller.signal.aborted) setBusy(new Set(locks.current));
    }
  }
  async function confirmExecution(receipt: unknown, submitted: Work, workspace: Workspace, signal: AbortSignal, preview?: import('./api').SkillPreview | import('./api').HookPreview) {
    validateExecutionReceipt(receipt, submitted, workspace, preview);
    const confirmed = await refresh();
    if (!signal.aborted) confirmExecutionHistory(receipt, submitted, confirmed);
  }
  const baseCannotExecute = inspectionRequired || !connected || !work || [...busy].some(key => key !== 'employee' && key !== 'work') || !!state?.configuration || work.status === 'cancelled' || work.assignees.length !== 1 || work.attempts.some(a => a.state === 'active');
  const cannotExecute = baseCannotExecute || loopAvailabilityState.id !== selected || loopAvailabilityState.blocked;
  // Compare values, not snapshot identity: unchanged polling must retain consent.
  const executionSnapshot = JSON.stringify([work, state?.configuration, state?.provider, state?.model]);
  useLayoutEffect(() => {
    if (resubmission === null) return;
    if (cannotExecute || resubmission !== executionSnapshot) {
      const restore = resubmissionRef.current?.contains(document.activeElement);
      resubmissionToken.current = null;
      setResubmission(null);
      setNotice('Saved work or execution availability changed. Review history before retrying.');
      if (restore) {
        if (!cannotExecute) executeRef.current?.focus();
        else historyRef.current?.focus();
      }
    } else resendCancelRef.current?.focus();
  }, [resubmission, executionSnapshot, cannotExecute]);

  function cancelResubmission() {
    resubmissionToken.current = null;
    setResubmission(null);
    executeRef.current?.focus();
  }
  function execute(confirmed = false) {
    if (cannotExecute || !work || locks.current.has(work.id)) return;
    if (work.attempts.at(-1)?.output != null) {
      if (!confirmed) {
        resubmissionToken.current = executionSnapshot;
        setResubmission(executionSnapshot);
        return;
      }
      if (resubmissionToken.current !== executionSnapshot) return;
    } else if (confirmed) return;
    // Consume consent before awaiting or rendering, alongside the existing lock.
    resubmissionToken.current = null;
    setResubmission(null);
    historyRef.current?.focus();
    void mutate(work.id, async signal => {
      await confirmExecution(await api<unknown>(`/api/work/${encodeURIComponent(work.id)}/execute`, {expected_runs: work.attempts.length}, signal), work, state!, signal);
    }, true);
  }
  return <>
    <a className="skip" href="#main">Skip to workspace</a>
    <header><p className="eyebrow">AGENTOWN / LOCAL WORKSPACE</p><h1>Where agents come alive.</h1><p>Create an employee. Give them text to work on. Review what comes back.</p></header>
    <main id="main">
      <p id="connection" role="status" aria-live="polite">{connected ? `Connected · ${work ? workStatus(work) : 'Ready for your first work'}` : connectionError ? `${state ? 'Disconnected — displayed history may be out of date.' : 'Workspace unavailable.'} ${connectionError}` : 'Connecting to your workspace…'}</p>
      <p id="configuration">{state && (state.configuration || `Provider: ${state.provider} · Model: ${state.model} · ${['anthropic', 'openai', 'bedrock', 'xai'].includes(state.provider) ? 'Real provider requests' : 'Test responses — not live validation'}`)}</p>
      <p id="notice" role="alert">{notice}</p><button id="refresh" type="button" onClick={() => {
        const version = recoveryVersion.current;
        const executionVersion = executionRecoveryVersion.current;
        setExecutionInspectionReady(false);
        const executionInFlight = [...locks.current].some(key => key !== 'employee' && key !== 'work');
        void refresh().then(ok => {
          if (ok) {
            if (!executionInFlight && executionVersion === executionRecoveryVersion.current && ![...locks.current].some(key => key !== 'employee' && key !== 'work')) {
              if (executionBlocked.current) setExecutionInspectionReady(true);
            }
            if (creationBlocked.current && version === recoveryVersion.current && !locks.current.has('employee') && !locks.current.has('work')) setCreationRecovery('inspect');
          }
        });
      }}>Refresh connection</button>
      {creationRecovery && <section aria-label="Creation recovery">
        <p role="alert">Creation may already have occurred. Your drafts and previous selection are retained. Choose Refresh connection, then inspect employees and saved work before another submission. Polling does not clear this state; nothing is automatically resent.</p>
        <button type="button" disabled={creationRecovery !== 'inspect' || !connected} onClick={() => {
          creationBlocked.current = false; setCreationRecovery(null); setNotice('Inspection confirmed. Review your drafts before explicitly submitting again.');
        }}>I inspected employees and saved work</button>
      </section>}
      {inspectionRequired && <section aria-label="Execution recovery">
        <p role="status">Submission needs inspection. Delivery is uncertain. Choose Refresh connection, inspect the attempts below, then explicitly retry. Nothing is resent automatically.</p>
        <button type="button" disabled={!executionInspectionReady || !connected || busy.size > 0} onClick={() => {
          if (!executionBlocked.current || !executionInspectionReady || !connected || locks.current.size > 0) return;
          executionBlocked.current = false; setInspectionRequired(false); setExecutionInspectionReady(false);
          setNotice('History inspection confirmed. Review saved attempts before explicitly retrying. Nothing was resent.');
          historyRef.current?.focus();
        }}>I inspected execution history</button>
      </section>}
      <CompanyOverview onOpenSkillWork={request => { setSkillRequest({...request}); setHookRequest(null); setLoopRequest(null); setViewEmployee(''); setSearch(''); setOutcome('all'); setSelected(request.taskId); }} onOpenHookWork={request => { setSkillRequest(null); setHookRequest({...request}); setLoopRequest(null); setViewEmployee(''); setSearch(''); setOutcome('all'); setSelected(request.taskId); }} onOpenSession={request => { setHookRequest(null); setSkillRequest(null); setLoopRequest({...request}); setViewEmployee(''); setSearch(''); setOutcome('all'); setSelected(request.taskId); }} onSelectTeamMember={id => { setViewEmployee(id); setSearch(''); setOutcome('all'); searchRef.current?.focus(); }} onOpenTeam={id => setTeamRequest({id})} onOpenClient={id => setClientRequest({id})} onOpenSkill={id => setConfigurationRequest({kind: 'skills', id})} onOpenHook={id => setConfigurationRequest({kind: 'hooks', id})} onOpenLoop={id => setConfigurationRequest({kind: 'loops', id})} workspace={state} connected={connected} error={connectionError} selectedEmployee={viewEmployee} onSelectEmployee={setViewEmployee} onOpenWork={id => {
        setSkillRequest(null); setHookRequest(null); setLoopRequest(null); setViewEmployee(''); setSearch(''); setOutcome('all'); setSelected(id); historyRef.current?.focus();
      }} />
      <Teams openTeam={teamRequest} workspace={state} connected={connected} onSelectEmployee={id => {
        setViewEmployee(id); setSearch(''); setOutcome('all'); searchRef.current?.focus();
      }} />
      <div className="workspace"><aside><section><h2>1. Your employees</h2>
        <p id="employees-empty" hidden={!!state?.employees.length}>No employees yet. Create your first one.</p>
        <ul id="employees">{state?.employees.map(e => <li key={e.id}>{e.name}</li>)}</ul>
        <form id="employee-form" onSubmit={event => {event.preventDefault(); void mutate('employee', async signal => {
          const previousIds = new Set(state!.employees.map(record => record.id));
          const id = creationId(await api<unknown>('/api/employees', {name}, signal));
          if (signal.aborted) return;
          const confirmed = await refresh();
          if (signal.aborted) return;
          // Rust str::trim uses Unicode White_Space, unlike JavaScript trim.
          const requestedName = name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
          if (!confirmed || previousIds.has(id) || confirmed.employees.find(record => record.id === id)?.name !== requestedName) {
            throw new Error('Employee creation could not be confirmed in refreshed employees.');
          }
          setEmployee(id); setName(previous => previous === name ? '' : previous); pendingFocus.current = 'input';
        });}}>
          <DraftStatus labels={name.trim() ? ['Employee name'] : []} />
          <button type="button" disabled={busy.has('employee') || !name} onClick={() => setName('')}>Discard employee draft</button>
          <label htmlFor="name">Employee name</label><input id="name" name="name" required maxLength={200} autoComplete="off" value={name} onChange={e => setName(e.target.value)} />
          <button disabled={!!creationRecovery || !connected || busy.has('employee')}>Create employee</button>
        </form></section>
        <section><h2>2. Give them work</h2><form id="work-form" onSubmit={event => {event.preventDefault(); if (!assignee || replacement) return; setInputTouched(true); if (workInputError(input, assignee)) { inputRef.current?.focus(); return; } void mutate('work', async signal => {
          const previousIds = new Set(state!.work.map(record => record.id));
          const id = creationId(await api<unknown>('/api/work', {input, employee: assignee}, signal));
          if (signal.aborted) return;
          const confirmed = await refresh();
          if (signal.aborted) return;
          const saved = confirmed?.work.find(record => record.id === id);
          if (!confirmed || previousIds.has(id) || !saved || saved.input !== input || saved.assignees.length !== 1 || saved.assignees[0] !== assignee) {
            throw new Error('Work creation could not be confirmed in refreshed saved work.');
          }
          setSelected(id); setInput(''); setInputTouched(false); setServerInputError(''); pendingFocus.current = 'execute';
        });}}>
          <label htmlFor="employee">Assign to</label><select id="employee" required disabled={busy.has('work')} value={assignee} onChange={e => { setEmployee(e.target.value); setServerInputError(''); }}><option value="">Select an employee</option>{state?.employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <label htmlFor="input">What would you like help with?</label><p id="input-help">Save work creates separate work without executing it. Retry resends the original saved text, including when you have edited this draft.</p>
          <textarea id="input" ref={inputRef} disabled={busy.has('work')} aria-required="true" rows={7} aria-invalid={!!inputError} aria-describedby="input-help input-limits input-error input-unsaved" value={input} onChange={e => { setInput(e.target.value); setInputTouched(true); setServerInputError(''); }} />
          <p id="input-unsaved" role="status" aria-live="polite">{hasUnsavedDraft ? 'Unsaved request. Save work or clear this text before leaving. Reloading or closing this page can lose your draft.' : ''}</p>
          <p id="input-limits">Enter nonblank text up to 100,000 UTF-8 bytes. Saving also has a 120,000-byte limit after text escaping. Shorten or split requests that exceed either limit; pasting keeps your full draft.</p>
          <p id="input-error" role="status" aria-live="polite">{inputError}</p>
          <button disabled={!!creationRecovery || !connected || busy.has('work') || !!replacement || !assignee}>Save work</button>
        </form><p role="status" aria-live="polite" aria-atomic="true">{draftNotice}</p></section></aside>
        <section id="employee-work" className="history"><h2>3. Work &amp; results</h2>
          <p id="empty" hidden={!!state?.work.length}>No work yet. Your saved work and results will appear here.</p>
          <label htmlFor="search">Search saved work</label>
          <input id="search" type="search" ref={searchRef} value={search} aria-describedby="search-help" onChange={e => setSearch(e.target.value)} />
          <p id="search-help">Search the full saved input, ignoring case. Spaces and markup match literally; accents are distinct.</p>
          <button type="button" onClick={() => { setSearch(''); searchRef.current?.focus(); }}>Clear search</button>
          <label htmlFor="outcome">Current outcome</label>
          <select id="outcome" value={outcome} aria-describedby="outcome-help" onChange={e => setOutcome(e.target.value as WorkOutcome | 'all')}>
            <option value="all">All outcomes</option>
            <option value="pending">Pending work</option>
            <option value="active">Active attempts</option>
            <option value="results">Available results</option>
            <option value="failed">Failed or interrupted work</option>
          </select>
          <p id="outcome-help">Combines with search using the latest recorded attempt. Results remain unverified; active attempts may be caller-reported. All outcomes also includes other recorded states. When disconnected, filters use the last loaded history.</p>
          <button type="button" onClick={() => { setViewEmployee(''); setSearch(''); setOutcome('all'); searchRef.current?.focus(); }}>Show all loaded work</button>
          <p role="status">{viewEmployee ? `Assigned work for ${state?.employees.find(e => e.id === viewEmployee)?.name ?? 'an unavailable employee'} · Employee ID: ${viewEmployee}. ${connected ? '' : 'Using stale assignments from the last successful refresh.'}` : 'Showing work for all employees.'}</p>
          {!!viewEmployee && <button type="button" onClick={() => { setViewEmployee(''); searchRef.current?.focus(); }}>Return to all employees</button>}
          <p>Employee navigation only changes this view. It does not save, assign or execute work.</p>
          <ul aria-label="Matching requests">{matches.map(w => <li key={w.id}><button type="button" onFocus={event => { focusedRequest.current = {id: w.id, input: w.input, element: event.currentTarget}; }} onClick={() => { setSelected(w.id); historyRef.current?.focus(); }}>Open request: {w.input.slice(0, 55)} · ID: {w.id}</button></li>)}</ul>
          <p role="status" aria-live="polite" aria-atomic="true">{matchingAnnouncement}</p>
          <p id="search-count" role="status" aria-live="polite" aria-atomic="true">{state ? `${matches.length} of ${state.work.length} saved requests match.` : 'Saved history has not loaded yet.'}</p>
          {!!state?.work.length && !matches.length && <p>No saved work matches your employee, search and outcome filters. This employee may have no assigned work. Change either filter, change the employee selection, return to all employees or choose Show all loaded work to reset all filters.</p>}
          {selectedExcluded && <p id="selection-help">The selected work is outside these matches. Its detail remains selected below. Select a match to change it.</p>}
          <label htmlFor="history">Saved work</label><select id="history" ref={historyRef} aria-describedby={selectedExcluded ? 'selection-help' : undefined} value={selectedExcluded ? '' : work?.id ?? ''} onChange={e => { setSkillRequest(null); setHookRequest(null); setLoopRequest(null); setSelected(e.target.value); }}>
            {(selectedExcluded || !work) && <option value="" disabled>Select a matching request</option>}
            {matches.map(w => <option key={w.id} value={w.id}>{w.input.slice(0, 55)} — {workStatus(w)} · ID: {w.id}</option>)}
          </select>
          <WorkInspection skillRequest={skillRequest?.taskId === selected ? skillRequest : null} hookRequest={hookRequest?.taskId === selected ? hookRequest : null} loopRequest={loopRequest?.taskId === selected ? loopRequest : null} taskId={selected || null} connected={connected} />
          <WorkHandoff taskId={work?.id ?? null} connected={connected} />
          <div id="detail">{work && <>
            <h3>Saved work</h3><p>Work ID: {work.id}</p><p className="badge">{workStatus(work)}</p><pre>{work.input}</pre>
            <p>Assigned to: {work.assignees.map(id => state?.employees.find(e => e.id === id)?.name || id).join(', ') || 'No employee assigned'}</p>
            <HistoryExport key={`history/${work.id}`} work={work} employees={state?.employees ?? []} connected={connected} />
            <button type="button" ref={draftActionRef} disabled={busy.has('work') || !!replacement} onClick={() => {
              if (locks.current.has('work')) return;
              if (input.length) setReplacement(work); else loadDraft(work);
            }}>Use as new draft</button>
            {replacement && <section role="region" aria-labelledby="replace-title" onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); cancelReplacement(); }
            }}>
              <h4 id="replace-title">Replace your unsaved draft?</h4>
              <p>This replaces your draft text and employee selection with the selected saved work. Original saved history stays unchanged.</p>
              <button type="button" ref={cancelRef} onClick={cancelReplacement}>Cancel</button>
              <button type="button" disabled={busy.has('work')} onClick={() => loadDraft(replacement)}>Replace draft</button>
            </section>}

            <LoopExecution key={`loop/${work.id}`} work={work} workspace={state!} connected={connected}
              draft={input} disabled={baseCannotExecute} availability={loopAvailability}
              submit={async (path, payload, emergency) => {
                let failure: unknown;
                let receipt: unknown;
                await mutate(emergency ? `stop/${work.id}` : work.id, async signal => {
                  try { receipt = await api<unknown>(path, payload, signal); }
                  catch (error) { failure = error; throw error; }
                });
                if (failure) throw failure;
                return receipt;
              }} />
            <HookExecution key={`hook/${work.id}`} work={work} workspace={state!} connected={connected}
              draft={input} disabled={cannotExecute}
              submit={preview => { void mutate(work.id, async signal => {
                await confirmExecution(await api<unknown>(`/api/work/${encodeURIComponent(work.id)}/execute`, {hook_preview_id: preview.preview_id, expected_runs: preview.expected_runs}, signal), work, state!, signal, preview);
              }, true); }} />
            <SkillExecution key={`skill/${work.id}`} work={work} workspace={state!} connected={connected}
              draft={input} disabled={cannotExecute}
              submit={preview => { void mutate(work.id, async signal => {
                await confirmExecution(await api<unknown>(`/api/work/${encodeURIComponent(work.id)}/execute`, {preview_id: preview.preview_id, expected_runs: preview.expected_runs}, signal), work, state!, signal, preview);
              }, true); }} />
            <button id="execute" ref={executeRef} type="button" disabled={cannotExecute} onClick={() => execute()}>{work.attempts.length ? 'Retry explicitly' : 'Execute work'}</button>
            {resubmission !== null && <section ref={resubmissionRef} role="region" aria-labelledby="resend-title" aria-describedby="resend-help" onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); cancelResubmission(); }
            }}>
              <h4 id="resend-title">Resend saved work?</h4>
              <p id="resend-help">This resends the original saved input, creates another attempt and preserves all previous results. Your unsaved draft and employee selection stay unchanged.</p>
              <div className="result-actions">
                <button type="button" ref={resendCancelRef} onClick={cancelResubmission}>Cancel resend</button>
                <button type="button" disabled={cannotExecute} onClick={() => execute(true)}>Confirm resend</button>
              </div>
            </section>}
            {!!work.attempts.length && <p>A retry sends the saved text again and creates a separate attempt. Previous results stay in history.</p>}
            {[...work.attempts].reverse().map((attempt, i) => <AttemptResult key={`${work.id}/${attempt.id}`} attempt={attempt} work={work} number={work.attempts.length - i} latest={i === 0} />)}
          </>}</div>
        </section></div>
      <footer>Responses are unverified. Read and check the full result before using it.</footer>
      <Configuration connected={connected} workspace={state} openRecord={configurationRequest} />
      <Connections openClient={clientRequest} workspaceConnected={connected} />
    </main>
  </>;
}
