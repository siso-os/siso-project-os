import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyProjectAdoption } from '../src/adoption.mjs'
import { applyUpgrade, planUpgrade, rollbackUpgrade, verifyRuntimeSource } from '../src/upgrade.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'https://github.com/sisodias/siso-project-os.git'
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

function git(root, args, expected = 0) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, expected, `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result.stdout
}

async function verifiedRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-upgrade-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, 'bin', 'siso-project-os.mjs'), '#!/usr/bin/env node\n', 'utf8')
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Upgrade fixture'])
  git(root, ['config', 'user.email', 'upgrade@example.invalid'])
  git(root, ['remote', 'add', 'origin', repository])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'Create synthetic v0.5.1 source'])
  git(root, ['tag', '-a', 'v0.5.1', '-m', 'Synthetic v0.5.1'])
  const commit = git(root, ['rev-parse', 'refs/tags/v0.5.1^{}']).trim()
  git(root, ['checkout', '--detach', commit])
  const input = {
    'runtime-repository': repository,
    'runtime-tag': 'v0.5.1',
    'runtime-tag-object': git(root, ['rev-parse', 'refs/tags/v0.5.1']).trim(),
    'runtime-commit': commit,
    'runtime-tree': git(root, ['rev-parse', 'refs/tags/v0.5.1^{}^{tree}']).trim(),
  }
  return verifyRuntimeSource(input, { checkoutRoot: root })
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimeSource = await verifiedRuntime(t)
  await applyProjectAdoption(root, {
    name: 'Upgrade fixture',
    summary: 'Version migration test.',
    outcome: 'Safe upgrades.',
    runtimeSource,
  })
  return { root, runtimeSource }
}

function render(content, replacements) {
  let output = content
  for (const [token, value] of Object.entries(replacements)) output = output.split(token).join(value)
  return output
}

async function write(root, path, content) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

async function simulateV050(root, options = {}) {
  const migration = JSON.parse(await readFile(join(packageRoot, 'migrations', '0.5.0.json'), 'utf8'))
  const current = JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8'))
  const replacements = {
    '{{PROJECT_NAME}}': current.project_name,
    '{{PROJECT_NAME_JSON}}': JSON.stringify(current.project_name),
    '{{PROJECT_NAME_HTML}}': current.project_name,
    '{{PROJECT_SUMMARY_JSON}}': JSON.stringify(current.project_summary),
    '{{DESIRED_OUTCOME_JSON}}': JSON.stringify(current.desired_outcome),
  }
  for (const entry of migration.files) {
    const source = entry.path.startsWith('.project-os/schemas/')
      ? entry.path.slice('.project-os/'.length)
      : `template/${entry.path}`
    const content = git(packageRoot, ['show', `v0.5.0:${source}`])
    await write(root, entry.path, entry.templated ? render(content, replacements) : content)
  }
  await unlink(join(root, '.project-os', 'project-os-launcher.mjs')).catch(() => {})
  const manifestPath = join(root, '.project-os', 'install-manifest.json')
  if (options.manifest === false) {
    await unlink(manifestPath).catch(() => {})
    return
  }
  const files = []
  for (const entry of migration.files) {
    files.push({
      path: entry.path,
      sha256: createHash('sha256').update(await readFile(join(root, entry.path))).digest('hex'),
    })
  }
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    package: '@siso/project-os',
    installed_version: '0.5.0',
    installed_at: '2026-08-29T00:00:00.000Z',
    installed_by: 'v0.5.0-fixture',
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    preserved_paths: [],
  }, null, 2)}\n`, 'utf8')
}

async function simulateLegacy(root) {
  await writeFile(join(root, '.agents', 'agents', 'project-operator.json'), OLD_ROLE, 'utf8')
  const configPath = join(root, '.project-os', 'project.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  delete config.project_os_version
  delete config.launcher
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await unlink(join(root, '.project-os', 'install-manifest.json'))
}

function options(runtimeSource, id) {
  return { runtimeSource, id, now: '2026-08-30T00:00:00.000Z', by: 'test-agent' }
}

test('current installation records managed hashes and plans no upgrade', async (t) => {
  const { root, runtimeSource } = await fixture(t)
  const manifest = JSON.parse(await readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8'))
  assert.equal(manifest.installed_version, '0.5.1')
  assert.ok(manifest.files.some((entry) => entry.path === '.project-os/project-os-launcher.mjs'))
  const plan = await planUpgrade(root, options(runtimeSource, 'UPGRADE-CURRENT-TEST'))
  assert.equal(Object.isFrozen(runtimeSource), true)
  assert.equal(plan.current, true)
  assert.equal(plan.can_apply, true)
  assert.equal(plan.summary.preserve, 0)
  assert.deepEqual(plan.target_source, runtimeSource)
})

test('manifest-backed v0.5.0 upgrades known bytes and rollback restores them exactly', async (t) => {
  const { root, runtimeSource } = await fixture(t)
  await simulateV050(root)
  const configPath = join(root, '.project-os', 'project.json')
  const commandPath = join(root, '.agents', 'commands', 'project-os-check.json')
  const manifestPath = join(root, '.project-os', 'install-manifest.json')
  const before = {
    configuration: await readFile(configPath, 'utf8'),
    command: await readFile(commandPath, 'utf8'),
    manifest: await readFile(manifestPath, 'utf8'),
  }
  const upgradeOptions = options(runtimeSource, 'UPGRADE-V050-MANIFEST-TEST')
  const plan = await planUpgrade(root, upgradeOptions)
  assert.equal(plan.from_version, '0.5.0')
  assert.equal(plan.to_version, '0.5.1')
  assert.equal(plan.can_apply, true)
  assert.equal(plan.operations.find((entry) => entry.path === configPath.slice(root.length + 1)).action, 'replace')
  assert.equal(plan.operations.find((entry) => entry.path === '.project-os/project-os-launcher.mjs').action, 'create')

  const applied = await applyUpgrade(root, upgradeOptions)
  const configuration = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(configuration.project_os_version, '0.5.1')
  assert.equal(configuration.launcher.program, 'node')
  assert.deepEqual(configuration.launcher.source, runtimeSource)
  assert.equal(applied.upgrade.target_source.commit, runtimeSource.commit)

  const rolledBack = await rollbackUpgrade(root, upgradeOptions.id, { now: '2026-08-30T01:00:00.000Z' })
  assert.equal(rolledBack.upgrade.state, 'rolled_back')
  assert.equal(await readFile(configPath, 'utf8'), before.configuration)
  assert.equal(await readFile(commandPath, 'utf8'), before.command)
  assert.equal(await readFile(manifestPath, 'utf8'), before.manifest)
  await assert.rejects(readFile(join(root, '.project-os', 'project-os-launcher.mjs'), 'utf8'), /ENOENT/)
  assert.equal(rolledBack.restored_source.tag_object, '6a1db28c537dd1537c8b83f0a8fe7780a11989c8')
  assert.deepEqual(rolledBack.next_commands[0].arguments, ['<VERIFIED_V0_5_0_SOURCE>/bin/siso-project-os.mjs', 'check', '.', '--json'])
})

test('manifestless v0.5.0 upgrades only checked-in historical bytes', async (t) => {
  const { root, runtimeSource } = await fixture(t)
  await simulateV050(root, { manifest: false })
  const upgradeOptions = options(runtimeSource, 'UPGRADE-V050-MANIFESTLESS-TEST')
  const plan = await planUpgrade(root, upgradeOptions)
  assert.equal(plan.can_apply, true)
  for (const path of ['.project-os/project.json', '.agents/commands/project-os-onboard.json', '.agents/commands/project-os-check.json']) {
    const operation = plan.operations.find((entry) => entry.path === path)
    assert.equal(operation.action, 'replace')
    assert.match(operation.reason, /checked-in baseline/)
  }
  await applyUpgrade(root, upgradeOptions)
  assert.equal(JSON.parse(await readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8')).installed_version, '0.5.1')
})

test('modified v0.5.0 launcher, configuration, and generated command are preserved before mutation', async (t) => {
  const { root, runtimeSource } = await fixture(t)
  await simulateV050(root, { manifest: false })
  const configPath = join(root, '.project-os', 'project.json')
  const commandPath = join(root, '.agents', 'commands', 'project-os-check.json')
  const launcherPath = join(root, '.project-os', 'project-os-launcher.mjs')
  const configuration = JSON.parse(await readFile(configPath, 'utf8'))
  configuration.launcher.arguments.push('--project-owned')
  await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
  await writeFile(commandPath, `${await readFile(commandPath, 'utf8')}\n`, 'utf8')
  await writeFile(launcherPath, '// project-owned launcher\n', 'utf8')
  const before = await Promise.all([configPath, commandPath, launcherPath].map((path) => readFile(path, 'utf8')))
  const upgradeOptions = options(runtimeSource, 'UPGRADE-V050-COLLISION-TEST')
  const plan = await planUpgrade(root, upgradeOptions)
  assert.equal(plan.can_apply, false)
  for (const path of ['.project-os/project.json', '.agents/commands/project-os-check.json', '.project-os/project-os-launcher.mjs']) {
    assert.equal(plan.operations.find((entry) => entry.path === path).action, 'preserve')
  }
  await assert.rejects(applyUpgrade(root, upgradeOptions), /preserves unresolved project authorities/)
  assert.deepEqual(await Promise.all([configPath, commandPath, launcherPath].map((path) => readFile(path, 'utf8'))), before)
})

test('legacy baseline upgrades safely and rolls back exactly', async (t) => {
  const { root, runtimeSource } = await fixture(t)
  await simulateLegacy(root)
  const upgradeOptions = options(runtimeSource, 'UPGRADE-LEGACY-TEST')
  const plan = await planUpgrade(root, upgradeOptions)
  assert.equal(plan.from_version, 'legacy-unversioned')
  assert.equal(plan.to_version, '0.5.1')
  assert.equal(plan.can_apply, true)
  const role = plan.operations.find((entry) => entry.path === '.agents/agents/project-operator.json')
  assert.equal(role.action, 'replace')
  assert.match(role.reason, /checked-in baseline/)

  const applied = await applyUpgrade(root, upgradeOptions)
  assert.equal(applied.ok, true)
  assert.equal(applied.upgrade.state, 'applied')
  assert.equal(JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')).project_os_version, '0.5.1')
  assert.match(await readFile(join(root, applied.record), 'utf8'), /data-contract="project-os-upgrade"/)

  const rolledBack = await rollbackUpgrade(root, upgradeOptions.id, { now: '2026-08-30T01:00:00.000Z' })
  assert.equal(rolledBack.upgrade.state, 'rolled_back')
  assert.equal(await readFile(join(root, '.agents', 'agents', 'project-operator.json'), 'utf8'), OLD_ROLE)
  assert.equal('project_os_version' in JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')), false)
  assert.equal('launcher' in JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8')), false)
  await assert.rejects(readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8'), /ENOENT/)
})

test('rollback refuses changed targets and missing backups', async (t) => {
  await t.test('changed target', async (t) => {
    const { root, runtimeSource } = await fixture(t)
    await simulateV050(root)
    const upgradeOptions = options(runtimeSource, 'UPGRADE-CHANGED-TARGET-TEST')
    await applyUpgrade(root, upgradeOptions)
    const commandPath = join(root, '.agents', 'commands', 'project-os-check.json')
    await writeFile(commandPath, `${await readFile(commandPath, 'utf8')}\n`, 'utf8')
    await assert.rejects(rollbackUpgrade(root, upgradeOptions.id), /changed after UPGRADE-CHANGED-TARGET-TEST/)
  })

  await t.test('missing backup', async (t) => {
    const { root, runtimeSource } = await fixture(t)
    await simulateV050(root)
    const upgradeOptions = options(runtimeSource, 'UPGRADE-MISSING-BACKUP-TEST')
    const applied = await applyUpgrade(root, upgradeOptions)
    const replaced = applied.upgrade.operations.find((entry) => entry.action === 'replace')
    await unlink(join(root, applied.upgrade.backup_root, replaced.path))
    await assert.rejects(rollbackUpgrade(root, upgradeOptions.id), /rollback backup is missing/)
  })
})

test('upgrade rejects absent provenance before calculating target operations', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(planUpgrade(root, { id: 'UPGRADE-NO-PROVENANCE' }), /complete runtime provenance is required/)
})
