import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyProjectAdoption } from '../src/adoption.mjs'
import { applyUpgrade, planUpgrade, rollbackUpgrade } from '../src/upgrade.mjs'

const OLD_ROLE = `{
  "schema_version": 1,
  "role_id": "project-operator",
  "title": "Project operator",
  "description": "Cold-picks up a Project OS repository, selects canonical work, preserves task and run truth, verifies the named surface, and writes a bounded handoff.",
  "ownership": "INSTALL",
  "instruction_routes": [
    "AGENTS.md",
    "PROJECT-OS.md",
    ".agents/skills/project-operator/SKILL.md",
    ".agents/skills/project-operator/OPERATOR.html"
  ],
  "capabilities": [
    "project.operator",
    "project.onboard",
    "project.check",
    "project.verification"
  ],
  "write_scope": [
    "the selected task and linked run packet",
    "files named by the run write fence"
  ],
  "verification": [
    "project.check",
    "project.verification"
  ]
}
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await applyProjectAdoption(root, { name: 'Upgrade fixture', summary: 'Version migration test.', outcome: 'Safe upgrades.' })
  return root
}

async function simulateLegacy(root) {
  const rolePath = join(root, '.agents', 'agents', 'project-operator.json')
  await writeFile(rolePath, OLD_ROLE, 'utf8')
  const configPath = join(root, '.project-os', 'project.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  delete config.project_os_version
  delete config.launcher
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await unlink(join(root, '.project-os', 'install-manifest.json'))
}

test('current installation records managed hashes and plans no upgrade', async (t) => {
  const root = await fixture(t)
  const manifest = JSON.parse(await readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8'))
  assert.equal(manifest.installed_version, '0.4.1')
  assert.ok(manifest.files.some((entry) => entry.path === '.agents/agents/project-operator.json'))
  const plan = await planUpgrade(root, { id: 'UPGRADE-CURRENT-TEST', now: '2026-07-29T00:00:00.000Z' })
  assert.equal(plan.current, true)
  assert.equal(plan.can_apply, true)
  assert.equal(plan.summary.preserve, 0)
})

test('legacy v0.3 baseline upgrades safely and rolls back exactly', async (t) => {
  const root = await fixture(t)
  await simulateLegacy(root)
  const options = { id: 'UPGRADE-LEGACY-TEST', now: '2026-07-29T00:00:00.000Z', by: 'test-agent' }
  const plan = await planUpgrade(root, options)
  assert.equal(plan.from_version, 'legacy-unversioned')
  assert.equal(plan.to_version, '0.4.1')
  assert.equal(plan.can_apply, true)
  const role = plan.operations.find((entry) => entry.path === '.agents/agents/project-operator.json')
  assert.equal(role.action, 'replace')
  assert.match(role.reason, /checked-in baseline from an earlier package release/)

  const applied = await applyUpgrade(root, options)
  assert.equal(applied.ok, true)
  assert.equal(applied.upgrade.state, 'applied')
  assert.match(await readFile(join(root, '.agents', 'agents', 'project-operator.json'), 'utf8'), /PROJECT-OS\.html/)
  assert.equal(JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')).project_os_version, '0.4.1')
  assert.deepEqual(JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')).launcher, { program: 'npx', arguments: ['--yes', 'github:sisodias/siso-project-os#v0.4.1'] })
  assert.equal(JSON.parse(await readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8')).installed_version, '0.4.1')
  assert.match(await readFile(join(root, applied.record), 'utf8'), /data-contract="project-os-upgrade"/)

  const rolledBack = await rollbackUpgrade(root, options.id, { now: '2026-07-29T01:00:00.000Z' })
  assert.equal(rolledBack.upgrade.state, 'rolled_back')
  assert.equal(await readFile(join(root, '.agents', 'agents', 'project-operator.json'), 'utf8'), OLD_ROLE)
  assert.equal('project_os_version' in JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')), false)
  assert.equal('launcher' in JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')), false)
  await assert.rejects(readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8'), /ENOENT/)
})

test('rollback refuses to overwrite post-upgrade project edits', async (t) => {
  const root = await fixture(t)
  await simulateLegacy(root)
  const options = { id: 'UPGRADE-GUARD-TEST', now: '2026-07-29T00:00:00.000Z' }
  await applyUpgrade(root, options)
  const rolePath = join(root, '.agents', 'agents', 'project-operator.json')
  await writeFile(rolePath, `${await readFile(rolePath, 'utf8')}\n`, 'utf8')
  await assert.rejects(rollbackUpgrade(root, options.id), /changed after UPGRADE-GUARD-TEST/)
})
