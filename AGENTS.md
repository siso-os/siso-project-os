# SISO Project OS — Agent Rules

This repository packages reusable per-project operating infrastructure distilled from a
protected source project. The source is evidence, never a write target; see `docs/provenance.html`.

## Start here

1. `SPEC.md` — scope, contracts, and acceptance criteria.
2. `README.md` — user-facing adoption path.
3. `docs/work-lifecycle.md`, `docs/knowledge-spine.html`, and `docs/ui-loop.html` — the three operating packs.

## Invariants

- One canonical task registry: `.agents/tasks/**/task.json`. Dashboards and HTML are projections.
- Generated files never become alternate writers.
- Checks are read-only. Repairs require an explicit command.
- New task IDs are allocated under an exclusive lock and validated across every lifecycle folder.
- Every sprint, run, and UI campaign references canonical task IDs.
- Durable knowledge is one fact per memory file. Run packets are ephemeral execution contracts.
- Only runtime-required `AGENTS.md`/`CLAUDE.md` shims remain Markdown. Authored operating surfaces are deterministic HTML; canonical machine records are JSON/JSONL.
- The package is generic: never copy source-product names, credentials, customer facts, or bulk history.
- Preserve unrelated work. Multiple agents may edit different owned directories concurrently.

## Code-search and editing

- Use Serena first for code navigation when available.
- Use `apply_patch` for hand-authored file edits.
- Keep the runtime dependency-free on Node.js 20+.

## Required verification

Run the closest checks after changes:

```bash
npm test
npm run check
npm pack --dry-run
```

Do not claim the package is reusable until a clean temporary-project adoption smoke passes.
