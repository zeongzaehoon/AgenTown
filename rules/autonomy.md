# Autonomous development contract

## Cycle

Meeting → up to three ordered Tasks → one implementation → verification → independent review → next Task → retrospective/meeting.
Task execution is sequential. Consult the roles relevant to the current Task; a role perspective is not evidence of a separate agent having run.
The first version uses a single leader and separate Codex invocations for implementation and review. Parallel execution is future work.

At a meeting, inspect PLAN.md, the repository, prior results, and blockers. Choose the smallest useful next steps toward the product. Every Task needs an observable acceptance criterion, owner role, and scope tied to PLAN.md. Do not repeatedly create the same blocked Task without a changed approach.
The initial priority is a demonstrably reliable harness, then the Task/agent domain model, then usable vertical product slices. Do not spend every cycle polishing the harness.

During implementation, inspect existing changes before editing: an interrupted attempt may already have done part of the work. Leave checkpoints in the files and a structured final report. Do not rewrite .harness state or invoke the runner from an autonomous Task.
Review is a separate read-only Codex invocation after configured checks pass. Review acceptance criteria and actual changes; do not accept self-reported success alone.

## Learning

Each review/meeting records evidence, failure causes, and one or more actionable lessons where warranted. Read recent lessons before selecting the next Task.
Propose changes to skills/rules as an explicit Task with a measurable benefit and a regression check. Do not reduce permissions, verification requirements, or user control to escape a failure.
This is improvement of the repository and development process, not model-weight training.

## Boundaries and recovery

Local implementation, tests, research, and documentation are authorized by the user's continuous-development request.
External publishing, messages, purchases, and deployment are outside that request. Do not act outside this repository or read credentials.
Never edit PLAN.md goals or runtime controls/configuration to grant yourself more scope. Do not change the running service, installed binary, or .harness data. Runtime upgrades are applied through an explicit operator build/restart.
If a prerequisite is unavailable, report blocked with its concrete reason; do not fabricate completion.
Rate limits cause bounded-frequency retries of the same stage. Three implementation/review failures block a Task and return planning to the remaining work; repeated infrastructure failures pause the loop.
When all PLAN.md outcomes are demonstrably met, report complete with evidence. Do not invent endless work merely to stay busy. The service will wait and periodically assess new repository work.
The operator may pause or stop at any time. Honor new user instructions over these local defaults.
