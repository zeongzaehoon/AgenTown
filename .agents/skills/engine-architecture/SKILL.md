---
name: engine-architecture
description: Design or change LLM Engine's Rust Core, Python interfaces, and Task-centered data relationships. Use for architecture, persistence, scheduler, or domain-model changes in this repository.
---

# Engine architecture

Read PLAN.md section 3 and rules/engineering.md. Keep domain transitions in Rust and I/O integrations behind ports. The Python CLI is an interface adapter; do not grow a second scheduler in it.

For a persistence change, specify entities, stable IDs, relationships, lifecycle, migration, and restart behavior before coding. Distinguish Task, Run, Meeting, Agent, Artifact, and Evidence rather than storing unrelated text under a single label. The current harness checkpoint is an initial development ledger, not a finished product ontology.

A Task may have several assignees; a Run is one attempt at one stage. Completion requires verification evidence. Retries retain Task identity and create a new Run. Any dependency design must handle missing dependencies and cycles.

For scheduler changes, test duplicate runners, restart during a stage, malformed provider output, quota cooldown, failed verification, and pause/stop. Provider failures cannot advance a Task to done.
Keep provider-specific events and SDKs in adapters. Do not introduce every planned SDK before a concrete product slice needs it.
