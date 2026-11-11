# C8-T2 resumed implementation — 2026-09-13

Scope: packaging and installed React employee-to-result integration only. Preserved
the interrupted implementation and operator directory migration. No subagents ran;
PLAN.md and harness source/state/configuration were not edited.

The existing `python/tests/installed_package.py` builds a fresh locked wheel,
compares all production assets with the archive, exports hashed runtime dependencies,
installs into a clean virtual environment and probes imports outside the checkout
with Node absent from PATH. `test_installed_web.py` exercises the installed executable,
missing configuration, synthetic credential redaction, deterministic failure and
explicit retry, restart history and actual process termination during provider I/O.
Recovery waits for the real Rust lease and checks the submission count stays at three.

The supervisor's existing `test_web_browser.py` uses that installed fixture. This
resume adds a provider-journal wait before killing its third request: persisted
Running state precedes provider I/O, so state alone could race with submission.
Screenshots, interaction JSON, trace, persisted IDs/results and wheel/source hashes
must be inspected in the future supervisor run's exact evidence directory. No
verification artifact was supplied, and no browser success is claimed here.

## Research consulted in this resumed stage

- https://www.maturin.rs/project_layout — mixed packages support a separate Python
  source directory; ignored assets need explicit inclusion. Retain the static include
  and byte-for-byte wheel checks.
- https://pyo3.rs/v0.27.2/ — the selected version supports native extension modules
  and documents rebuilding with maturin develop. Keep native rebuild before pytest.
- https://docs.python.org/3.13/library/venv.html — virtual environments isolate
  installed packages and use bin on POSIX versus Scripts on Windows. Test a new
  environment rather than the editable checkout.
- https://docs.astral.sh/uv/concepts/projects/export/ — export the universal lock to
  requirements format for locked downstream installation.
- https://docs.python.org/3.13/library/subprocess.html — kill/terminate semantics
  differ by platform; wait for process exit and retain the return code.
- https://vite.dev/guide/build.html — production builds emit distributable assets;
  package that output, with no frontend development server at runtime.

## Outstanding acceptance

The current environment has no `ANTHROPIC_API_KEY` variable (presence-only check;
no credential value or credential store was read). No model was intentionally
supplied for a live request. The full actual provider response displayed in the
installed browser and recovered after restart is blocked by runtime configuration.
Deterministic output does not satisfy this criterion. Section 8 remains incomplete.

Only macOS arm64 checks ran. Windows commands are documented but untested. Browser
coverage awaits the supervisor; screen-reader and desktop-installer validation,
teams UI, 3D and additional providers remain whole-product gaps.

## Ordinary checks completed

All commands ran on macOS arm64 with Python 3.13.12:

- `npm --prefix frontend test`: 6 passed, including TypeScript checking;
  `c8-t2-resume-npm-test.txt`.
- `npm --prefix frontend run build`: passed; HTML and hashed JS/CSS emitted;
  `c8-t2-resume-build.txt`.
- `cargo test --manifest-path rust/Cargo.toml --workspace --locked`: 40 passed;
  `c8-t2-resume-cargo.txt`.
- `python3 .harness/cli.py check`: all configured checks passed;
  `c8-t2-resume-harness.txt` and copied `c8-t2-resume-harness-checks.txt`.
  This ordinary harness check is not the future supervisor browser artifact.
- After the harness exited, `uv run --directory python --locked maturin develop
  --locked` finished successfully (`c8-t2-resume-sequential-native.txt`), then
  `LLM_ENGINE_PACKAGE_EVIDENCE=/Users/hoon/Portfolio/llm-engine/docs/evidence/c8-t2-resume-installed
  uv run --directory python --locked python -m pytest` passed: 56 passed, one
  opt-in browser test skipped, one Starlette/AnyIO deprecation warning, 235.26s
  (`c8-t2-resume-pytest.txt`). No build ran concurrently with this final pytest.

`c8-t2-resume-installed/package/` retains the wheel, archive contents, exported
hashed requirements, build/install subprocess output, isolated runtime probe and
52 source/asset hashes. The macOS wheel SHA-256 is
`7291e637831607980cc9ad51906d33b5e0f8a12bf977fcea7fa26d45438bec59`.
`c8-t2-resume-installed/` retains served asset hashes, server output, recovered
SQLite database and `process-recovery.json` with full deterministic output.

Recovered Task: `a3421835-636c-40ea-adc8-5dcab9b6430f`. Its Runs are
`f75cf89d-8b2b-4f71-b786-dde453879f70` (rate-limit failure),
`265b94c7-3ff0-43f0-8b98-22cc24b06076` (unverified deterministic result), and
`1e51204f-518c-4f2c-b9a4-a5fdf17b2a48` (interrupted). The killed process exited
with -9; exactly three provider submissions remained after lease recovery and
another restart. Missing-key execution created no attempt; the synthetic redaction
canary was absent from responses, database and server output.

Earlier `c8-t2-*` logs without `resume` predate the layout move and are historical,
not evidence for this snapshot. The initial resumed native rebuild overlapped the
harness command; use the explicitly sequential final rebuild/pytest pair above.
Implementation is ready for supervisor verification under the handoff contract;
that is not acceptance or completion. The missing live configuration is an
environment blocker for the actual-provider criterion, independently of the pending
supervisor browser gate.
