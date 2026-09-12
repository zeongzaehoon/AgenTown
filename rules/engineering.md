# Engineering rules

- Keep a shared Core with ports and adapters. Domain logic must not depend on an LLM vendor, UI, or process runner.
- Python owns the user-facing interface. Rust owns state changes, persistence, scheduling, CPU work, and concurrency.
- The development harness is infrastructure for building the product, not the full product Core.
- Before a Task, consult relevant skills and research authoritative sources. Record URLs, findings, and the decision; report unavailable research honestly.
- Add a skill or refine an existing one only for a demonstrated reusable knowledge gap. Do not install unreviewed executable skills from the web.
- Validate behavior at failure boundaries, especially interruption, retry, state transitions, and verification. Do not weaken tests to get a pass.
- Keep AGENTS.md short. Put detailed conventions here or in focused skills.
- Product UI must stay simple and approachable; keep internal implementation concepts out of user flows unless useful to the user.
- Use local Git history/checkpoints to make changes reviewable. Never discard unrelated work or push automatically.
