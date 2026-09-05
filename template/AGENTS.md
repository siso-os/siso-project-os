# {{PROJECT_NAME}} — Agent Router

<!-- siso-project-os:v1 -->

This repository uses SISO Project OS for project-local agent state.

Load `.agents/skills/project-operator/SKILL.md` as the runtime entrypoint; it routes to the
canonical HTML operating authority without duplicating it here.

## Start here

1. Read this `AGENTS.md` — binding repository rules.
2. Read `PROJECT-OS.html` — where each kind of project truth lives.
3. Read the pinned launcher in `.project-os/project.json`, then use it to execute the logical
   `project-os onboard --json` command with this repository as the root — project health, human
   gates, and unblocked next work.
4. Open the selected canonical `.agents/tasks/.../task.json` before acting.
5. Create or use its linked run packet for a substantial attempt.
6. Verify, run the pinned launcher's `check . --json` arguments, and hand off from repository evidence.

Humans can open `.project-os/generated/onboarding.html` for the same delivery map. The knowledge
spine rules live at `docs/project-os/INDEX.html`; the durable onboarding contract is
`docs/project-os/ONBOARDING.html`; task-linked UI work lives at `.uihub/README.html`.

## Runtime and capability boundary

The project front door is `.agents/PAGE.md`; `.agents/HANDOFF.md` routes to the
current owner's resumable state. `.agents/repos.json` holds repository links,
`owners.log` indexes material changes, and `page.url` records verified publication.
These short Markdown entry files are the explicit project-spine exception to
the kit's HTML-first authored-document convention.

Project OS owns project records and packets; it does not replace the agent CLI that is reading this
file. Codex CLI operates through this `AGENTS.md`; Claude Code operates through `CLAUDE.md`. Either
runtime can execute the complete single-agent lifecycle directly. Optional orchestration providers
may add spawning, model routing, persistent panes, messaging, or telemetry, but their absence never
blocks core Project OS operation. Discover project-local skills, roles, commands, proven recipes,
verification adapters, and optional providers through the declared capability inventory.

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

Run the pinned launcher before handoff. For this installed version:
`npx --yes github:sisodias/siso-project-os#v0.5.0 check . --json`.
