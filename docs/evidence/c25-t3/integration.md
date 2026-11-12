# C25-T3 integration invocation

Read the existing member report at `docs/evidence/c25-t3/implementation.md`
and inspected the merged Windows configuration, launcher, workflow, build/runtime
mapping and service launch arguments. Reused its recorded primary-source research;
no new research or agents were invoked.

Fixed Windows smoke-check child discovery: match the packaged
`service/python/python.exe` executable and the isolated `llm_engine.desktop`
module/database/port arguments, rather than requiring exactly one shell child.
Unrelated WebView2/browser children no longer prevent service discovery. Missing,
inaccessible or ambiguous matches remain unselected.

Actually executed in this invocation:

- `python3 desktop/tests/test_windows_delivery.py`: 3 passed, 1 skipped
  (the real Windows `cmd.exe` launcher argument test). Portable regression
  coverage includes a browser sibling, unrelated Python processes, case-insensitive
  Windows executable paths, missing arguments and ambiguous matching services.

These portable checks do not establish Windows execution. Consolidated supervisor
checks and browser validation are pending. Windows installer build/install,
native launcher arguments, Job Object cleanup, graphical launch/shutdown/restart,
WebView2 provisioning, uninstall/reinstall preservation and upgrade recovery
remain unexecuted here; see `docs/desktop.md` for the host checklist. Live LLM
calls were skipped under the user policy. No workflow was dispatched and no
installer was published or signed.
