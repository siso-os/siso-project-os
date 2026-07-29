# {{PROJECT_NAME}} — Agent Router

<!-- siso-project-os:v1 -->

This repository uses SISO Project OS for project-local agent state.

## Start here

1. Read this `AGENTS.md` — binding repository rules.
2. Read `PROJECT-OS.html` — where each kind of project truth lives.
3. Run `project-os onboard --json` — project health, human gates, and unblocked next work.
4. Open the selected canonical `.agents/tasks/.../task.json` before acting.
5. Create or use its linked run packet for a substantial attempt.
6. Verify, run `project-os check`, and hand off from repository evidence.

Humans can open `.project-os/generated/onboarding.html` for the same delivery map. The knowledge
spine rules live at `docs/project-os/ONBOARDING.html`; task-linked UI work lives at `.uihub/README.html`.

## Runtime and capability boundary

Project OS owns project records and packets; it does not spawn or supervise agents. Use the shared
Agent Base routes for live execution: `subagents` for lane selection, `conduct` for an in-session
fleet, `orchestrate` plus `herdr` for persistent panes, and `agent-comms` for messaging. Discover
project-local skills, roles, commands, proven recipes, and verification adapters through the
declared capability inventory. Do not copy shared runtime skills into this repository.

## Binding rules

- A plan is not committed work until it has one canonical task ID.
- Dashboards, indexes, and HTML views are projections, never alternate writers.
- Every run packet names its parent task, write fence, return shape, verification, and stop condition.
- Checks are read-only. Repairs and archive/fold operations are explicit.
- Durable lessons go to `.agents/memory/`; attempt-specific material stays with its run or task evidence.
- UI campaigns reference canonical task IDs and cannot own an independent backlog.
- Preserve unrelated dirty work and verify completion from repository evidence, not an agent claim.
- Product-specific commands and policies remain project-local adapters; their receipts link back to
  canonical tasks/runs and never become hidden writers.

Run `project-os check .` before handoff. If the command is not installed locally, use
`npx github:sisodias/siso-project-os check .`.
