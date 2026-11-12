# C26-T3 implementation handoff

One Frontend Developer invocation; no sub-agents. Changed the Connections React
surface/tests, Python presentation/API/tests and local/desktop documentation.
Existing template generation callers retain four static platform templates;
the API explicitly supplies its selected database to obtain five runtime choices.

Local check: direct Python import and assertions passed for five runtime choices,
JSON/TOML parsing, exact spaced database arguments and unchanged template API.
The first smoke assertion exposed a template-loop variable shadowing the selected
database; fixed it and reran the smoke check successfully.

`python3 -m pytest python/tests/test_connections.py -q` could not run: the available
Python has no pytest. No frontend node_modules or tsc executable is available.
No dependencies installed. Focused Python/API and TypeScript/UI tests are added
but pending supervisor execution. Browser/visual checks and packaged desktop
launch are pending supervisor validation; no actual client session is claimed.
Live provider tests skipped per user policy. No settings writes, server launches,
remote exposure or provider calls occurred. Desktop reproduction instructions
are in docs/desktop.md, section “Connections from an installed desktop (C26-T3)”.
