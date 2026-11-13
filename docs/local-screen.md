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

Supervisor-selected consolidated checks and browser validation remain pending.
Live provider validation is skipped, not passed; external connectivity is unverified.

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
