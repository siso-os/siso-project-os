import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FULL_PROFILE_FILES,
  applyFullProfileAdoption,
  planFullProfileAdoption,
  scaffoldProjectAgent,
  scaffoldProjectCommand,
  scaffoldProjectSkill,
} from '../src/adoption.mjs'
import {
  CAPABILITY_OWNERSHIP,
  discoverProjectCapabilities,
  doctorProjectCapabilities,
} from '../src/capabilities.mjs'
import { walkFiles } from '../src/shared.mjs'

const AGENT_BASE_CAPABILITIES = ['subagents', 'conduct', 'orchestrate', 'herdr', 'agent-comms']

async function fixture(t, prefix = 'project-os-capabilities-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function write(root, path, content) {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

async function treeDigest(root) {
  const hash = createHash('sha256')
  for (const path of await walkFiles(root)) {
    hash.update(path)
    hash.update(await readFile(join(root, path)))
  }
  return hash.digest('hex')
}

test('empty greenfield repo installs one canonical full-profile operator and passes with declared providers', async (t) => {
  const root = await fixture(t)
  const empty = await discoverProjectCapabilities(root)
  assert.deepEqual(empty.counts, { skill: 0, agent: 0, command: 0, recipe: 0, adapter: 0 })
  assert.deepEqual(empty.errors, [])

  const plan = await planFullProfileAdoption(root)
  assert.equal(plan.mode, 'greenfield')
  assert.equal(plan.non_destructive, true)
  assert.equal(plan.can_apply, true)
  assert.ok(plan.migration.some((entry) => entry.action === 'merge-root-route'))

  const applied = await applyFullProfileAdoption(root)
  assert.equal(applied.ok, true)
  assert.ok(applied.created.includes('.agents/skills/project-operator/SKILL.md'))
  assert.deepEqual(FULL_PROFILE_FILES.filter((path) => path.endsWith('.md')).sort(), [
    '.agents/skills/project-operator/SKILL.md',
    'CLAUDE.md',
  ])
  assert.match(await readFile(join(root, '.agents', 'skills', 'project-operator', 'SKILL.md'), 'utf8'), /name: project-operator/)
  assert.match(await readFile(join(root, '.agents', 'skills', 'project-operator', 'SKILL.md'), 'utf8'), /OPERATOR\.html/)
  assert.match(await readFile(join(root, '.agents', 'skills', 'project-operator', 'OPERATOR.html'), 'utf8'), /data-contract="project-os-operator\.v1"/)
  assert.match(await readFile(join(root, '.agents', 'skills', 'project-operator', 'OPERATOR.html'), 'utf8'), /"discovery_shim":"\.agents\/skills\/project-operator\/SKILL\.md"/)
  assert.match(await readFile(join(root, 'CLAUDE.md'), 'utf8'), /runtime entry shim, not a second rules source/)
  await write(root, 'AGENTS.md', '# Agent runtime shim\n\nLoad `.agents/skills/project-operator/SKILL.md`.\n')
  assert.equal((await walkFiles(root)).some((path) => /^\.(?:claude|codex)\/skills\/project-operator\/SKILL\.md$/.test(path)), false)
  assert.ok(await readFile(join(root, 'docs', 'project-os', 'CAPABILITIES.html'), 'utf8'))

  const discovered = await discoverProjectCapabilities(root)
  assert.deepEqual(discovered.counts, { skill: 1, agent: 1, command: 2, recipe: 0, adapter: 1 })
  assert.deepEqual(discovered.conflicts, [])
  const manifest = JSON.parse(await readFile(join(root, '.agents', 'capabilities', 'project-os.json'), 'utf8'))
  assert.deepEqual([...new Set(manifest.capabilities.map((entry) => entry.ownership))].sort(), [...CAPABILITY_OWNERSHIP].sort())

  const doctor = await doctorProjectCapabilities(root, {
    providerCapabilities: { 'siso-agent-base': AGENT_BASE_CAPABILITIES },
    env: {},
  })
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks.filter((entry) => entry.status === 'fail'), null, 2))
  assert.equal(doctor.profile_id, 'full')
  assert.equal(doctor.canonical_operator, '.agents/skills/project-operator/SKILL.md')
  assert.equal(doctor.operator_authority, '.agents/skills/project-operator/OPERATOR.html')
  assert.ok(doctor.checks.some((entry) => entry.id === 'operator.authority-route' && entry.status === 'pass'))
  assert.ok(doctor.checks.some((entry) => entry.id === 'capability.agent-base.subagents' && entry.status === 'pass'))
  assert.ok(doctor.checks.some((entry) => entry.id === 'capability.runtime.node' && entry.status === 'pass'))
})

test('discovery deterministically inventories mixed Claude, Codex, neutral, recipe, and adapter routes', async (t) => {
  const root = await fixture(t)
  await write(root, '.agents/skills/local-release/SKILL.md', '---\nname: local-release\ndescription: neutral\n---\n# Local release\n')
  await write(root, '.claude/skills/release/SKILL.md', '---\nname: release\ndescription: Claude release\n---\n# Release\n')
  await write(root, '.codex/skills/release/SKILL.md', '---\nname: release\ndescription: Codex release\n---\n# Release\n')
  await write(root, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews changes\n---\n# Reviewer\n')
  await write(root, '.codex/agents/builder.json', '{"role_id":"builder","title":"Builder","description":"Builds"}\n')
  await write(root, '.agents/commands/status.json', '{"command_id":"status","title":"Status","description":"Reads status"}\n')
  await write(root, '.claude/commands/review.md', '---\nname: review\ndescription: Review command\n---\n# Review\n')
  await write(root, '.codex/prompts/ship.md', '---\nname: ship\ndescription: Ship prompt\n---\n# Ship\n')
  await write(root, 'docs/proven-recipes/release.md', '# Release recipe\n\nProven steps.\n')
  await write(root, '.agents/adapters/status.json', '{"adapter_id":"status-receipt","description":"Status receipt"}\n')

  const first = await discoverProjectCapabilities(root)
  const second = await discoverProjectCapabilities(root)
  assert.deepEqual(second, first)
  assert.deepEqual(first.counts, { skill: 3, agent: 2, command: 3, recipe: 1, adapter: 1 })
  assert.deepEqual(first.conflicts, [{
    identity: 'skill:release',
    paths: ['.claude/skills/release/SKILL.md', '.codex/skills/release/SKILL.md'],
    engines: ['claude', 'codex'],
    message: 'skill:release has multiple project-local definitions',
  }])
  assert.equal(JSON.stringify(first).includes(root), false)
  assert.ok(first.items.some((entry) => entry.kind === 'recipe' && entry.id === 'release'))
  assert.ok(first.routes.some((entry) => entry.root === '.codex/commands' && entry.count === 0))
})

test('full-profile doctor fails loudly and actionably when required Agent Base routes are missing', async (t) => {
  const root = await fixture(t)
  await applyFullProfileAdoption(root)
  await write(root, 'AGENTS.md', '# Agent runtime shim\n\nLoad `.agents/skills/project-operator/SKILL.md`.\n')
  const doctor = await doctorProjectCapabilities(root, { env: {} })
  assert.equal(doctor.ok, false)
  const failures = doctor.checks.filter((entry) => entry.status === 'fail')
  assert.deepEqual(
    failures.map((entry) => entry.id),
    AGENT_BASE_CAPABILITIES.map((id) => `capability.agent-base.${id}`).sort(),
  )
  for (const failure of failures) {
    assert.match(failure.message, /unresolved/)
    assert.match(failure.remediation, /providerRoots\.siso-agent-base|SISO_AGENT_BASE_ROOT/)
    assert.doesNotMatch(failure.remediation, /Users\/|credentials?|token|secret value/i)
  }
})

test('doctor rejects a broken operator shim and a duplicate engine-local operator definition', async (t) => {
  const root = await fixture(t, 'project-os-capability-shim-')
  await applyFullProfileAdoption(root)
  await write(root, 'AGENTS.md', '# Agent runtime shim\n\nLoad `.agents/skills/project-operator/SKILL.md`.\n')
  const shimPath = '.agents/skills/project-operator/SKILL.md'
  const validShim = await readFile(join(root, shimPath), 'utf8')
  await write(root, shimPath, '---\nname: project-operator\ndescription: broken\n---\n# Broken shim\n')
  const broken = await doctorProjectCapabilities(root, {
    providerCapabilities: { 'siso-agent-base': AGENT_BASE_CAPABILITIES },
    env: {},
  })
  assert.equal(broken.ok, false)
  assert.ok(broken.checks.some((entry) => entry.id === 'operator.authority-route' && entry.status === 'fail'))

  await write(root, shimPath, validShim)
  await write(root, '.claude/skills/project-operator/SKILL.md', '---\nname: project-operator\ndescription: duplicate shim\n---\n# Duplicate\n')
  const duplicate = await doctorProjectCapabilities(root, {
    providerCapabilities: { 'siso-agent-base': AGENT_BASE_CAPABILITIES },
    env: {},
  })
  assert.equal(duplicate.ok, false)
  assert.ok(duplicate.checks.some((entry) => entry.id === 'discovery.conflict.skill:project-operator' && entry.status === 'fail'))
})

test('existing-repo plan reports collisions and apply leaves every existing byte untouched', async (t) => {
  const root = await fixture(t, 'project-os-capability-collision-')
  await write(root, '.agents/project-profile.json', '{"custom":true}\n')
  await write(root, '.claude/skills/existing/SKILL.md', '---\nname: existing\ndescription: existing project skill\n---\n')
  const before = await treeDigest(root)
  const beforeFiles = await walkFiles(root)

  const plan = await planFullProfileAdoption(root)
  assert.equal(plan.mode, 'existing')
  assert.equal(plan.can_apply, false)
  assert.ok(plan.collisions.some((entry) => entry.code === 'target_collision' && entry.path === '.agents/project-profile.json'))
  assert.ok(plan.existing_capabilities.items.some((entry) => entry.id === 'existing'))
  assert.ok(plan.migration.some((entry) => entry.action === 'review-collisions' && entry.status === 'required'))

  await assert.rejects(applyFullProfileAdoption(root), /would overwrite existing files/)
  assert.equal(await treeDigest(root), before)
  assert.deepEqual(await walkFiles(root), beforeFiles)
})

test('existing project-local recipe authority is untouched while missing profile files are added', async (t) => {
  const root = await fixture(t, 'project-os-capability-existing-')
  const authored = '# Team release recipes\n\nProject-owned content.\n'
  await write(root, 'docs/proven-recipes/INDEX.md', authored)
  const plan = await planFullProfileAdoption(root)
  assert.equal(plan.operations.some((entry) => entry.path === 'docs/proven-recipes/INDEX.md'), false)
  assert.ok(plan.existing_capabilities.routes.some((entry) => entry.root === 'docs/proven-recipes'))

  const applied = await applyFullProfileAdoption(root)
  assert.equal(applied.ok, true)
  assert.equal(await readFile(join(root, 'docs', 'proven-recipes', 'INDEX.md'), 'utf8'), authored)
  assert.ok(await readFile(join(root, '.agents', 'project-profile.json'), 'utf8'))
})

test('full-profile adoption and project-local scaffolds are idempotent and collision-safe', async (t) => {
  const root = await fixture(t, 'project-os-capability-idempotent-')
  const first = await applyFullProfileAdoption(root)
  const afterFirst = await treeDigest(root)
  const second = await applyFullProfileAdoption(root)
  assert.ok(first.created.length > 0)
  assert.deepEqual(second.created, [])
  assert.equal(second.plan.idempotent, true)
  assert.equal(await treeDigest(root), afterFirst)

  const skillSpec = { id: 'release-operator', title: 'Release operator', description: 'Runs the project-specific release gate.' }
  const agentSpec = { id: 'release-reviewer', title: 'Release reviewer', description: 'Reviews project-specific release evidence.' }
  const commandSpec = { id: 'release-status', title: 'Release status', description: 'Reads release status.', program: 'node', arguments: ['scripts/release-status.mjs'], output: 'json' }
  assert.equal((await scaffoldProjectSkill(root, skillSpec)).action, 'create')
  assert.equal((await scaffoldProjectAgent(root, agentSpec)).action, 'create')
  assert.equal((await scaffoldProjectCommand(root, commandSpec)).action, 'create')
  assert.equal((await scaffoldProjectSkill(root, skillSpec)).action, 'retain')
  assert.equal((await scaffoldProjectAgent(root, agentSpec)).action, 'retain')
  assert.equal((await scaffoldProjectCommand(root, commandSpec)).action, 'retain')

  const skillBefore = await readFile(join(root, '.agents', 'skills', 'release-operator', 'SKILL.md'), 'utf8')
  assert.match(skillBefore, /CAPABILITY\.html/)
  assert.match(await readFile(join(root, '.agents', 'skills', 'release-operator', 'CAPABILITY.html'), 'utf8'), /data-contract="project-os-skill-capability\.v1"/)
  await assert.rejects(
    scaffoldProjectSkill(root, { ...skillSpec, description: 'A divergent second body.' }),
    /would overwrite existing capability/,
  )
  assert.equal(await readFile(join(root, '.agents', 'skills', 'release-operator', 'SKILL.md'), 'utf8'), skillBefore)
  assert.equal((await walkFiles(root)).some((path) => /^\.(?:claude|codex)\/skills\/release-operator/.test(path)), false)

  const discovered = await discoverProjectCapabilities(root)
  assert.ok(discovered.items.some((entry) => entry.kind === 'skill' && entry.id === 'release-operator'))
  assert.ok(discovered.items.some((entry) => entry.kind === 'agent' && entry.id === 'release-reviewer'))
  assert.ok(discovered.items.some((entry) => entry.kind === 'command' && entry.id === 'release-status'))
})

test('discovery stops at configured bounds and reports the truncation', async (t) => {
  const root = await fixture(t, 'project-os-capability-bounds-')
  for (const id of ['alpha', 'bravo', 'charlie']) {
    await write(root, `.agents/skills/${id}/SKILL.md`, `---\nname: ${id}\ndescription: bounded fixture\n---\n`)
  }
  const result = await discoverProjectCapabilities(root, { maxFilesPerRoot: 1 })
  assert.equal(result.counts.skill, 1)
  assert.ok(result.errors.some((entry) => entry.code === 'discovery_file_limit_reached' && entry.path === '.agents/skills'))
  assert.ok(result.routes.some((entry) => entry.root === '.agents/skills' && entry.truncated === true))
})
