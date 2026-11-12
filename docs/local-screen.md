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
