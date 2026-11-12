# C25-T2 implementation invocation

The supervisor executed the delivery flow on macOS 14.5 arm64. It built and
verified `desktop/target/release/bundle/dmg/AgenTown-unsigned-arm64.dmg` with
SHA-256 `69c632ebd5afc5e415b3c81d0508ba378a5a6b3549caabe84ca340cfe3ab3db1`.

Changes: build.py calls package_dmg.py after macOS app assembly; package_dmg.py
creates and verifies a compressed image and reports artifact identity.
check_dmg.py mounts that artifact and runs check_app.py against its app.
check_app.py retains the prior window/DOM checks and adds saved work, app-only
removal/reinstallation and opt-in delivery service interruption/recovery checks.
No service API, database path or native lifecycle code was changed.

Executed: `python3.13 desktop/tests/test_build.py` — 4 tests passed.
Executed: AST parsing of build.py, package_dmg.py, check_dmg.py and check_app.py —
all parsed successfully. Inspected Apple's local `/usr/bin/hdiutil create -help`
for packaging flags. Reused existing Tauri resource/configuration research.

Executed `desktop/check_dmg.py` against that image: `hdiutil` mounted it read-only
at an isolated `/private/tmp` volume, `ditto` installed the bundled app outside
the checkout, and the app launched with an empty PATH and isolated native home.
The check retained employee `f02d0038-118a-4ada-9a40-00f68d188e94` and saved work
`033d7046-c3b2-4806-b151-6cc68b8a5e04` across restart, app-only removal and
reinstallation, and owned-service interruption followed by shell relaunch. It
then confirmed clean owned-service shutdown and detached `disk4`. The IDs are
per-run evidence, not fixtures.

`python3.13 desktop/tests/test_build.py` passed 4 tests. The preceding full
supervisor run also passed 7 desktop lifecycle tests, 130 frontend tests, 165
Python tests with one browser-only skip, and the full browser profile; the next
supervisor rerun includes `desktop/check_dmg.py` as an explicit product check so
the mount/install evidence is retained in the canonical verification log. Real
LLM calls are skipped, not passed. Signing, notarization and publication were not
performed, and no installed runtime or service settings were changed.
