# LLM Engine

Read `PLAN.md` for product intent and `rules/engineering.md` for implementation rules.
For autonomous work, also read `rules/autonomy.md` and use `.agents/skills/task-cycle/SKILL.md`.
Use `.agents/skills/engine-architecture/SKILL.md` for Rust/Python boundaries and Task data design.
Role responsibilities are in `harness/roles.md`; runtime configuration is `harness/config.json`.

Keep work inside the current Task and preserve existing user changes.
Run `python3 harness/cli.py check` before declaring implementation complete.
Record evidence and actionable lessons. Never mark a failed or unverified Task done.
