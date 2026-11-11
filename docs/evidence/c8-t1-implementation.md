# C8-T1 implementation checkpoint

Only C8-T1 implementation was performed. No additional agents ran. Existing
uncommitted product code and user changes were preserved; PLAN.md, local agent
instructions, harness source/state/configuration, service settings and installed
runtime were not edited.

The partial screen is now typed React with typed API records and a Vite production
build. Existing Python endpoints, Anthropic I/O and Rust persistence/admission are
reused. Synchronous handler locks prevent duplicate clicks; effects only inspect
history, clean up polling, and reject superseded responses. React text rendering
retains safe full output. Stable controls/keyed history preserve focus and expanded
attempts. The existing CSS, accessible labels, announcements and responsive layout
are retained. Missing production assets now return build guidance. Maturin's asset
include covers the generated nested assets directory; installed-wheel acceptance
remains C8-T2.

Official research URLs, findings, version selection and checkout launch/walkthrough
are recorded in `docs/local-screen.md`. Exact dependencies are locked in the root
`package-lock.json`. Generated assets/dependencies are ignored.

## Commands and result files

Commands ran from `/Users/hoon/Portfolio/llm-engine` on macOS arm64. Each named
text file contains actual subprocess output. Frontend commands used
`PATH=/private/tmp/llm-engine-c8-node/node_modules/.bin:$PATH`; npm used
`--cache .harness/cache/npm`. The temporary build tool was obtained with
`npm --cache .harness/cache/npm install --prefix /private/tmp/llm-engine-c8-node --no-audit --no-fund node@24.21.0`.
Default Node was 18.20.8 and the Homebrew alternative 19.6.0. No installed runtime
was replaced. Initial npm metadata lookup hit the read-only home cache; selecting
the authorized dependency cache resolved it.

1. `npm install --package-lock-only --no-audit --no-fund`: exit 0; generated lock.
2. `npm ci --no-audit --no-fund`: exit 0; `c8-t1-npm-ci.txt` (99 packages).
3. `npm test`: exit 0; `c8-t1-npm-test.txt` (explicit TypeScript check and 6 DOM
   behavior tests). An initial TypeScript check identified the missing Vite CSS
   module declaration; `vite-env.d.ts` fixes it. Final tests cover full flow,
   duplicate clicks, safe output, failure/retry, focus, disconnection/draft retention,
   configuration/interruption, superseded snapshots, active polling/remount and
   uncertain saved-response delivery. DOM tests are not real-browser evidence.
4. `npm run build`: exit 0; `c8-t1-build.txt` (explicit TypeScript check, production
   HTML and hashed CSS/JS).
5. `cargo test --workspace --locked`: exit 0; `c8-t1-cargo.txt`.
6. `UV_CACHE_DIR=.harness/cache/uv uv run --locked maturin develop --locked`:
   exit 0; `c8-t1-native.txt`. Completed before Python checks were started.
7. `UV_CACHE_DIR=.harness/cache/uv uv run --locked python -m pytest`:
   exit 0; `c8-t1-pytest.txt` (55 passed, 1 opt-in browser skip, one upstream
   Starlette/AnyIO deprecation warning).
8. `PATH=/private/tmp/llm-engine-c8-node/node_modules/.bin:$PATH UV_CACHE_DIR=.harness/cache/uv npm_config_cache=.harness/cache/npm python3 .harness/cli.py check`:
   exit 0; `c8-t1-harness.txt` reports all configured checks passed.

`git diff --check` passed. The exact supervisor browser directory was still absent
after all ordinary checks finished.

`c8-t1-source-sha256.txt` hashes the frontend/Python/Rust/test implementation sources,
configuration, lockfiles, relevant docs and generated production assets.

## Outstanding acceptance

Mandatory migrated browser verification is pending in the supervisor. The supplied
exact artifact `.harness/runs/1789271391-755924000/checks.log` had no sibling
`browser/` directory when inspected; no other run's evidence was substituted.
`tests/test_web_browser.py` retains all prior full-flow assertions and additionally
checks the React root/module entry point and focus after saving. Supervisor must
run it with the matching build and retain screenshots, interactions, trace and
persisted state. A compatible Node 24 toolchain must be on the supervisor PATH for
frontend checks; service settings were not changed to arrange that.

No restricted-sandbox Chromium launch, live-provider call, installed-wheel
walkthrough, Windows execution or screen-reader validation was performed. A
historical expired fixture is not proof of killing an outstanding process. Live
and installed-workflow validation remain C8-T2; PLAN.md section 8 is incomplete.
