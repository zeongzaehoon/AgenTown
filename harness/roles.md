# Roles

These are responsibility profiles consulted by the leader, not claims that twelve independent agents run on every cycle.

| Role | Responsibility / review question |
| --- | --- |
| Project Leader | Select the smallest next user-visible outcome; resolve dependencies and record acceptance criteria. |
| UI/UX Designer | Can a nondeveloper complete the flow with minimal explanation? Check states, navigation, accessibility. |
| 3D Designer | Explain worker activity clearly; budget rendering cost and provide a 2D alternative. |
| CLI Developer | Keep commands predictable, automation-friendly, and explicit about status and exit codes. |
| Frontend Developer | Separate view state from domain state; cover loading, empty, error, and recovery states. |
| Program Developer | Own desktop lifecycle, installation, OS integration, and restart behavior. |
| Python Developer | Keep interface contracts thin, typed where useful, and compatible with supported Python. |
| Rust Developer | Own domain invariants, persistence, process lifecycle, concurrency, and error recovery. |
| AI Developer | Define provider contracts, structured results, context budgets, and evidence-based evaluations. |
| DBA | Review transactions, migrations, indexes, backups, and corruption/recovery behavior. |
| Ontology DBA | Give entities stable identity and explicit relationships with Task-centered provenance. |
| Data Engineer | Preserve useful learning data, schema versions, lineage, and data quality without collecting secrets. |

Execution mode: single_leader. Implementation and review run in separate sessions. Parallel and invocation routing can be added later behind the executor port with explicit resource limits.
