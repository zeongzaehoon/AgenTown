# AgenTown desktop shell

C25-T1 adds an unsigned Tauri shell around the existing React/Python workspace.
The merged shell and service share the private protocol below. Consolidated
native build and browser verification remain pending. No macOS installation or Windows installation is claimed
by this source change. DMG delivery and Windows installers remain C25-T2/T3.

## Build and launch

On the build computer install Python 3.13, uv, Node 24, Rust and the Tauri 2 CLI
(`cargo install tauri-cli --version '^2' --locked`), plus the official
[Tauri native prerequisites](https://v2.tauri.app/start/prerequisites/).
From a clean source checkout on macOS run:

```sh
python3.13 desktop/build.py
open desktop/target/release/bundle/macos/AgenTown.app
```

The build command first runs the separate desktop Rust lifecycle tests (without
the webview feature), then installs frontend dependencies, builds React, builds the
maturin wheel, downloads a platform-matching Python 3.13 standalone runtime,
installs the product wheel and its dependencies in that runtime, checks imports
and built assets, then builds an unsigned app. Before native assembly,
`desktop/check_runtime.py` copies the complete service to a temporary directory
outside the checkout and launches it with an empty `PATH` and isolated Python.
It checks authenticated readiness, fetches the React entry module, saves an
employee through the API, verifies its ID after restart, and requires clean EOF
shutdown on both launches. It uses only a temporary database and makes no LLM
calls. Any failure stops the build. No server command is necessary.
The packaged app requires neither Node nor an installed Python nor `.agents` or
`.harness`. Build tools and download access are development prerequisites only.
Do not copy a virtualenv into the bundle. Build independently for each OS and
architecture; this command does not cross-compile native Python extensions.
Runtime download uses uv's `--no-bin --no-registry` options, so assembly does not
register Python or replace developer executable links. Runtime selection ignores
uv's minor-version symlink alias. To check this build regression without downloads:
`python3.13 desktop/tests/test_build.py`.
uv marks the downloaded runtime as externally managed. Package installation uses
`--break-system-packages` only for the disposable copy under
`desktop/resources/python`; the build rejects interpreter paths (including
symlinks) resolving outside that copy. It does not modify the developer's Python.
The tracked `desktop/resources/README.md` keeps Tauri's resource directory present
for native compile checks in a clean checkout. Only the build command assembles
the runtime; a compile check with that placeholder is not a runnable distribution.
Windows installer commands and host-validation limits are documented below.

For lifecycle checks without a webview:

```sh
cargo test --manifest-path desktop/Cargo.toml --no-default-features
```

## Shared service contract (integration checkpoint)

The Rust shell and Python adapter implement this shared wire boundary:

* Execute `python -I -m llm_engine.desktop --database <absolute file> --port <port>`.
  Python binds **only** `127.0.0.1` and retains the existing exact Host and
  same-origin mutation checks. No CORS or Tauri-origin exemption is needed.
* Rust generates two independent 32-byte random hex strings, writes one JSON
  line `{"token":"<request token>","identity":"<response identity>"}` to the child's
  private stdin, and keeps that pipe open. Neither value is in arguments, URLs,
  environment, database or logs. The request token and response identity must
  remain distinct: an occupied endpoint sees the request token and must still
  be unable to forge the response identity.
* `GET /_desktop/ready`, with exact loopback Host and
  `X-AgenTown-Desktop: <request token>`, returns HTTP 200 JSON
  `{"ready":true,"identity":"<identity>"}` only after initialization, including
  database and packaged assets. Reject missing/wrong request token. Never reflect the request token as identity. This endpoint
  must not be available in ordinary `agentown-web` mode.
* EOF on private stdin requests graceful server shutdown. Python must monitor
  this after consuming the first line, including owner death. Rust waits at
  most five seconds before terminating the whole child group/job.
* Rust chooses an ephemeral loopback port and has a 20-second readiness budget.
  There is a bind handoff race: an occupied endpoint must cause a safe failure,
  never opening that endpoint without matching authenticated readiness.
* The window is created only after readiness. Navigation is restricted to the
  exact owned loopback origin. No Tauri IPC capabilities are granted to it.
  Unexpected service death closes the app with an actionable native error.
  Duplicate admission uses an OS file lock held through child shutdown.

Rust suppresses child stdout/stderr, so provider errors or identity cannot leak
through desktop logs. Startup errors describe recovery without echoing service
output. Product error reporting remains in the existing API/UI. Native shell
initialization errors may be reported by Tauri itself.

## User files and preservation

The application identifier is `com.agentown.desktop`. Paths are obtained through
Tauri's native directory resolver, rather than the checkout/current directory:

| Platform | Data and database | Configuration | Logs |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/com.agentown.desktop/agentown.sqlite3` | `~/Library/Application Support/com.agentown.desktop/` | `~/Library/Logs/com.agentown.desktop/` |
| Windows | `%APPDATA%\com.agentown.desktop\agentown.sqlite3` | `%APPDATA%\com.agentown.desktop\` | `%LOCALAPPDATA%\com.agentown.desktop\logs\` |

The shell creates these directories, reserves `desktop.lock` in data, and always
passes the same absolute database path across launches. It never deletes data,
configuration or logs on exit, replacement or upgrade. Removing the app bundle
also leaves these directories intact. Manual deletion is an explicit user
operation after quitting the app; installer-specific policy requires its own
platform validation. No separate desktop configuration format or log content is
introduced here. Back up the data directory with the app closed, including any
SQLite sidecars. Existing database migrations remain owned by the product.

## Evidence still required

The ordinary `rust/Cargo.toml` workspace gate does **not** cover the desktop
workspace. The documented desktop build now runs its lifecycle tests itself and
fails before resource assembly if they fail. Supervisor verification must retain
the output of `python3.13 desktop/build.py`, including both those test results
and the native Tauri build result; a product Core test log alone is insufficient.
The relocated-service smoke result is also printed into that build output. This
checks the assembled resources, but does not establish visible Tauri webview
behavior or the final bundle's resource mapping. To repeat it against an existing
macOS bundle without rebuilding:

```sh
python3.13 desktop/check_runtime.py desktop/target/release/bundle/macos/AgenTown.app/Contents/Resources/service
```

For the assembled macOS app, use this acceptance sequence and record each result:

Run `python3.13 desktop/check_app.py` after assembly in a graphical macOS login.
It copies the bundle outside the checkout, launches with an empty PATH and a
temporary macOS home, observes an on-screen native window, and waits for a
webview DOM signal requiring the React heading, employee form and connected
status. It saves an employee through the owned service API, quits, relaunches,
waits for React again, and checks both the saved ID and name. It also requires
owned-service cleanup. Retain its actual output in the verification artifact;
source inspection alone is not passing evidence. This automated check does not
exercise employee form interaction or visually inspect the saved record, so the
graphical acceptance sequence below remains required.

The supervisor can prepare and launch the copied bundle with the following
commands from the checkout root. Run them in one terminal session in a graphical
macOS login, after the build succeeds. These commands launch the actual Tauri
executable, rather than the staging service or a browser pointed at it:

```sh
desktop_acceptance_dir=$(mktemp -d /private/tmp/agentown-desktop-XXXXXX)
mkdir "$desktop_acceptance_dir/empty-path"
ditto desktop/target/release/bundle/macos/AgenTown.app "$desktop_acceptance_dir/AgenTown.app"
cd "$desktop_acceptance_dir"
env PATH="$desktop_acceptance_dir/empty-path" ./AgenTown.app/Contents/MacOS/agentown-desktop &
desktop_shell_pid=$!
ps -p "$desktop_shell_pid" -o pid=,ppid=,comm=
pgrep -P "$desktop_shell_pid"
```

Record the child PID once readiness completes; `pgrep` before service spawn can
return no result. Use `ps -p <child-pid> -o pid=,ppid=,comm=` to confirm the child
belongs to the copied runtime. Avoid dumping process environments, which can
contain inherited credentials. Retain a screenshot of the visible workspace
and the process observations with the supervisor's verification artifact.
For each relaunch or duplicate launch, repeat the `env PATH=...` command above
from this temporary directory. For the service-death check, send `kill -TERM`
only to the recorded owned service PID while its shell is still running. After
normal quit, wait for the shell and confirm both recorded PIDs have exited.
Remove the temporary bundle only after every app instance has closed; retain
the platform data directory for the restart check.

1. Copy `desktop/target/release/bundle/macos/AgenTown.app` to a temporary directory
   outside the checkout. From that directory, launch its
   `Contents/MacOS/agentown-desktop` executable with `PATH` pointing to an empty
   directory. This exercises the copied resource paths without finding Node or
   Python through `PATH`. Confirm the React workspace opens.
2. Create an employee with a unique verification name in the workspace and record
   its saved ID. Quit, confirm the owned Python process exits, relaunch the copied
   app in the same way, and confirm the same employee ID and name remain. This
   leaves an ordinary employee record in the platform data directory; use a
   dedicated OS test account for a fresh-data acceptance run.
3. Launch the executable again while the first instance is open. Confirm an
   actionable already-running dialog, no second workspace/service, and that the
   first workspace still works. Dismiss the dialog.
4. Terminate only the owned Python service process. Confirm the shell reports
   unexpected service exit and closes after the dialog is dismissed. Relaunch to
   confirm saved data remains. Quit and confirm no service descendants survive.

The executable launch, visible workspace, saved IDs before/after restart, process
observations and dialogs need actual supervisor evidence. The deterministic
lifecycle fixtures cover readiness timeout, occupied endpoint identity and forced
descendant cleanup; they do not prove an assembled webview or standalone runtime
works. This sequence is for macOS; Windows requires its own host evidence.

The supervisor must resolve/build the new Cargo project, test the shared Python
contract, launch the assembled app outside the checkout with Node/Python absent
from PATH, exercise the workspace, verify retained records after restart, and
run the full packaging/product gate. Browser evidence is pending. Native forced
cleanup must be exercised on each claimed platform. Real provider calls are
skipped under the current user policy, never recorded as passed.

Resource mapping follows the official [Tauri resource guide](https://v2.tauri.app/develop/resources/)
and [configuration reference](https://v2.tauri.app/reference/config/).

## Unsigned macOS DMG delivery (C25-T2)

`python3.13 desktop/build.py` now also packages the assembled macOS app with
Apple's built-in `hdiutil`. No third-party DMG layout tool is required. The image
contains `AgenTown.app` (including `Contents/Resources/service`) and an Applications
shortcut. It is a compressed HFS+ image, verified by `hdiutil verify`. This is
unsigned local distribution, separate from Developer ID signing, notarization,
Gatekeeper approval or publication. It does not alter installed applications or
service settings. Repeating the command replaces only the exact generated
architecture-specific DMG in the target build directory.

To package an existing complete bundle without rebuilding, use:

```sh
python3.13 desktop/package_dmg.py
# Or choose an output path explicitly:
python3.13 desktop/package_dmg.py /absolute/AgenTown.app /absolute/AgenTown-test.dmg
```

Default output is `desktop/target/release/bundle/dmg/AgenTown-unsigned-arm64.dmg`
on Apple Silicon (`x86_64` on Intel). Packaging prints the absolute artifact path,
SHA-256, OS version and architecture. Reproducible means the documented procedure;
DMG timestamps and generated identifiers do not imply byte-identical builds.
Apple's local `hdiutil create -help` documents the selected `-srcfolder`, `-fs`
and `-format` options; the existing Tauri resource/configuration references above
continue to define the app resource mapping.

In a graphical macOS login, retain actual output of these commands:

```sh
python3.13 desktop/build.py > docs/evidence/c25-t2/build.txt 2>&1
python3.13 desktop/check_dmg.py desktop/target/release/bundle/dmg/AgenTown-unsigned-arm64.dmg > docs/evidence/c25-t2/installed.txt 2>&1
```

The delivery check mounts the actual image read-only, uses `ditto` to install into
an isolated writable temporary directory outside the checkout, and launches with
an empty PATH and temporary `CFFIXED_USER_HOME`. It retains that same home while
quitting/relaunching and removing only the test app before reinstalling from the
mounted image. It compares employee ID/name and saved work ID/text/assignee on
each launch. Work is saved through the app-owned API, not executed. Each launch
requires the React rendered signal; the first also observes the native window.
It interrupts only the recorded owned service, confirms that child is reaped,
terminates the isolated shell, then reopens the app and verifies retained
records. The native unexpected-service error remains covered by the shell's
actionable-error path; the automated delivery check does not require macOS
Accessibility or Screen Recording permission. Each shutdown requires
owned-service exit.
The image is detached in a finally block. Temporary test data is removed only
when the isolated test completes; ordinary user data is never targeted. Keep
manual visual/form interaction evidence separate from these API-driven checks.

Implementation-stage evidence and outstanding validation are recorded in
[evidence/c25-t2/implementation.md](evidence/c25-t2/implementation.md).

### GitHub Release publication

`.github/workflows/release-macos.yml` is the release boundary. Pushing a version
tag such as `v0.1.0` starts a fresh Apple Silicon `macos-15` build, runs the deterministic
helper tests, assembles the complete bundled service, mounts the produced DMG,
and exercises install, first launch, restart, reinstall, persistence and owned
process cleanup through `desktop/check_dmg.py`. Only after those checks pass does
the workflow create a GitHub Release and upload the architecture-labelled DMG
and `SHA256SUMS.txt`. Build and installed-check logs remain attached to the
workflow run as evidence; they are not release downloads.

The release workflow intentionally labels the image `unsigned`. It does not
claim Developer ID signing, hardened-runtime signing, notarization or Gatekeeper
approval. Add those steps only when Apple credentials are configured and their
result is independently verified. A failed build or installed-app check prevents
publication. Re-running a failed tag workflow does not replace an existing app
or touch user data. GitHub repository settings must allow Actions to write
repository contents so the built-in token can create the Release.

Release operators create a release only from a clean, pushed commit whose
version matches `desktop/tauri.conf.json` and `desktop/Cargo.toml`, then push the
matching annotated tag:

```sh
git tag -a v0.1.0 -m "AgenTown v0.1.0"
git push origin v0.1.0
```

Monitor the **macOS desktop release** workflow. The downloadable file appears at
<https://github.com/zeongzaehoon/AgenTown/releases> only after both jobs pass.

## Windows NSIS delivery (C25-T3)

On a Windows x64 build host with the development prerequisites above, including
MSVC Build Tools and the Windows SDK, run:

```powershell
py -3.13 desktop/build.py
```

Tauri automatically merges `tauri.windows.conf.json`. The unsigned installer is
`desktop/target/release/bundle/nsis/*-setup.exe`; the bundled application includes
`agentown-desktop.exe`, `launch-agentown.bat`, and `service/python/python.exe`
with all product dependencies and built React assets. The Windows ICO contains
the existing product PNG. macOS continues using its existing configuration.
No signing certificate, release publication or workflow dispatch is required.
Unsigned downloads may encounter Windows reputation prompts; signing is a
separate release step.

The NSIS installer uses `currentUser`, placing registration under HKCU and
installing without administrator access by default. The app and batch launcher
do not request elevation. Run the installed Start menu shortcut, executable, or
its sibling `launch-agentown.bat` from any working directory. The batch file uses
its own quoted directory, disables delayed expansion and forwards `%*` directly
without CALL, START or another shell expansion. Quote arguments containing
spaces or cmd metacharacters as usual. The shell currently has no user command-line
options; forwarding is tested with a capture executable, including spaces,
ampersands, Unicode, exclamation marks and exit status.

WebView2 uses Tauri's embedded Evergreen bootstrapper: existing WebView2 is
reused; a machine without it needs network access to download the runtime.
This is not an offline installer. Organization policy can restrict WebView2
installation; install Evergreen through the organization's approved mechanism
before launching in that case. Python and Node are never runtime prerequisites.
The decisions follow the official [Windows installer guide](https://v2.tauri.app/distribute/windows-installer/)
and [NSIS configuration reference](https://v2.tauri.app/reference/config/#nsisconfig).

Windows data/database and configuration remain under
`%APPDATA%\com.agentown.desktop\`; logs remain under
`%LOCALAPPDATA%\com.agentown.desktop\logs\`. Close the application before an
upgrade, backup or uninstall. Application replacement does not migrate these
folders elsewhere. Uninstall should preserve them for reinstall; if the stock
uninstaller offers a separate application-data removal option, leave it
unchecked to retain work. Intentional data deletion is destructive and optional.
Actual uninstall/reinstall preservation still needs Windows-host evidence.

`.github/workflows/windows-desktop.yml` configures Windows Server 2022 CI to run
build-helper and real cmd launcher tests, the separate desktop Rust lifecycle
suite (including a Windows Job Object fixture), the complete bundled-runtime
readiness/EOF/persistence check, and NSIS assembly. It installs that installer
in the disposable runner account and runs `desktop/check_windows.py` against the
installed files. That smoke check copies the app outside the checkout into a
spaced Unicode path, empties PATH, requires the React rendered signal, saves an
employee and work, closes the native window, requires service exit, restarts and
compares saved IDs/content. It uses the runner account's normal platform data
folders; use a disposable Windows account when running it manually. No LLM calls
occur. Graphical runner restrictions cause a failing smoke check, never a silent
pass. Installer and actual log files are retained with `upload-artifact`, including
on failure; creating this workflow does not execute it or publish a release.

Remaining Windows-host evidence: actual CI build and install output; launcher
argument and Windows Job Object fixture results; native first-run/render and
restart results; standard-user/no-developer-runtime installation; missing-WebView2
bootstrapper behavior; duplicate-launch and unexpected-service dialog inspection;
normal and forced process cleanup; uninstall/reinstall with saved employee/work
IDs; failed upgrade/interrupted install recovery; and manual visual/form use.
None was executed by the implementation invocation on macOS. Supervisor browser
and consolidated product verification are also pending. macOS delivery evidence
is not Windows proof.

### Connections from an installed desktop (C26-T3)

1. On macOS, launch `/Applications/AgenTown.app` from Finder (or `open /Applications/AgenTown.app`). On Windows, launch AgenTown from the Start menu after installation, or run its installed `launch-agentown.bat`. These steps require no checkout or Node.
2. Open **Connections**, choose Codex, Claude Code, Claude Desktop, Cursor or ChatGPT. The local platform is selected by the service. Inspect the displayed absolute settings destination and configuration. The command is the running packaged Python with `-I -m llm_engine.mcp_server`; its database argument is the desktop's selected database. Paths containing spaces remain separate JSON/TOML arguments.
3. Copy setup instructions or download the setup artifact. Downloads are merge fragments: back up the displayed destination, merge only `agentown`, and preserve other settings. Claude Code can instead add the displayed command/args through `/mcp` in user scope. No action here writes application settings or starts another service.
4. Follow the displayed restart/status inspection instructions. Ask the client to list employees and saved work without execution. An installation hint, successful copy or download proves neither configuration nor a protocol session; this screen keeps configured unknown and connected/exercised unverified.
5. ChatGPT downloads a prerequisite checklist. Public HTTPS, a TLS proxy, an OAuth issuer with supported registration/login and eligible client configuration remain operator prerequisites. This screen neither exposes the local service nor supplies credentials. See `docs/mcp.md` for the opt-in remote adapter contract.
6. Deny clipboard permission to check manual-copy recovery. If downloads are denied by the host, use the readable instructions and save manually. Stop the local service and refresh to check disconnected/stale recovery; restart AgenTown and refresh. Inspect history before retrying work and never delete the database to repair a connection.

Client sessions, actual downloads in each desktop webview and browser interaction
for this snapshot require supervisor validation. No live provider calls are needed
for this setup flow.
