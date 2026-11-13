# Readable product architecture

AgenTown uses DDD vocabulary and Hexagonal dependency direction so a developer
can follow data from an entry point to a business decision and back without
guessing which layer owns it. This is a migration contract for feature work,
not permission for a repository-wide file shuffle.

## One readable path

Every product action should be traceable in this order:

```text
React event / CLI command / HTTP or MCP request
  -> typed inbound adapter
  -> named application use case
  -> Rust domain command or query through a port
  -> SQLite / provider / operating-system outbound adapter
  -> explicit result or domain error
  -> boundary DTO and user-visible state
```

The domain never imports FastAPI, MCP, provider SDKs, SQLite, Tauri or React.
Adapters know the domain-facing port; the domain does not know its adapters.
Mapping occurs once at a boundary rather than leaking transport dictionaries
through the application.

## Python: interfaces and orchestration

Python owns inbound product interfaces, provider SDK integration and narrow
application orchestration. Rust remains the source of truth for product state,
invariants, concurrency and persistence.

As a feature is changed, move it toward this package shape:

```text
llm_engine/
  application/              # named use cases and their input/output types
  ports/                    # Protocols required by those use cases
  adapters/
    inbound/                # web, CLI, MCP and desktop request translation
    outbound/               # native Rust binding and provider SDK adapters
  features/<feature>/       # optional vertical slice while migration is local
  bootstrap.py              # explicit composition root only
```

Rules:

- A route or MCP tool validates transport input, calls one named use case and
  maps its result. It does not contain persistence or provider policy.
- A use case receives ports in its constructor. It never creates a concrete
  repository, SDK client or database session internally.
- Ports describe business-needed behavior rather than mirroring an entire SDK.
- Provider-specific exceptions and payloads stay in outbound adapters and map
  to stable application errors.
- Configuration and construction live in one composition root. Avoid lazy
  imports as a routine circular-dependency fix; remove the cycle instead.
- Prefer typed dataclasses, enums and Protocols over unstructured dictionaries.
  Do not reproduce Rust domain invariants in Python.

## Rust: domain language first

The Rust workspaces retain their Hexagonal roles:

- `engine-core` owns entities, value objects, domain errors, transitions and
  ports. A feature module should read in the order types → commands/queries →
  invariants → tests.
- `engine-sqlite` implements persistence ports and atomic storage behavior. SQL
  row mapping and migrations do not leak into Core.
- `engine-python` maps typed Python requests/results to Core ports. It is an
  adapter, not a second domain or scheduler.
- the Tauri workspace owns desktop process and window lifecycle only.

Use newtypes for identities, enums for closed states and small functions named
after the business decision. Constructors establish valid objects. Rejected
commands leave state unchanged. Prefer a focused feature module over a generic
`manager`, `utils` or `common` dumping ground. Comments explain why an invariant
exists; types and names explain what the code does.

## React: feature flow instead of a giant screen

React presents the same Task-centered state; it does not invent another domain.
As a screen is changed, colocate its component, API contract, pure selectors and
interaction tests under a feature boundary such as `features/company`,
`features/work`, `features/connections` or `features/configuration`.

Rules:

- Parse and type an API response once. Components receive typed view models.
- Put workload/status derivation in pure named selectors with table-driven
  tests. Rendering code should describe layout and interaction, not rediscover
  business state in nested expressions.
- Keep server state, unsaved form state and transient UI state visibly separate.
- A user event calls one named action; polling and navigation are read-only
  unless the product contract explicitly says otherwise.
- Split components at a coherent user responsibility, not at arbitrary line
  counts. Avoid prop chains that hide where a mutation originates.
- Preserve accessible names, keyboard flow, focus recovery, non-color status
  and reduced motion as part of the component contract.

## Naming and review checklist

Use product language: Agent, AgentTeam, TF, Task, Run, Skill, Hook, Loop,
Connection, Attempt and Evidence. A `Service` or `Manager` name is acceptable
only when its single responsibility is obvious; prefer verbs such as
`StartLoop`, `InspectWorkspace` or `SaveTask` for use cases.

For each feature change, a reviewer should be able to answer:

1. Where does input enter and where is it validated?
2. Which named use case coordinates the action?
3. Which Rust rule authorizes or rejects the state change?
4. Which port is used and which adapter performs I/O?
5. Where is the boundary result mapped for the user?
6. Which tests prove the domain rule, adapter contract and complete user flow?

If these answers require searching unrelated modules or following generic
dictionaries, improve the boundary within the current feature scope.

## Reference review

The user-provided local references were inspected read-only on 2026-11-13.
`knitlog-install` demonstrates an approachable API → service → repository →
model path and centralized dependency providers. AgenTown adopts the visible
flow but not concrete repository construction inside services, direct database
session ownership by use cases, or lazy imports used to tolerate cycles.
`groxy` demonstrates explicit connection and response types. AgenTown adopts
typed boundary objects but not a single large module combining configuration,
connection pools, transport and response behavior.

Migration is incremental: a user-visible vertical slice moves to the target
boundary when it is next changed, with compatibility tests at the old public
entry point. Large mechanical moves without a product outcome are deferred.

Selected ordinary-text execution uses `ExecuteSelectedWork` with immutable typed
request/result values and `SelectedWorkExecutionPort`, separate from
`InspectSelectedWork` and its read-only port. The web composition root supplies
`LocalMcpExecution`, which invokes the installed stdio MCP execution tool against
the selected database using server configuration. Rust remains the sole admission
and persistence authority. Transport uncertainty produces no replay. See
[text execution](text-execution.md#explicit-local-product-execution-api) for the API.
