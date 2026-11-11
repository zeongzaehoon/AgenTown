# C8-T1 resumed implementation handoff

Only the assigned implementation stage ran; no subagents ran. Inspected the existing
React/TypeScript migration, API, browser assertions, behavior tests and launch docs.
Preserved all existing partial/user implementation. Corrected stale launch/evidence
guidance in docs/local-screen.md: the supplied Node 24 toolchain is now on PATH,
and no verification artifact was supplied for this stage. Historical C8-T1 evidence
is retained as historical evidence, not substituted for supervisor verification.
No PLAN.md, .harness source/state/config, service settings or installed runtime edits.

## Research and decisions

- https://react.dev/reference/react/useEffect : cleanup runs on unmount and StrictMode
  exercises an extra setup/cleanup cycle. Retain effect cleanup and generation guards;
  mutations remain in explicit event handlers.
- https://vite.dev/guide/ : production frontend build workflow. Retain the existing
  Vite output served by Python, with explicit TypeScript checking in both scripts.
- https://www.w3.org/WAI/WCAG22/quickref/ : keyboard operation, visible focus, labels
  and status announcements support retaining the existing native controls and CSS.
- Official package metadata rechecked using npm view with the authorized npm cache:
  https://registry.npmjs.org/vite/8.3.0 requires Node ^20.19.0 || >=22.12.0;
  https://registry.npmjs.org/jsdom/30.0.1 requires ^22.22.2 || ^24.15.0 || >=26.0.0;
  https://registry.npmjs.org/@testing-library%2freact/16.3.3 supports React and React DOM
  ^18.0.0 || ^19.0.0, with Testing Library DOM ^10.0.0. Retain locked versions:
  supplied Node v24.21.0 satisfies these constraints. No dependency upgrade needed.

## Commands and actual results

Working directory: /Users/hoon/Portfolio/llm-engine; macOS arm64.
Node resolves through .harness/toolchains/node/node_modules/.bin/node, v24.21.0.
Each output is retained under docs/evidence/c8-t1-handoff-<suffix>.txt.

1. npm ci --cache .harness/cache/npm --no-audit --no-fund: exit 0 (npm-ci).
2. npm test: exit 0; TypeScript and 6 behavior tests pass (npm-test).
3. npm run build: exit 0; TypeScript and production asset build pass (build).
4. cargo test --workspace --locked: exit 0; 40 tests pass (cargo).
5. UV_CACHE_DIR=.harness/cache/uv uv run --locked maturin develop --locked:
   exit 0 (native), completed before starting Python checks.
6. UV_CACHE_DIR=.harness/cache/uv uv run --locked python -m pytest:
   exit 0; 55 passed, 1 opt-in browser skipped; upstream AnyIO deprecation warning (pytest).
7. UV_CACHE_DIR=.harness/cache/uv npm_config_cache=.harness/cache/npm python3 .harness/cli.py check:
   exit 0; all configured checks passed (harness).
8. git diff --check: exit 0.

## Pending supervisor acceptance

Request ready_for_verification, not Task completion. Mandatory supervisor screenshots,
interactions, trace and persisted state are pending for this snapshot. No Chromium
launch was attempted. DOM tests are deterministic and do not prove browser or live
provider execution. No new installed-wheel, Windows, screen-reader or live-provider
validation is claimed. Section 8 remains incomplete; C8-T2 retains its separate scope.
Source and generated production asset hashes are in c8-t1-handoff-source-sha256.txt.
