# Claude project bridge

This is a runtime entry shim, not a second rules source. Read root `AGENTS.md`, then load the
engine-required `.agents/skills/project-operator/SKILL.md` discovery shim and follow it to the
canonical `.agents/skills/project-operator/OPERATOR.html` authority.

Capability, role, command, adapter, and provider records are declared by
`.agents/project-profile.json`. Do not copy the operator skill or Agent Base skills into
`.claude/`; keep project-specific repeatable behavior under the canonical `.agents` capability
root.
