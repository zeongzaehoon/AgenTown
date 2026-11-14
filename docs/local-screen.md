# Local employee and work screen (React + TypeScript)

This screen connects employee creation → saved and assigned text → provider
execution → progress and full results → retained history. Results are **unverified**;
a response does not complete the Task or establish its quality.

## Launch from the checkout

Use Node 24.15 or newer in the Node 24 line, npm, Python 3.13, Rust/Cargo and a writable database path whose parent already exists. Node is needed only to build the frontend. On macOS:

```sh
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
uv sync --directory python --locked
uv run --directory python --locked maturin develop --locked
uv run --directory python --locked agentown-web --database /tmp/llm-work.sqlite3 --model YOUR_MODEL_ID
```

On Windows PowerShell, after installing the Python/Rust build prerequisites:

```powershell
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
uv sync --directory python --locked
uv run --directory python --locked maturin develop --locked
uv run --directory python --locked agentown-web --database "$env:USERPROFILE\llm-work.sqlite3" --model YOUR_MODEL_ID
```

Intentionally supply `ANTHROPIC_API_KEY` in the server's runtime environment and
choose a model available to your account. Do not paste credentials into the screen.
There is no credential discovery, browser configuration form or production demo
provider. Missing credentials/model leave history usable and display configuration
instructions; set the server environment/model and restart to enable execution.

Open **http://127.0.0.1:8765**. An optional `--port 8766` changes both the listening
port and required origin; open that exact URL. The server binds only to IPv4
loopback, disables proxy-header trust and does not expose a remote-host option.
Only run it for your own local account; this is not a multiuser authentication service.

1. Enter an employee name and choose **Create employee**. Focus moves to work text.
2. Select that employee. Enter, for example, `Summarize in one sentence: The team
   agreed to ship the draft on Friday.` Choose **Save work**.
3. The saved text and assignment appear as **Pending**. Choose **Execute work**.
   **Running** means the request is waiting; no progress percentage is estimated.
4. Read the full text under **Result available · Unverified**. Attempts include
   model, provider, Work ID and Attempt ID. Test-injected responses are explicitly
   marked as tests; normal Anthropic requests are identified as real provider requests.
5. For failure, inspect the specific recovery advice. **Retry explicitly** sends
   the same saved text again under a new Run; it retains all earlier attempts.
   To change text, save a new work item. No automatic resend occurs.
6. Stop with Ctrl+C, launch again with the same database path, and reload the same
   URL. Saved work, employees and attempt results remain. A dropped browser
   connection leaves history visible with a stale-data notice and disables saves and execution.
   Copy and download remain available for already loaded results.
   Reconnect and inspect before retrying: a lost response does not prove no send.

Graceful shutdown allows up to 70 seconds for in-flight provider I/O. If the
process is forcibly stopped, the original Rust lease lasts at most 120 seconds
from admission; history polling recovers expired attempts as interrupted. Before
expiry an attempt remains **Running** (waiting/uncertain), with recovery guidance.
No scheduler resumes or resends it. Explicit retry must wait for terminal recovery.

## Team HTTP API (C22-T1)

After the checkout installation steps above, launch with an existing writable
database parent. No model or provider credentials are needed for team operations:

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-teams.sqlite3
```

From another terminal, create an employee and a team, then substitute the returned
IDs in the membership request:

```sh
curl http://127.0.0.1:8765/api/teams
curl -H 'Origin: http://127.0.0.1:8765' -H 'Content-Type: application/json' \
  -d '{"name":"Writer"}' http://127.0.0.1:8765/api/employees
curl -H 'Origin: http://127.0.0.1:8765' -H 'Content-Type: application/json' \
  -d '{"name":"Delivery"}' http://127.0.0.1:8765/api/teams
curl -H 'Origin: http://127.0.0.1:8765' -H 'Content-Type: application/json' \
  -d '{"members":["EMPLOYEE_ID"]}' http://127.0.0.1:8765/api/teams/TEAM_ID/members
curl http://127.0.0.1:8765/api/teams
```

`GET /api/teams` returns `{"teams":[{"id":"…","name":"Delivery","members":["…"]}]}`
(initially an empty list). `POST /api/teams` returns the created team with status
201; adding members returns the updated team with status 200. Names accept 1–200
characters and must be nonblank; Rust trims them. Member requests accept 1–100
employee ID strings, each at most 100 characters. The shared serialized JSON body
limit is 120,000 bytes (413 on overflow). Invalid input returns 400 with safe
guidance; list/storage access failures return safe errors without raw database
details. Native storage failures represented as validation errors return 400;
OS errors and list failures return 503. Mutation requests require the exact
loopback Origin and JSON content type. Responses retain redaction and no-store.

Add an invalid ID alongside an existing employee, repeat a member in one batch,
or add a current member alongside a new employee: each request must fail and the
list must retain its previous membership. Rust validates and commits the whole
batch atomically. Stop the server and restart with the same database path; GET
must return the same team ID and membership. Team operations never invoke a
provider, assign work or start a scheduler. The team screen is a separate Task.

`python/tests/test_web.py` includes deterministic API persistence, atomicity,
input-boundary, origin, redaction and safe-error cases. This implementation
workspace lacks product test dependencies and native bindings, so runtime API
tests, server launch and supervisor-selected consolidated/browser checks remain
pending verification. Live provider calls are skipped, not passed.

## Implementation decisions and boundaries

- Typed React components build with Vite into `python/src/llm_engine/static/`;
  production HTML/CSS/JavaScript are served by Starlette and Uvicorn. Python handles
  HTTP presentation and async provider SDK I/O; Rust creates/assigns work atomically,
  admits Runs, enforces concurrency, persists results and recovers expired attempts.
  The full work text uses the existing immutable Task title; an execution snapshots
  it into the existing immutable execution input. No new schema or Python store.
- Each execute HTTP request awaits the existing async provider port. Other HTTP
  requests can inspect state during provider waits. No Python task queue, scheduler,
  automatic retry or background execution registry. Rust compares the observed
  attempt count inside its admission transaction, so a duplicated execute request
  cannot become a fresh retry even after the first response finishes.
- Form handlers synchronously disable duplicate clicks until a request resolves;
  the browser never automatically repeats mutations after a lost response. Creation
  endpoints are not general idempotency-key APIs: manually replaying a create HTTP
  request creates another entity. Inspect history after a disconnect before saving again.
- Exact Host plus Origin, JSON content type and Fetch Metadata checks constrain
  mutations to same-origin requests. History polling is also a protected JSON POST
  because Rust recovery can persist an interrupted outcome; GET serves only assets.
  No CORS access is enabled. CSP restricts assets
  and requests to self, disables framing and base elements. All variable DOM text
  uses React text children, never HTML interpretation. API errors are fixed messages;
  configured credentials are redacted even from legacy stored text in responses.
- Native fields have explicit HTML labels, focus outlines, keyboard operation,
  textual status, live announcements, contrast and responsive layout. No motion is
  required. React reconciles stable keyed attempts and controls to preserve focus, expanded history and text selection. Effects only poll history; all saves and execution requests originate in event handlers. Superseded snapshots are ignored and effects cancel polling on cleanup.
- Existing CLI-created Tasks and reported Runs can be inspected. Execution needs
  exactly one employee. A reported Run is not presented as a provider response.
- The current Rust snapshot-read cost remains. No streaming, teams UI, installers,
  3D, quality approval, or whole-product completion is claimed.

## Research used before implementation (2026-09-13)

- https://starlette.dev/threadpool/ describes synchronous endpoint thread dispatch.
  Decision: retain async endpoints and the existing async SDK so provider waits do
  not block the event loop; do not move domain scheduling into Python.
- https://starlette.dev/middleware/ describes Host protection and notes that simple
  cross-origin requests can still reach an app under CORS middleware. Decision:
  explicitly reject foreign mutation origins before routing, not merely omit CORS
  response headers. Use a pure ASGI wrapper for response headers and request gates.
- https://www.w3.org/WAI/WCAG22/quickref/ covers keyboard access, focus visibility,
  labels, contrast and status messages. Decision: native controls, visible outlines,
  text labels and polite live connection/execution status; no invented percentages.
- https://playwright.dev/python/docs/test-runners documents actual browser contexts,
  screenshot and trace artifacts. Decision: deterministic provider gate behind a real
  subprocess server, Chromium interaction test with screenshots and tracing.
- Uvicorn settings URLs (`https://www.uvicorn.org/settings/` and
  `https://www.uvicorn.org/`) could not be fetched through the research tool.
  Launch parameters were checked against the installed package while implementing.

## Verification

Run the native rebuild to completion before Python checks:

```sh
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
cargo test --manifest-path rust/Cargo.toml --workspace --locked
uv run --directory python --locked maturin develop --locked
uv run --directory python --locked python -m pytest
uv run --directory python --locked playwright install chromium
LLM_ENGINE_BROWSER=1 uv run --directory python --locked python -m pytest -s tests/test_web_browser.py
python3 .harness/cli.py check
```

In PowerShell use `$env:LLM_ENGINE_BROWSER = "1"` before the browser command.
`LLM_ENGINE_BROWSER_EVIDENCE` selects the output directory; otherwise tests use a
pytest temporary directory. Optional `LLM_ENGINE_BROWSER_CHANNEL=chromium` selects
the full Chromium build instead of the headless shell. Browser tests are explicitly
skipped in the normal unit suite unless enabled; a skipped test is not validation.

The browser test covers empty, pending/reloaded, keyboard execution, running/reload,
duplicate clicks, failure/retry, full safe text, disconnected controls, server restart
and retained results, historical interrupted recovery and a narrow viewport. An
expired valid fixture exercises recovery without changing the product clock; this
is distinct from C8-T2's required killed-process integration evidence.

Actual outcomes and source hashes are in `docs/evidence/c7-t2-*`. Browser execution
was attempted on macOS arm64; see the implementation evidence report for the actual
outcome. No Windows, screen-reader, installed-wheel or live-provider walkthrough has
been performed for this Task. Live credentials were not intentionally supplied.
PLAN.md section 8 remains incomplete pending browser/live installed-workflow evidence.

## C8-T1 migration research and build evidence

Consulted before choosing the migration:

- https://react.dev/learn/synchronizing-with-effects distinguishes user-event
  mutations from effects, and requires cleanup for external synchronization.
  Decision: saves/execute only in guarded handlers; StrictMode exercises cleanup;
  polling never retries execution and ignores superseded snapshots.
- https://vite.dev/blog/announcing-vite8 documents Vite 8 and its Node
  20.19+/22.12+ requirement. https://vitest.dev/guide/ describes its Vite-based test
  pipeline. Use one Vite configuration for JSX compilation and DOM behavior tests.
- https://www.typescriptlang.org/docs/handbook/react.html documents typed JSX.
  Both root scripts run explicit `tsc --noEmit`; transpilation alone is insufficient.
- https://www.w3.org/WAI/WCAG22/quickref/ informed retention of native keyboard
  controls, labels, visible focus, responsive reflow and status announcements.
- Official npm package metadata (queried with `npm view`):
  https://registry.npmjs.org/vite/latest (8.3.0),
  https://registry.npmjs.org/react/latest (19.3.0),
  https://registry.npmjs.org/typescript/latest (7.0.2),
  https://registry.npmjs.org/vitest/latest (5.0.0),
  https://registry.npmjs.org/jsdom/latest (30.0.1), and
  https://registry.npmjs.org/@testing-library%2freact/latest (16.3.3).
  React Testing Library declares React 19 compatibility; jsdom requires Node
  24.15+ on the Node 24 line. Exact dependency versions and transitive integrity
  hashes are retained in `package-lock.json`.

Build before `maturin develop` or wheel construction; generated assets and
`node_modules` are ignored. The Python service serves only the production build,
with no Vite development server, inline scripts, CDN assets or Node runtime.
Missing build assets produce actionable HTTP 503 guidance. Wheel installation
and live validation belong to C8-T2.

The current harness supplies Node 24.21.0 on PATH; no temporary Node installation
or service change is needed. Ordinary checks and source hashes for the resumed
implementation are retained in `docs/evidence/c8-t1-handoff-*`.
No verification artifact was supplied for this implementation stage. The supervisor
will produce the matching checks log and sibling browser artifacts after the
`ready_for_verification` handoff; earlier runs are not evidence for this snapshot.
No Chromium launch is attempted inside the restricted sandbox. Deterministic DOM
and API tests do not establish browser or live-provider validation. Windows,
screen-reader and live-provider checks remain unperformed; section 8 is incomplete.

## C8-T2: build and install a wheel outside the checkout

Build on each target OS/architecture with Python 3.13, Rust and Node 24 installed.
Run from a clean product checkout (neither `.agents` nor `.harness` is a build
input). The frontend must be built **before** the wheel. These commands preserve
`package-lock.json`, `Cargo.lock` and `uv.lock`; they do not update dependency locks.

```sh
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
uv sync --directory python --locked
cargo test --manifest-path rust/Cargo.toml --workspace --locked
uv run --directory python --locked maturin develop --locked
uv run --directory python --locked python -m pytest
uv run --directory python --locked maturin build --locked --out dist
uv export --directory python --locked --no-dev --no-emit-project --output-file dist/requirements.txt
```

Distribute the matching platform wheel and exported `requirements.txt` together.
The export pins runtime dependencies and their hashes; the wheel's normal version
ranges alone do not lock its dependencies. On macOS, copy those files to a directory
outside the checkout, open a terminal there and run:

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python --require-hashes -r requirements.txt
uv pip install --python .venv/bin/python --no-deps ./agentown-0.1.0-cp313-cp313-macosx_11_0_arm64.whl
uv pip check --python .venv/bin/python
.venv/bin/agentown-web --database "$PWD/work.sqlite3" --model YOUR_MODEL_ID
```

Use the actual wheel filename emitted on your platform. On Windows PowerShell,
copy the Windows wheel and requirements file outside the checkout, then run:

```powershell
uv venv --python 3.13 .venv
uv pip install --python .venv\Scripts\python.exe --require-hashes -r requirements.txt
uv pip install --python .venv\Scripts\python.exe --no-deps .\agentown-0.1.0-cp313-cp313-win_amd64.whl
uv pip check --python .venv\Scripts\python.exe
.venv\Scripts\agentown-web.exe --database "$PWD\work.sqlite3" --model YOUR_MODEL_ID
```

Before launch, intentionally set `ANTHROPIC_API_KEY` in that terminal's environment
using your normal secret-management method. The command line takes a model, never
a key. End users need Python and installed dependencies; Node, Rust, the checkout,
`.agents` and `.harness` are unnecessary at runtime. The database parent must exist.
Follow steps 1–6 above on either platform, including Ctrl+C and restarting the exact
same command/database to recover the full response. No live request is performed by
the deterministic test provider. Provider output remains unverified.

### Installed validation and evidence

`uv run --directory python --locked python -m pytest -s tests/test_installed_web.py` builds a fresh
wheel, exports locked requirements and installs it into a new temporary virtualenv.
It runs the real `agentown-web` executable outside the checkout with Node absent
from PATH, checks missing configuration and served asset references, and tests a
synthetic secret without contacting a provider. It then injects a deterministic
provider through the existing port to prove failure, explicit retry, retained full
output, actual process kill during an outstanding request and natural Rust lease
expiry (approximately two minutes). It never rewrites a lease or changes the clock.
The submission journal must remain at three calls across recovery and restart.
Set `LLM_ENGINE_PACKAGE_EVIDENCE` to retain logs, wheel, source/asset hashes,
Task/Run IDs and the recovered SQLite database at a known location.

The existing supervisor command for `python/tests/test_web_browser.py` now uses the same
fresh-wheel fixture automatically, without configuration changes. Its screenshots,
interaction JSON, trace, provider submission journal, database and package evidence
remain in the supervisor-supplied `LLM_ENGINE_BROWSER_EVIDENCE` directory. It retains
all original UI assertions and replaces the historical interruption fixture with an
actual killed request and lease wait. Browser execution belongs to that supervisor
run; this implementation does not claim its future artifacts already exist.

Research consulted before this packaging change (2026-09-13):

- https://www.maturin.rs/project_layout.html explains mixed Python/Rust layout and
  ignored data inclusion. Retain the explicit static asset include and compare
  every built asset byte with the wheel archive.
- https://pyo3.rs/v0.27.2/ documents the selected PyO3 version and extension-module
  feature. Keep native rebuilds sequential before Python verification.
- https://docs.astral.sh/uv/concepts/projects/export/ documents exporting a lockfile
  to requirements format. Install the hashed runtime export before the wheel with
  `--no-deps`, then check installed dependency consistency.
- https://docs.python.org/3.13/library/subprocess.html distinguishes terminate,
  kill and wait, including platform differences. Use kill plus wait and assert a
  nonzero exit for interruption evidence rather than inserting historical records.
- https://playwright.dev/python/docs/trace-viewer documents trace screenshots and
  DOM snapshots. Retain tracing and screenshots for the installed browser flow.

Live-provider validation requires an intentionally supplied runtime key and model;
none was supplied for C8-T2 implementation. The actual full provider response shown
in the installed browser and recovered after restart remains outstanding. Windows,
screen-reader and installer checks are also unperformed. PLAN.md section 8 remains
incomplete; teams UI, 3D, additional providers and the broader desktop product remain
whole-product gaps. Consult `docs/evidence/c8-t2-implementation.md` for actual checks.


## Copy and download saved results (C9-T1)

Launch using `agentown-web --database PATH --model MODEL` as documented above.
Expand any saved attempt and choose **Copy result** or **Download text** beneath
its result. Tab reaches both buttons; Enter or Space activates them. Copy sends
the full plain text to the clipboard. If access is denied or unavailable, the
screen reports that failure and offers Download text. Feedback is announced
politely without moving focus. A download request is reported as requested,
since the browser controls whether and where it is saved.

Downloads contain the full UTF-8 text (no added heading, BOM or truncation), named
`agentown-attempt-ATTEMPT_ID.txt`. Unicode, whitespace and literal markup are
retained; markup is never executed. Copy passes the same full string to the
platform clipboard; OS clipboard/paste behavior can affect line endings.
Unverified and test-response labels remain on screen; exported text is the saved
result alone, so exporting does not certify its quality.

Both actions work after reopening saved history and on already loaded results
while disconnected. They do not call the server, execute a provider, create Runs
or change saved history. Reloading a disconnected page cannot retrieve history;
reconnect first if it was not already loaded.

Research consulted before implementation (2026-09-13):

- https://www.w3.org/TR/clipboard-apis/#dom-clipboard-writetext specifies an
  asynchronous plain-text write with permission rejection. Use an explicit button
  gesture, await success, and catch both missing API and denied access.
- https://www.w3.org/TR/FileAPI/ specifies Blob string encoding and object URL
  lifetime. Use a text/plain UTF-8 Blob with default transparent line endings and
  release its URL after the browser has time to consume it.
- https://html.spec.whatwg.org/multipage/links.html#downloading-resources describes
  download links and suggested filenames. Use an attempt ID restricted to ASCII
  letters, numbers, hyphen and underscore; do not derive filenames from output.
- https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html and
  https://www.w3.org/WAI/WCAG22/quickref/ support native keyboard controls and
  programmatically exposed status without focus movement. Use a polite, atomic
  status region per saved result.

Actual C9-T1 ordinary outcomes are retained in `docs/evidence/c9-t1-*`.
The extended installed Chromium supervisor flow retains exact downloaded bytes,
copy/focus interactions and screenshots after restart, offline and for a historical
result after interruption. Its current-snapshot execution is pending supervisor
verification; previous browser runs do not validate this change. Windows, other
browsers and screen-reader checks have not run. C8-T2 live-provider configuration
and actual live response/restart acceptance remain outstanding; section 8 is
incomplete.

### Reuse saved work as a draft (C10-T1)

Launch `agentown-web --database PATH --model MODEL` using the installation steps
above. Select Saved work, then activate **Use as new draft**. The existing form
receives the full saved input and its sole employee if that employee is still
available. Otherwise select an employee explicitly. Edit the text and choose
**Save work** to create separate pending work with no attempts. Execute work is
still a separate action. **Retry explicitly** always resends the original saved
input, regardless of edits in the form; original results and attempts stay intact.
Saving preserves leading and trailing whitespace, multiline Unicode and literal
markup exactly. Whitespace-only requests are rejected.

If the form contains any text (including whitespace), a Replace draft/Cancel
confirmation appears with focus on Cancel. Enter activates the focused choice;
Escape within the confirmation cancels. Cancel returns focus to Use as new draft
and keeps text and employee unchanged. Replace moves focus to the editor. The
confirmation captures the selected request, so later history selections do not
change which input it will load. Polling never replaces draft edits. Saving locks
the form and replacement action until the request settles. Loaded history remains
available for drafting offline; saving requires reconnection. Drafts are local
unsaved form state and are not retained across page reloads.

Research consulted for this implementation:

- https://react.dev/reference/react-dom/components/textarea — controlled `value`
  plus synchronous `onChange` retains editable multiline text. Keep draft state
  separate from refreshed history and use plain text, without HTML interpretation.
- https://www.w3.org/WAI/WCAG22/quickref/ — keyboard operation, focus order and status
  messages inform native buttons, explicit focus destinations and polite feedback.
- https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/ — modal dialogs require
  constrained focus and appropriate return focus. This small confirmation uses a
  labelled inline region instead of claiming modal semantics; Cancel receives
  initial focus, and cancellation restores the action's usable focus.

C10-T1 ordinary checks run on macOS arm64. Installed Chromium validation is pending
supervisor handoff for this snapshot; the extended flow retains offline editing,
keyboard cancellation, revised/original Task IDs and content, screenshots and
restart comparisons, while preserving export and three-submission process-kill
coverage. Windows, screen-reader and other browser validation have not run.
C8-T2 live-provider configuration and acceptance remain outstanding; deterministic
checks do not complete PLAN.md section 8.

### Search saved work (C11-T1)

Launch with `agentown-web --database PATH --model MODEL` using the installation
steps above. Under Work & results, type in **Search saved work**, then choose a
match from **Saved work** to inspect its full input and attempt history. Labels
include stable full Work IDs so requests with identical previews are distinguishable.
The matching/total count describes loaded requests. Clear search clears text,
retains the outcome filter and returns focus to the search field. No matches is separate from an
empty workspace. A selected detail outside the matches stays visible with an
explanation; search never selects a different request. Successful Save work still
selects the newly saved request even if it falls outside the search.

Matching is a literal substring of the entire input (including beyond the 55-character
preview), after JavaScript Unicode `toLowerCase()` on both strings. Empty search
matches all. Whitespace, punctuation, emoji and markup are literal; no trimming,
regex, HTML interpretation, accent removal, Unicode normalization or locale-specific
case folding is applied. For example ÉCOLE matches école, but e does not match é,
and ss does not match ß. Search and selection only inspect loaded data and create
no work, attempts or provider requests. Draft text/assignee and expanded results
remain unchanged by search, clear and polling. Loaded history can be searched when
disconnected; the stale-history notice remains visible and mutations are disabled.

Research consulted for C11-T1:
- https://react.dev/learn/you-might-not-need-an-effect — calculate filtered display
  data during render; keep query and selection independent rather than synchronizing
  filtered results through effects.
- https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolowercase
  — Unicode default case conversion; `includes` provides literal substring matching.
- https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html — search counts
  are status messages; use a persistent polite atomic region whose text changes
  only when counts change, avoiding repeated unchanged polling announcements.
- https://www.w3.org/WAI/WCAG22/quickref/ — retain native labelled keyboard controls
  and visible focus; Clear search returns focus without remounting the detail.

Coverage: behavior tests run on macOS arm64; installed supervisor Chromium search
screenshots/interactions and exact persisted-content comparisons are pending the
C11-T1 verification gate. Windows, other browsers and assistive-technology testing
have not run. C8-T2 live-provider acceptance remains outstanding.

History consistency repair (C11-T1): the API recovers expired leases and reads
employees, requests, Runs and execution results in one Rust-owned SQLite
transaction. A response therefore retains one coherent snapshot even if an
execution finishes immediately afterward; the next poll observes the new state.
This adds no schema change, submission or automatic retry. Search still filters
only the loaded history in the browser.

Research: [SQLite isolation](https://www.sqlite.org/isolation.html) explains that
separate reads can observe different committed transactions; BEGIN IMMEDIATE
serializes writers and permits recovery followed by consistent reads within the
same transaction. This is why the history API now uses one native snapshot instead
of separate Run and execution queries. The full-snapshot read cost remains.

### Recorded attempt times (C12-T1)

Launch `agentown-web --database PATH --model MODEL`, select saved work, and expand
an attempt to see its recorded start and end. Dates include the year, milliseconds
and explicit UTC zone (independent of the device zone); `<time datetime>` retains
the exact ISO instant. These are Rust Run timestamps, passed through the existing
coherent history snapshot with no schema change or additional history read. Start
means the attempt was recorded before provider I/O; end means its terminal outcome
was recorded. They are not provider-side timestamps or measured request durations.
Interruption time is when interruption was recorded during recovery, not the precise
process-stop time. Active attempts with no end say so; missing, invalid or values
outside the native 1970–9999 range say “Time unavailable,” never the current time.
Caller-reported attempts are explicitly separate from provider requests. Test and
unverified result labels remain; polling supplies no elapsed progress or completion.
Loaded dates remain inspectable when disconnected, with the existing stale warning.

Research: the [HTML time element](https://html.spec.whatwg.org/multipage/text-level-semantics.html#the-time-element)
supports a machine-readable datetime separate from its visible text. The
[ECMA-402 date formatting specification](https://tc39.es/ecma402/#datetimeformat-objects)
allows explicit time zones; fixed UTC ISO-derived text was chosen here to keep the
same readable precision and dates across devices without relying on locale defaults.
[WCAG quick reference](https://www.w3.org/WAI/WCAG22/quickref/) informs preserving
keyboard/focus and status messages; static dates are outside live regions to avoid
polling announcements. No additional dependency is required.

Coverage for this change: ordinary checks on macOS arm64; installed supervisor
Chromium screenshots, interactions and exact persisted timestamp comparisons are
pending handoff. Windows, other browsers and screen readers have not been tested.
C8-T2 live configuration/response validation remains outstanding; section 8 is incomplete.

### Pasting and request limits (C13-T1)

Launch `agentown-web --database PATH --model MODEL` as above. Paste or edit the
full request, choose an employee, then Save work. Pasting no longer has a
25,000-unit cap. Saving requires nonblank text within **100,000 UTF-8 bytes** and
an entire JSON request body within **120,000 bytes**, including the employee ID,
JSON keys and escaping. Both limits are inclusive. Quotes, backslashes, newlines
and control characters can increase the serialized size. These are storage and
transport limits, not token estimates or guarantees of provider capacity.

Field-associated guidance identifies invalid/oversized text and asks you to
shorten it or split it into separate requests. A rejected save keeps the complete
draft and employee selection; correct the text and save again. Local validation
sends no save or execution request. Server size rejection has distinct guidance
from employee/database errors and provider configuration. Rust still validates
native text, and the server still enforces its streamed-body limit. Saving never
executes a provider. Polling and temporary disconnection preserve the in-page
draft; reloading or closing the page does not persist unsaved drafts.

Accepted text preserves spaces, literal markup, Korean, emoji and combining
characters without Unicode normalization. Browser textarea values normalize CRLF
and CR line endings to LF before JSON submission. The API itself preserves line
endings. Blank detection follows Unicode White_Space, matching native Rust trim
rather than JavaScript trim (NEL is whitespace; BOM is not). Invalid lone UTF-16
surrogates receive correction guidance instead of silently becoming replacement
characters. Existing credential rejection/redaction remains in effect.

Research consulted for this change:
- https://html.spec.whatwg.org/multipage/form-elements.html#the-textarea-element — textarea API newline normalization and maxlength behavior; remove maxlength to preserve pasted input.
- https://encoding.spec.whatwg.org/#interface-textencoder — TextEncoder encodes UTF-8; measure text and the exact JSON.stringify payload independently.
- https://doc.rust-lang.org/std/primitive.str.html#method.trim — native trim uses Unicode White_Space; align advisory blank checks without modifying submitted text.
- https://www.w3.org/WAI/WCAG22/quickref/ and https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA21 — identify errors, suggest corrections and associate aria-invalid with the field.

Ordinary checks run on macOS arm64. The extended installed Chromium supervisor
flow must still verify real clipboard paste, oversized correction, exact long
saved text after restart, and existing recovery/export/search/time assertions.
Browser verification is pending at implementation handoff. Windows, other
browsers and screen readers have not been validated. C8-T2 live-provider evidence
still requires intentionally supplied configuration; section 8 remains incomplete.

### Output-limit recovery (C14-T1)

Launch `agentown-web --database PATH --model MODEL` with intentional Anthropic
configuration as described above. If an answer reaches the fixed 2048-token output
cap, the attempt fails with the sanitized `output_limit` code. Its partial response
is not retained, displayed as a result, or quality-approved. Open the failed attempt
for guidance, choose **Use as new draft**, and ask for a shorter answer or split the
work into separate requests. Save creates separate work; execute it explicitly.
The original request and attempts remain in history. **Retry explicitly** resends
unchanged input and may reach the same limit again. There are zero automatic retries;
the existing SDK 45-second, request 60-second and execution 65-second timeouts remain.

The new code uses the existing execution error field and atomic Rust terminal write;
there is no schema expansion or rewriting of historical malformed-response records.
Reopening preserves the failure, absent output and recorded terminal timestamp.

Research: [Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
distinguish natural `end_turn`, truncated `max_tokens`, and `refusal`. We inspect the
stop reason before content and choose explicit draft correction under the existing
cap. [Anthropic Python SDK](https://github.com/anthropics/anthropic-sdk-python)
documents configurable timeouts and default retries; the adapter retains explicit
`max_retries=0` to avoid unrequested submissions.

C14-T1's historical ordinary checks ran on macOS arm64; the isolated team worker
checks are recorded separately in `docs/evidence/c14-t1-ai-worker.md` and do not
establish installed-package validation of the current snapshot. Installed Chromium coverage now includes
a separately counted output-limit/corrected-draft/restart scenario, retaining the
original flow's three submissions and paste/search/export/timestamp/process-kill
checks. The separate scenario journal records the exact original and corrected
requests with their model, so verification can compare actual fixture submissions
against retained history. Supervisor browser execution is pending at implementation handoff. Windows,
other browsers and screen-reader execution remain untested. Deterministic responses
do not satisfy C8-T2's outstanding intentional live-provider acceptance.

### Unsaved request leave warning (C15-T1)

Launch `agentown-web --database PATH` with an existing writable parent directory
and open http://127.0.0.1:8765. Credentials and a model are unnecessary for this
exercise; missing configuration disables provider execution but permits saving.

1. Create an employee if needed. Type request text: the field-associated
   **Unsaved request** notice appears. Even whitespace-only text gets the warning,
   although it cannot be saved until corrected to nonblank text.
2. After interacting with the page, try reloading or closing the tab. Where the
   browser offers a native leave confirmation, choose to stay and inspect the draft.
3. Search or select saved history and refresh the connection: the draft stays in
   the field. Stop the server to exercise disconnection; the warning remains.
   Restart with the same database and refresh the connection to continue.
4. Choose **Save work** explicitly. Protection remains while saving and after a
   rejected or uncertain save. Only confirmed saving or clearing all text removes
   the warning. Inspect history before saving again after uncertain delivery.
5. Choose **Use as new draft** on saved work: its loaded text is a new unsaved
   draft and receives the same warning. Saving does not execute work.

The page requests native confirmation using `beforeunload`. Browsers control
whether a dialog appears and its wording; they generally require prior user
interaction and may omit it, especially on mobile or when a process is terminated.
Dialogs are not guaranteed. This feature does not persist or automatically save
unsaved drafts: leaving, reloading or closing can still lose them. Polling and
leave events never save requests or invoke a provider.

Deterministic frontend tests cover the confirmation signal, field association,
whitespace, loaded drafts, pending/rejected/confirmed saves, disconnected history
interaction and StrictMode listener cleanup. They do not prove actual browser
dialogs. Supervisor frontend tests/build and ordinary Python checks are pending
at implementation handoff; browser checks depend on the selected verification
profile. Live provider tests are skipped under the current user policy.

### Confirm resending a saved result (C16-T1)

Launch `agentown-web --database PATH` and open http://127.0.0.1:8765 to inspect
saved-result history. Without provider configuration, execution stays disabled.
For the complete interaction without credentials or live calls, use the existing
test-only server in a prepared development environment (with built frontend assets):

```sh
# Choose a new database and gate path in an existing writable directory.
printf 'success' > /tmp/c16-response-gate
uv run --directory python --locked python tests/web_browser_server.py /tmp/c16-work.sqlite3 8766 /tmp/c16-response-gate
```

Open http://127.0.0.1:8766, create an employee, save work and execute it once.
The fixture returns a clearly labelled test result and appends each submission to
`/tmp/c16-response-gate.calls`. This fixture is separate from the production CLI;
it does not enable a production demo mode. Stop any existing server on that port
before starting it. These are exercise instructions, not evidence of execution.

1. Enter a different unsaved draft and select its employee. On the saved result,
   choose **Retry explicitly**. The labelled **Resend saved work?** region explains
   that confirmation resends saved input, adds an attempt and retains old results.
   Focus starts on **Cancel resend**. Opening sends no execution request.
2. Press Enter to cancel, or reopen, Tab to **Confirm resend**, then press Escape.
   Focus returns to Retry; draft, employee selection, saved selection and results
   stay unchanged. The fixture submission count must remain one.
3. Reopen and wait through polling. Confirmation and focus stay in place. Tab to
   **Confirm resend** and press Enter, or rapidly click it twice. Exactly one new
   submission is recorded (total two), with a separate attempt. The draft stays
   unchanged; both saved results remain. Focus moves to the Saved work selector.
4. Open confirmation and change saved selection, or stop the fixture server until
   disconnection appears. Confirmation closes. Reconnect with the same database:
   it does not reopen or send anything. Changed attempts, assignment, cancellation,
   model or execution configuration also require fresh confirmation. If focus was
   inside confirmation, it returns to Retry when usable, otherwise Saved work;
   focus on another control remains there.
5. First execution and retries whose latest attempt has no output remain direct.
   To exercise failure recovery, set the gate file to `fail`, confirm one resend,
   inspect the failure, then set it to `success` and Retry explicitly.

Deterministic frontend coverage in `App.test.tsx` asserts request counts and the
existing `expected_runs` body, keyboard and cancellation behavior, unchanged
polling, stale confirmation invalidation, draft/result preservation, empty output
and failed-latest-attempt recovery. No API or persistence contract changes.
Frontend dependencies are absent in this isolated implementation workspace, so
frontend tests/build and the selected consolidated verification checks remain
pending supervisor execution. Browser validation is pending where the selected
profile requires it; live-provider validation is skipped, not passed.

### Recover from stalled responses (C17-T1)

The client allows **15 seconds** for each history refresh, employee save or work
save, and **75 seconds** for execution (above the existing 65-second server
provider boundary). Each deadline includes fetching headers **and reading the JSON
body**, using one total budget. A mutation then inspects history with a separate
15-second budget. Thus save locks release within **30 seconds**, and execution
locks within **90 seconds**, even if both requests stall. These are client timer
budgets; suspended tabs or a blocked browser event loop can delay timer delivery.
History polling resumes after timeout; **Refresh connection** can supersede a
pending history read immediately. Successful inspection restores connection controls.

A client timeout is uncertain delivery: saving or execution may already have
occurred, and aborting the browser request does **not** prove provider cancellation.
Read the timeout notice, check the server, choose **Refresh connection**, and inspect
employees, saved work and attempts before choosing any explicit retry. Recovery
only inspects state; it never automatically replays employee creation, saving or
execution. An active attempt still prevents execution, expected attempt counts
still guard admission, and resending a saved result still requires confirmation.
If history also times out, loaded history remains visible as stale and mutations
stay disabled until connection is restored. Unsaved work text, employee name and
assignment remain; a confirmed save may clear the submitted text as usual.
Late timed-out responses cannot clear drafts or replace newer history. Unmounting
cancels outstanding reads and mutations and releases their timers/listeners.

Exercise with `agentown-web --database PATH` and http://127.0.0.1:8765 using an
existing writable database parent. Credentials are unnecessary for history and
save exercises. Use a development request interceptor that can hold a response
indefinitely (headers or JSON body); simply stopping the server may fail immediately
and exercises disconnection instead of the deadline.

1. Load existing work, type an unsaved request and employee name, and choose an
   employee. Hold `/api/state`; within 15 seconds inspect the stale-history timeout
   guidance and retained fields. Release the interceptor and choose **Refresh
   connection**. History reconnects without saving or executing anything.
2. Separately hold `/api/employees` and `/api/work` responses after submitting once.
   Repeat with headers delivered but the body held. Inspect the uncertain-delivery
   notice, retained unsaved values and released controls. Inspect server history
   before explicitly saving again: a lost save response can conceal a saved entity.
3. Allow a mutation response, but hold its subsequent `/api/state` response. After
   15 seconds the draft controls unlock; confirmed work saving clears only its
   submitted draft. Repeat holding both responses to exercise the 30-second total
   save bound. Reconnect; the mutation must have been submitted exactly once.
4. For execution, use the existing deterministic test fixture described above,
   without live credentials. Hold execution headers or body beyond 75 seconds,
   optionally holding recovery history for another 15 seconds. Inspect history
   before retrying: active attempts remain protected; results require resubmission
   consent. Keep an unrelated draft and assignment unchanged throughout.
5. Deliver an old held response after reconnecting; it must not replace history or
   clear unsaved fields. Navigate away with a pending request to exercise cleanup.

`api.test.tsx` and `deadlines.test.tsx` use fake timers and deliberately uncooperative
fetch/body promises to assert these boundaries, cancellation, late responses,
reconnection, cleanup and exactly one mutation submission. Existing App tests retain
active-attempt, expected_runs and resubmission coverage. These are deterministic
fixtures, not live-provider evidence. Integration validation passed all 21 focused
API/deadline tests and TypeScript checking using existing dependencies. The unmount
test drains jsdom’s zero-delay focus selection event before checking that both
pending request deadlines and the polling interval are removed. Consolidated
frontend tests/build and ordinary Python checks remain pending supervisor
verification. Browser validation is pending where required by the selected profile.
Live LLM calls remain skipped, not passed.

### Filter by current outcome (C18-T1)

With prepared frontend assets and the product installed, run:

```sh
agentown-web --database /tmp/c18-work.sqlite3
```

Open http://127.0.0.1:8765. No credentials or model are needed to create employees,
save requests, or filter loaded history; execution remains disabled without
configuration. Use an existing database to inspect its recorded attempts.

1. Create two employees and save `Plan for Friday` and `Shopping list`. Type
   `PLAN` into **Search saved work** and choose **Pending work** in the labelled
   **Current outcome** selector. Expect `1 of 2 saved requests match.`
2. Choose **Available results**. For these newly saved requests, expect zero
   matches and guidance to change either filter or reset both. The previously
   selected work stays visible below with an explanation that it is outside matches.
3. Enter unsaved text and change **Assign to**. Tab to **Current outcome**, use
   the platform's native select keys to change it, then activate **Show all loaded
   work** by keyboard. Both filters reset, all loaded requests return, and focus
   returns to search. The draft, employee and selected detail remain unchanged.
   **Clear search** clears only text and retains the selected outcome.
4. Stop the server and wait for **Disconnected**. Repeat filtering and reset:
   loaded history remains usable, with its stale-history warning. No save or
   execution request is caused by filtering. Restart with the same database and
   choose **Refresh connection** to see updated history.

For credential-free result and polling exercises, use the test-only server in the
C16-T1 instructions above with a fresh database. Its responses are deterministic
fixtures, not live validation. Save work and execute explicitly, select **Available
results**, expand its result, and enter a draft. Remove the test gate file
(`/tmp/c16-response-gate`) before explicitly retrying with confirmation:
while the latest attempt is active it moves out of the results matches without
closing the older expanded result or losing the draft. Write `success` back to
the gate file to release the response; it returns to the results matches. Repeat
with `fail` to observe **Failed or interrupted work** and retained older results. Filtering itself must not increase the fixture's
`.calls` submission count. For failed/interrupted and caller-reported histories,
the deterministic frontend cases exercise those structured states without a provider.

Categories follow the same classification as the displayed work status: the latest
attempt takes precedence (active, non-null output including empty text, interruption,
failure, then other recorded attempt). Earlier results do not make a currently
failed or active request match **Available results**. Results remain **Unverified**;
active attempts without a provider remain **Caller-reported**, with no provider
request implied. **Pending work** includes pending requests without attempts.
**All outcomes** includes cancelled, blocked, in-progress work without attempts,
and other recorded states. Counts describe the intersection with text search in
loaded history, including while disconnected.

Implementation added deterministic classification and frontend interaction tests.
This invocation could not execute them because this isolated workspace has no
frontend test dependencies. Supervisor-selected frontend tests, typecheck/build,
ordinary Python checks and applicable browser validation remain pending; no browser
artifact is claimed. Live LLM validation is skipped, not passed. Existing C11-T1
React, Unicode search and WCAG research above is reused; no new research was needed.

### Download saved work history (C19-T1)

Launch the installed product with prepared frontend assets using
`agentown-web --database PATH`, then open http://127.0.0.1:8765. Select **Saved
work** and choose **Download saved history** (also usable with Tab and Enter).
The UTF-8 `.txt` file contains the selected work ID, exact saved input, assigned
employee names and IDs, and every loaded attempt in recorded order, with IDs,
participants, timestamps, provider/model, outputs and failures. Missing employee
names retain their IDs. Empty output differs from absent output. Results remain
unverified; test responses and caller-reported attempts are identified. Interruption
recording time is not presented as the precise process-stop time.

No credentials are needed: use existing saved history, or create an employee and
save a pending request without executing. For multiple attempts and failures, use
the existing credential-free C16-T1 test-server fixture above, explicitly execute,
and retry with its success/fail gate. These test responses are not live validation.

Enter a different unsaved draft and assignment before downloading. Inspect the
file: it must contain only the selected saved work, with no unrelated draft.
Stop the server, refresh to see **Disconnected**, and download again: loaded
history remains available and the file warns that it may be stale. Downloading
neither saves nor executes work, nor changes draft, assignment or saved selection.
Existing per-result **Download text** remains available. Success feedback means
the browser download was requested, not proof that the file was written; if a
browser download operation fails, an accessible message offers retry.

`frontend/src/history-export.test.tsx` inspects actual download Blob content using
deterministic Unicode, multi-attempt, failure, interruption, empty-output,
caller-reported, pending and disconnected fixtures. It also asserts keyboard
feedback, failure/retry, preserved selections/draft and no added API requests.
This isolated implementation workspace lacks frontend dependencies; these tests,
TypeScript/build and supervisor-selected consolidated checks remain pending.
Browser validation is pending supervisor verification where required. Live-provider
validation is skipped, not passed. Existing File API, HTML download and WCAG
research recorded above is reused; no new research uncertainty was introduced.

The download failure cases cover both object-URL creation and anchor-click
failures, asserting preserved focus, unsaved text, assignment and saved history;
retry exports saved input only. To run these focused checks in a prepared
development checkout, use `npm --prefix frontend test -- src/history-export.test.tsx`.

Known consolidated browser-check issue: both third-attempt retry branches in
`python/tests/test_web_browser.py` omit **Confirm resend** after **Retry explicitly**
on a saved result. That flow requires confirmation, as documented for C16-T1.
The browser fixture needs repair under its own file ownership before those
branches can verify execution. The saved-history export retains the existing
resend consent behavior. Browser validation remains pending; no passing browser
result is claimed.

### Connections (C20-T3)

In a prepared checkout, build/package the frontend using the installation steps
above, then launch the product with an explicit database:

```sh
uv run --directory python --locked agentown-web --database /absolute/company.sqlite
```

Open `http://127.0.0.1:8765`. Tab to **Open connections** and press Enter.
Choose **Client** (Codex or Claude Code) and **Platform** (macOS or Windows)
using the native keyboard-accessible selects. **Copy setup instructions** copies
the selected configuration, preparation, inspection, supported actions, consent
and recovery steps. Replace both example paths before merging the configuration.
The read-only **Setup instructions** text area also supports manual selection and
copying when clipboard permission is denied. Copy success explicitly leaves
client readiness unknown; neither configuration nor connection verification is
inferred. No installed client settings, credential stores or harness data are read.

The visible workspace connection is separate from external client readiness.
Stop the local web server and choose **Refresh setup**: loaded instructions and
selection remain visible with a stale/unavailable message. Restart the same web
server and refresh setup again to recover. Use **Refresh connection** to recover
workspace history. Hiding Connections leaves employee, draft, assignment and work
history mounted and preserves the existing execution/resend consent flow.
Connections only calls the versioned presentation endpoint; it never executes work.

The same-origin, no-store `POST /api/connections/v1` presents the published stdio
workflow v1 and four C20-T2 configuration variants without runtime documentation
reads or probing clients. The static setup response defaults all clients to
unknown. There is no persisted connection registry or client verification in this
Task. Windows setup availability does not establish Windows launch validation.

Implementation observations: Python compilation and direct parsing/comparison of
all four generated configurations against C20-T2 artifacts passed. Pytest is not
installed and frontend dependencies are absent in this isolated workspace, so
frontend behavior/API tests and visible browser behavior remain **pending
supervisor verification**, not observed passes. Live provider calls were skipped.
See [the invocation record](evidence/c20-t3/implementation.md).

### Company overview (C21-T1)

With prepared frontend assets and the product installed, launch
`agentown-web --database PATH` (use an existing writable parent directory) and
open http://127.0.0.1:8765. No credentials or model are needed for this exercise.

1. Create two employees, including two with the same name if desired. The
   **Company overview** identifies each by its full employee ID and initially
   shows **No assigned work**. Missing execution setup is a separate message.
2. Save a request assigned to each employee without executing it. The pending
   counts update from the same workspace refresh used by saved history. Counts
   represent recorded requests, not estimated progress. Results remain unverified;
   caller-reported active attempts do not imply provider execution.
3. For existing shared assignments, count each request once for each assigned
   employee, even if the assignment ID is repeated. Employee totals can therefore
   exceed company request totals. Existing blocked/cancelled work appears in
   **Other recorded work**. Unassigned work and assignments only to unavailable
   employees appear under **Work without a current employee**. Choose **Open
   work** there to inspect its saved detail; this resets history filters without
   changing an unsaved draft. Shared/unassigned fixtures are covered deterministically
   in component tests; the save form continues to assign one employee.
4. Type an unsaved draft, stop the server and wait for disconnection. The overview
   retains counts with an explicit stale-data warning. Restart the same database
   and refresh the connection: recorded counts recover without automatic execution.
   An initial unavailable response instead shows no invented empty employee state.
5. Resize to a narrow viewport and use Tab/Enter to open unassigned work. Cards
   wrap, labels remain textual, and existing visible focus styling applies. The
   overview has no animation; the existing reduced-motion rule remains in effect.

`CompanyOverview.test.tsx` covers mixed categories, empty output, duplicate names,
shared and repeated assignments, unavailable employees, loading/empty/stale data,
unassigned navigation, the existing 800ms App polling, disconnect/reconnect and
retained drafts. Frontend dependencies are absent in this isolated workspace;
these tests and TypeScript/build remain pending supervisor verification, together
with supervisor-selected consolidated and browser checks. No browser execution
or visual artifact is claimed here. Live provider calls are skipped, not passed.
Existing WCAG guidance recorded in this document is reused; no new research
uncertainty or API/schema change was introduced.

### Open an employee's assigned requests

Launch `agentown-web --database PATH` and open <http://127.0.0.1:8765>.
Create two employees (duplicate names are supported), choose each employee in
**Assign to**, enter separate text and **Save work**. No provider credentials
are needed to save or navigate; do not execute for this walkthrough.

Activate an employee's name button in Company overview with a pointer, Enter or
Space. The button exposes its selected state and its accessible name includes
the employee ID. Work & results shows only requests assigned to that ID,
intersected with the existing text and outcome filters. Choose **Open request**
to open the existing saved-work detail; keyboard focus moves to Saved work.
An excluded detail stays visible, with an explanation. **Return to all employees**
removes only the employee filter; **Show all loaded work** resets all filters.
Both return keyboard focus to search.

Keep unsaved text and a different draft assignment while navigating. Filtering
and reset preserve those values and expanded results for the selected request.
Opening different work uses the existing retry-consent invalidation safeguards.
Polling updates assignment matches without selecting another detail. If the
selected employee disappears, their ID remains visible as unavailable. Empty
matches explain the filters; a disconnected view labels its last loaded
assignments as stale and still permits local navigation. Navigation never saves,
reassigns or executes requests.

Deterministic App interaction coverage exercises duplicate IDs/names, Enter and
Space, composed filters, detail focus, retained drafts/results, polling,
unavailable employees, stale data, consent and zero navigation mutation calls.
The installed Chromium flow in `python/tests/test_web_browser.py` additionally
creates two same-name employees with separate saved requests and exercises real
keyboard focus, opening, reset and disconnected navigation, recording
`13-employee-navigation-offline.png` and the employee/request IDs in
`interactions.json`. These browser checks are pending supervisor execution for
this Task; live provider calls remain skipped under the user policy.

## Teams: creation, membership and assigned work (C22-T2)

Use the launch command above and open the local product URL. Team management
requires no provider key or model. The team API prerequisite is C22-T1.

1. Create two employees with the same name and save a different request for each;
   do not choose Execute work. Note the full employee and work IDs.
2. Choose **Browse teams**. While fetching, the screen announces loading; an empty
   database shows **No teams yet**. Create a team by entering **Team name** and
   pressing Enter. Focus moves to **Saved team**, whose options include full IDs.
   Create another team with the same name and distinguish the two by ID.
3. Select the first team. Tab to the intended employee checkbox, press Space,
   then activate **Add members**. Membership is saved only by that action. Focus
   returns to Saved team and the persisted member appears with their full ID.
   Team membership does not assign work or start collaboration.
4. Enter another team-name draft and select a prospective member. Switch teams
   and back: the membership draft remains. Disconnect the browser from the local
   server and attempt Add members. The failure retains drafts and marks loaded
   data stale. Reconnect, choose Refresh connection and Refresh teams, inspect
   persisted membership, and explicitly save any remaining selections. No
   mutation is automatically retried. Refreshing alone does not save drafts.
5. Reload the page, choose Browse teams and the same team ID. Its saved members
   remain; unsaved team drafts are session-only and are not persisted on reload.
   Activate **View member work** with Enter: focus moves to Search saved work,
   and existing assigned requests are filtered by employee ID. Activate the
   matching **Open request** to focus Saved work and inspect the recorded work.
   Loaded member navigation also works while disconnected, using stale data.
6. Confirm the original work draft/assignment remain during team navigation and
   pending result retry consent is preserved unless the underlying work or
   execution availability changes. Browsing and team saves make no execute calls.

Deterministic coverage: `frontend/src/Teams.test.tsx` covers loading, empty,
failed/stale/recovered states, duplicate team/employee names, per-team drafts,
creation, persisted membership on remount and ID-based navigation. The installed
browser scenario in `python/tests/test_web_browser.py` adds keyboard/focus,
offline recovery, reload persistence and navigation with a mutation journal;
it writes `teams.json` and `14-teams-persisted-navigation.png` alongside its
existing trace and interaction journal. Browser execution and visual inspection
are pending supervisor verification for this implementation snapshot. Live LLM
validation is skipped, not passed, under the current user policy.

## Skills, Hooks and Loop configuration (C24-T2)

Prerequisite: C24-T1's [configuration API](configuration-api.md). After the normal
frontend build/product install above, launch the local product server:

```sh
agentown-web --database /tmp/configuration-workspace.sqlite3 --port 8765
```

Open <http://127.0.0.1:8765>. No credentials or model are required. Create an
employee and save a pending work request without executing it; optionally create
a team. These provide Hook targets and Loop work references.

1. Tab to **Open configuration**, press Enter, and wait for **Showing saved
   configuration**. Select **Skill** in **Record type**, enter Name and
   Instructions, then **Create Skill**. Focus moves to **Saved record**. Note
   its stable ID and inspect **Saved values**, which shows persisted fields.
2. Edit Name/Instructions and choose **Save changes**. Choose **Enable
   configuration**, then **Disable configuration**. Inspect the saved boolean.
   Configuration does not execute work; runtime execution of Skills, Hooks and
   Loops is unavailable even when enabled.
3. Select **Hook**, choose a saved Skill, Employee or Team target type, target
   and event. Create, edit fields, save and toggle it. Select **Loop**, choose
   saved work, enter 1–100 maximum iterations and 60–86400 interval seconds,
   create, edit, save and toggle it. All selectors show stable IDs, including
   duplicate names. Empty lists require creating references first. The server
   remains authoritative if a reference becomes unavailable.
4. Choose **Create new** in Saved record to create another record. Switch
   between types/records with an unsaved draft: drafts remain within the session.
   Enter invalid/blank values and observe validation and disabled save controls.
5. Stop the server and attempt a save or **Refresh configuration**. Loading and
   saving are announced; failure retains drafts and loaded saved values, marks
   data stale/disconnected and disables mutations. Restart using the same command
   and database. Choose Refresh configuration and inspect Saved values and the
   record list (a failed create may already have persisted). Refresh never resends
   mutations. Explicitly choose Save/Create only after checking; an uncertain
   create retried blindly could create another record. Drafts remain for comparison.
6. Reload the page, reopen Configuration and select the same IDs. Edited fields
   and enabled/disabled values must persist. Stop/restart the server with the same
   database and repeat. Unsaved drafts are session-only and discarded by reload.
   Use Tab/Shift+Tab, Enter and native select keys throughout; focus is visible
   using the existing focus outline. Inspect status/error announcements.

`frontend/src/Configuration.test.tsx` provides deterministic interaction fixtures
for all three kinds, edits, explicit toggles, validation, ID-based selection,
remount persistence, loading/empty/disconnected/error recovery, retained drafts,
and requests restricted to configuration/reference endpoints (no execution).
These fixtures do not prove server restart persistence. Supervisor frontend
checks/build and the applicable consolidated verification profile remain pending;
real browser exercise/screenshots are pending only if that profile requires them.
This implementation invocation did not run browser or installed-product checks.
Live provider calls remain skipped, not passed. Existing WCAG research and the
C24-T1 API documentation were reused; no new research uncertainty arose.

C26-T3 Connections: the packaged service provides five choices, runtime-specific
stdio merge fragments for local clients and an HTTPS/OAuth prerequisite checklist
for ChatGPT. Copy and download are explicit actions and never advance connection
status. Installation detection is a bounded hint only. Exact current settings
paths, validation and recovery appear in the read-only instructions. Keyboard
users can open Connections, select a client and activate either action with
standard native controls. See `docs/desktop.md` for installed launch/recovery steps.

### Preview and execute one Skill

Launch `agentown-web --database /tmp/agentown-skill.sqlite --port 8765`
and open http://127.0.0.1:8765. Create an employee and save work. In Configuration,
create a Skill with instructions and enable it. Enabling configuration does not
execute anything; Hooks and Loops remain inactive. Provider/model settings must
be intentionally supplied for execution; live provider validation is skipped.

In the saved work detail, choose an enabled Skill and activate **Preview Skill
with saved work**. Native select and button controls support Tab, arrows, Space
and Enter. Review the server's full effective instructions and saved work, then
activate **Execute once with Skill**. Focus moves to that explicit action after
preview; Cancel returns focus to preview. Preview performs no provider call.
The ordinary Execute work / Retry explicitly action continues to use no Skill.
A Skill preview always refers to saved work, never the unsaved draft.

Editing the draft, changing selected work, recorded attempts, provider/model or
Skill configuration, or losing connectivity invalidates consent. Skill records
are refreshed periodically; the server also rejects changed/disabled/stale
previews at admission. Each submission consumes the preview and uses the
existing duplicate-admission guard. A retry requires a fresh preview and explicit
execution. After uncertain delivery, inspect attempts with **Refresh connection**
before retrying; background polling never clears this inspection requirement or
resends work. The latest attempt shows immutable saved Skill name/ID, preview ID,
instructions and effective input alongside its result/error and attempt ID.
Subsequent configuration edits do not change saved provenance.

Deterministic browser interaction and visual validation for this snapshot are
pending the supervisor gate. A fixture response is not live-provider evidence.

### Preview and explicitly execute an employee Hook (C28-T2)

For saved production work, launch `agentown-web --database /tmp/agentown-hook.sqlite --port 8765`
and open <http://127.0.0.1:8765>. Execution needs intentionally supplied provider
configuration. Live provider calls are skipped under the current policy.

To exercise the complete flow without credentials, use the existing test-only
server with built frontend assets and the prepared Python development environment:

```sh
printf 'success' > /tmp/c28-hook-gate
uv run --directory python --locked python tests/web_browser_server.py /tmp/c28-hook.sqlite 8766 /tmp/c28-hook-gate
```

Open <http://127.0.0.1:8766>. Create employee Writer, save a short text request,
and choose **Execute work**. Wait for the deterministic TEST RESPONSE and a
finished attempt. In Configuration create and enable a Skill (for example,
name Follow-up, instructions “Write a concise follow-up”). Create and enable a
Hook targeting Writer, referencing that Skill, with event `run_completed`.
Return to the saved work detail.

1. Under **Apply an employee Hook**, choose the matching Hook using Tab and arrow
   keys. Press Enter on **Preview Hook with saved work**. Preview sends no
   provider request: `/tmp/c28-hook-gate.calls` still has one line. The preview
   shows the server-composed effective input and source event, Run ID and outcome.
2. Focus moves to **Execute once with Hook**. Escape or **Cancel Hook preview**
   closes consent and returns focus. Preview again and explicitly execute once.
   The fixture call count becomes two; no automatic third attempt appears.
3. Open the new attempt. **Saved Hook provenance** shows the persisted Hook,
   source Run/event/outcome, employee, Skill, preview ID, instructions and input.
   Editing configuration afterwards does not rewrite that provenance.
4. Preview again, then edit the unsaved draft or change the Hook/Skill in
   Configuration. Consent is invalidated on the next configuration refresh;
   changed work, attempts and provider/model also invalidate it. Disabled Hooks,
   missing/disabled Skills, and unmatched targets/events have distinct choice
   labels. Team and `task_created` Hooks are unmatched in this bounded flow.
5. Stop the fixture server. Disconnected state removes consent. If an execution
   response was lost, **Submission needs inspection** prevents fresh consent
   until **Refresh connection** succeeds. Background polling does not clear that
   requirement. Restart the fixture with the same database, refresh, inspect
   attempts, then request a new preview before explicitly retrying.
6. For `run_failed`, set the gate file to `fail`, explicitly retry ordinary saved
   work and wait for its failure; configure an enabled `run_failed` employee Hook.
   Interrupted and caller-reported outcomes do not qualify for this adapter.

Ordinary execution and direct Skill preview remain separate explicit actions.
Enabling a Hook never dispatches work or activates a Loop. The commands above are
runnable fixture instructions, not evidence that browser execution passed in this
invocation. Frontend behavior tests cover consent and recovery; frontend
checks/build, applicable supervisor checks and browser validation are pending
handoff. Live-provider validation remains skipped, not passed.

### Preview, start and stop bounded Loops (C29-T3)

Prerequisite: C29-T2's Loop execution API. Build/package the frontend using the
steps above, launch `agentown-web --database /tmp/agentown-loop.sqlite --port 8765`,
and open <http://127.0.0.1:8765>. For deterministic exercise without credentials,
use the documented `tests/web_browser_server.py` fixture command above with a new
Loop database and gate file set to `success`; this uses test responses only.

Create an employee, save work, then create and enable a Loop for that saved work
in Configuration (for example maximum 2 attempts, interval 60 seconds). Enabled
means configured; nothing starts automatically. In the saved work detail choose
**Saved Loop**, then **Preview Loop with saved work**. Review the saved input,
employee ID, maximum attempts and interval. Preview makes no provider call.
Tab/Enter and native select keys work throughout. Focus moves to **Authorize and
start bounded Loop**; Escape or Cancel closes consent and restores focus.

Explicitly authorize once. Session IDs, admitted counts, provider/model and actual
attempt records appear below. Waiting means recorded attempts finished while the
server still controls further admissions; the screen does not estimate progress
or run its own scheduler. A complete session is labeled Exhausted. Failed,
stopped, expired, restarted and stale sessions remain distinct. Hooks and Skills
are never automatically activated. Existing work execution controls are disabled
while this work has an active Loop or Loop inspection is unavailable.

**Stop Loop** remains available during execution and while ordinary execution is
disabled. Stop prevents further admissions and attempts local cancellation;
remote completion may remain unknown. With the deterministic gate file absent,
start then stop to exercise cancellation; set it to `fail` to exercise failure.
Leave a successful two-attempt session running to observe waiting then exhausted.
Inspect immutable attempt IDs/results, rather than assuming a response was cancelled.

Draft, saved work, provider/model, configuration or connection changes invalidate
previews. Start consent is consumed before awaiting a response; competing work
submissions share the existing mutation guard. On uncertain delivery, refresh the
connection and inspect sessions and attempts before obtaining fresh consent.
Stop/restart the fixture server with the same database, refresh and inspect the
recovered session state; reconnecting never restarts a Loop. Loaded sessions are
marked stale while disconnected and remain visible. Preview and status controls
provide focus recovery and polite accessible announcements.

Behavior coverage is in `frontend/src/LoopExecution.test.tsx` and the existing
App and deadline fixtures. Run `npm test` and `npm run build` from `frontend/` for
the consolidated frontend checks. Workspace connection and Loop inspection load
independently; execution becomes available only after both are ready. After saving
work, keyboard focus moves to Execute when that control becomes available.
Browser flow validation remains pending. No fresh installed-browser artifact is
required solely for this frontend scope. Real LLM validation is skipped, not passed.

### Company overview Loop inspection (C30-T1)

Launch the product with `agentown-web --database /tmp/agentown-loop.sqlite --port 8765`
and open <http://127.0.0.1:8765>. The company overview's **Bounded Loop activity**
reads `/api/loops/v1` independently of workspace polling. It shows recorded
sessions, employee and work IDs, active/waiting or terminal labels, and admitted
counts. These counts are separate from ordinary employee workload counts.

For deterministic exercise without credentials:

```sh
printf 'success' > /tmp/agentown-loop-gate
uv run --directory python --locked python tests/web_browser_server.py /tmp/agentown-loop.sqlite 8765 /tmp/agentown-loop-gate
```

1. Create an employee and save a request. In Configuration create and enable a
   Loop targeting that work, with maximum 2 attempts and interval 60 seconds.
2. In saved work, preview the Loop and explicitly authorize its start. The
   overview shows its session ID and admitted count. With successful fixture
   responses it moves from Active to Waiting and eventually Exhausted. To hold
   an attempt active, remove the gate file before starting a fresh session.
3. Type an unsaved request and a saved-work search filter. Wait through refreshes:
   both remain intact. Tab to **Open work** on the Loop session and press Enter.
   This explicit navigation clears work filters, selects the linked saved work,
   and focuses **Saved work**, preserving the unsaved request. Inspect the existing
   **Run a bounded Loop** section and its **Stop Loop** control. Navigation itself
   never starts or resumes execution.
4. Stop a held session using **Stop Loop** and inspect its stopped label. Use a
   gate containing `fail` for a failed attempt. Results remain test responses and
   unverified. Unknown/deleted employee IDs remain visible; absent loaded work
   has an unavailable-link message instead of a misleading navigation control.
5. To exercise independent inspection failure, block `/api/loops/v1` in browser
   request blocking while leaving `/api/state` available. After the next poll,
   workspace data stays connected while Loop inspection shows stale sessions.
   Unblock it to recover. Blocking before initial load shows unavailable data,
   rather than an empty-session claim. Initial loading has its own message.

Deterministic coverage is in `OverviewLoops.test.tsx` and
`CompanyOverview.test.tsx`: transitions, independent failure/recovery, linked-work
navigation/focus, draft/filter preservation, abort and timer cleanup. This
invocation did not run browser validation; supervisor frontend tests/build,
ordinary Python checks and browser validation remain pending. Live provider calls
remain skipped, not passed.


Loop ownership and history (C34): launch `agentown-mcp --database /absolute/path/product.db`
and `agentown-web --database /absolute/path/product.db` against the same database
(use each command's `--help` for provider/model options). Opening the web screen
and polling Loop history does not claim execution authority, recover sessions or
dispatch work. Inspection adds `control: {state, can_control, message}`; states
are `available`, `local_authority`, `competing_owner`, `storage_failure` and
`closed`. Availability is advisory: Rust still exclusively admits every mutation.
No owner handle or runtime identity is returned.

When MCP owns execution, stop the Loop using `stop_loop_v1` on that same MCP
server. The web service cannot cancel another server's operation. To transfer
control, gracefully shut down the owning server, then explicitly start/stop from
the new service. Merely refreshing history after release does not recover or
replay work. Explicit control recovers abandoned sessions as restarted without
replaying them; a new activation needs a fresh, explicitly approved preview.
Storage failures require checking database/lock-file permissions and access,
not repeatedly trying to take control. Live provider validation remains skipped.

### Ownership-aware Loop screen exercise (C34-T2)

Use the credential-free browser fixture command in the C30 exercise above; its
responses are test data, not live provider validation. Both **Bounded Loop
activity** and saved work now show **Caller-declared source (unverified)**. A
missing/null source reads **Unknown / legacy session**. This label is metadata,
not proof of which server owns execution.

For deterministic UI exercises, use the interaction cases in
`frontend/src/LoopExecution.test.tsx` and `OverviewLoops.test.tsx` (supervisor runs
`npm test` in `frontend`). They supply the existing `/api/loops/v1` contract
without credentials. The observable states are:

- `available`: local preview/start and active-session Stop are eligible, subject
  to ordinary saved-work restrictions and explicit consent.
- `local_authority`: the screen says this server owns execution. Emergency Stop
  remains available even when ordinary execution is disabled.
- `competing_owner`: history remains connected/readable and Open work remains
  usable; local Loop preview/start/Stop are disabled. Follow the displayed
  instructions to use `stop_loop_v1` on the owning MCP server or Stop on the
  owning web server. Shut down that owner to transfer authority, then inspect
  again and explicitly retry. Polling never performs the transfer or recovery.
- `storage_failure`: local control is disabled with database/lock-file access
  guidance; previously loaded sessions remain visible with a stale notice.
- `closed`, missing or unknown authority: local Loop actions fail closed.
- Inspection transport failure: disconnected/unavailable inspection is shown
  separately from ownership; loaded records remain marked potentially stale.
  Successful polling restores inspection and eligible controls without sending
  any start or stop request. Any invalidated preview requires new consent.

With a draft entered, navigate from a company Loop card to saved work and wait
through polling and failures. The draft and history remain; navigation focuses
Saved work. Control changes invalidate a displayed preview. Stop prevents new
admissions and attempts local cancellation; remote completion may remain unknown.
Availability is advisory and the server can reject an ownership race. Such
failures retain inspection-before-retry guidance and never automatically resend.
Browser validation and consolidated frontend/build/Python checks are pending the
supervisor gate. Live provider validation remains skipped, not passed.

### Saved-work caller attribution API (C35-T1)

`POST /api/state` now includes `declared_source` on every saved-work attempt.
The value is caller-declared, unverified metadata from native `execution_sources`,
joined by Run ID after `history_snapshot` performs its existing recovery. Missing
metadata (including ordinary web executions and legacy reporter Runs) is JSON
`null`; no identity is inferred from participants, provider or reporting source.
Skill and Hook provenance, attempt ordering and snapshot status remain intact.

Implementation invocation checks: the available product Python 3.13 environment
ran `pytest python/tests/test_web.py -q -k 'not
same_origin_boundary_configuration_and_redaction'`: **37 passed, 1 deselected**.
The initial run also exercised that existing test; its asset-count assertion
failed because this isolated source workspace lacks built frontend assets.
The supervisor must rerun it with built assets. New deterministic tests exercise
persisted ordinary MCP, Skill and Hook sources, null web/legacy values, Run/Task
association, ordering, reopening, read-after-snapshot ordering and sanitized
source-read failures. No real provider calls were made.

A separate process invoked the `agentown-web` entry point (`llm_engine.web.main`)
with `--database <temporary-product.db> --port 18765`. It used this checkout's
Python source and the already available product native binding, without rebuilding
or changing the installed package. The database was copied from the deterministic
attribution test. A real HTTP request was made with:

```sh
curl -H 'Origin: http://127.0.0.1:18765' -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:18765/api/state
```

Observed response: two saved Tasks, six attempts, and sources
`["other-client", null, null, "codex", "cursor", "claude-code"]` in response order.
Temporary artifacts for this invocation are
`/var/folders/dx/ny9cjsmd1bb3r42zbp694xkh0000gn/T/c35-workspace-2oxpq1_h/`
(`product.db`, `state.json`, `server.log`). The process shut down normally.
These are fixture results, not live provider evidence. Browser validation and
consolidated checks remain pending the supervisor gate; live LLM tests are skipped
under the user policy, not passed.


### Inspect saved-work caller attribution (C35-T2)

Launch the product against an existing database containing saved attempts:

```sh
agentown-web --database /path/to/product.db --port 8765
```

Open http://127.0.0.1:8765, choose a request in **Saved work**, and expand
its **Attempt** summaries. Tab to each summary and press Enter or Space to
expand or collapse it. Every attempt displays **Caller-declared source
(unverified)** from that attempt's recorded metadata. Ordinary, Skill and Hook
attempts may have different sources; the saved Skill/Hook provenance remains
available alongside it. Missing metadata, including older history, displays
**Unknown / not recorded**. Source text is displayed literally, including markup.
This attribution establishes neither authenticated identity, Loop ownership nor
provider verification. It does not change the existing result quality labels.

Leave multiple attempts expanded through a history refresh: their expansion and
keyboard focus remain in place. Opening history and polling only inspect data;
they do not execute work. No API keys or provider calls are needed to inspect
existing history. The deterministic App test named `caller-declared attribution`
covers per-attempt sources, literal markup, null/omitted metadata and polling
retention without execution requests. In a prepared frontend environment run:

```sh
cd frontend
npx vitest run src/App.test.tsx -t 'caller-declared attribution'
```

Browser interaction and consolidated checks for this change are pending supervisor
verification. Live provider calls are skipped under the current user policy, not
passed.

### Stop from Company overview (C36-T1)

Build/package the updated frontend using the steps above, then launch:

```sh
agentown-web --database /path/to/product.db --port 8765
```

Open http://127.0.0.1:8765 and Company overview. For a credential-free exercise,
use the existing C29/C30 browser-server fixture with a fresh product database,
create saved work and an enabled Loop (two attempts, 60-second interval), then
preview and explicitly authorize it from saved work. Fixture responses are test
results, not live LLM evidence. Return to Company overview while it is active.

1. Enter an unsaved work draft. In **Bounded Loop activity**, Tab to **Stop Loop
   <session ID> from overview** and press Enter once. The action names the exact
   session and posts only `{session_id}` to `/api/loops/v1/stop`. Linked-work
   navigation and even loaded linked work are unnecessary for stopping.
2. During submission, repeated clicks/Enter cannot submit another request.
   The button remains focusable with `aria-disabled` so focus is retained while
   its explanation changes. The draft stays intact. The status announcement
   reports the request outcome without claiming confirmed remote cancellation.
3. Inspection is polled every 800 ms. Data older than 2.4 seconds, failed or
   unavailable inspection, terminal sessions and missing local authority prevent
   stopping. Read the adjacent explanation and ownership recovery instructions.
   **Inspect Loop sessions again** explicitly refreshes without mutating anything.
4. If ownership changes or the connection fails during Stop, inspect again before
   another explicit attempt. A response already in flight before Stop cannot
   restore eligibility. A successful inspection begun after the request settles
   is required. Polling and navigation never automatically retry Stop.
5. After local cancellation is requested, inspect the recorded session/attempts.
   Remote completion may remain unknown. A terminal session cannot be stopped.
   A competing owner requires stopping through its MCP/web server or shutting
   that owner down before inspecting and explicitly retrying locally.

Deterministic fixture evidence is in `frontend/src/OverviewLoops.test.tsx`:
component cases cover stale in-flight inspection, duplicate clicks, absent linked
work, terminal/stale/unavailable/ungranted control, competing ownership and
ambiguous failures. Its App case preserves draft and keyboard focus across Stop,
then navigates to saved work without another mutation. To run in a prepared tree:

```sh
cd frontend
npx tsc --noEmit
npx vitest run src/OverviewLoops.test.tsx
```

Implementation checks used a temporary copy of frontend sources and the existing
repository dependency tree because this isolated workspace has no node_modules.
TypeScript passed. The first scoped test run found an ambiguous ownership-text
selector (7 passed, 1 failed); it was changed to select the named authority status.
The final scoped run passed all 8 tests with `--configLoader runner` (avoiding
a bundled-config cache write into the read-only shared dependency tree). Browser
interaction and the applicable consolidated supervisor verification profile
remain pending this handoff. Live LLM calls are skipped, not passed.

### Select employee characters in the office (C37-T1)

Serve the current built frontend with the product entry point:

```sh
agentown-web --database /path/to/product.db --port 8765
```

Open http://127.0.0.1:8765 and **Company overview → Employee office**.
The responsive floor places every persisted employee at a desk, with a character,
name and full ID. **Employee workload list** below is an alternative presentation
of the same assignments. No character motion or navigation starts work.

1. Create two employees named Alex and one with no assignments. Enter an unsaved
   work draft. Select either Alex character using Tab and Enter (or Space).
   Its character and matching list button both expose the pressed state and
   visible “Selected” text. The existing Work & results view filters by that
   employee ID; the other Alex remains distinct. Select a different list button
   and observe the corresponding character selection. Draft text is retained.
2. With shared saved work, both assigned employees count that request once.
   Pending, active, failed/interrupted, blocked, unverified results and other
   counts are textual. Blocked is a subset of other recorded work. An active
   attempt without a provider is explicitly caller-reported, with “no provider
   request”; a character never implies live presence or automatic execution.
3. Polling updates these same desks without resetting selection or drafts.
   Disconnect the server: retained office counts say “Stale snapshot” and the
   company status identifies the last successful refresh. With no initial data,
   loading and unavailable messages appear instead of fabricated employees.
   An empty employee collection shows an empty office and creation guidance.
4. Use a narrow viewport: desks wrap into a single column without horizontal
   character controls. Tab through character and list buttons: the focus outline
   remains visible and native Enter/Space activation retains focus. Enable the
   operating system's reduced-motion preference: all office/list animation and
   transitions are disabled; status and controls remain present. Identity,
   selection and activity use text and shapes as well as color.
5. Existing Bounded Loop activity inspection and Stop controls remain available
   above the office and keep their existing authority/freshness restrictions.

Deterministic representative-state evidence: `CompanyOverview.test.tsx` uses
three persisted IDs including duplicate names, duplicated/shared assignments,
caller-reported activity, failed and blocked work, empty/unavailable/stale states,
and polling with a retained draft. Its office interaction case checks Enter and
Space selection, synchronized pressed states and retained focus across a stale
snapshot update. `App.test.tsx`'s employee-navigation case now enters through an
office character and verifies filtered work, preserved draft, assignment choice,
expanded result details and existing execution consent, then uses list navigation.

Runnable scoped checks in a prepared frontend tree:

```sh
cd frontend
npx tsc --noEmit
npx vitest run src/CompanyOverview.test.tsx src/App.test.tsx -t 'office characters|mixed recorded|loading, unavailable|App uses existing polling|employee navigation' --configLoader runner
```

This invocation used a temporary source copy and the existing repository
node_modules because the isolated workspace has no dependencies installed.
TypeScript passed. The initial focused run exposed an empty-label assertion that
needed scoping to the accessible list now that both presentations show it.
The final focused run passed 5 tests across 2 files (77 unrelated tests skipped).
Browser interaction, visual inspection and consolidated profile verification
remain pending supervisor verification; no fresh screenshot or installed-browser
result is claimed. Accessibility decisions reuse the recorded
[WCAG 2.2 guidance](https://www.w3.org/WAI/WCAG22/quickref/) and `docs/2d-world.md`.
Live provider calls remain skipped, not passed.

### Open a saved Skill from its office book

Run `agentown-web --database PATH --port 8765` with your product database and
open http://127.0.0.1:8765. In Configuration, create two Skills with the same
name and different instructions. Leave one configuration enabled and the other
disabled. Refresh **Skill books** in Company overview: each named manual shows
its persisted ID and textual configuration status.

Tab to a book and press Enter or Space. Configuration opens with that exact ID
selected and focus moves to **Saved record**. Opening a book only inspects
configuration; it never saves, enables, previews or executes work. Edit its
instructions without saving, open the other book, then reopen the first: the
unsaved instructions remain. Work input drafts and saved-work selection also
remain in place. Reopening the same book moves focus back to Saved record.

Refresh Skill books after creating or editing Skills; the shelf is a snapshot,
not a live presence indicator. While loading it says so. An empty successful
response says no Skills are saved; an initial failure says unavailable. A failed
refresh keeps existing books with explicit stale labels. Retry using **Refresh
Skill books**. If a selected Skill is no longer returned when Configuration is
refreshed, its exact ID is shown as unavailable, its draft is retained, and
saving is disabled. Refresh and inspect before making any explicit changes.

Deterministic coverage: `cd frontend && npm test -- src/SkillBooks.test.tsx`
(with frontend dependencies installed). Component tests cover loading, empty,
unavailable, stale snapshots, duplicate names and native keyboard activation;
the App test covers ID navigation, focus, repeated opening, draft retention and
an unavailable selection. Supervisor browser validation is pending for this
change. Live provider calls are skipped under the current user policy.

### Company-office client workstations

Launch `agentown-web --database PATH --port 8765` with your product database,
then open `http://127.0.0.1:8765`. In Company overview, Tab to **Open Codex
workstation setup** (or Claude Code, Claude Desktop, Cursor or ChatGPT) and press
Enter or Space. Connections opens with that client selected and keyboard focus
on its setup heading, including when the setup service is unavailable. Continue
with Tab to Refresh setup, Client, Platform and the existing copy/download
controls. ChatGPT still requires the remote HTTPS prerequisites shown there.

Type a work draft or edit a Skill in Configuration, then open several
workstations: those drafts remain intact. Choose a platform, hide Connections
and reopen a workstation: the platform choice and loaded setup remain available.
Opening a workstation only navigates; it never saves configuration, edits another
application's settings or executes work. Installation detection is an inconclusive
hint; configured remains unknown, connected and exercised remain unverified.
Workspace connectivity does not establish client connectivity. Failed refreshes
retain explicitly stale instructions; an absent selected client shows unavailable
setup rather than another client's instructions. Refresh setup to recover.

Deterministic coverage: with frontend dependencies installed, run
`cd frontend && npx vitest run src/Workstations.test.tsx src/Connections.test.tsx`
and `npx tsc --noEmit`. Supervisor verification supplies the current check profile
and any browser checks. These steps do not prove actual client integration or
live-provider execution; live LLM validation is skipped under the user policy.

### Persistent company team rooms

Launch `agentown-web --database PATH --port 8765` and open
`http://127.0.0.1:8765`. In the existing Teams panel, create two teams with the
same name and add a shared employee to both. In Company overview choose
**Refresh team rooms**. Each room displays the persisted team ID, so duplicate
names remain distinguishable. Empty teams say **No members yet**; missing
employees display their ID without an actionable character.

Tab to a room's **Select team member** character and press Enter or Space to
open that employee's assigned-work view. The search field receives focus and
filters reset. The displayed member workload counts recorded employee
assignments using the same status classification as the employee office; shared
requests count once per employee. These counts are not team-owned work and
must not be summed across rooms. Membership implies neither collaboration nor
execution. Active can include caller-reported activity without a provider call;
results remain unverified.

Activate **Manage team: … · ID: …** to open that exact team in the existing
management panel, with focus on **Saved team**. Type an unsaved team name,
select an employee to add, and type a work draft. Visit another room's management
panel, then return, including opening the same room twice. The work draft,
assignment, team-name draft and per-team membership selections remain intact.
Opening rooms does not save membership, assign team work, or start execution.
Use Refresh team rooms after explicit team changes; room and management
snapshots refresh independently. A removed selected team is reported unavailable
in management and its draft is retained.

Loading, no teams, initial failure and stale snapshots have separate text
statuses. Stop the server and refresh rooms to retain a visibly stale snapshot;
restart and refresh to recover. With no previously loaded rooms a failure says
unavailable. Employee assignments also show stale labels on a disconnected
workspace. Character actions retain native keyboard support and visible focus;
reduced-motion settings suppress room animation and transitions.

Deterministic coverage is in `frontend/src/TeamRooms.test.tsx` and the existing
CompanyOverview/Teams tests. With dependencies available, run
`cd frontend && npx vitest run src/TeamRooms.test.tsx src/CompanyOverview.test.tsx src/Teams.test.tsx`
and `npx tsc --noEmit`. Supervisor checks and browser validation are pending at
implementation handoff. Live LLM calls are skipped under the user policy.

### Open saved work from a team room

Launch `agentown-web --database PATH --port 8765`, open
`http://127.0.0.1:8765`, and inspect Company overview. Use a database with saved
work assigned to team members. Under **Saved member assignments**, each card
shows the Task ID, its recorded status and the assigned members in that room
with employee IDs. These are member assignments, not team-owned work. A Task
shared by multiple members appears once within that room; a shared employee’s
work can appear in several rooms. Do not sum room counts. Results are unverified;
caller-reported active attempts do not prove a provider request.

Type an unsaved work draft, edit a team name/membership selection and open
Configuration to type unsaved Skill instructions. Select an employee’s work,
enter an excluding search and choose a different outcome filter. Tab to a room’s
**Open member assignment: … · Task ID: … · Team ID: …** card and press Enter
or Space. **Saved work** receives focus with that exact Task selected; employee,
search and outcome filters clear. All three drafts and the draft employee
assignment remain intact. Repeat with Tasks having identical input text and
check their distinct IDs. Opening cards never saves, assigns or executes work.

Loading team rooms, unavailable rooms/company data, rooms without saved member
assignments, and stale snapshots have distinct messages. Disconnect and refresh
to inspect the retained stale cards; they remain available for saved-history
navigation. Reconnect and refresh company data to remove obsolete assignments.
Refresh team rooms separately after changing membership. Unavailable members
retain their IDs and can still have saved assignments; membership does not
imply execution or collaboration.

Deterministic coverage: `cd frontend && npx vitest run src/TeamRooms.test.tsx
src/CompanyOverview.test.tsx src/App.test.tsx` (enter the command on one line),
then `npx tsc --noEmit`. The implementation workspace has no installed frontend
dependencies, so execution is pending supervisor verification. The supervisor
runs the declared frontend profile (frontend tests/build and ordinary Python
checks), subject to its periodic full-check policy. Browser validation is pending;
no browser or fresh-install evidence is claimed for this slice. Live LLM calls
remain skipped, not passed.

### Saved Hook trigger devices

Launch `agentown-web --database PATH --port 8765` with an existing product database, then open `http://127.0.0.1:8765`. In Company overview, Hook trigger devices show each saved Hook's persisted ID, event, target kind/ID and configuration-enabled status. Configuration enabled does not mean automatic execution. No credentials or live provider calls are needed.

Use Tab to focus a device and Enter or Space to open that exact ID in Configuration. Saved record receives focus after loading; opening the same device again also restores focus. Duplicate names remain distinguishable by ID. Edit a Hook draft, open another device, and return: its unsaved draft and the work-input draft remain. Switching to a Skill draft and back also retains both. Navigation never saves, enables, previews or executes work.

Refresh Hook devices reloads the office snapshot. Loading, empty, unavailable and stale states are separate; failed refresh retains the last snapshot and a later successful refresh recovers. Refresh configuration independently reloads saved values without resending drafts. If a selected Hook has been removed, its ID and draft remain visible with saving disabled; refreshing after restoration recovers the record without discarding the draft.

With frontend dependencies installed, run `cd frontend && npx tsc --noEmit` and `npx vitest run src/HookDevices.test.tsx src/SkillBooks.test.tsx src/CompanyOverview.test.tsx src/App.test.tsx`. These deterministic tests cover identity, keyboard activation, repeated focus, draft preservation, failure recovery, removed records and read-only configuration requests. Supervisor verification supplies the applicable consolidated checks and any browser validation; no browser or live-provider result is claimed by this implementation.


### Saved Loop policy devices (C42-T1)

Launch `agentown-web --database PATH --port 8765` and open
`http://127.0.0.1:8765`. Save work and create two Loop policies in Configuration
with the same name, different iteration limits/intervals and enabled states.
No credentials are needed. In Company overview, **Saved Loop policy devices**
show persisted policy ID, linked Task ID, iteration limit, interval in seconds
and configuration-enabled state. The separate execution-session section keeps
its existing inspection and explicit stop controls. A saved enabled policy is
not evidence of an active session.

Type a work draft and an unsaved configuration draft. Tab to a Loop device and
press Enter or Space: Configuration opens the exact ID and focuses **Saved
record**. Edit its name, open the other same-name device and return; each draft
remains associated with its persisted ID. Activate the same device repeatedly
and check focus returns to Saved record. Switch to a new Skill draft and back;
that draft and the work input must remain intact. In the network inspector,
opening devices must issue only inspection requests, with GET for configuration;
there must be no saves, previews, session starts or stops.

**Refresh Loop devices** reloads the office snapshot independently. Check loading,
empty, unavailable, malformed-response and stale messages using deterministic
fixtures. Failed refresh retains the last valid devices, marked stale; a
successful refresh replaces them. **Refresh configuration** retains drafts when
a selected policy disappears, shows its unavailable ID and disables saving.
Restoring that policy and refreshing recovers it without discarding its draft.
Malformed saved-policy snapshots are rejected in both office and Configuration.

With frontend dependencies available, run `cd frontend` then
`npx vitest run src/LoopDevices.test.tsx src/OverviewLoops.test.tsx src/Configuration.test.tsx src/HookDevices.test.tsx src/CompanyOverview.test.tsx`
and `npx tsc --noEmit`. C42 implementation added deterministic component/App
coverage; execution is pending because this isolated workspace has no frontend
node_modules. Supervisor-selected consolidated verification and browser validation
remain pending. No browser result is claimed here. Live LLM validation remains
skipped, not passed.

### Copy a client configuration fragment (C45-T1)

Launch `agentown-web --database PATH --port 8765` with an existing product
database, or open the packaged desktop app. Open **Connections**, select a local
client (Codex, Claude Code, Claude Desktop or Cursor), then select its platform.
**Configuration destination** and **Configuration fragment** are separately
labeled, read-only fields: Tab into either and select its text for manual copying.
**Copy configuration** copies only the exact fragment, including whitespace;
it does not include the destination or setup instructions. Merge it manually
at the shown destination after reviewing existing settings.

Tab to Copy configuration and press Enter or Space. The status announces copying
and its result. Change client/platform and check both fields update. If clipboard
access is denied or unavailable, follow the status guidance to select the
Configuration fragment field and copy manually. Changing selection while copying
clears pending feedback; a late result cannot claim the new selection was copied.
Copying makes no API requests, changes no settings, and runs no diagnostic or work.
Client configuration stays unknown; connection and exercise stay unverified.

**Copy setup instructions** still copies the full instructions, and **Download
setup artifact** retains its existing behavior. ChatGPT instead shows a labeled
**ChatGPT prerequisites checklist** for remote HTTPS setup, with no local
configuration fields or Copy configuration action. Its full instructions and
prerequisites download remain available.

Deterministic interaction coverage in `frontend/src/Connections.test.tsx` checks
exact clipboard content, client/platform selection, Enter/Space, status, denied
and unavailable clipboard recovery, pending-selection changes, ChatGPT and absence
of extra requests. With frontend dependencies available, run `cd frontend` then
`npx vitest run src/Connections.test.tsx` and `npx tsc --noEmit`.
This isolated implementation workspace has no frontend node_modules; execution,
frontend build, ordinary Python checks and browser validation remain pending
supervisor verification under its selected profile. Live LLM calls remain skipped,
not passed. No external client or credentials are required for this exercise.

### Recover from malformed Connections setup (C46-T1)

Launch `agentown-web --database PATH --port 8765` with an existing database, or
open the desktop product, then open **Connections**. The screen validates the
complete setup response before replacing instructions, including unselected
clients/platforms, action text, optional status/filename fields when present,
and ChatGPT prerequisite text. Configuration whitespace is preserved exactly.

For deterministic reproduction, run `cd frontend` then
`npx vitest run src/Connections.test.tsx src/Workstations.test.tsx` and
`npx tsc --noEmit` with frontend dependencies available. The setup recovery cases
serve a malformed initial response, a valid retry, a malformed refresh, and a
valid recovery. Cases cover missing/invalid actions, client and platform fields,
configuration text, duplicate selection IDs and invalid status hints, including
ChatGPT. Existing clipboard, download and workstation interaction cases remain.

For manual inspection, use a development response override for
`/api/connections/v1` (do not change client settings). Remove `actions`, replace
it with an object, or replace any client's platform `configuration` with null.
Open Connections: the live status announces unavailable instructions, Refresh
setup stays usable, and no copy/download artifacts are offered. Restore the
original response and refresh, select a client/platform, then apply the malformed
override again and refresh. Previous selections and exact valid instructions
remain available with explicit stale feedback. Repeat using ChatGPT: malformed
checklist text cannot crash rendering or replace the valid checklist. Restore
the original response and refresh to clear the stale status and load current
instructions. Copy/download still use the validated artifact; readiness remains
unknown and connection/exercise remain unverified throughout.

Integration validation passed TypeScript checking (`tsc --noEmit`) and the two
focused interaction files above (113 tests). The workstation stale-state assertion
now matches the explicit “Previously loaded instructions may be stale” feedback.
The supervisor-selected consolidated profile and browser checks remain pending.
No live provider or external client configuration is required. Live LLM tests
remain skipped.


### Read ordered local-client setup guidance (C47-T1)

Launch `agentown-web --database PATH --port 8765` with your existing database,
then open `http://127.0.0.1:8765`, or open the desktop app. Open **Connections**
and select Codex, Claude Code, Claude Desktop, or Cursor and the desired platform.
The four numbered steps now show the existing API guidance directly:

1. **Prepare AgenTown**: read the preparation and replace paths as directed.
2. **Configure [client] · [platform]**: inspect the destination and exact fragment.
   Copy configuration or download the artifact, then merge manually if desired.
3. **Inspect and verify in [client]**: follow the selected client's inspection
   instructions and the read-only employee/work prompt. The existing local server
   and shared-data checks remain available here with their recovery notices.
4. **Recover if setup fails**: read recovery guidance before retrying.

No external client installation or credentials are needed to inspect these steps.
Changing client or platform updates the destination, fragment, and inspection
instructions together. Preparation and recovery preserve API line breaks. The
combined **Setup instructions** field and its copy action remain available.
Tab from the setup heading through Refresh setup, Client, Platform and the fields;
use Enter or Space to activate focused buttons. All guidance is readable without
opening a disclosure or searching the combined field.

For recovery, stop the web server and choose **Refresh setup**: the stale notice
appears while previously loaded steps stay readable. Restart with the same database
and refresh again: the notice clears and guidance updates, retaining selection.
Choose ChatGPT: its separate **ChatGPT prerequisites checklist** replaces local
steps and offers no local configuration fragment or diagnostic controls. Copying,
downloading, and local checks never establish external configuration, connection,
or exercise. Deterministic Connections interaction tests cover these states;
supervisor-selected browser validation is pending for this implementation.
Live provider calls remain skipped, not passed.

### Copy and download ChatGPT remote prerequisites (C48-T1)

Launch `agentown-web --database PATH --port 8765` with an existing product
database and open `http://127.0.0.1:8765`, or open the desktop app. Open
**Connections → ChatGPT**. Read the visible **ChatGPT prerequisites checklist**
and **Setup instructions**: both describe the supplied remote HTTPS/OAuth
prerequisites. The combined instructions identify the remote prerequisite
destination without asking you to merge a local settings fragment. The API's
shared local-client preparation (including “merge only the agentown entry” and
“Download saves a merge fragment”) must be absent from ChatGPT's visible and
copied instructions and return when selecting a local client.

Choose **Copy setup instructions**, paste into a text editor, and compare with
the read-only Setup instructions field. Choose **Download setup artifact**:
the status identifies a prerequisite checklist and asks you to review HTTPS/OAuth
prerequisites. The downloaded filename and exact checklist content remain those
supplied by the setup API. No local diagnostic controls appear. Readiness remains
unknown, and configuration/connection/exercise are unknown or unverified.

If clipboard access is denied or unavailable, select the Setup instructions field
and copy manually as directed; retry the button after clipboard access is restored.
Switch to Codex or another local client: the numbered setup steps, configuration
fragment, local checks, and manual merge guidance return, and ChatGPT feedback
clears. No credentials, public endpoint, external client session or live LLM calls
are needed to inspect this flow.

Deterministic coverage in `frontend/src/Connections.test.tsx` checks remote
clipboard text, exact downloaded checklist text and filename, download status,
denied/unavailable clipboard recovery, and returning to local setup. With frontend
dependencies available, run `cd frontend`, `npx vitest run src/Connections.test.tsx`
and `npx tsc --noEmit`. This implementation workspace has no frontend dependencies;
these checks and supervisor-selected consolidated/browser validation remain pending.
Live LLM calls remain skipped, not passed.

### Malformed workspace snapshots and recovery (C49-T1)

Launch `agentown-web --database /ABSOLUTE/PATH/workspace.sqlite3 --port 8765`
with an existing product database, then open `http://127.0.0.1:8765`.
The company overview and work screen share one validated workspace snapshot.
Employee/work/attempt identities, assignment and participant lists, result metadata,
and saved Skill/Hook provenance are checked before replacing that snapshot.
Unknown extension fields, absent optional metadata and legacy null metadata are
preserved; historical employee references do not require a current employee.

Runnable deterministic interaction coverage (no provider credentials required):

```sh
cd frontend
npm exec -- vitest run src/workspace-validation.test.tsx src/App.test.tsx src/CompanyOverview.test.tsx src/deadlines.test.tsx
```

To reproduce visually with browser developer tools or an HTTP response override:

1. Load saved work with results. Select it, expand a historical attempt, and enter
   unsaved request and employee-name drafts.
2. Override the POST `/api/state` JSON response: replace an attempt's `participants`
   with `[{}]`, a work's `assignees` with `[null]`, or its `hook` with
   `{"hook_name": {"invalid": true}}`. Choose **Refresh connection**.
3. Confirm disconnected/stale feedback explains that the snapshot is invalid and
   offers Refresh connection. The company and work views retain loaded history,
   selection, expanded results and drafts. Execution stays disabled.
4. Remove the override, add work through another product client, and refresh.
   Confirm connected feedback, newly added work in history, unchanged selection
   and drafts, and restored execution controls. Inspect network requests: recovery
   only reads state and supporting inspection endpoints; no mutation is replayed.
5. Reload with the malformed response override enabled to test initial failure.
   Confirm actionable **Workspace unavailable** feedback, disabled save/execution
   controls and no rendering crash. Remove the override and refresh to recover.

The focused tests exercise these failures and recovery using deterministic API
responses; they do not establish live provider behavior. Supervisor-selected
consolidated checks and browser validation run after implementation handoff.
Live provider calls remain skipped under the user policy.

Prototype-name regression: set an attempt's `error` to `"__proto__"`,
`"constructor"` or `"toString"`, or set an attempt-free work's `status` to one
of those strings. Test both initial load and Refresh connection. These unknown
string values retain the generic error advice/status label without crashing;
only own dictionary entries select specialized text. The focused App interaction
regressions also verify retained selection/draft and externally added work after
refresh, with no mutation replay.

### Malformed saved Skill/Hook configuration (C50-T1)

Start with an existing database:

```sh
agentown-web --database /ABSOLUTE/PATH/workspace.sqlite3 --port 8765
```

Open http://127.0.0.1:8765 and select saved work assigned to one employee.
For Hook preview, use work whose latest attempt finished with reported success.
No provider credentials are needed for configuration or preview. In browser response
overrides, use these deterministic GET responses (replace `EMPLOYEE_ID` with the
saved work's assignee ID):

- `/api/config/v1/skills`:
  `{"skills":[{"id":"fixture-s","name":"Concise","instructions":"Be concise.","enabled":true}]}`
- `/api/config/v1/hooks`:
  `{"hooks":[{"id":"fixture-h","name":"Follow up","skill_id":"fixture-s","target_kind":"agent","target_id":"EMPLOYEE_ID","event":"run_completed","enabled":true}]}`

These are response fixtures, not database edits. To obtain a server-issued preview,
create matching records through the product configuration screen instead, enable
them explicitly, and use their actual stable IDs in the overrides. Preview uses
saved work; leave unsaved request text in the editor to verify preservation.

1. Select the enabled Skill or eligible Hook and press Enter on its preview button.
   Inspect the effective saved input; no execution is requested.
2. Change either response to include a null record, duplicate ID, a string
   `enabled`, invalid field type, or unsupported Hook target/event. Wait for the
   next poll (800 ms). Loaded choices remain visible with **stale** feedback;
   preview and execution are unavailable and prior consent is removed. Focus
   returns to the labelled execution region when its preview button is disabled.
   Hook loading accepts both responses together, never half of a failed snapshot.
3. Restore valid responses. The selected stable ID remains selected if present;
   drafts and saved work remain intact. Recovery does not replay preview or
   execution. Press Tab to reach preview and Enter for a fresh explicit preview.
   Cancel it; inspect Network to confirm zero `/execute` requests.
4. Reload with malformed overrides active. Confirm **unavailable** feedback,
   disabled preview and no crash. Restore valid responses and wait for recovery.
   If a selected record disappears in a valid response, choose another record.

Run deterministic validator and interaction coverage with frontend dependencies:

```sh
cd frontend
npm exec -- vitest run src/execution-configuration.test.tsx src/SkillExecution.test.tsx src/HookExecution.test.tsx
npm exec -- tsc --noEmit
```

The new interactions cover malformed initial snapshots, malformed polling after
keyboard preview, recovery, retained selection/draft, focus and zero unintended
submissions for Skills and for each half of the Hook snapshot. Integration ran
these three suites successfully (39 tests) and passed `tsc --noEmit` using the
available local frontend dependencies. Polling intervals are controlled in the
recovery tests while keyboard interaction timeout queues run normally. The
supervisor's applicable consolidated/browser verification remains pending. Live
provider calls remain skipped, not passed.

### Loop inspection recovery (C51-T1)

Launch `agentown-web --database PATH --model MODEL` with an existing AgenTown
SQLite database. Open company **Bounded Loop activity**, then open linked saved
work and **Run a bounded Loop**. No provider call is needed to inspect history
or preview. Keep an unsaved work draft while exercising recovery.

For deterministic reproduction run, from `frontend/`:
`npx vitest run src/loop-response.test.tsx src/OverviewLoops.test.tsx src/LoopExecution.test.tsx`.
The fixtures control polling intervals independently of request and Testing
Library timeouts. They supply null initial responses, malformed nested sessions,
previews, execution output/error, and saved policies, followed by valid recovery.

Expected: initial invalid data shows unavailable feedback; subsequent invalid
data leaves the last valid history and selected policy visible with stale
feedback. Stop and preview are unavailable. Focused preview consent disappears
and focus returns to the Loop region; overview stop focus remains reachable.
Recovery retains selection and the parent-owned draft and never replays preview,
start or stop. A new explicit preview and authorization are required to start.
Unknown session states remain readable; missing execution records remain
unavailable, and absent/unknown authority grants no execution permission.
Live provider calls are skipped. Supervisor browser verification remains pending.


Loop unknown-state regression: with the existing deterministic Loop inspection fixture,
set a session's `state` to `__proto__`, `constructor`, or `toString` and inspect
both company Loop activity and that session's saved-work Loop execution. Each
must display `Unknown session state: <state>` and keep history readable. The
company stop control must remain unavailable; saved-work must offer no stop for
that session. Merely inspecting must issue no preview, start, or stop request.
These cases are covered in `OverviewLoops.test.tsx` and `LoopExecution.test.tsx`.

### Skill and Hook preview consent validation (C52-T1)

Launch `agentown-web --database PATH --port 8765` using an existing saved-work
fixture database; open http://127.0.0.1:8765 and select assigned saved work.
Use an enabled Skill, or an enabled employee Hook whose event matches the latest
finished attempt and whose Skill is enabled. Keep an unsaved draft in the editor.
No credentials or live provider calls are needed for preview.

With deterministic network response overrides for POST
`/api/work/WORK_ID/skill-preview` or `/api/work/WORK_ID/hook-preview`:

1. Start from a valid preview response for that saved work/configuration. Replace
   `preview_id` with `1`, `true`, `{}`, `[]`, an empty string or whitespace.
   Also exercise null/array responses, unsupported `schema_version`, nonstring
   `input`, string/mismatched `expected_runs`, and mismatched `task_id`/`skill_id`.
   For Hooks, mismatch `hook_id`, `agent_id`, `source_run_id`, `source_outcome`
   or `event`; replace either enabled flag with `"true"`, `1`, or `false`.
2. Explicitly click preview. Expect actionable invalid/unsupported feedback and
   no execution button. Saved work, attempt history, selection and draft remain.
3. Restore the valid fixture response. This alone must neither preview nor
   authorize execution. Click preview again, inspect the effective saved input,
   then explicitly execute once. Rapid double clicks submit only once; inspect
   Network for one execution request. Intercept execution with the existing
   deterministic fixture to avoid a provider call.

Focused interaction coverage: from `frontend/`, run
`npm exec -- vitest run src/execution-configuration.test.tsx src/execution-preview.test.tsx src/SkillExecution.test.tsx src/HookExecution.test.tsx`
and `npm exec -- tsc --noEmit`. The new matrix exercises each invalid response,
recovery, retained work/draft and explicit single submission. Only product polling
intervals are suppressed; interaction timeout queues remain active. Integration
repaired the configuration-recovery Hook fixture to include the required string
`hook_name`, matching the API contract without relaxing response validation.
All 89 tests in these four files and TypeScript checking passed during integration.
The isolated workspace reused existing dependencies and used `--configLoader runner`
for Vitest to avoid writing bundled configuration into the shared dependency tree.
The consolidated supervisor frontend/build and ordinary Python gate remain pending.
Browser validation is pending supervisor verification. Live validation is skipped,
not passed.

### Configuration response recovery (C53-T1)

In the existing product, open **Configuration**. No credentials are needed;
configuration saves and enables do not execute work. With a deterministic API
fixture or browser network response override, exercise each of Skill, Hook and
Loop:

1. Return null, a non-list, an invalid record or duplicate IDs from one of
   GET `/api/config/v1/skills`, `/hooks`, `/loops`. An invalid initial load must
   show unavailable feedback, no invented empty list, and disabled save controls.
   Restore valid responses and explicitly activate **Refresh configuration**.
2. Select saved records and edit drafts in all three types. Make a refresh return
   a valid changed Skill list but an invalid Hook or Loop list. All three previous
   saved lists, selections and drafts must remain; saves and enables are disabled.
3. Restore valid responses, refresh explicitly, then explicitly save or enable.
   Override the mutation response with null, an array, invalid fields, or (for
   update/enable) a valid record with a different ID. Expect uncertain-save
   feedback, retained drafts and selections, the prior saved snapshot and disabled
   mutations. The server may already have saved the request: inspect refreshed
   saved values before choosing whether to retry.
4. Restore valid responses. Use Tab to reach **Refresh configuration** and Enter
   to activate it. Refresh must send only reads; switching types retains drafts.
   Only a new explicit save or enable sends another mutation. Successful saves
   return keyboard focus to **Saved record**.

Deterministic interaction coverage is runnable from `frontend/` with
`npm exec -- vitest run src/Configuration.test.tsx` and
`npm exec -- tsc --noEmit` after the normal frontend dependencies are available.
The matrix covers each list's invalid initial load and atomic refresh, malformed
create/update/enable responses, wrong update/enable IDs, keyboard recovery,
retained drafts and mutation counts before and after explicit recovery.
This implementation workspace has no frontend test dependencies; these checks
and browser validation are pending supervisor verification. Live LLM validation
is skipped, not passed.

### Employee and work creation recovery (C54-T1)

Use an **existing, initialized deterministic fixture database** containing employees
and saved work. From the prepared product environment, launch:

```sh
agentown-web --database /absolute/path/to/existing-fixture.sqlite3 --port 8765
```

Open http://127.0.0.1:8765. Creation, saving and refresh require no credentials;
do not execute work or call a live provider for this reproduction.

1. Select saved history, choose an employee, and enter both an employee-name draft
   and work-request draft. Override the response to POST `/api/employees` or
   `/api/work` with `null`, `[]`, `{}`, `{"id":1}`, `{"id":true}`,
   `{"id":{}}`, `{"id":""}` or `{"id":"  "}`. Also try unreadable JSON
   and a response delayed beyond 15 seconds. The request may already have created
   a record, so inspect the actual fixture database through the screen.
2. Explicitly submit the affected form. Both creation buttons become blocked after
   uncertainty. Names, request text, assigned employee and selected history remain.
   A valid response requires an object with a nonblank string ID. Rapid double
   clicks issue one mutation. Edit the employee name during a delayed valid
   employee response: that newer name must remain after success.
3. Allow polling to run. Recovery remains visible and requests are never replayed.
   Restore valid responses and use Tab/Enter to activate **Refresh connection**.
   A failed refresh cannot enable inspection confirmation. A successful refresh
   reads current state without resubmitting either creation request.
4. Inspect the employee list and saved work for a possible already-created record.
   Activate **I inspected employees and saved work** with Tab/Enter. Only then
   decide whether a new explicit submission is necessary. Confirmation itself
   issues no mutation. Valid new submissions work normally and double clicks
   still produce only one request. Use Network to verify counts for each endpoint.

Focused checks, when frontend dependencies are available:

```sh
cd frontend
npm exec -- tsc --noEmit
npm exec -- vitest run src/creation-recovery.test.tsx src/deadlines.test.tsx
```

The interaction matrix covers malformed/unreadable responses for both endpoints,
retained drafts/selection, polling, failed and keyboard recovery, explicit new
submission counts, and in-flight employee-name edits. Deadline tests cover stalled
headers/body, late responses and retained drafts for both creation endpoints.
This implementation workspace lacks frontend dependencies and test executables;
these checks and browser validation are pending supervisor verification. Live
provider validation is skipped, not passed.

### Execution receipt uncertainty (C55-T1)

In a prepared development environment with built frontend assets, launch the
existing deterministic server (its app is the same `create_app` used by
`agentown-web`, with a test provider injected; the production CLI has no fixture
provider switch):

```sh
printf 'success' > /tmp/c55-response-gate
uv run --directory python --locked python tests/web_browser_server.py /tmp/c55-work.sqlite3 8766 /tmp/c55-response-gate
```

Open http://127.0.0.1:8766. Create an employee, save work and execute once.
The fixture needs no credentials and records provider submissions in
`/tmp/c55-response-gate.calls`. In Configuration, create and enable a Skill,
then an employee Hook referring to that Skill with event `run_completed`.
Keep the successful attempt as the Hook's source. Enter a different unsaved
draft and keep the saved work selected.

1. Using a browser response override or local intercepting proxy, replace only
   the next POST `/api/work/{id}/execute` **response**, allowing the request to
   reach the fixture. Try `null`, `{}`, an array, unreadable JSON, or a genuine
   receipt with `schema_version` changed to `2`. For Skill and Hook also try
   removing their provenance object or changing its `preview_id` or `run_id`.
2. Exercise each path separately: **Retry explicitly** (and **Confirm resend**
   when the prior attempt has output), **Preview Skill with saved work** then
   **Execute once with Skill**, and **Preview Hook with saved work** then
   **Execute once with Hook**. Double-click the execution control: Network must
   show one execution POST. Draft text, employee selection, saved selection and
   prior attempts remain; an actionable receipt warning and submission
   inspection message appear. Skill/Hook execution consent disappears.
3. Let polling run. Execution stays blocked. Force `/api/state` to fail or
   return an invalid snapshot, then choose **Refresh connection**: the block
   remains. Restore valid snapshots; polling still cannot clear it. Remove
   the receipt override and explicitly choose **Refresh connection**. Inspect
   attempts for the possible already-completed request before deciding to retry.
   Refresh sends no execution POST. Skill and Hook need a new explicit preview.
4. Repeat with unmodified successful receipt bodies. A v1 finalized receipt
   with matching input, provider/model, new Run ID, deadline, unverified quality,
   output/error pair and applicable saved provenance allows normal controls.
   A finalized provider failure (`output: null`, nonblank `error`) is also a
   valid receipt; it is not evidence of uncertain delivery.

Focused checks for the supervisor when dependencies are available:

```sh
cd frontend
npm exec -- tsc --noEmit
npm exec -- vitest run src/execution-receipt.test.tsx src/HookExecution.test.tsx src/SkillExecution.test.tsx src/deadlines.test.tsx
```

The added deterministic interactions cover all three paths, valid/malformed/
unsupported bodies, single submission, retained drafts/selection/history,
polling, failed refresh, explicit keyboard recovery, consumed preview consent,
and a stale in-flight refresh. These reproduction steps were not browser-executed
in the implementation workspace. Frontend dependencies are absent; focused
execution and supervisor-selected verification remain pending. Live provider
validation is skipped, not passed.

### Bounded Loop receipt uncertainty (C56-T1)

Use the existing deterministic web fixture, with built frontend assets:

```sh
printf 'success' > /tmp/c56-response-gate
uv run --directory python --locked python tests/web_browser_server.py /tmp/c56-work.sqlite3 8766 /tmp/c56-response-gate
```

Open http://127.0.0.1:8766, create an employee and save assigned work. In
Configuration create and enable a Loop for that saved work, with maximum attempts
2 and interval 60 seconds. Keep an unsaved draft in the work input.

1. In saved-work **Run a bounded Loop**, select the policy, keyboard-activate
   **Preview Loop with saved work**, then **Authorize and start bounded Loop**.
   A valid version-1 session response shows admission acknowledged. This confirms
   admission only; inspect persisted session and attempt records for execution.
2. Stop the active session from saved work. A valid stopped-session receipt shows
   **Local stop acknowledged**, with remote completion explicitly unknown.
   Preview and explicitly start a new session, then stop it from company
   **Bounded Loop activity**. Inspect records from both surfaces.
3. Using a browser response override or local proxy, allow the next start or stop
   POST to reach the fixture but replace its response with `null`, `{}`, an array,
   unreadable JSON, or a real receipt with `schema_version: 2`. Also try a start
   receipt whose nested `preview.preview_id` differs, and a stop receipt whose
   `session_id` differs. Each must show an unconfirmed outcome, retain selected
   policy, unsaved draft and earlier records, and consume start consent. Double
   activation must send only one request. No receipt proves remote cancellation.
4. Restore genuine GET inspection responses. Fresh authoritative inspection may
   restore emergency stop even when ordinary execution is disabled. It must not
   start or stop automatically. Inspect actual session/attempt records before
   making another explicit request; a response override does not undo admission.
   A poll started before submission must not restore authority after submission.

Focused deterministic checks (from `frontend`, with dependencies available):

```sh
npx vitest run src/loop-response.test.tsx src/LoopExecution.test.tsx src/OverviewLoops.test.tsx src/App.test.tsx
npx tsc --noEmit
```

The tests cover receipt validation, uncertainty, retained records/selection,
consumed consent, duplicate activation, stale in-flight inspection, recovery and
keyboard operation. The fixture's `.calls` file and the screen's retained session
and attempt records provide observable evidence. This implementation workspace
has no frontend dependencies; these tests and supervisor-selected browser checks
remain pending. Live provider calls are skipped, not passed.

## Team save uncertainty and explicit recovery (C57-T1)

Launch without provider credentials (use an existing writable database directory):

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-teams-recovery.sqlite3 --port 8765
```

Open <http://127.0.0.1:8765>, create two employees, choose **Browse teams**, and
create two teams with the same name. Their IDs distinguish them. Select a team,
add one employee, then select the other employee as a draft addition. Enter a
new team-name draft. Switching teams and back must preserve that addition.
Existing members remain visible, including an **Unavailable employee** entry if
an employee is absent from the workspace snapshot. No work executes here.

For a reproducible uncertain response, paste this into browser developer tools.
It lets the next team POST reach the real server, then replaces only its receipt;
it does not change the server API. The save may therefore already be persisted.
Keep the Network panel open to count requests.

```js
window.teamRecoveryFetch = window.fetch;
window.fetch = async (input, init) => {
  const result = await window.teamRecoveryFetch(input, init);
  if (init?.method === 'POST' && String(input).startsWith('/api/teams')) {
    window.fetch = window.teamRecoveryFetch;
    return new Response('{', {status: 200});
  }
  return result;
};
```

Activate **Add members** (or repeat with **Create team**). Rapid duplicate
activation must send one POST. The alert explains uncertainty and instructs
refresh and inspection. Confirmed records and drafts stay visible; neither save
button permits resubmission. To exercise a mismatched receipt instead, replace
`new Response('{', {status: 200})` with
`Response.json({id: 'wrong-team', name: 'Wrong', members: []})`.

Before recovery, make refresh return an invalid list by installing:

```js
window.fetch = async (input, init) =>
  init?.method === 'GET' && String(input) === '/api/teams'
    ? Response.json({teams: [{id: 'invalid', name: 'Incomplete'}]})
    : window.teamRecoveryFetch(input, init);
```

Tab to **Refresh teams** and press Enter. The failed refresh must retain prior
teams and drafts, announce an error, and keep saves blocked. Restore transport
with `window.fetch = window.teamRecoveryFetch`, focus **Refresh teams**, and
press Enter again. Only this successful explicit GET restores save eligibility;
refresh must never issue another POST. Inspect the saved IDs and membership
before deliberately retrying. Already saved additions appear as existing members;
an unchanged creation draft lets you inspect whether its team was saved before
choosing to submit again. Successful explicit saves announce the saved ID and
return focus to **Saved team**.

Deterministic interaction and contract coverage is in `Teams.test.tsx` and
`api.test.tsx`. With frontend dependencies available, run:

```sh
cd frontend
npx vitest run src/Teams.test.tsx src/api.test.tsx
```

These fixtures cover malformed/unreadable and mismatched receipts, lost prior
members, missing requested additions, duplicate IDs, atomic invalid list
rejection, failed recovery, retained drafts/selections, duplicate submission and
keyboard recovery. Supervisor browser/build verification is required separately;
this reproduction does not require live provider calls.

### Contradictory configuration receipts (C58-T1)

Launch the local product using the command above and open **Open configuration**.
Create a Skill, then a Hook referencing it and an employee, and a Loop referencing
saved work. These actions configure records only; no provider credentials are
needed. Select each saved record, enable it, edit its name, and save. The enabled
state must remain enabled. Names with surrounding whitespace are trimmed;
Skill instructions keep their whitespace.

For a reproducible contradiction, install this one-shot receipt interceptor in
browser developer tools before creating, saving or toggling a configuration:

```js
window.configurationRecoveryFetch = window.fetch;
window.fetch = async (input, init) => {
  const result = await window.configurationRecoveryFetch(input, init);
  if (['POST', 'PUT'].includes(init?.method) &&
      String(input).startsWith('/api/config/v1/')) {
    window.fetch = window.configurationRecoveryFetch;
    const receipt = await result.json();
    return Response.json({...receipt, name: 'Contradictory receipt'});
  }
  return result;
};
```

Repeat for Skills, Hooks and Loops. The mutation reaches the server, but its
receipt must not replace the displayed confirmed values, change the selection,
clear the draft, or announce success. Save and toggle buttons must remain
blocked. To exercise a toggle mismatch, replace the returned object with
`{...receipt, enabled: !receipt.enabled}`. For a duplicate creation ID, select
**Create new**, retain an existing record's ID, and return
`{...receipt, id: 'THE_EXISTING_ID'}` instead. For field mismatches use
`instructions` on Skills, `skill_id`, `target_kind`, `target_id` or `event` on
Hooks, and `task_id`, `max_iterations` or `interval_seconds` on Loops.

Tab to **Refresh configuration** and press Enter. A failed refresh must keep the
lockout and drafts. After a successful refresh, inspect **Saved values**, IDs and
enabled state; the server may already have saved the first request. Switching
record types and back retains drafts and selections. Refresh issues GETs only.
Only a deliberate save/toggle after inspection sends another mutation; successful
creates/edits return focus to **Saved record**. Restore transport if needed with
`window.fetch = window.configurationRecoveryFetch`.

Run the deterministic interaction coverage with installed frontend dependencies:

```sh
cd frontend
npx vitest run src/Configuration.test.tsx
```

It covers normalized successes, each field contradiction, enabled-state changes
on edits, both toggle directions, duplicate creation IDs, failed/successful
refresh, retained confirmed values/drafts/selections and keyboard recovery across
all three types. Frontend tests/build and ordinary Python checks remain part of
supervisor verification; live provider calls are skipped under user policy.

## Unsaved employee, team and configuration drafts (C59-T1)

Use the checkout launch instructions above, or start the already built local
product without provider configuration:

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-drafts.sqlite3
```

Open http://127.0.0.1:8765. No credentials, work text or execution is needed.

1. Leave **What would you like help with?** empty. Browse teams and open
   configuration. Untouched new forms and selected saved records must not show
   unsaved status or request a leave warning.
2. Type an employee name, a new team name, and select an employee to add to a
   saved team. Edit a saved Skill's instructions, a Hook field or a Loop limit.
   Each meaningful draft shows **Unsaved drafts**. Attempt a reload or tab close,
   then choose to stay. The browser should warn after user interaction (wording
   and whether a dialog is allowed are controlled by the browser).
3. Switch teams, record types and records. Close teams and configuration. Draft
   summaries remain visible, including record IDs, and leaving is still protected.
   Reopen the panels: selections and field values remain in this session.
4. Revert a field to its original value, uncheck a selected member, or use the
   corresponding **Discard … draft** control. Only that draft is cleared. With
   several drafts present, saving/discarding one must leave protection active
   until the others are saved, reverted or discarded. Successful validated saves
   clear their own contribution. Untouched Hook/Loop defaults never contribute.
5. Use the receipt-recovery exercises above to reject a team or configuration
   save. Drafts and leave protection remain; refresh does not resend them.
   Inspect confirmed values before explicitly retrying. Discard remains an
   explicit choice even after failure. Finally type work text: existing work
   draft protection must still operate independently.

Drafts are in memory, not durable storage. A browser warning cannot guarantee
recovery after a forced close or crash. Closing a panel retains its drafts.

Deterministic React interaction coverage (with frontend dependencies installed):

```sh
cd frontend
npx vitest run src/unsaved-drafts.test.tsx src/Teams.test.tsx src/Configuration.test.tsx
```

The interaction tests dispatch cancellable `beforeunload` events to inspect the
actual leave guard without browser-dialog automation. Supervisor verification
must run the frontend TypeScript/test gate and the applicable product profile.
Browser exercise and consolidated verification are pending for this snapshot;
live provider calls are skipped under user policy.

Creation confirmation and recovery (C60-T1): launch `agentown-web` using the
local server setup above, then open its displayed workspace URL.

1. Enter an employee name with surrounding spaces and choose **Create employee**.
   The name clears and **Assign to** changes only after refreshed employees
   contain the new receipt ID with the Rust-normalized name. Edit the name while
   saving: that newer draft must survive successful confirmation.
2. Enter work with surrounding whitespace, select an employee, and choose
   **Save work**. Only a refreshed record with a new receipt ID, the exact text,
   and that single assignee clears the draft and selects the saved work.
3. With a controlled API fixture, return an existing ID, omit the receipt record
   from refreshed state, change its name/text/assignee, return invalid workspace
   data, or fail the refresh. Drafts and previous selections must remain. The
   **Creation recovery** region appears and both creation actions stay blocked.
   Double clicks and direct form submissions must not create duplicate requests.
4. Restore valid state. Polling alone must not unlock submission. Focus
   **Refresh connection**, press Enter, then Tab to **I inspected employees and
   saved work**. Inspect loaded records before pressing Enter to acknowledge.
   Nothing is resent; review drafts before any explicit new submission.

Runnable deterministic interaction coverage, with frontend dependencies installed:

```sh
cd frontend
npx vitest run src/creation-recovery.test.tsx src/deadlines.test.tsx src/App.test.tsx
```

These fixtures cover receipt/refresh failures, keyboard recovery, duplicate
submission guards, Rust Unicode whitespace behavior and exact work text.
Consolidated checks and browser validation are pending supervisor verification
for this snapshot. Live provider calls remain skipped, not passed.

Team persisted-save confirmation (C61-T1): use the existing prepared-checkout
launch command:

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-teams-recovery.sqlite3 --port 8765
```

Open <http://127.0.0.1:8765> and choose **Browse teams**. Create a team or
add employees. A save receipt now triggers a validated GET of teams before the
success message, confirmed data update, or submitted draft removal. The read
must contain the receipt ID, requested name and membership, including previously
confirmed members. Other team selections and the unrelated name draft remain.

For uncertain-delivery exercises, use the existing Teams transport interception
steps above, but return a valid POST receipt and intercept the following GET:
return an empty teams list, a changed name, omitted previous member, or reject
the read. Confirm no success appears, the prior team and drafts remain, and
repeated submit/Enter does not send another POST. Restore transport, Tab to
**Refresh teams**, and press Enter. Inspect the refreshed IDs, names and members,
then activate **I inspected saved teams and membership** with Enter. Only then
may you explicitly submit again; refresh and inspection never resend a request.
If the first save is visible, discard the retained draft rather than duplicate it.
A failed refresh keeps inspection disabled. On a confirmed save, only the
submitted draft clears and focus returns to **Saved team**.

Deterministic cases in `frontend/src/Teams.test.tsx` cover matching receipts
followed by missing/contradictory state, failed reads, confirmed saves, unrelated
drafts, duplicate submissions while confirming, and keyboard refresh/inspection.
With dependencies available: `cd frontend && npx vitest run src/Teams.test.tsx`
and `npx tsc --noEmit`. Supervisor-selected consolidated and browser checks
remain pending; live LLM calls are skipped under the current user policy.

Configuration persisted confirmation (C62-T1): launch `agentown-web --database
PATH` from the prepared checkout and open Configuration. Create a Skill, then a
Hook referencing that Skill and an employee/team, then a Loop referencing saved
work. Edit each record and enable/disable it. Each mutation must be followed by a
GET of its corresponding `/api/config/v1/skills`, `/hooks` or `/loops` list.
Success, selected ID and submitted draft removal occur only when that list
confirms the receipt ID, requested fields and enabled state. Other drafts remain.

To exercise recovery without provider calls, use browser Network response
replacement (or the existing configuration transport interception) to leave the
mutation receipt intact but replace the subsequent GET body with an empty list,
a record with a contradictory field/enabled value, or malformed data; also try a
failed GET. Hold that GET to verify pending controls block duplicate submissions
and retain leave protection. On failure, prior confirmed values, selection and
all drafts remain, with an uncertain-delivery alert and no success announcement.
Restore genuine GET responses, focus **Refresh configuration** with Tab and press
Enter. A failed refresh keeps inspection disabled. After a successful refresh,
select persisted records and inspect IDs, fields and enabled state, then activate
**I inspected saved configuration** with Tab/Enter. Only then explicitly retry if
needed. Neither refresh nor inspection sends a mutation. Toggle confirmation
never clears an existing field draft. No credentials or live LLM calls are needed.

Deterministic coverage is in `frontend/src/Configuration.test.tsx` (all three
record types, creation/editing, both toggle directions, delayed confirmation,
invalid/failed confirmation, unrelated drafts and keyboard recovery). Run from
`frontend`: `npm test -- --run src/Configuration.test.tsx src/unsaved-drafts.test.tsx`.
Supervisor verification and browser validation remain pending for this snapshot.

Execution persisted-history confirmation (C63-T1): from a prepared checkout,
launch a disposable workspace with
`uv run --directory python --locked agentown-web --database /tmp/agentown-execution-confirmation.sqlite3 --port 8765`.
Open <http://127.0.0.1:8765>. Use the existing deterministic provider fixture
setup above; no real provider calls are required. Create an employee and saved
work, execute ordinary work, then preview and execute an enabled Skill and Hook.
Each receipt must be followed by validated `/api/state` history containing its
new Run ID, terminal outcome, input, provider/model, result/error, unverified
quality and applicable saved provenance before submission unlocks.

For deterministic interaction coverage run from `frontend`:
`npx vitest run src/execution-receipt.test.tsx src/App.test.tsx src/deadlines.test.tsx`
and `npx tsc --noEmit`. The receipt tests exercise all three paths with success
and provider failure, held confirmation, absent/contradictory/malformed/failed
history, repeated clicks, retained drafts and keyboard recovery. To exercise
manually with transport interception, preserve a valid receipt and hold or
replace its following `/api/state` response. Controls stay locked while held.
Missing or contradictory history announces uncertain delivery. Restore responses,
Tab to **Refresh connection**, press Enter, inspect saved attempts and provenance,
then Tab to **I inspected execution history** and press Enter. A failed refresh
keeps inspection disabled; polling never releases recovery. Retry only explicitly
if needed; neither recovery action resends work. Skill and Hook need fresh previews.
Supervisor consolidated verification, disposable-server/browser exercises and
visual validation remain pending for this snapshot. Real LLM calls are skipped,
not passed.

### Loop persisted confirmation and explicit recovery (C64-T1)

Launch a disposable product database, using the existing saved configuration
workflow (no credentials or live provider calls are needed):

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-loop-confirmation.sqlite3 --port 8765
```

Open http://127.0.0.1:8765. Create an employee, save assigned work and configure
an enabled Loop with two iterations and a 60-second interval. Preserve an unsaved
work draft while exercising the controls. Use browser network interception for
`GET /api/loops/v1` after a mutation response, leaving POST responses intact:

1. Keyboard-select the saved Loop, preview and authorize once. Hold the following
   GET: the status says the response was received and saved confirmation is
   pending. Repeated activation must send only one POST. Release a matching
   session, including an increased admitted count or terminal state: confirmation
   succeeds without requiring the original active snapshot.
2. Repeat with a missing session, changed preview/provider/model, regressed or
   excessive admission count, malformed JSON or failed GET. The status announces
   uncertainty; loaded records, policy selection and draft remain. Permit normal
   polling to recover: a new start must remain blocked.
3. Tab to **Refresh Loop session records**, press Enter, inspect the displayed
   sessions and attempts, then keyboard-activate **I inspected refreshed Loop
   records**. These controls issue reads only. A new start requires a fresh preview
   and consent; an active session continues to block duplicate starts.
4. During start recovery, refresh a recorded active session with granted local
   authority and explicitly **Stop Loop**. Local stop is confirmed only after the
   following GET records that same stopped session. Remote completion remains
   unknown. Repeat from company overview, including with linked work unavailable.
   Hold/fail/corrupt the confirmation GET or return an active session: uncertainty
   remains and previous records stay readable. Keyboard-activate **Inspect Loop
   sessions again** to recover controls without replaying the stop.
5. Delay a polling read across a mutation, then return it. Its earlier generation
   cannot overwrite confirmation. Authority loss and stale inspection must prevent
   stop; a fresh granted inspection restores explicit emergency stop.

Focused deterministic interaction checks (from frontend, once dependencies exist):

```sh
npm exec -- tsc --noEmit
npm exec -- vitest run src/loop-response.test.tsx src/LoopExecution.test.tsx src/OverviewLoops.test.tsx
```

This implementation invocation did not execute the launch or browser exercise.
Frontend dependencies were unavailable in the isolated snapshot; focused checks
and the supervisor browser gate are pending. Live provider calls are skipped,
not passed. Earlier receipt-only instructions are superseded by this section.

### Loop consent focus recovery (C65-T1)

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-loop-recovery.sqlite3 --port 8765
```

Open http://127.0.0.1:8765 and open saved assigned work with an enabled Loop
(or create an employee, save assigned work, and configure that Loop first).
Keep an unsaved work draft. Preview the selected Loop and leave keyboard focus
on **Authorize and start bounded Loop** or **Cancel Loop preview**. Using the
existing deterministic inspection fixture or network interception, return
`control: {state: "competing_owner", can_control: false, message: ""}` on the next
`GET /api/loops/v1`, preserving the existing sessions and attempts.

Consent disappears and focus reaches the labeled **Run a bounded Loop** region
when preview is unavailable. Repeat with focus on another control outside the
preview: its focus must remain unchanged. Return the original available authority
on a fresh inspection. Selection, draft and readable history remain; recovery
does not move focus or replay start/stop. A new start requires a new preview and
explicit authorization. The C64 persisted-confirmation, explicit recovery and
emergency-stop checks above still apply.

`LoopExecution.test.tsx` deterministically triggers the product polling callback
for focused start, focused cancel and outside-focus cases, retaining the exact
Loop-region focus guarantee and checking fresh preview plus explicit consent.
Focus is tracked while the preview is mounted, so invalidation can restore it
even after the removed control has yielded focus to the page body. Moving focus
outside the preview before invalidation leaves that outside control focused.
This invocation did not launch the product or run browser checks. Frontend
dependencies are absent in the isolated snapshot; focused tests, frontend
tests/build and ordinary Python checks remain pending supervisor verification.
Live provider calls are skipped, not passed.

### Selected-work local MCP inspection recovery (C67-T1)

Launch with the installed product entry point and an absolute product database:

```sh
agentown-web --database /absolute/path/to/product.sqlite --port 8765
```

Open http://127.0.0.1:8765, select saved work, and keyboard-activate **Inspect
through local MCP**. Confirm the displayed Task ID matches the selection, and
inspect recorded attempts, provider results and their unverified quality label.
This is installed-local-MCP evidence only; it does not verify an external client
or execute work. A work item without attempts must say so explicitly.

Change selection while inspection is pending, including A → B → A. Old results
and errors must stay discarded. No new inspection occurs until explicitly
requested. If the local server is busy, unavailable, or times out, the inspection
control becomes available for explicit retry; recovery must never execute work.

Execution regression exercise: select work whose latest saved output is an empty
string. **Retry explicitly** must still open resend consent. Escape cancels and
returns focus; only **Confirm resend** submits one attempt. For an uncertain Hook
submission, a failed **Refresh connection** must keep recovery blocked. After a
successful explicit refresh, keyboard-activate **I inspected execution history**.
Recovery must require a fresh Hook preview and fresh consent, with no replay.

C67 implementation evidence: inspected current inspection, consent, Hook preview
validation and explicit-refresh code. The current tests already contain the
availability waits and required `hook_name` fixture repair. No new production
defect was established by static inspection, so these repairs are preserved.
Added deterministic coverage for A → B → A late-error rejection and cancellation,
empty-output keyboard cancel/confirm with exactly one submission, and Hook
recovery requiring fresh preview without replay. Existing coverage checks matching
Task identity, stale success, unavailable inspection, explicit retry and timeout.

Frontend dependencies are absent in this isolated workspace (`frontend/node_modules`
does not exist), so focused tests and TypeScript checks were not executed. No
current verification artifact was supplied; historical failure descriptions are
diagnostic leads only. The supervisor must run frontend tests/build and the other
checks selected by its current verification profile. Focused regression command:

```sh
cd frontend
./node_modules/.bin/vitest run src/WorkInspection.test.tsx src/HookExecution.test.tsx src/App.test.tsx -t 'inspection|empty saved output|unknown submission'
```

The launch and browser exercise above were not executed in this invocation;
supervisor browser validation remains pending. Live LLM calls are skipped, not
passed. External clients remain unverified.


### Saved Skill and Hook context in local inspection (C68-T1)

In a prepared development checkout with frontend assets built, run the credential-free
provider fixture using a new disposable database (stop an existing server on port 8766 first):

```sh
printf 'success' > /tmp/c68-response-gate
uv run --directory python --locked python tests/web_browser_server.py /tmp/c68-work.sqlite3 8766 /tmp/c68-response-gate
```

Open <http://127.0.0.1:8766>. Create an employee and save assigned work. In configuration,
create and enable a Skill with recognizable instructions, and an employee Hook for
**run completed** using that Skill. Explicitly execute ordinary work once, then preview
and confirm Skill execution, and preview and confirm the matching Hook. Each execution
is a deliberate setup action against the deterministic provider; inspection requires
no execution consent and never executes or retries work.

Select that saved work and keyboard-activate **Inspect through local MCP**. Verify the
confirmed Task and per-attempt Run IDs. The ordinary attempt says no saved Skill or Hook
context was recorded. The Skill attempt displays its saved name, Skill ID, preview ID,
instructions and effective input. The Hook attempt additionally displays its saved Hook
name and ID, source Run ID/event/outcome and target employee ID, alongside its saved
Skill context. Compare the effective input with the recorded execution. Editing current
configuration must not change these saved snapshots on a later inspection.

The observable artifact is the confirmed inspection with each snapshot attached to its
own Run. Monitor the network and `/tmp/c68-response-gate.calls`: pressing inspection must
only POST `/api/connections/v1/inspect-work`, with no execute/retry request and no increase
in provider submissions. Repeat inspection after switching selection and during a held
response, including A → B → A; late results must not restore old context. Simulate a
failed response or contradictory saved input/source identity using network interception:
confirmation and saved context must disappear, with explicit inspection available for
recovery. Restore the genuine response and inspect again; nothing is replayed.

Focused deterministic interaction coverage, with dependencies available:

```sh
cd frontend
./node_modules/.bin/vitest run src/WorkInspection.test.tsx
./node_modules/.bin/tsc --noEmit
```

This invocation added response validation, per-attempt display and interaction tests.
Frontend dependencies are absent in the isolated workspace, so these commands and the
browser exercise were not executed here. Integration with the Python mapping and
supervisor checks/browser validation remain pending. Live LLM calls are skipped, not
passed; external-client connection remains unverified.


### Inspect recorded Loop context through local MCP (C69-T1)

Prerequisites: the delivered Loop inspection and saved-context flow, an installed
`agentown-mcp` command and an existing product database containing recorded work.
Launch `agentown-web --database /absolute/path/product.sqlite --port 8765`, then
open <http://127.0.0.1:8765>, or launch the packaged app against that database.
Select saved work and keyboard-activate **Inspect through local MCP**. No
credentials or external-client connection are needed.

For a recorded Loop attempt, inspect its **Saved Loop context** region: session
ID, ordinal, original policy name, original input, maximum attempts and interval
are recorded admission context. Compare with an edited current policy: the saved
context retains the original values. **Observed session state**, admitted count
and next time are separate observations; history and session progress may advance
between reads. Ordinary and Skill/Hook attempts retain their existing display.
Confirmed absent linkage displays an explicit absence message; uncertain linkage
says absence is not confirmed and offers explicit reinspection.

The evidence names every tool in order: `get_task`,
`get_work_history_v1` with `read_only=true`, and `inspect_loop_sessions_v1`.
Inspection invokes no execution, stop, recovery or provider operation. It does not
change product records. Switch selected work during a held inspection: the old
response must never appear on the new selection. Malformed data or transport
failure clears previous confirmation and leaves the same inspection button
available for explicit retry, without automatic retries.

Deterministic frontend coverage is in `frontend/src/WorkInspection.test.tsx`:
`npm exec -- vitest run src/WorkInspection.test.tsx` from `frontend/` with dependencies
prepared. The supervisor-selected checks and browser validation remain pending.
Live provider validation remains skipped, not passed.

### Copy a selected-work MCP handoff (C70-T1)

Use an existing product database with saved work; no external client installation,
credentials or provider calls are needed. Run:

```sh
agentown-web --database /absolute/path/product.sqlite --port 8765
```

Open <http://127.0.0.1:8765>, or open the packaged desktop app with its existing
product database. Select **Saved work**, note its Work ID, and keyboard-activate
**Copy read-only MCP handoff**. The accessible status identifies the copied Task.
Paste into a plain text editor to verify the canonical Task ID and exact calls:
`get_task({"task_id":"ID"})`,
`get_work_history_v1({"task_id":"ID","read_only":true})`, and
`inspect_loop_sessions_v1({})`. The instructions require filtering Loop context
to that Task and separate explicit consent for execution or retry. They include
no saved result bodies or credentials. Copying itself sends no requests, changes
no records or client settings, and does not establish external connectivity.

If clipboard access is denied or unavailable, the status explains recovery and
reveals **Manual read-only MCP handoff**. Focus its read-only text field to select
all, then use your device's copy command. **Show manual handoff** also makes this
available directly. Manual copying is not reported as confirmed clipboard success.
Retry the Copy button explicitly after restoring clipboard access.

Switch between two saved Tasks and verify pasted IDs follow selection. During a
held clipboard operation, the Copy button is disabled. Change selection (including
A → B → A), remove selected work from refreshed history, or disconnect the server
and wait for the connection status to change: old manual text and copy confirmation
must disappear, and late clipboard completion must not restore them. A clipboard
write already submitted to the device cannot be recalled; paste and check the ID
before using it. Refresh the connection and select available saved work before
copying again. Observe the network: handoff controls send zero MCP, execution,
provider or settings requests. Local MCP inspection remains a separate action.

With frontend dependencies prepared, run the deterministic interaction checks:

```sh
cd frontend
./node_modules/.bin/vitest run src/WorkHandoff.test.tsx
./node_modules/.bin/tsc --noEmit
```

Keyboard recovery exercise (C113-T1): choose **Show manual handoff**, then Tab
into **Manual read-only MCP handoff**. While focus remains in that textarea,
refresh history after removing the selected work in another local window, or
stop the local server and wait for the workspace to report disconnection.
Focus must move to **Share selected work with an MCP client**, and the polite
status must announce that the previous manual handoff is unavailable. Tab
continues to the next available control. Reconnect/refresh and select saved work:
the textarea stays closed until you explicitly choose **Show manual handoff**.
Repeat with focus on a control outside the handoff; that focus must stay put.
Changing the selected Task also invalidates the manual handoff. Ordinary selection
clicks retain focus on the selection control; the deterministic tests above cover
a selection update while the textarea itself retains focus. They also hold and
resolve/reject clipboard promises across each invalidation and verify zero
network requests. These tests require no credentials or external MCP client.

Supervisor frontend-profile verification passed all 19 WorkHandoff tests and
1,187 frontend tests, TypeScript checking, the production build, and 505 Python
tests with 2 skipped. Installed-browser and installation/process-recovery gates
were deferred by this profile. Live provider validation is skipped, not passed;
external connectivity is unverified.

### Ordinary-text readiness in selected-work inspection (C72-T1)

Prerequisites: delivered text preflight and local MCP inspection, an installed
product, and an existing product database with saved work. Run:

```sh
agentown-web --database /absolute/path/product.sqlite --port 8765
```

Open <http://127.0.0.1:8765>, or launch the packaged desktop app against that
database. Select saved work and keyboard-activate **Inspect through local MCP**.
The **Ordinary-text execution readiness** region shows the preflight Task ID,
exact saved ordinary-text input, assigned employee IDs, observed attempt count,
active-attempt state, advisory eligibility and resubmission-consent requirement.
Evidence includes `preflight_text_work_v1` alongside the three existing reads.
No credentials or external client are required.

Readiness does not validate provider configuration, grant consent or authorize
execution. Each tool is a separate observation: counts, saved text and assignments
can differ during concurrent changes. Missing work at preflight has no saved
input and must not imply eligibility, even if an earlier Task read succeeded.
If deletion prevents an earlier read, the entire inspection can be unavailable.

Switch selection (including A → B → A), disconnect, or hold a response while
switching/disconnecting: readiness clears and late completions cannot restore it.
Reconnect explicitly, then inspect again. Timeout, malformed data or transport
failure also clears readiness and leaves explicit retry available. No automatic
execution, mutation, lease recovery or provider call is requested by inspection.

Deterministic interaction/parser coverage is in
`frontend/src/WorkInspection.test.tsx`, including eligible, ineligible, missing,
concurrent differing observations, malformed readiness, disconnection and explicit
recovery, plus existing selection, timeout and late-completion cases. With
frontend dependencies prepared:

```sh
cd frontend
./node_modules/.bin/vitest run src/WorkInspection.test.tsx
./node_modules/.bin/tsc --noEmit
```

This implementation invocation did not run these checks because frontend
dependencies are absent in its isolated workspace. Supervisor-selected checks
and browser validation are pending. Live provider validation remains skipped,
not passed.

The selected ordinary-text execution API is available independently of its
forthcoming screen control. Launch `agentown-web --database
/absolute/path/product.sqlite --port 8765` with the configured provider/model
flags. Inspect saved work before POSTing `/api/connections/v1/execute-work` with
canonical `task_id`, observed `expected_runs` and explicit boolean
`resubmission_consent`. See the [exact contract and recovery steps](text-execution.md#explicit-local-product-execution-api).
Inspection remains read-only; uncertain delivery requires inspection and fresh
consent, never automatic replay. Live-provider validation remains skipped.

### Execute selected saved work through local MCP

Launch `agentown-web --database /absolute/path/product.sqlite --port 8765`
with the existing `--provider` and `--model` flags for your configured provider.
Open `http://127.0.0.1:8765`, create an employee and save/assign ordinary text,
or select existing saved work. Choose **Inspect through local MCP**. Review the
exact saved ordinary-text input, assigned employee IDs, active-attempt indicator,
and observed attempt count. Inspection itself never calls a provider.

For eligible work, check **I authorize one execution of this saved input** and
choose **Execute once through local MCP**. This can incur provider cost. For work
with prior attempts the checkbox explicitly authorizes one resubmission. Each
submission consumes consent and locks duplicate clicks. Selection changes and
disconnection discard consent and any late response. Keyboard users can Tab to
the checkbox, press Space, then Tab and Enter to execute. After a response or
failure, focus moves to **Inspect before another execution**.

A recorded result is labelled quality unverified. “Transport completed” means the
execution record arrived; inspect whether it contains output or a provider error.
It does not approve output or complete the saved Task. Configuration, busy and
admission rejection, timeout, malformed replies and lost delivery all require
explicit reinspection before fresh consent. Nothing automatically replays.
Recovery inspection remains available for the selected ID even if refreshed
history no longer lists that work; missing readiness cannot authorize execution.
Reconnect explicitly when disconnected, then inspect again. An active attempt
must finish or be reconciled through the existing recovery procedure in
[text execution](text-execution.md) before requesting more work.

Real provider calls remain skipped under the user’s live-test policy. React
interaction fixtures exercise consent and recovery without credentials; their
outputs are deterministic fixtures, not live LLM validation.

Selected-work expired attempts can now be explicitly reconciled through the
same-origin `POST /api/connections/v1/reconcile-work` API with
`{"task_id":"<canonical UUID>","recovery_consent":true}`. This is separate
from inspection and execution; the screen recovery control is subsequent work.
See [runnable recovery steps](text-execution.md#explicit-expired-attempt-recovery-through-local-mcp)
for consent scope, response outcomes, and deterministic installed-process coverage.

### Selected-work recovery consent (C75-T2)

Launch `agentown-web --database /tmp/agentown-recovery.sqlite --port 8765`
with the deterministic expired-attempt database described in
[text execution recovery](text-execution.md#product-screen-recovery-demo).
Select the seeded work and choose **Inspect through local MCP**, then **Review
recovery scope**. The review explains that other expired leases in the database
snapshot can change. Keyboard activation moves focus to the authorization
checkbox; Space selects it, Tab reaches **Reconcile expired attempts once**, and
Enter submits. Pending disables duplicate submission. Confirmation distinguishes
observed interrupted attempts from attempts that remain active, without claiming
that the receipt proves a transition. Focus then moves to **Inspect after recovery**.

Recovery clears inspection and prior execution consent. Inspect explicitly again
and authorize execution anew; recovery never executes. On timeout, malformed
receipt or transport loss, delivery remains uncertain. Selection and recovery
controls remain available even if refreshed saved history omits the selected
work. Inspect read-only before deciding on another separately consented recovery.
Mounting, polling, opening scope review and ordinary inspection never reconcile.

Interaction coverage: `frontend/src/WorkRecovery.test.tsx` (keyboard/focus,
consent, pending duplicate lock, stale selection, uncertain delivery and receipt
validation). Supervisor browser and consolidated checks are pending for this
snapshot; live provider calls are skipped under user policy.

### Apply a saved employee Hook through local inspection

Launch `agentown-web --database PATH` with the database containing saved work,
an assigned employee, an enabled Skill and enabled employee Hook. The work needs
an eligible latest ordinary Run: `run_completed` / `reported_success`, or
`run_failed` / `failure`, matching the Hook event. Team and task-created Hooks
are not eligible for this follow-up flow.

Select saved work, choose **Inspect through local MCP**, then **Find Hooks through
local MCP**. Select a Hook and choose **Preview local Hook**. Discovery and preview
never execute. Review the exact effective input, target employee, Skill, source
Run/event/outcome, preview ID and prior attempt count. Check the separate consent
box and choose **Execute local Hook once** to authorize one attempt. Enabled
configuration never implies automatic dispatch. Provider/model settings are those
of the running server; live provider validation is currently skipped.

The panel displays persisted output or recorded provider error and **Quality
unverified**. Every dispatch consumes consent, including rejected, malformed or
uncertain receipts. Use **Inspect before another Hook execution**, discover again
and obtain a fresh preview before another authorization. Selection changes,
disconnection, reinspection and replacement previews discard consent and ignore
late replies. Unsaved drafts and ordinary execution/Skill/recovery remain in
their existing controls. Deterministic coverage lives in `WorkHook.test.tsx`;
supervisor browser validation is pending for this change.

Selected-work bounded Loop APIs are available under
`/api/connections/v1/loops/{list,preview,start,inspect,stop}` when running
`agentown-web --database /absolute/company.sqlite --provider anthropic --model MODEL_ID`.
See [the runnable request sequence and ownership limitations](mcp.md#selected-work-loop-control-through-the-local-screen-server).
These APIs require existing assigned work and an enabled saved Loop policy. Preview
is credential-free; activation requires explicit consent to the exact observed
input, employee, attempt count, bounds and server provider/model. The web process
retains the installed MCP execution owner until shutdown, so inspection and Stop
reach the same owner. Deterministic subprocess fixtures are test evidence only;
real provider operation remains skipped, and browser verification is pending.

### Selected-work Loop through the retained local MCP owner

Launch the installed product with `agentown-web --database /ABSOLUTE/PATH/company.sqlite3`.
Use existing saved work assigned to an employee and an enabled Loop policy for that
Task. Select the saved work, choose **Inspect through local MCP**, then **Find matching
Loops through local MCP**. Choose a Loop and **Preview local Loop**. Review the exact
saved input, employee, provider/model, prior attempt count, maximum attempts and
interval. Check the authorization box, then separately choose **Authorize and activate
local Loop**. Configuration, mounting, discovery and preview never activate it.

Choose **Inspect local Loop sessions** to read persisted state and attempts. Results
are quality-unverified. A receipt alone is not a persisted-state confirmation. After
activation, consent is consumed; inspect records and acknowledge inspection before
requesting a new preview. Uncertain delivery never triggers automatic replay.

Session controls remain visible when changing selected work, replacing a preview or
losing the connection. Reconnect, inspect the retained session and choose **Stop local
Loop**. Stop prevents new admissions and attempts local cancellation; remote provider
completion may remain unknown. Changing selection or disconnecting does not stop work.
Another owner requires Stop through that owning MCP/web server; after shutting down
that owner, inspect and explicitly retry. Restarting this page can recover sessions
by selecting their Task and explicitly inspecting local Loop sessions.

This UI uses the installed local MCP process (`list_loops_v1`, `preview_loop_v1`,
`start_loop_v1`, `inspect_loop_sessions_v1`, `stop_loop_v1`) through the web server's
retained owner. It is not evidence of an external-client connection or live-provider
validation. Deterministic interaction coverage is in `frontend/src/WorkLoop.test.tsx`;
supervisor browser validation is pending for this implementation snapshot.

### Open a recorded Loop from the company overview

Run `agentown-web --database PATH` against the database containing your saved
work and Loop sessions, and open the printed local URL. In Company overview →
Bounded Loop activity, Tab to **Open work: … · Loop …** and press Enter.
This carries the recorded Task ID and session ID into local MCP inspection,
clears history filters, and preserves unsaved employee, configuration and work
drafts. Navigation performs no execution action.

The requested-inspection region receives focus. Choose **Inspect local Loop
sessions** explicitly: this reads through the retained local MCP endpoint and
focuses the matching saved session. Check both IDs and saved input. If the
session is missing, the screen says so; if linked work is absent, the overview
has no Open action. Disconnected records and cached records may be stale.
Competing-owner inspection does not authorize Stop, regardless of the
caller-declared source. Rapid navigation discards obsolete read results.

For an active session with granted authority, choose **Stop local Loop …**.
The request uses `/api/connections/v1/loops/stop` with the exact Task and session
IDs, followed by read-only inspection. Only persisted `stopped` state with
matching saved provenance confirms Stop. A lost or uncertain receipt stays
unconfirmed and is never replayed automatically; explicitly inspect before
considering another action. Stop requests local cancellation; remote completion
may remain unknown. Merely opening, inspecting, disconnecting or changing the
selection never starts, resumes or stops work.

Deterministic coverage is in `OverviewLoops.test.tsx` and `WorkLoop.test.tsx`.
Run `cd frontend && npm test -- src/OverviewLoops.test.tsx src/WorkLoop.test.tsx`
with frontend dependencies available. Supervisor change-based verification and
browser validation are pending for this implementation snapshot. Live provider
calls are skipped under the current user policy, not passed.

### Open a saved Loop device’s linked work

Launch `agentown-web --database PATH` with the database containing saved work and
Loop policies. In Company overview → Saved Loop policy devices, use **Open linked
work · local MCP** (Enter or Space also works). The separate device/Configuration
action continues to open the exact policy editor. Existing work and configuration
drafts remain intact. Missing linked work disables the work action; disconnected
or stale snapshots are labeled and never imply execution.

The requested Task and policy IDs appear in the focused Requested Loop inspection
region. Navigation clears prior inspection, preview and execution consent and
makes no preview, activation or stop request. Choose **Inspect through local MCP**,
then **Find matching Loops through local MCP**. Discovery selects and focuses only
the requested enabled policy ID, even when names repeat. If the policy was removed,
disabled or moved to another Task, the screen explains that it is unavailable;
no similarly named policy is substituted. Select **Preview local Loop**, inspect
its exact saved input, limits, provider and model, then explicitly authorize that
preview before activation. Recorded-session navigation remains a separate explicit
inspection flow. Rapid navigation discards obsolete inspection/discovery responses.

Deterministic checks for this slice (with frontend dependencies installed):
`cd frontend && npx tsc --noEmit && npx vitest run src/LoopDevices.test.tsx src/WorkLoop.test.tsx src/OverviewLoops.test.tsx src/WorkInspection.test.tsx`.
Supervisor browser/change-based verification is pending for C80-T1; live provider
calls are skipped under the user’s live-test policy, not counted as passed.


### Open a Hook device’s assigned work

Launch `agentown-web --database PATH` using the database containing saved employees,
assigned work, a Skill and employee `run_completed` or `run_failed` Hooks. In Company
 overview → Hook trigger devices, choose an explicit saved work item by Task ID
under the desired Hook ID (names can repeat). The original Configuration button
remains available, and work/configuration drafts are retained. Team and task-created
Hooks are configuration only; employees without loaded assignments show an empty
explanation. Refresh saved history if assignments are missing.

Opening clears history filters and focuses “Requested Hook inspection”. It sends
no inspection, discovery, preview or execution request. Choose “Inspect through
local MCP”, then “Find Hooks through local MCP”. Only the exact requested enabled
employee follow-up Hook is selected, after checking its target against the inspected
assignment. Missing, disabled, retargeted or unsupported records explain the problem
without selecting another Hook. Choose “Preview local Hook” explicitly; the server
validates current state. Review the exact preview and give fresh checkbox consent
before executing once. Navigation (including the same Task again), disconnection
and reinspection discard obsolete inspection, previews and consent; late replies
cannot restore them. Disconnection does not establish cancellation of dispatched work.

Deterministic interaction coverage: `cd frontend && npm test -- HookDevices.test.tsx
WorkHook.test.tsx`. These fixtures cover duplicate identities, keyboard focus,
empty/unsupported devices, exact selection, stale replies, draft retention and
navigation without mutation. Supervisor browser verification remains pending for
this change. Live provider calls are skipped under the current user policy.

### Open saved work from a Skill book

Launch `agentown-web --database PATH`, open the printed local URL, then use
Company overview → Skill library. The existing book button opens Configuration.
Each book has a labeled saved-work chooser and one **Open** action. Options
include exact Task IDs; labels include exact Skill IDs, even with duplicate names
or work text. The compact native chooser supports standard keyboard navigation. If history is empty, save work or refresh saved history.
Unavailable, refreshing or stale book snapshots disable work navigation.

Choose saved work, then Tab to **Open** and press Enter or Space (or click it).
Choosing alone makes no request, grants no consent and leaves inspection unchanged.
Valid choices survive history polling and reordering. If chosen work disappears,
the chooser clears and requires a new explicit choice, even if that Task returns.
Disconnected history explains why Open is unavailable. The Open action clears history
filters, retains unsaved drafts and focuses Requested Skill inspection. Navigation
makes no MCP request and grants no consent. Choose **Inspect through local MCP**,
then **Find Skills through local MCP**. Only the requested enabled Skill ID is
selected and focused; missing or disabled records explain why no selection was
made. Names never substitute for identity. Choose **Preview local Skill**, review
the exact input, authorize that preview, then separately choose **Execute local
Skill once**. Reopening even the same Task, changing selection or disconnecting
invalidates inspection, previews and consent; late replies cannot restore them.
Inspect and discover again explicitly after recovery.

Deterministic interaction coverage lives in `SkillBooks.test.tsx` and
`WorkSkill.test.tsx`. Browser validation for the saved-work chooser is pending the supervisor gate. Real provider calls are skipped
under the live-test policy, never passed.

### Inspect retained local MCP Loops from Company overview

Launch `agentown-web --database PATH` with the same product database used for
saved work and Loop sessions, then open the printed local URL. Without selecting
work, choose **Inspect company Loops through local MCP** in Company overview.
This explicit read calls `inspect_loop_sessions_v1({})` through the web process's
retained local MCP owner. It lists all recorded Task/session IDs, persisted state,
attempt status and the owner's authority. Empty, unavailable, stale (after 2.4
seconds) and competing-owner results have separate messages. Caller-declared
source is unverified and never grants control. Refresh is explicit; this panel
does not poll or mutate work.

For a loaded Task, choose **Inspect local MCP session … in work** (keyboard Enter
or Space works). The existing selected-work inspection receives exact IDs and
focuses its requested-inspection region; drafts remain intact. Choose **Inspect
local Loop sessions** there to read and focus the exact session and reach its
existing explicit Stop flow. Navigation does not preview, start, stop, or check
consent. If linked work is unavailable, the overview explains why it cannot open
it. Cached rows remain labeled stale after failed inspection; inspect again for
current state and authority. Another owner must be stopped through its own server.

Deterministic checks: `cd frontend && npm test -- OverviewLoops.test.tsx WorkLoop.test.tsx loop-response.test.tsx`;
from `python/`, run `python -m pytest tests/test_selected_loop.py` with the native
binding installed. These fixtures do not establish real provider operation; live
provider calls remain skipped. Browser verification is performed by the supervisor
under the change-based verification profile.

### Stop a retained local MCP Loop from Company overview

Run `agentown-web --database PATH` against the database containing the retained
local MCP session, then open Company overview. Choose **Inspect company Loops
through local MCP** explicitly. The row displays the exact Task ID, session ID,
persisted state and current owner authority. Linked work need not be present in
loaded history. Inspection alone never authorizes a mutation.

For an active session with fresh granted local authority, focus **Stop local MCP
Loop SESSION from overview** and press Enter (or click it). A pending status
appears immediately; duplicate activation cannot dispatch another request.
The request uses that row's exact Task and session IDs through the retained
owner Stop API. Success is shown only after a separate persisted Task inspection
returns `stopped` with matching session identity, preview, provider/model and
session timestamps. The row then displays **Persisted state: stopped** and
**Saved stopped state confirmed**. This acknowledges local cancellation; remote
completion may remain unknown.

Stale, unavailable, competing-owner, terminal and pending controls include an
explanation. Authority expires after 2.4 seconds: inspect explicitly again.
An uncertain response leaves Stop unavailable and announces that the outcome is
not confirmed. Use **Inspect company Loops through local MCP** to reconcile the
saved state before any new explicit action; nothing automatically resends.
Draft text and existing work/session navigation remain available.

Deterministic interaction coverage lives in `frontend/src/OverviewLoops.test.tsx`
(run `cd frontend && npm test -- src/OverviewLoops.test.tsx` with dependencies
installed). It covers keyboard/focus feedback, exact request identity, duplicate
prevention, stale inspection responses, missing linked work, uncertain delivery,
authority/expiry/terminal guards and persisted provenance confirmation. Browser
and consolidated profile checks are performed by the supervisor after handoff.
Live provider calls remain skipped, not passed.

### Choose assigned work compactly from Hook devices (C86-T1)

Launch `agentown-web --database PATH --port 8765`, open
`http://127.0.0.1:8765`, and go to Company overview → Hook trigger devices.
Use existing saved employee-assigned work and employee `run_completed` or
`run_failed` Hooks. No credentials are needed for this navigation.

Each supported Hook has a labeled native **Assigned work for Hook** chooser
containing only its employee’s loaded assignments. Repeated names are distinguished
by exact Hook, employee and Task IDs. Choose work with the native keyboard controls,
then Tab to **Open** and press Enter or Space. Selection alone makes no request.
Open preserves work and configuration drafts, clears history filters and focuses
**Requested Hook inspection** with the exact Task, Hook and employee IDs. It grants
no execution consent and makes no MCP discovery, preview or execution request.

Valid choices survive saved-history polling and reordering. Removing a Task,
removing its employee assignment or changing the Hook’s target clears the choice;
restoring the old data requires explicit reselection. Team and task-created Hooks
remain configuration only. Empty assignments, disconnected history, refreshing
and stale Hook snapshots explain why opening is unavailable. Refresh Hook devices
after a failed refresh; valid choices remain selected and become available again.

Scoped deterministic checks: `cd frontend && npx tsc --noEmit` and
`npx vitest run src/HookDevices.test.tsx src/WorkHook.test.tsx`.
The supervisor frontend profile passed consolidated frontend and Python checks;
it intentionally deferred a fresh installed-browser gate. Live provider
validation is skipped under the user policy, not passed.


### Current-snapshot linked Loop navigation (C87-T1)

Run `agentown-web --database PATH`, then open <http://127.0.0.1:8765> and
Company overview → Saved Loop policy devices. Prerequisite: existing saved work
and a Loop policy linked to that work; no credentials or provider calls are needed.

1. Enter an unsaved work draft and a configuration draft. Tab to **Open linked
   work · local MCP**, press Enter or Space, and confirm focus moves to Requested
   Loop inspection with the exact Task and policy IDs. Both drafts remain intact.
2. Click **Refresh Loop devices**. Existing cards remain visible, but linked-work
   actions are disabled while loading. Each disabled action has an associated
   explanation. A failed or malformed refresh keeps navigation disabled until a
   successful refresh; the retained card is explicitly stale.
3. Save a policy retargeting through another product window, then refresh devices
   here. Only the latest snapshot's exact Task and policy IDs are used. If the new
   Task is absent from loaded saved work, refresh saved history first.
4. Disconnect the local server and refresh the connection: linked-work navigation
   is disabled with a reconnect explanation. Restore the server and refresh the
   connection and devices. Successful current data restores the action when its
   exact linked Task is available.
5. Opening linked work grants no consent and sends no MCP inspection, discovery,
   preview or mutation request. Those steps still require separate explicit actions.

Deterministic scoped checks, when frontend dependencies are available:
`cd frontend && npx tsc --noEmit && npx vitest run src/LoopDevices.test.tsx src/App.test.tsx`.
The LoopDevices tests cover deferred refresh, failed/malformed refresh, recovery,
retargeting, disconnection and missing work. The App interaction in that test file
checks keyboard focus, exact retargeted identities, draft preservation and a strict
read-only endpoint allowlist. Supervisor verification passed 1,021 frontend tests,
the production build and 505 Python tests, with 2 Python tests skipped. A fresh
installed-browser gate was deferred by the verification profile. Live provider
tests are skipped, never passed.

### Dismiss local Skill and Hook previews (C88-T1)

Launch `agentown-web` and open `http://127.0.0.1:8765`. Use representative saved
work, an enabled Skill, and an enabled employee `run_completed` or `run_failed`
Hook referencing that Skill. No credentials are needed to inspect or preview.

1. In Company overview, choose saved work in a Skill book's **Saved work for
   Skill** chooser, then **Open**. For a Hook device, use **Assigned work for
   Hook** and **Open** with work assigned to its employee.
2. Choose **Inspect through local MCP**, then **Find Skills through local MCP**
   or **Find Hooks through local MCP**. Review the selected exact record and
   explicitly choose **Preview local Skill** or **Preview local Hook**.
3. Check the execution consent checkbox. Press Escape while focus is inside
   the preview, or activate **Cancel local Skill preview** / **Cancel local Hook
   preview**. The preview closes, consent clears, a polite status announces
   dismissal, and focus returns to the corresponding Preview button. Cancellation
   sends no request and preserves selected work, configuration and unrelated drafts.
4. Activate Preview again. This requests a fresh preview; its consent checkbox
   starts unchecked and Execute remains disabled until fresh consent is given.
5. Once Execute has dispatched, the preview and Cancel action are gone. Escape
   does not cancel execution or clear its outcome. For uncertain delivery, use
   the explicit inspection recovery; consent stays consumed and nothing resends.

Deterministic coverage: from `frontend`, run
`npx vitest run src/WorkSkill.test.tsx src/WorkHook.test.tsx src/App.test.tsx`,
then `npm run build`. Tests include Company navigation, both dismissal actions,
focus, checked-consent reset, fresh previews, no dismissal requests, draft
preservation and pending/uncertain dispatch recovery. Supervisor full verification
passed 1,029 frontend tests, the production build, 508 Python tests with 2 skipped,
Rust and desktop checks, and 2 Chromium browser checks. Live LLM calls are skipped,
not passed.

### Dismiss local MCP Loop previews (C89-T1)

```sh
uv run --directory python --locked agentown-web --database /tmp/agentown-local-loop.sqlite3 --port 8765
```

Open http://127.0.0.1:8765. Prerequisites: saved employee-assigned text work
and an enabled matching Loop. No provider credentials are needed for inspection,
preview or dismissal. In Company overview, choose the saved Loop's **Open linked
work for Loop** action, then **Inspect through local MCP**, **Find matching Loops
through local MCP**, and **Preview local Loop**.

Check consent, then choose **Cancel local Loop preview**, or press Escape while
focus is inside the preview. The preview disappears, the status announces
“Local Loop preview dismissed. Consent cleared. No activation requested.” and
focus returns to **Preview local Loop**. Repeat with a fresh preview: consent
must be unchecked and activation disabled until checked again. Dismissal sends
no request, changes no saved work or drafts, and leaves retained-session Stop
access intact. Escape outside the preview does not dismiss it.

With deterministic network fixtures, disconnect or invalidate explicit inspection
while focus is in the preview. Focus reaches **Bounded Loop through local MCP**;
when focus is on an outside control, that control keeps focus. Requested Loop
navigation instead reaches **Requested Loop inspection**. Reconnect and inspect
again before requesting a fresh preview and fresh consent. Dispatched activation
has no preview to cancel: changing selection or pressing Escape neither aborts
nor replays activation, even if delivery becomes uncertain. Inspect persisted
sessions explicitly to recover; retained sessions keep their existing Stop rules.

Scoped checks: `cd frontend && npm test -- src/WorkLoop.test.tsx src/App.test.tsx`
and `npm run build`. Supervisor verification passed 1,041 frontend tests, the
production build, and 505 Python tests, with 2 Python tests skipped. The selected
frontend profile deferred installed-browser and process-recovery gates; those passed
in the preceding C88 full profile. Live provider calls are skipped, not passed.

### Dismiss saved-work execution previews (C90-T1)

In the existing work screen, select an enabled Skill, matching employee Hook
(requires a terminal attempt), or matching bounded Loop. Choose **Preview Skill
with saved work**, **Preview Hook with saved work**, or **Preview Loop with saved
work**. No provider credentials are required to preview or dismiss.

For each preview, choose its **Cancel** button, then repeat with a fresh preview
and press Escape while focus is on its execute/start control or Cancel button.
The preview disappears, focus returns to its enabled Preview button (or the
section if Preview is unavailable), and the status announces that consent was
cleared and no execution/start was requested. Execution/start is unavailable
until another explicit preview. Press Escape on a control outside the preview:
the preview and consent remain unchanged. Draft text and saved selections remain.

Dismissal sends no request, including execution, Loop start, or Loop stop.
Existing active Loop sessions retain Stop access under the existing connection
and authority rules, including when ordinary execution is disabled. Deterministic
interaction tests isolate the 800 ms background polling when asserting zero
requests. Existing invalidation and active-session tests cover section focus
fallback and emergency Stop access.

Supervisor verification passed 1,048 frontend tests, the production build, and
505 Python tests, with 2 Python tests skipped. The selected frontend profile
deferred installed-browser and process-recovery gates; those passed in the recent
C88 full profile. Live provider calls remain skipped, not passed.

### Inspect local MCP Loop attempt execution states (C91-T1)

Launch the existing product flow:

```sh
uv run --directory python --locked agentown-web --database /absolute/path/product.sqlite3 --port 8765
```

Open <http://127.0.0.1:8765>. Prerequisites are saved work assigned to an
employee and recorded Loop sessions/attempts in that product database. From
Company overview, open a recorded Loop's linked work, then choose **Inspect local
Loop sessions**. Inspection reads persisted records; it does not preview, start
or stop work and does not require a provider call.

Each session contains only its own attempts, with ordinal and run ID. Active
execution reads **Active · Waiting for provider response**. A persisted finished
attempt shows provider execution success or failure (other terminal outcomes
retain their recorded wording). Output and error text stay visible. A missing
execution record reads **Execution record unavailable · Provider completion
unknown**. Missing state also leaves completion unknown. **Quality unverified**
remains visible even for provider success. A stopped session does not establish
that its provider finished; inspect its individual attempts.

Choose **Inspect local Loop sessions** again, or **Inspect retained session …**,
to refresh persisted state. A running attempt can then become finished under the
same run ID. Stop remains available for active retained sessions only under the
existing authority rules. Inspection never acknowledges recovery automatically:
after uncertain activation, inspect and explicitly acknowledge the records before
requesting a fresh preview and consent. No activation or Stop is replayed.

Deterministic interaction fixtures require no credentials or prepopulated local
DB. With frontend dependencies available, run:

```sh
cd frontend
npx vitest run src/WorkLoop.test.tsx
```

The linked-session fixture supplies two sessions for one assigned Task: active
and successful attempts in one, failed and missing-record attempts in a stopped
session. It refreshes the active attempt to success with the same identity and
asserts session separation, retained output/error, quality wording and only
inspection requests. Existing fixtures cover explicit recovery and retained Stop.
Supervisor verification passed 1,053 frontend tests, including 32 WorkLoop tests,
the production build, and 505 Python tests, with 2 Python tests skipped. The
selected frontend profile deferred installed-browser and process-recovery gates;
those passed in the recent C88 full profile. Live provider calls remain skipped,
not passed.

### Company overview local MCP attempt details (C92-T1)

Launch `agentown-web --database /absolute/path/product.sqlite3 --port 8765`
(or `uv run --directory python --locked agentown-web --database
/absolute/path/product.sqlite3 --port 8765` from this checkout), then open
<http://127.0.0.1:8765> → Company overview. The packaged desktop app provides
the same Company overview surface. Prerequisite: the existing local MCP company
inspection API and recorded sessions/attempts in the selected product database.
Linked Tasks do not need to be present in the loaded workspace.

1. Choose **Inspect company Loops through local MCP** explicitly. For each
   recorded session, focus **Attempt details for local MCP Loop …** and press
   Enter or Space to expand or collapse. Focus stays on the disclosure button.
   Details can be inspected even when linked work is unavailable; opening work
   is optional.
2. Each expanded session shows only its matching attempts: ordinal, Run ID,
   persisted execution state, output/error and **Quality unverified**. C91
   execution wording applies: active means waiting for provider response,
   finished success/failure describes execution only, and missing records or
   missing state leave provider completion unknown. No recorded attempts also
   leaves provider completion unknown.
3. Choose **Inspect company Loops through local MCP** again to update persisted
   records, including a state change under the same Run ID. Existing session
   disclosures retain their expansion state. Reinspection does not move keyboard
   focus from a retained disclosure. After inspection expires (2.4 seconds), or
   inspection fails, expanded retained details visibly say **Stale attempt
   details** until successful explicit reinspection.
4. Expansion/collapse reads retained records only: it sends no request, grants
   no consent and never previews, activates or stops work. Stop remains a
   separate explicit control with its existing authority requirements.

Deterministic fixtures need no credentials or local database. With frontend
dependencies installed, run `cd frontend && npx tsc --noEmit && npx vitest run
src/OverviewLoops.test.tsx src/WorkLoop.test.tsx`. Added OverviewLoops tests
cover multiple sessions with absent linked work, keyboard expansion/collapse
and stable focus, session separation, output/error and missing execution records,
same-Run-ID refresh, failed/unavailable/expired inspection, retained stale
records and request-free expansion. The keyboard test freezes polling intervals
only, allowing keyboard interaction timeouts to settle; stale-state tests advance
the full fake clock explicitly. Integration validation passed TypeScript checking
and all 40 OverviewLoops tests using existing frontend dependencies. Supervisor
verification passed 1,057 frontend tests, the production build, and 505 Python
tests, with 2 Python tests skipped. The selected frontend profile deferred
installed-browser and process-recovery gates; those passed in the recent C88 full
profile. Live provider validation is skipped, not passed.

### Inspect ordinary Loop attempts in Company overview (C93-T1)

Launch `agentown-web --database /absolute/path/product.sqlite3 --port 8765`
and open <http://127.0.0.1:8765> → Company overview → **Bounded Loop activity**.
Prerequisite: recorded ordinary Loop sessions and attempts in that product
SQLite database and the existing GET `/api/loops/v1` inspection contract.
No credentials or new backend endpoint are needed for inspection.

Focus **Attempt details for Loop SESSION** and press Enter or Space. Each
session shows only its matching attempts: ordinal, Run ID, execution state,
recorded output/error and **Quality unverified**. Details remain available when
linked work is unavailable. An empty attempt list or missing execution record
explicitly leaves provider completion unknown. Disclosure sends no requests,
grants no consent and starts no work.

Keep a disclosure focused and expanded while polling or choosing **Inspect Loop
sessions again**. Updated records, including changes to the same Run ID, appear
without collapsing retained sessions or replacing their focused buttons. If
inspection fails, or a pending poll leaves the last successful inspection older
than 2.4 seconds, retained details visibly become stale. A successful refresh
restores current details. Existing Stop controls still require fresh inspection,
granted local authority and an active session; disclosure grants no Stop authority.

Deterministic interaction coverage: `cd frontend && npx vitest run src/OverviewLoops.test.tsx`.
It covers session separation, unavailable linked work, Enter/Space, request-free
disclosure, same-Run-ID refresh, retained focus, empty/missing execution records
and expired/failed/malformed inspection. The periodic full profile passed 1,061
frontend tests, including 44 OverviewLoops tests, the production build, 508
Python tests, Rust and desktop checks, and two Chromium browser checks; 2 Python
tests were skipped. Live provider calls are skipped, not passed, under the user
live-test policy.


### Inspect recorded Skill use in Company overview (C94-T1)

Launch `agentown-web --database /absolute/path/product.sqlite3 --port 8765`
and open <http://127.0.0.1:8765> → Company overview → **Skill library**.
Prerequisite: existing Skills and saved Workspace attempt provenance in the product
database. No credentials or backend expansion are required for inspection.

Focus **Recorded use for Skill: NAME · Skill ID: ID** and press Enter or Space.
The local disclosure shows matching attempts across loaded saved Tasks using only
persisted direct Skill or Hook Skill IDs. Names never establish a match. Each
matching attempt appears once, including when both provenance forms match.
Inspect Task/Run identity, saved Skill name, instructions, effective input and
preview identity, execution state, recorded output/error and **Quality unverified**.
Current configuration edits do not rewrite this saved context. Existing book
navigation and saved-work selection remain available independently.

Keep the disclosure expanded and focused while saved history refreshes. Updates
to the same Run appear in place, preserving the button and its focus. **Refresh
Skill books** refreshes configuration only; use the existing connection/history
refresh to load newer attempts. Opening or closing recorded use sends no request,
grants no execution consent and starts no work. No matches means no matching
records in the loaded history, not proof that this Skill has never been used.
Unavailable Workspace data is distinct from an empty loaded history. When the
connection fails, retained records are labeled a stale disconnected snapshot;
they do not establish current execution state.

Deterministic interaction coverage is in `frontend/src/SkillBooks.test.tsx`:
`cd frontend && npx vitest run src/SkillBooks.test.tsx` (with dependencies installed).
Coverage includes direct/Hook ID matching, unrelated exclusion, duplicate match
suppression, configuration refresh preserving saved context, Enter/Space,
request-free disclosure, same-Run refresh, retained focus, unavailable Workspace,
empty history and disconnected retained records. Supervisor verification passed
1,062 frontend tests, including 7 SkillBooks tests, TypeScript checks, the
production build and 505 Python tests; 2 Python tests were skipped. The selected
frontend profile deferred installed-browser and process-recovery gates. Live
provider tests remain skipped, not passed.

### Inspect recorded Hook follow-ups in Company overview (C94-T2)

Launch `agentown-web --database /absolute/path/product.sqlite3 --port 8765`
and open <http://127.0.0.1:8765> → Company overview → **Hook trigger devices**.
Prerequisite: saved Hooks and Workspace Hook attempt provenance in the product
database. Inspection requires no credentials or new API/persistence contract.

Focus **Recorded attempts for Hook: NAME · Hook ID: ID** and press Enter or
Space. Matching uses the persisted Hook ID across all loaded saved work, even
when the Hook is now disabled, its employee/Skill/event/target has changed, or
work is no longer assigned to that employee. Duplicate names do not establish
identity. Inspect Task and follow-up Run IDs, saved Hook and source Run/event/
outcome/employee, saved Skill name/ID/instructions/effective input and preview
identity, execution state, output/error and **Quality unverified**. Saved
context remains distinct from current configuration and execution success does
not imply quality verification.

Opening or closing the disclosure sends no requests, grants no execution consent
and starts no work. Existing configuration navigation and assigned-work actions
remain independent. Keep the disclosure focused and expanded while refreshing
saved history: same-Run changes appear in place without replacing the focused
button. **Refresh Hook devices** refreshes configuration only; use the existing
connection/history refresh to load newer attempts. Disclosure state follows Hook
identity through configuration changes and reordering.

No matching loaded records does not prove the Hook has never run. An unavailable
Workspace has its own message. Disconnected retained records are labeled a stale
saved-work snapshot and do not confirm current execution state. Refresh the
connection to obtain newer history; configuration refresh alone does not make
saved work current.

Deterministic coverage: `cd frontend && npx vitest run src/HookDevices.test.tsx`
with installed dependencies. The new interaction test covers saved identity
separation (including the same Run ID in different Tasks), unrelated direct Skill
exclusion, changed/disabled configuration, Enter/Space, request-free expansion,
same-Run updates, focus retention, empty/unavailable history and disconnected
snapshots. Supervisor frontend verification passed all 32 test files and 1,063 tests, the
production build, 505 Python tests with 2 skipped, and the harness Rust and
operational test suites. The selected frontend profile deferred installed-browser
and installation/process-recovery gates. Live provider tests remain skipped, not
passed, under the user policy.

### Inspect saved Loop input and conditions in Company overview (C95-T1)

Launch `agentown-web --database /absolute/path/product.sqlite3 --port 8765`
and open <http://127.0.0.1:8765> → Company overview → **Bounded Loop activity**.
Prerequisite: existing persisted Loop inspection records in this product database;
no credentials or new execution are required.

1. Focus **Attempt details for Loop SESSION** and press Enter or Space. The
   disclosure shows **Saved session settings**: Task, employee, policy, preview
   and session IDs, saved policy name, complete saved input, maximum iterations,
   interval in seconds, expected prior runs, and session provider/model alongside
   recorded attempt results.
2. Choose **Inspect company Loops through local MCP**, then focus **Attempt details
   for local MCP Loop SESSION** and press Enter or Space for the same saved context
   from the retained local MCP owner. Opening/closing either disclosure sends no
   request and grants no execution consent.
3. Compare sessions even when their policy names match. Values come from each
   session's persisted preview/session records, so editing current work or provider
   configuration does not change historical context. Missing linked work does not
   prevent inspection. **Recorded attempt settings** separately show any recorded
   provider, model and input; missing values say not recorded rather than borrowing
   session settings.
4. Keep a disclosure focused and expanded while refreshing inspection. It stays
   expanded for that session and retains focus. If inspection fails or expires,
   retained details are marked stale and Stop remains subject to fresh authority.
   Existing explicit consent and Stop ownership checks still apply.

Focused deterministic check: `cd frontend && npx vitest run src/OverviewLoops.test.tsx`.
Coverage includes duplicate policy names, distinct persisted inputs/settings,
changed current work/configuration, unavailable linked work, keyboard disclosure,
request-free expansion, refresh reordering/focus retention, and stale/unavailable
inspection. This invocation attempted `npm test -- src/OverviewLoops.test.tsx`; it stopped
before running tests with `tsc: command not found` because this isolated workspace
has no frontend dependencies installed. Supervisor verification passed all 32
frontend test files and 1,065 tests, including 46 OverviewLoops tests, the
production build, 505 Python tests with 2 skipped, and the harness Rust and
operational suites. The selected frontend profile deferred installed-browser and
installation/process-recovery gates. Live provider calls remain skipped, not passed.

### Inspect a recorded Hook follow-up’s source attempt (C96-T1)

Launch `agentown-web --database PATH --port 8765`, open
<http://127.0.0.1:8765> → Company overview → **Hook trigger devices** →
**Recorded attempts for Hook**. Prerequisite: saved Hook follow-up provenance and
its source-attempt history; deterministic fixtures suffice. No provider call is needed.

Within a follow-up, Tab to **Source attempt details · Run ID: ID** and use Enter
or Space to expand/collapse it. Inspect the persisted source state, outcome,
output and error. Matching uses the saved source Run ID within that follow-up’s
Task only, even when newer attempts exist or another Task contains the same Run
ID. Duplicate Hook names remain distinguished by Hook ID. Current configuration
and the latest attempt never replace a missing source. Missing source records,
unavailable Workspace and disconnected stale snapshots have separate messages.
Missing output/error is explicit; empty recorded strings remain recorded values.

Opening and closing details makes no requests, grants no consent and starts no
work. Refresh saved history through the existing connection/history refresh to
see updated source records in place; an expanded same-Run disclosure retains
focus. Refresh Hook devices alone refreshes configuration, not attempt history.
Disconnected retained history remains inspectable with its stale warning.

Focused deterministic check, with frontend dependencies installed:
`cd frontend && npx vitest run src/HookDevices.test.tsx` and `npx tsc --noEmit`.
The C96 fixture covers multiple source/follow-up attempts, cross-Task collisions,
missing sources, duplicate Hook names, Enter/Space, zero disclosure requests,
refreshed source values/removal, focus retention and unavailable/stale history.
This implementation checkout has no frontend dependencies, so these checks were
not executed locally. Supervisor verification passed all 32 frontend test files
and 1,066 tests, including all 8 HookDevices tests, the production build, 505
Python tests with 2 skipped, and the harness Rust and operational suites. The
selected frontend profile deferred installed-browser and installation/process-
recovery gates. Live provider validation is skipped, not passed.

### Disconnected Skill and Hook configuration snapshots (C97-T1)

Launch `agentown-web --database PATH --port 8765` and open
<http://127.0.0.1:8765> → Company overview with saved Skills and Hooks (or
use the deterministic fixtures below). No credentials or provider calls are needed.

With the page loaded, stop the local server and wait for connection polling to
report disconnection. Both configuration section statuses and retained cards
identify disconnected, potentially stale configuration. Empty retained snapshots
report that current configuration is unknown; unavailable snapshots do not claim
that no records exist. Tab to a retained card and press Enter or Space: read-only
Configuration navigation remains available. Saved-work inspection navigation stays
blocked while disconnected, loading or after a configuration-refresh failure. After
connection recovery its existing guards resume; the potentially stale disclosure
is not an execution authorization. Recorded-history disclosures retain their
separate stale-history warning.

Restart the same server/database and refresh connection. Reconnection alone does
not fetch Skills or Hooks, clear their refresh errors, or validate retained
configuration. Use **Refresh Skill books** and **Refresh Hook devices** separately.
Each section distinguishes loading, failed refresh, successful empty results and
successful saved records. A request spanning disconnection remains potentially
stale even if it finishes after connection recovery. A later successful connected
refresh clears that section's warning. Existing cards keep identity and focus.
To exercise independent failures deterministically, use the interaction tests;
they fail each configuration endpoint in turn while the other refresh succeeds.

With frontend dependencies available, run:

```sh
cd frontend
npx vitest run src/SkillBooks.test.tsx src/HookDevices.test.tsx src/CompanyOverview.test.tsx
npx tsc --noEmit
```

Integration reused available frontend dependencies: TypeScript checking passed,
the three focused files passed 26 tests, and the targeted App preview-dismissal
cases passed 3 tests (86 unrelated cases skipped). These checks preserve the
existing inspection-navigation guards while retaining configuration warnings.
Supervisor full-profile verification passed the Rust workspace and desktop
lifecycle/build gates, all 32 frontend test files and 1,072 tests, the production
build, 508 Python tests with 2 skipped, the harness suites, and both browser/
process-recovery checks with recorded evidence. Live provider validation is
skipped, not passed.

### Retained Loop configuration freshness (C98-T1)

Launch `agentown-web --database PATH --port 8765` and open
<http://127.0.0.1:8765> → Company overview → **Saved Loop policy devices**.
Prerequisite: existing configuration endpoints and a product database; use saved
Loop policies to exercise populated cards, or an empty database for empty results.
No credentials or provider calls are needed.

Stop the server and wait for connection polling to report disconnection. Retained
cards show **Disconnected — potentially stale configuration snapshot**. An empty
snapshot says current Loops are unknown rather than asserting none exist.
Restart the same server/database and refresh connection: the section reports
connection restored with potentially stale configuration, and retained cards keep
their textual warning. Reconnection alone does not refresh the device snapshot;
other panels may independently read Loop configuration.
Configuration navigation remains available, with the same policy IDs and drafts;
linked-work navigation keeps its existing connection, loading, failure and
missing-work guards. The freshness warning adds no navigation restriction or
execution consent.

Choose **Refresh Loop devices** explicitly. Loading remains visible alongside the
freshness disclosure. A failed refresh retains the previous cards or empty
snapshot with failure feedback. Only a successful connected refresh started after
the disconnection clears the warning and shows saved policies or **No saved Loops
yet**. With deterministic deferred responses, disconnect and reconnect while a
refresh is in flight: its eventual success must retain the warning. A request
started while disconnected must also retain it after recovery. Refresh again
while connected to validate the configuration.

Focused deterministic checks (with frontend dependencies available):

```sh
cd frontend
npx tsc --noEmit
npx vitest run src/LoopDevices.test.tsx src/CompanyOverview.test.tsx
```

The component cases cover populated/empty retention, failed refresh, recovery,
requests spanning disconnection and requests started disconnected. The App cases
exercise actual polling recovery and independently retained device freshness,
Configuration navigation/focus, retained work drafts and absent execution consent.
Integration used existing frontend dependencies for scoped checks. Supervisor
verification passed all 32 frontend test files and 1,078 tests, the production
build, 505 Python tests with 2 skipped, and the harness Rust and operational
suites. The selected frontend profile deferred installed-browser and installation/
process-recovery gates. Live provider validation is skipped, not passed.

### Connections evidence after workspace recovery (C99-T1)

Run `agentown-web --database PATH --port 8765`, open
<http://127.0.0.1:8765> → Company → a client workstation → Connections.
Use an existing product database; credentials are unnecessary. Select a client
and platform, load setup, then explicitly choose **Check local server** and
**Check shared data**. These local checks do not execute work or call providers.

Stop the server and wait for workspace disconnection. Retained setup instructions
and installation hints, diagnostic outcomes, and shared-data outcomes/counts
show separate **Previous … observation** warnings. Restart the same server and
database. Reconnection alone must retain all warnings, selected client/platform,
readable and copyable configuration, and keyboard focus. External configuration
remains unknown and connection/exercise remain unverified.

Explicitly **Refresh setup**: success clears only the setup warning. Each check
requires its own successful explicit rerun to clear its warning. A failed recovery
keeps the warning. With deferred test responses, disconnect/reconnect during each
request: eventual success must still show previous evidence. Requests started
while disconnected also cannot establish current evidence. Recovery never
starts checks or execution automatically.

Focused checks with frontend dependencies available:

```sh
cd frontend
npx tsc --noEmit
npx vitest run src/Connections.test.tsx src/Workstations.test.tsx
```

Supervisor verification passed all 32 frontend test files and 1,082 tests, the
production build, 505 Python tests with 2 skipped, and the harness Rust and
operational suites. The selected frontend profile deferred installed-browser and
installation/process-recovery gates. Live provider validation is skipped, not
passed.

### Configuration connection recovery

Run `agentown-web --database PATH --port 8765` with your local database path and
open `http://127.0.0.1:8765`. Open **Configuration**. Select saved Skill, Hook and
Loop records in turn and enter a draft edit. Configuration never executes work.

1. Stop the local server and use **Refresh connection**. Saved values, selected
   records and drafts remain readable; saving and enabling/disabling are blocked.
   You can still navigate records and edit drafts.
2. Restart the same command and use **Refresh connection**. The configuration
   stale warning and mutation guards remain, even for an empty saved list.
3. Explicitly choose **Refresh configuration** while connected. Only a successful
   refresh that does not span a connection transition restores configuration
   freshness. A failed refresh or a late response from before disconnection
   cannot unlock saving. Retry the refresh after restoring the connection.
4. Review saved IDs, fields and enabled states against retained drafts. If a save
   was interrupted, delivery may be uncertain: after refreshing, also choose
   **I inspected saved configuration** before explicitly retrying. Changes are
   never automatically resent. Navigation and drafts remain available throughout.

These recovery steps require no provider credentials. Supervisor verification
passed all 32 frontend test files and 1,089 tests, the production build, 505
Python tests with 2 skipped, and the harness Rust and operational suites. The
selected frontend profile deferred installed-browser and installation/process-
recovery gates. Live provider validation is skipped, not passed.

### Retained local Loop session freshness after reconnect (C101-T1)

Run `agentown-web --database PATH --port 8765` with existing saved work and
local Loop records, then open <http://127.0.0.1:8765>. Select saved work →
**Inspect through local MCP** → **Inspect local Loop sessions**. No provider
credentials or external client are required to inspect existing records.

Session and attempt observations are current only as of a successful explicit
inspection in this connection. Open another saved Task and inspect it; each
retained session keeps its own Task's freshness. Saved inputs, provider/model
provenance, receipts and attempt results remain visible when observations go stale.

Disconnect and reconnect the local service using the same database. Both Tasks'
observations remain stale after reconnect; selection is preserved and no inspection,
activation or resend happens automatically. Choose **Inspect retained session …**
to refresh that Task only. A failed inspection revokes that Task's freshness while
retaining its evidence. A response spanning disconnect/reconnect is discarded.
Current observations are a snapshot, not a promise that execution has stopped.

After activation or uncertain delivery, **I inspected local Loop records** requires
a successful explicit inspection in the current connection. Reconnect, rejected or
failed reads, late responses and Stop's internal confirmation read cannot authorize
this acknowledgement. Inspect explicitly again before acknowledging recovery and
requesting a fresh preview. Retained emergency **Stop local Loop …** remains
available when connected under existing ownership and uncertain-Stop guards;
stale evidence alone does not remove Stop access. No recovery action resends work.

Deterministic interaction checks (with frontend dependencies available):
`cd frontend && npm test -- src/WorkLoop.test.tsx`.
Coverage includes two retained Tasks, independent refresh, failed and deferred
reads, connection transitions, retained results/provenance, Stop ownership guards
and recovery acknowledgement. Supervisor verification passed all 32 frontend
test files and 1,092 tests, the production build, 505 Python tests with 2
skipped, and the harness Rust and operational suites. The selected frontend
profile deferred installed-browser and installation/process-recovery gates.
Live provider calls are skipped, not passed.

### Saved-work bounded Loop recovery on the current connection (C102-T1)

Launch `agentown-web --database PATH --port 8765` with an existing product
database, open <http://127.0.0.1:8765>, select saved work, and expand **Run a
bounded Loop**. Existing session and attempt evidence remains readable offline.
Disconnect and reconnect the service using the same database: the retained records
stay visibly stale until a successful read on the current connection. Polling can
refresh observations and restore emergency **Stop Loop …** with current authority;
it cannot acknowledge an uncertain start or replay a request.

For an uncertain start, choose **Refresh Loop session records**, inspect the
sessions and attempts, then choose **I inspected refreshed Loop records**. A
refresh completed before disconnection cannot authorize acknowledgment after
reconnect. A read started before a connection transition is discarded even if its
response arrives afterward. Refresh explicitly again on the current connection.
Acknowledgment clears recovery only; starting requires a new preview and consent.
Stop remains available during uncertain-start recovery after a current authority
read, including when ordinary execution is disabled. Ownership checks still apply.
The initial connection reads Loop availability without waiting for polling. Loop
freshness gates Loop actions; ordinary execution retains its separate connection
and execution-history acknowledgment flow.

Deterministic deferred-response interactions:
`cd frontend && npm test -- src/LoopExecution.test.tsx`.
These cover prior refreshes, held explicit/poll/confirmation responses across
reconnect, retained records, polling-only recovery, fresh keyboard acknowledgment,
and emergency Stop without replay. Use fixtures for uncertain delivery; live
provider calls remain skipped. Supervisor full-profile verification passed all
32 frontend test files and 1,097 tests, the production build, 508 Python tests
with 2 skipped, the Rust product and desktop checks, and 2 installed-browser and
process-recovery checks.

Integration validation: TypeScript checking and all 109 tests in
`LoopExecution.test.tsx` and `execution-receipt.test.tsx` passed in a temporary
source copy using existing frontend dependencies. No live provider was called.


### Saved-work Skill and employee Hook recovery

Launch `agentown-web --database PATH --port 8765` with an existing fixture database,
then open `http://127.0.0.1:8765`. Use saved work with one assigned employee, an
enabled Skill, and an enabled employee Hook referencing that Skill. A Hook also
needs a latest finished attempt whose outcome matches its configured event.

1. Select saved work and an enabled Skill or eligible employee Hook. Tab to
   **Preview Skill with saved work** or **Preview Hook with saved work** and press
   Enter. Check the effective input; consent receives keyboard focus. Do not
   execute when exercising recovery without a provider.
2. Disconnect the product connection (for example, stop its server and use
   **Refresh connection**). The preview disappears, consent is cleared, focus
   recovers to the panel, and disconnected/stale status blocks preview.
3. Restore the same server/database and refresh the connection. With browser
   network tools holding configuration reads, the selection remains but preview
   stays blocked with loading/stale status. A Hook requires successful current
   reads of both Skills and Hooks. Fail a read to see the refresh error; polling
   can recover after reads succeed. Responses from before disconnect cannot
   restore configuration freshness or preview consent.
4. Disable the selected Skill (or Hook), or change its Hook event/employee in the
   configuration panel before allowing refresh. Preview remains blocked for
   ineligible configuration. Re-enable matching records and allow fresh reads.
5. Focus the preview button and press Enter again. Review the fresh input and
   use Escape to clear consent and return focus to the preview button. Reconnect
   never previews, submits, retries, or activates a Loop automatically. Ordinary
   execution retains its existing explicit history/retry guards.

Deterministic interaction coverage: from `frontend`, run
`npm test -- src/SkillExecution.test.tsx src/HookExecution.test.tsx`.
The tests hold only polling intervals and configuration/preview responses,
cover initial disconnection, held/failed reconnect reads, late responses,
disabled configuration, retained selections and fresh keyboard consent.
Supervisor verification passed all 32 frontend test files and 1,111 tests, the
production build, 505 Python tests with 2 skipped, and the harness Rust and
operational suites. The selected frontend profile deferred installed-browser and
installation/process-recovery gates. Live provider calls are skipped, not passed.

### Local MCP Skill and Hook inspection focus recovery (C104-T1)

Launch `agentown-web --database PATH --port 8765` and open
`http://127.0.0.1:8765` with the fixture records described above. These steps
exercise the **Local MCP work inspection** area rather than the saved-work
configuration preview panels.

1. Select saved work, choose **Inspect through local MCP**, then **Find Skills
   through local MCP** or **Find Hooks through local MCP**. Select an enabled
   Skill or eligible employee Hook and choose **Preview local Skill/Hook**.
   Check its consent box and leave keyboard focus there. Do not execute.
2. Disconnect using **Refresh connection** while the local server is stopped,
   or select different saved work. If focus was still inside the removed
   inspection content, it moves to the visible **Local MCP work inspection**
   region. Restore the server and refresh the connection: inspection, preview
   and consent must remain cleared until explicitly requested again.
3. Repeat with focus on a control outside the removed inspection content.
   That focus stays in place. Explicit Skill/Hook navigation instead retains
   its **Requested Skill inspection** or **Requested Hook inspection** destination.
4. With consent focused, trigger explicit reinspection (browser console:
   `document.querySelector('#selected-work-inspection > button').click()`).
   Focus recovers to the inspection region while the old preview disappears.
   A normal keyboard activation of the inspection button keeps focus there.
5. Hold a preview response in browser network tooling, disconnect/reconnect,
   then release the old response. It must not restore a preview, consent or
   move focus. Inspect, discover and preview explicitly again: consent is
   unchecked. Network requests to `/skills/execute` and `/hooks/execute` stay
   at zero throughout these recovery steps.

Deterministic checks (with frontend dependencies installed):
`cd frontend && npm test -- src/WorkInspection.test.tsx src/WorkSkill.test.tsx src/WorkHook.test.tsx`.
Both panel suites assert focused elements, fresh unchecked consent, unchanged
execution request counts, navigation priority and deferred-response rejection.
Integration validation passed all 148 tests across these three files and
TypeScript checking. Checks ran against a temporary copy using existing frontend
dependencies and Vitest’s runner config loader. Both preview helpers target
the named preview consent so the ordinary execution consent cannot make the
query ambiguous. Supervisor verification passed all 32 frontend test files and
1,121 tests, the production build, 505 Python tests with 2 skipped, and the
harness Rust and operational suites. The selected frontend profile deferred
installed-browser and installation/process-recovery gates. Live provider calls
remain skipped, not passed.

### Company Loop removal focus recovery (C106-T1)

Launch `agentown-web --database PATH --port 8765` (replace PATH with a local
product database), open <http://127.0.0.1:8765> → Company overview → **Bounded
Loop activity**. No credentials or provider calls are needed. For deterministic
browser inspection, paste this into the browser console. It replaces only the two
inspection responses in this tab; reload the page to restore normal requests.

```js
const originalLoopFetch = window.fetch.bind(window);
const loopId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const loopSession = n => ({schema_version: 1, session_id: loopId(n),
  state: 'active', admitted: 0, next_at: 0, started_at: 1, expires_at: 100,
  provider: 'test', model: 'test', preview: {schema_version: 1,
    preview_id: loopId(n + 40), policy_id: loopId(n + 30),
    policy_name: 'Keyboard fixture', task_id: loopId(n + 10), agent_id: loopId(20),
    input: 'Deterministic saved input', max_iterations: 2, interval_seconds: 60,
    expected_runs: 0, policy_enabled: true, created_at: 1}});
window.loopFixture = [loopSession(1), loopSession(2)];
window.fetch = (path, init) => {
  const data = {schema_version: 1, sessions: window.loopFixture, attempts: [],
    cancellation: '', control: {state: 'competing_owner', can_control: false,
      message: 'Read-only keyboard fixture'}};
  if (path === '/api/loops/v1') return Promise.resolve(Response.json(data));
  if (path === '/api/connections/v1/loops/inspect-company')
    return Promise.resolve(Response.json({schema_version: 1, scope: 'company',
      status: 'confirmed', code: 'company_loops_inspected', recovery: 'Inspect explicitly', data}));
  return originalLoopFetch(path, init);
};
```

1. Wait for a web poll; explicitly choose **Inspect company Loops through local
   MCP** for that owner's records. Expand a session's attempt details, then leave
   focus on its disclosure or another control in its row.
2. In the console set `window.loopFixture = [loopSession(2)]`. Web polling removes
   the first row; local MCP removes it only on explicit inspection. To request
   inspection without moving existing focus, use
   `Array.from(document.querySelectorAll('button')).find(b => b.textContent ===
   'Inspect company Loops through local MCP').click()` in the console.
3. Focus must return to that owner's labeled inspection button, with its visible
   focus outline. A polite status announces the removal. Repeat with
   `window.loopFixture = []`: the same destination remains available and the
   announcement says no recorded sessions remain.
4. Restore both fixture sessions and repeat while focus is on the surviving
   session or outside the rows. That focus must remain in place. Inspection and
   removal never request stop, preview or execution; inspect the Network panel.

Run deterministic interaction checks in a prepared checkout:
`cd frontend && npm test -- src/OverviewLoops.test.tsx`. Coverage includes both
owners, row/details removal, empty results, surviving/external focus, and late
old-connection responses that must neither remove records nor move focus or
announce removal. Browser/visual validation belongs to supervisor verification;
the selected frontend profile deferred installed-browser and installation/
process-recovery gates. Supervisor verification passed all 32 frontend test
files and 1,131 tests, the production build, 505 Python tests with 2 skipped,
and the harness Rust and operational suites. Live LLM tests remain skipped
under the user policy.

### Team-room membership after connection recovery

1. Start `agentown-web --database PATH --port 8765` with your local product
   database path, then open `http://127.0.0.1:8765` → Company overview → Team rooms.
   Use a database with a saved team to inspect populated rooms; repeat with a
   database without teams to check the empty snapshot.
2. Wait for the membership snapshot, then stop the local server and wait for the
   company connection to show disconnected. Retained membership must say
   **Team rooms are stale**, including a retained empty snapshot. Saved room,
   employee and assignment navigation remains read-only; drafts remain intact.
3. Restart the same command and wait for company data to reconnect. Membership
   must still say **Team rooms are stale**. Workspace assignment freshness is
   separate: recovered company data does not confirm current team membership.
4. Select **Refresh team rooms**. Stale disclosure stays visible while the
   request is pending and after a failed refresh. Only a successful refresh on
   the current connection restores **Showing persisted team rooms** or
   **No team rooms yet**. Responses from before disconnection cannot replace
   retained membership, clear its stale disclosure, or finish a newer refresh.

Deterministic interaction coverage: from `frontend`, run
`npm test -- --run src/TeamRooms.test.tsx` when frontend dependencies are installed.
These checks require no provider credentials or live LLM calls. Supervisor
periodic full-profile verification passed all 32 frontend test files and 1,135
tests, the production build, 508 Python tests with 2 skipped, the Rust product
and desktop checks, and 2 installed-browser and process-recovery checks.

### Keyboard orientation after team-room removal

Start `agentown-web --database PATH --port 8765`, then open
`http://127.0.0.1:8765` → Company overview → Team rooms. For a reproducible
read-only fixture, run this in the browser console (reload restores normal
requests):

```js
window.originalTeamFetch = window.fetch.bind(window);
window.teamRoomFixture = [
  {id: 'keyboard-one', name: 'First room', members: []},
  {id: 'keyboard-two', name: 'Second room', members: []},
];
window.fetch = (path, init) => path === '/api/teams'
  ? Promise.resolve(Response.json({teams: window.teamRoomFixture}))
  : window.originalTeamFetch(path, init);
window.refreshTeamRooms = () => Array.from(document.querySelectorAll('button'))
  .find(button => button.textContent === 'Refresh team rooms').click();
window.refreshTeamRooms();
```

1. Tab to **Manage team: First room**. In the console set
   `window.teamRoomFixture = window.teamRoomFixture.slice(1)` and call
   `window.refreshTeamRooms()`. Focus returns to the enabled **Refresh team
   rooms** button. The polite **Team room removals** status reports one room
   removed. Repeat with `window.teamRoomFixture = []`: the status says no team
   rooms remain, and the same focus destination stays available.
2. To test member removal, restore a fixture room with `members` containing an
   actual employee ID from your database. Refresh, focus its **Select team
   member** button, then set that room's `members` to `[]` and refresh through
   the console. Focus returns to **Refresh team rooms** and the status reports
   the removed member. A focused assignment card that loses its last matching
   room member uses the same destination.
3. Restore both rooms. Repeat removal while focused on the surviving room or
   outside Team rooms. Focus stays there; the removal is still announced.
   Unchanged refreshes clear the removal message. Room/member identity, rather
   than display name, determines removal. Existing read-only navigation and
   work, team and configuration drafts remain intact.
4. Failed or aborted requests retain the snapshot and focus without a removal
   message. Deterministic tests also settle an old request after disconnect and
   reconnect while a newer refresh is pending: it must neither announce a
   removal nor move focus, change membership, or finish the newer refresh.

Scoped check in a prepared checkout:
`cd frontend && npm test -- src/TeamRooms.test.tsx`. This Task adds deterministic
coverage for room/member/assignment removal, empty results, surviving/external
focus and rejected responses. Supervisor verification passed all 32 frontend
test files and 1,144 tests, the production build, 505 Python tests with 2
skipped, and the harness Rust and operational suites. The selected frontend
profile deferred installed-browser and installation/process-recovery gates.
Live LLM calls remain skipped; these interactions require no provider credentials.

### Keyboard orientation after configuration-card removal (C109-T1)

Launch the local screen using the commands above (`agentown-web --database PATH
--port 8765`); no model or credentials are needed for this read-only flow. Open
`http://127.0.0.1:8765` → Company overview. In the browser console install these
configuration-only fixtures (reload restores normal requests):

```js
window.cardFetch = window.fetch.bind(window);
window.cardFixtures = {
  skills: [1, 2].map(n => ({id: `keyboard-s${n}`, name: `Book ${n}`,
    instructions: 'Read-only fixture', enabled: true})),
  hooks: [1, 2].map(n => ({id: `keyboard-h${n}`, name: `Hook ${n}`,
    event: 'run_completed', target_kind: 'agent', target_id: 'keyboard-agent',
    skill_id: 'keyboard-s1', enabled: true})),
  loops: [1, 2].map(n => ({id: `keyboard-l${n}`, name: `Policy ${n}`,
    task_id: 'keyboard-task', max_iterations: 2, interval_seconds: 60,
    enabled: true})),
};
window.fetch = (path, init) => {
  const kind = Object.keys(window.cardFixtures)
    .find(key => path === `/api/config/v1/${key}`);
  return kind ? Promise.resolve(Response.json({[kind]: window.cardFixtures[kind]}))
    : window.cardFetch(path, init);
};
window.refreshCards = label => Array.from(document.querySelectorAll('button'))
  .find(button => button.textContent === `Refresh ${label}`).click();
window.refreshCards('Skill books');
window.refreshCards('Hook devices');
window.refreshCards('Loop devices');
```

1. Tab to **Open Skill book: Book 1**. Set
   `window.cardFixtures.skills = window.cardFixtures.skills.slice(1)` and call
   `window.refreshCards('Skill books')` in the console. Return to the document:
   focus is on the enabled **Refresh Skill books** button. A polite removal status
   reports one removed record. Tab continues into the remaining book.
2. Repeat for **Open Hook device: Hook 1** with `hooks` / `Hook devices`, and
   **Open Loop device: Policy 1** with `loops` / `Loop devices`. Set each fixture
   array to `[]` and refresh with the last card focused: focus returns to its
   section Refresh button and the status says no cards remain.
3. Reload and reinstall fixtures. Rename and reverse an array without changing
   IDs, refresh while a surviving card has focus, and check that focus stays on
   that control. Remove the other card with focus on a surviving card or an
   outside draft input: focus stays put. Existing drafts, work selections and
   expanded recorded-history disclosures on surviving records remain intact.
4. Use DevTools offline mode (or reject the matching fetch) for a failed refresh:
   retain the previous cards and focus without a removal announcement. Restore
   networking and refresh explicitly. A response begun before disconnect/reconnect
   must not replace the current snapshot or recover focus; the deterministic
   suites exercise late responses settling after a newer accepted snapshot.

Runnable interaction coverage: `cd frontend && npx vitest run src/SkillBooks.test.tsx
src/HookDevices.test.tsx src/LoopDevices.test.tsx`. This includes empty snapshots,
rename/reorder, surviving/outside focus, failures and aborted old-connection
responses. Supervisor verification supplies browser checks under the current
profile. The supervisor frontend profile passed 32 frontend test files and
1,153 tests, the production build, and 505 Python tests with 2 skipped.
Installed-browser and installation/process-recovery gates were deferred by this
profile. Live LLM calls remain skipped, not passed.

### Keyboard orientation after employee removal (C110-T1)

Launch `agentown-web --database PATH --port 8765` with a local database and open
`http://127.0.0.1:8765` → Company overview. No provider configuration is required.
These console fixtures replace only workspace reads; reload restores normal data.
They do not delete saved employees or run work:

```js
window.employeeFetch = window.fetch.bind(window);
window.employeeSnapshot = await (await window.employeeFetch('/api/state')).json();
window.employeeSnapshot.employees = [
  {id: 'keyboard-a', name: 'Alex'}, {id: 'keyboard-b', name: 'Alex'}
];
window.fetch = (path, init) => path === '/api/state'
  ? Promise.resolve(Response.json(window.employeeSnapshot))
  : window.employeeFetch(path, init);
// Wait for the next workspace poll, then return to the document.
window.removeEmployeeLater = id => setTimeout(() => {
  window.employeeSnapshot.employees = window.employeeSnapshot.employees
    .filter(employee => employee.id !== id);
}, 5000);
```

1. Run `window.removeEmployeeLater('keyboard-a')`, return to the document and
   Tab to **Select office character: Alex · ID: keyboard-a** before five seconds
   elapse. On the next accepted poll, focus returns to **Company overview**.
   A polite message identifies the removed employee by name and ID. Tab continues
   through the overview controls. The other Alex remains available.
2. Repeat after reload/installing the fixture with **View assigned work: Alex ·
   ID: keyboard-a**. Remove `keyboard-b` while its character or workload button
   is focused: the same heading remains available and the announcement says no
   employees remain. Existing unavailable-employee filters, selected saved work
   and unsaved employee/work drafts remain intact.
3. Rename/reverse the fixture employees while a surviving button is focused;
   its focus stays put. Remove only the other ID, or focus an outside draft
   before removal: focus stays where the user left it, with no removal message.
4. Reject `/api/state` for a failed refresh: previous controls and focus remain.
   Restore reads to recover. A delayed response from a superseded request must
   not remove controls or move focus; the App interaction fixture exercises an
   old empty response arriving after a newer accepted snapshot.

Runnable deterministic interaction coverage in a prepared checkout:
`cd frontend && npx vitest run src/CompanyOverview.test.tsx src/App.test.tsx`.
Implementation recovery corrected the App test helper to wait for workspace
connectivity independently of Loop inspection freshness; reconnecting alone
does not guarantee that a retained Loop inspection is fresh. The scoped run
passed both files (103 tests), and `tsc --noEmit` passed. Integration recovery
also waits for the removal focus outcome rather than an already-connected
status before asserting the newly accepted snapshot. Its focused removal run
passed six tests (98 unrelated tests skipped) across both files. Shared read-only
dependencies required `--configLoader runner` for this isolated check.
The supervisor frontend profile passed 32 frontend test files and 1,159 tests,
the production build, and 505 Python tests with 2 skipped. Installed-browser
and installation/process-recovery gates were deferred by this profile. Live LLM
calls are skipped, not passed, under the user policy.

### Keyboard orientation when saved work leaves matches (C111-T1)

Launch `agentown-web --database PATH --port 8765`, open
`http://127.0.0.1:8765`, and navigate to **Work & results**. No provider or live
LLM call is needed. For a deterministic browser reproduction, paste this console
fixture (reload restores normal workspace reads; it never writes saved data):

```js
window.matchFetch = window.fetch.bind(window);
window.matchSnapshot = await (await window.matchFetch('/api/state')).json();
window.matchSnapshot.employees = [{id: 'keyboard-e', name: 'Writer'}];
window.matchSnapshot.work = ['keyboard-a', 'keyboard-b'].map(id => ({
  id, input: 'Keyboard request', status: 'pending',
  assignees: ['keyboard-e'], attempts: []
}));
window.fetch = (path, init) => path === '/api/state'
  ? Promise.resolve(Response.json(window.matchSnapshot))
  : window.matchFetch(path, init);
window.leaveMatchLater = (id, assignment = false) => setTimeout(() => {
  const work = window.matchSnapshot.work.find(work => work.id === id);
  if (assignment) work.assignees = [];
  else work.status = 'cancelled';
}, 5000);
```

1. Wait for polling, choose **View assigned work: Writer · ID: keyboard-e**,
   select **Pending work** under Current outcome, and search for `Keyboard`.
   Open request `keyboard-a`, then enter employee/work drafts without saving.
2. Run `window.leaveMatchLater('keyboard-a')`, return to the document and Tab
   to **Open request: Keyboard request · ID: keyboard-a** before five seconds
   elapse. The accepted poll moves focus to **Search saved work**. A polite
   status names the request and ID, says it left Matching requests, and explains
   that this does not mean deletion. Selected detail, filters and drafts remain.
   Tab continues through the filter controls to remaining matches.
3. Repeat with `window.leaveMatchLater('keyboard-b', true)` while its request
   button is focused. Reassignment leaves no matches; the same search control
   receives focus and the status explains the empty filtered view.
4. Reload/reinstall the fixture. Reverse `window.matchSnapshot.work` while a
   matching button is focused: focus follows its stable ID despite equal labels.
   Move focus to the draft, Saved work selector, or surviving request before
   another request leaves: that control keeps focus. Reject workspace reads:
   the stale list stays focused without a departure announcement. Superseded
   responses are covered by the deterministic interaction tests.

Scoped checks: `cd frontend && npx tsc --noEmit` and
`npx vitest run src/App.test.tsx --configLoader runner -t 'matching-request focus|matching refresh preserves'`.
Tests assert focus/status, accepted outcome and assignment changes, empty matches,
stable-ID reordering, outside/surviving controls, failed/superseded reads, retained
selection/filters/drafts, and workspace-only requests without mutation/execution.
Supervisor verification passed 32 frontend test files and 1,164 tests,
TypeScript checking, the production build, and 505 Python tests with 2 skipped.
Installed-browser and installation/process-recovery gates were deferred by this
profile. Live LLM calls remain skipped under user policy.

Implementation scoped validation: TypeScript checking passed; the five focused
App interaction cases passed (92 unrelated tests skipped), including Tab from
the recovered search control to Clear search. Existing shared dependencies were
used temporarily; no dependency installation or browser run was performed.

### Workstation setup refresh focus recovery (C112-T1)

Launch with the existing `agentown-web` flow and open the Codex workstation setup.
No credentials or live client connection are needed. For a deterministic delayed
removal, install this temporary fixture in the browser console after setup loads:

```js
window.originalSetupFetch = window.fetch;
window.fetch = async (input, init) => {
  const response = await window.originalSetupFetch(input, init);
  if (String(input) !== '/api/connections/v1') return response;
  const setup = await response.json();
  setup.clients = setup.clients.filter(client => client.id !== 'codex');
  await new Promise(resolve => setTimeout(resolve, 3000));
  return new Response(JSON.stringify(setup), {status: 200,
    headers: {'Content-Type': 'application/json'}});
};
```

Choose **Refresh setup**, then focus **Configuration fragment**, **Platform**,
**Setup instructions**, or **Check local server** before the response arrives.
When the selected setup disappears, focus moves to **Codex setup** and a polite
status explains that the control is unavailable. The client selector retains
Codex with an unavailable option; connection and exercise remain unverified.
Tab from the heading reaches Refresh setup, then the client selector.

Repeat while focus is on **Client** or an outside draft: focus must stay there.
To test surviving controls, change the fixture to remove `claude-code` instead;
Codex controls keep focus. Moving outside during the delay also preserves focus.
Reject the refresh or return an invalid empty `clients` array: loaded guidance
stays visible with the failure/stale disclosure and no focus recovery message.
Restore with `window.fetch = window.originalSetupFetch` and refresh explicitly.

Deterministic interaction coverage is in `frontend/src/Connections.test.tsx`,
including delayed removals of several controls, surviving/outside/selector focus,
invalid and failed responses, and superseded responses. Existing workstation
navigation tests remain unchanged. Scoped command when dependencies are present:
`npx vitest run src/Connections.test.tsx src/Workstations.test.tsx` and
`npx tsc --noEmit` from `frontend/`. Supervisor full-profile verification passed
32 frontend test files and 1,175 tests, TypeScript checking, the production
build, 508 Python tests with 2 skipped, the Rust and desktop gates, and 2
installed Chromium browser tests covering 38 interaction steps. Live LLM calls
are skipped under the current user policy, not passed.

### Selected-work recovery replacement focus (C114-T1)

Launch `agentown-web --database /tmp/agentown-recovery.sqlite --port 8765`
with saved work in that local product database, then open `http://127.0.0.1:8765`.
Select saved work and choose **Review recovery scope**. Consent receives focus;
check it if desired, but do not submit reconciliation for this exercise.

While consent retains focus, stop the local server and let workspace polling
observe disconnection. Focus moves to **Local MCP work inspection**, a labeled
region with a visible focus outline. A polite status explains that the previous
recovery review is unavailable and fresh review and consent are required.
Restart the same server and refresh the connection: review stays closed. Choose
**Review recovery scope** again; consent must be unchecked and reconciliation
must remain disabled until explicitly authorized.

Repeat by changing the selected saved work, or removing the selected work from
the returned saved-history snapshot in a local response fixture. To change
selection without first moving focus from consent, use the browser console to
set the Saved work selector's native value and dispatch a bubbling `change`
event, or use the deterministic interaction fixtures. If the selected work is
missing, the same inspection region survives and explains how to select work.
Normal clicks on selection controls keep their intentional focus destination.
Repeat while focus is on an outside draft/control: focus must stay there.
Explicit Skill/Hook navigation retains its requested inspection destination.
Observe network traffic: invalidation and reconnect send no reconciliation or
execution requests. Recovery requires separate explicit consent and submission.

`frontend/src/WorkRecovery.test.tsx` also covers replacement of **Inspect after
recovery**, held receipts arriving after selection loss/disconnect/reconnect,
fresh unchecked consent, outside focus, and requested navigation. Those receipt
fixtures are deterministic and do not reconcile the local database or call a
provider. No late receipt may restore invalidated review or move focus.
Recovery interaction coverage also removes canonical saved-work availability
while retaining the selected inspection ID, covering consent, post-recovery
controls, outside focus and late receipts. Read-only inspection remains available
for that ID; recovery requires available saved work.

Supervisor frontend-profile verification passed all 27 recovery interaction
tests and 1,205 frontend tests, TypeScript checking, the production build, and
505 Python tests with 2 skipped. Installed-browser and installation/process-
recovery gates were deferred by this profile. Live provider validation is
skipped under the user policy, not passed.

### Retained Loop refresh focus (C115-T1)

Launch `agentown-web --database /tmp/agentown-loop-focus.sqlite --port 8765`
and open http://127.0.0.1:8765. Save and select a text work item. No provider
credentials or activation are needed. This temporary browser-console fixture
intercepts only Loop inspection reads; reload removes it and no sessions are
written to SQLite. Replace `TASK_ID` with that saved work ID (a UUID for local
MCP inspection). Install before inspecting either Loop surface:

```js
const taskId = 'TASK_ID';
const sessionId = '22222222-2222-4222-8222-222222222222';
const preview = {schema_version: 1, preview_id: 'focus-fixture',
  policy_id: sessionId, policy_name: 'Keyboard fixture', task_id: taskId,
  agent_id: '11111111-1111-4111-8111-111111111111', input: 'Retained fixture input',
  expected_runs: 0, policy_enabled: true, max_iterations: 2,
  interval_seconds: 60, created_at: 1};
const retained = {schema_version: 1, session_id: sessionId, preview,
  state: 'active', admitted: 0, next_at: 1, started_at: 1, expires_at: 100,
  provider: 'fixture', model: 'fixture', declared_source: 'agentown-local-product'};
window.loopFocusFixture = {mode: 'active', delay: 0};
const originalLoopFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = String(input);
  const local = path === '/api/connections/v1/loops/inspect';
  if (!local && !(path === '/api/loops/v1' && (!init?.method || init.method === 'GET')))
    return originalLoopFetch(input, init);
  const {mode, delay} = window.loopFocusFixture;
  await new Promise(resolve => setTimeout(resolve, delay));
  if (mode === 'failed') throw new TypeError('Fixture inspection unavailable');
  const data = mode === 'invalid' ? {sessions: 'invalid'} : {
    schema_version: 1, control: {state: 'available', can_control: true, message: ''},
    sessions: mode === 'removed' ? [] : [{...retained, state: mode === 'terminal' ? 'stopped' : 'active'}],
    attempts: [], cancellation: 'Remote completion may remain unknown.'};
  return new Response(JSON.stringify(local ? {schema_version: 1,
    requested_task_id: taskId, status: 'confirmed', code: 'loops_inspected',
    recovery: 'Inspect explicitly', data} : data),
    {headers: {'Content-Type': 'application/json'}});
};
```

Inspect local Loop sessions, or wait for the saved-work Loop observation. Set
`window.loopFocusFixture = {mode: 'removed', delay: 3000}` and request another
inspection. Keep focus on the retained session region (console `.focus()` is
useful while local inspection controls are disabled). For saved-work polling,
focus its Stop button before the delayed response arrives. The accepted removal
must focus the bounded Loop region and announce that the session no longer
appears. Reset to `active`, inspect again, then use `terminal`: a focused Stop
control is replaced, focus moves to its surviving session region and a polite
status explains that Stop is no longer available. Never press Stop or authorize
activation during this reproduction.

Repeat with focus moved to an outside control during the delay: it stays there.
An `active` refresh preserves a surviving focused control. `failed` and `invalid`
keep retained records and do not announce focus recovery. Disconnect/reconnect
or explicitly navigate to another work item before a delayed response returns:
obsolete reads must not move focus or override requested navigation. Observe
**Loop focus update**, `document.activeElement`, and network requests: inspection
must never send start/activation or Stop requests.

Deterministic delayed-response coverage is in `WorkLoop.test.tsx` and
`LoopExecution.test.tsx` under “delayed … refresh preserves keyboard orientation”.
Integration validation passed TypeScript (`tsc --noEmit`) and both scoped Vitest
files (101 tests), using the available dependency tree and `--configLoader native`.
The named focus announcement retains `aria-live="polite"` without introducing
an extra status role ahead of the existing inspection/request messages.
Supervisor frontend-profile verification passed 32 frontend files and 1,220
tests, TypeScript checking, the production build, and 505 Python tests with 2
skipped. Installed-browser and installation/process-recovery gates were deferred
by this profile. Live provider tests are skipped, not passed, under the current
user policy.

## Skill and employee Hook eligibility focus (C116-T1)

Launch the documented local product with
`agentown-web --database /tmp/configuration-workspace.sqlite3 --port 8765` and
open http://127.0.0.1:8765. Use existing saved work and an enabled Skill. For
Hooks, select existing work with a terminal attempt and an enabled employee
Hook matching its assignee and event, whose required Skill is enabled. No new
provider configuration or provider call is needed. Do not open a preview or
press execution consent during this check.

For a reversible delayed configuration read, install this browser-console
fixture after selecting saved work (reload removes it). It changes read responses
only; it does not save configuration. Set `id` to the selected Skill or Hook ID:

```js
window.eligibilityFixture = {kind: 'skills', id: 'SELECTED_ID', mode: 'unchanged', delay: 3000};
const eligibilityFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await eligibilityFetch(input, init);
  const path = String(input);
  if (init?.method && init.method !== 'GET') return response;
  const fixture = {...window.eligibilityFixture};
  if (!path.endsWith('/api/config/v1/' + fixture.kind)) return response;
  const body = await response.clone().json();
  await new Promise(resolve => setTimeout(resolve, fixture.delay));
  body[fixture.kind] = body[fixture.kind].flatMap(record => {
    if (record.id !== fixture.id) return [record];
    if (fixture.mode === 'removed') return [];
    if (fixture.mode === 'disabled') return [{...record, enabled: false}];
    if (fixture.mode === 'unmatched') return [{...record, target_id: 'unmatched-fixture'}];
    return [record];
  });
  return new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}});
};
```

Choose the eligible entry, set `mode` to `removed` or `disabled`, and Tab to
**Preview Skill with saved work** or **Preview Hook with saved work** before the
next delayed response arrives. The accepted response disables that button;
`document.activeElement` becomes **Enabled Skill** or **Employee Hook**. Its
existing polite status says the selected Skill/Hook is no longer available for
preview, asks for an eligible choice, and states that no execution was requested.
The labelled section is the fallback if its selector cannot be used. For a Hook,
repeat with `kind: 'skills'` and its required Skill ID, and with `kind: 'hooks'`,
the Hook ID and `mode: 'unmatched'`.

Reload between cases to restore original reads. Repeat while focus stays on the
selector or moves outside this section during the delay: focus stays there.
`mode: 'unchanged'` preserves the focused, enabled launch button. Disconnect
before a held response resolves: obsolete responses must preserve outside focus
and the disconnected status. Inspect network activity: only configuration reads,
no preview request and no execution submission should occur.

Deterministic coverage in `SkillExecution.test.tsx` and `HookExecution.test.tsx`
uses “delayed … eligibility refresh” cases with explicitly released responses.
These assert focus, polite availability feedback, unchanged and obsolete
responses, outside/selector preservation, and zero preview/execution submissions.
The native-blur regression intercepts React's `setAttribute('disabled', …)`
commit, blurs the focused launch control immediately before the attribute write
(jsdom ignores `blur()` after disabling), and asserts body focus before checking
selector recovery and polite status. This proves that focus loss actually occurred.
This exercises browsers that drop focus when a focused button becomes disabled.
Supervisor frontend-profile verification passed 32 frontend files and 1,264
tests, TypeScript checking, the production build, and 505 Python tests with 2
skipped. Fresh browser evidence was deferred by this scoped verification
profile. Live provider calls are skipped, not passed, under the user policy.

## Request completion focus ownership (C117-T1)

Launch `agentown-web --database /tmp/focus-completion.sqlite3 --port 8765`
and open `http://127.0.0.1:8765`. Create an employee and save/assign text work
if this database is empty. Select that work and inspect through local MCP.
Live provider calls remain skipped. Use this browser-console fixture before
submitting either execution or expired-attempt recovery; it intercepts both
mutation routes, so neither mutation reaches the server:

```js
const originalFocusFetch = window.fetch.bind(window);
window.focusOutcome = 'confirmed'; // also: rejected, uncertain, timeout
window.focusRequests = 0;
window.finishFocusRequest = null;
window.fetch = async (input, init) => {
  const path = String(input);
  const execution = path.endsWith('/execute-work');
  if (!execution && !path.endsWith('/reconcile-work')) return originalFocusFetch(input, init);
  window.focusRequests++;
  const {task_id} = JSON.parse(init.body);
  const outcome = window.focusOutcome;
  return new Promise(resolve => {
    window.finishFocusRequest = () => {
      if (outcome === 'timeout') return; // client deadline ends the wait
      const confirmed = outcome === 'confirmed';
      const status = execution && confirmed ? 'completed' : outcome;
      const code = confirmed ? (execution ? 'execution_recorded' : 'reconciliation_confirmed')
        : outcome === 'rejected' ? (execution ? 'execution_busy' : 'recovery_busy') : 'delivery_uncertain';
      const value = {schema_version: 1, requested_task_id: task_id, status, code,
        recovery: 'Deterministic fixture receipt. Inspect explicitly; nothing was executed.'};
      if (execution) value.execution = confirmed ? {
        schema_version: 1, run_id: '22222222-2222-4222-8222-222222222222',
        input: 'Fixture input', provider: 'fixture', model: 'fixture',
        deadline_unix_ms: 100, output: 'Fixture result, not a provider response',
        error: null, quality: 'unverified'
      } : null;
      else Object.assign(value, {
        evidence: {source: 'installed_local_mcp', tool: 'get_work_history_v1',
          read_only: false, mutation_scope: 'snapshot_expired_leases', external_client_verified: false},
        inspection: confirmed ? {task: {id: task_id, title: 'Fixture saved work',
          status: 'pending', assignees: []}, attempts: [], readiness: null} : null
      });
      resolve(new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}}));
    };
  });
};
```

For execution, check its authorization, Tab to **Execute once through local
MCP**, and press Enter. For recovery, choose **Review recovery scope**, check
its authorization, Tab to **Reconcile expired attempts once**, and press Enter.
Consent becomes unchecked, submission locks, and the waiting status appears.
Keep focus in that request flow and invoke `finishFocusRequest()` from the
console. Focus returns to **Inspect before another execution** or **Inspect
after recovery**, including browsers that blur a submit button when disabled.
Check `document.activeElement` and the visible focus outline.

Repeat each flow with `focusOutcome` set before submission to each of the four
outcomes. Confirmed receipts display a recorded/confirmed status; rejected and
uncertain receipts display alerts. Timeout waits 75 seconds for execution or
15 seconds for recovery and displays uncertain-delivery advice. Timeout does
not establish cancellation or failure of a real request.

Repeat while moving focus to an outside usable control, such as an unsaved
request field, during the pending request. Completion must keep that focus.
Even focusing outside and then blurring must not return focus to the request.
`focusRequests` increases once per explicit submission; repeated activation,
completion and rerender must not replay it. Inspection and fresh authorization
are required for another execution. Changing selection or disconnecting during
the wait invalidates the flow; a late fixture receipt must not restore it or
move focus. Restore fetch with `window.fetch = originalFocusFetch` or reload.

Deterministic regressions:
`cd frontend && npx vitest run src/WorkExecution.test.tsx src/WorkRecovery.test.tsx`
and `npx tsc --noEmit`. The new matrix includes deferred receipts, client
timeouts, retained submit focus, native blur at React's disabled-attribute
commit (asserting body focus before the write and dispatching body focusin),
outside focus (including a synchronous move during the submission commit),
consumed consent, single submission and no replay. Existing
selection/disconnect tests remain.
The repair ignores only automatic body/ancestor fallback; a usable outside
control receiving focus during the disabled-attribute commit relinquishes
request focus ownership immediately. Both deferred outcome matrices cover this
case. Periodic full verification passed 1,304 frontend tests, TypeScript
checking, the production build, 508 Python tests with 2 skipped, and 2 browser
checks. Live provider validation is skipped, not passed.

## Open an employee’s failed or interrupted work (C118-T1)

Launch `agentown-web` with an existing database containing employees, saved
assignments and failed/interrupted attempts. No model or credentials are needed
to inspect this history:

```sh
uv run --directory python --locked agentown-web --database /tmp/llm-work.sqlite3
```

1. Open http://127.0.0.1:8765. Enter an unsaved work draft and search text that
   excludes the failed work; optionally choose another outcome.
2. In Company overview → Employee workload list, Tab to the employee card’s
   **View failed or interrupted work** action and press Enter or Space.
   Focus moves to **Work & results**; Tab continues to Search saved work.
3. Confirm search is cleared, Current outcome is **Failed or interrupted work**,
   and the employee ID matches the card. Shared assignments appear for each saved
   assignee; only the latest attempt determines the outcome. The action remains
   available with a zero count so an empty filtered view can be inspected.
4. Confirm the draft and previously selected detail remain intact. A selected
   item outside these filters is explicitly identified; choose a matching request
   to change the detail. Navigation does not save, assign, retry or execute work.
5. Disconnect the server and wait for the disconnected notice. Repeat the action:
   the retained overview and assignments are labeled stale and remain browsable.
   Restart the server with the same database and refresh. If the employee has no
   failed/interrupted work after refresh, the filtered view shows no matches and
   retains its employee/outcome filters and existing detail.

Deterministic interaction coverage is in `frontend/src/App.test.tsx` (test name
`employee failed-work navigation preserves selection and drafts without mutations`),
run with `npm --prefix frontend test -- src/App.test.tsx`. Supervisor frontend
verification passed 1,307 frontend tests, TypeScript checking, the production
build, and 505 Python tests with 2 skipped. Installed-browser and recovery gates
were deferred by this profile. Live provider calls are skipped, not passed.
