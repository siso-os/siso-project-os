# {{PROJECT_NAME}}

The project front door. Keep this page short enough for a new person or agent to
understand the project, find its source, and start useful work.

## Purpose and current work

Describe what the project does, who it serves, why it matters, and its current
outcome. Project identity and run configuration live in
[project.json](../.project-os/project.json); task state stays in the canonical
[task registry](tasks/index.html).

## Owner and recovery

Name the current owner and link its existing handoff from [HANDOFF.md](HANDOFF.md).
Material changes are indexed in [owners.log](owners.log). A log entry records an
owner's report; completion still needs the linked evidence.

## Start here

Read [AGENTS.md](../AGENTS.md), [PROJECT-OS.html](../PROJECT-OS.html), and
[FILE-TREE.html](../FILE-TREE.html). Record the project's actual setup, run and
test commands here after checking them. The kit's verification command is
`npx --yes github:sisodias/siso-project-os#v0.5.0 check . --json`.

## Links

Fill [repos.json](repos.json) with the canonical repository URL, parent URL,
Library Work ID, and independently owned satellite repositories. Use URLs and
stable IDs, never machine paths. The published page URL is in [page.url](page.url)
after publication has been verified. Empty values mean not yet recorded.

Source words and sessions belong to the project's declared data repositories;
do not copy private conversations, credentials or intake into a public page.
