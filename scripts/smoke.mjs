#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'siso-project-os-smoke-'))
const existingRoot = await mkdtemp(join(tmpdir(), 'siso-project-os-existing-smoke-'))
const providerRoot = await mkdtemp(join(tmpdir(), 'siso-agent-base-provider-smoke-'))
const bin = join(new URL('..', import.meta.url).pathname, 'bin', 'siso-project-os.mjs')

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  if (result.status !== expected) {
    throw new Error(`command failed (${result.status}): ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

try {
  for (const skill of ['subagents', 'conduct', 'orchestrate', 'herdr', 'agent-comms']) {
    const directory = join(providerRoot, 'templates', 'profile', 'skills', skill)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${skill}\ndescription: smoke provider\n---\n`, 'utf8')
  }
  run(['init', root, '--name', 'Smoke Project'])
  const configuration = JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8'))
  if (configuration.project_os_version !== '0.5.0') throw new Error(`unexpected Project OS version: ${configuration.project_os_version}`)
  if (JSON.stringify(configuration.launcher) !== JSON.stringify({ program: 'npx', arguments: ['--yes', 'github:sisodias/siso-project-os#v0.5.0'] })) {
    throw new Error(`unexpected pinned launcher: ${JSON.stringify(configuration.launcher)}`)
  }
  const installManifest = JSON.parse(await readFile(join(root, '.project-os', 'install-manifest.json'), 'utf8'))
  if (installManifest.installed_version !== '0.5.0' || installManifest.files.length < 100) {
    throw new Error(`install manifest incomplete: ${JSON.stringify(installManifest)}`)
  }
  const portableDoctor = JSON.parse(run(['doctor', root, '--json']).stdout)
  if (!portableDoctor.ok || portableDoctor.summary.warned < 1 || !portableDoctor.checks.some((check) => check.status === 'warn' && check.required === false)) {
    throw new Error(`portable doctor failed: ${JSON.stringify(portableDoctor, null, 2)}`)
  }
  const doctor = JSON.parse(run(['doctor', root, '--agent-base-root', providerRoot, '--json']).stdout)
  if (!doctor.ok) throw new Error(`doctor failed: ${JSON.stringify(doctor, null, 2)}`)
  const upgrade = JSON.parse(run(['upgrade', 'plan', root, '--json']).stdout)
  if (!upgrade.current || !upgrade.can_apply || upgrade.summary.preserve !== 0) {
    throw new Error(`current install did not plan as a no-op: ${JSON.stringify(upgrade, null, 2)}`)
  }
  const architecture = JSON.parse(run(['architecture', 'check', root, '--json']).stdout)
  if (!architecture.ok) throw new Error(`architecture failed: ${JSON.stringify(architecture, null, 2)}`)
  const capabilities = JSON.parse(run(['capabilities', 'list', root, '--json']).stdout)
  if (capabilities.counts.skill < 1 || capabilities.counts.agent < 1 || capabilities.counts.command < 2) throw new Error(`capability inventory incomplete: ${JSON.stringify(capabilities.counts)}`)
  run(['scaffold', 'skill', '--root', root, '--id', 'smoke-release', '--description', 'Smoke project release procedure.'])
  run(['scaffold', 'agent', '--root', root, '--id', 'smoke-reviewer', '--description', 'Smoke project reviewer.'])
  run(['scaffold', 'command', '--root', root, '--id', 'smoke-status', '--description', 'Reads smoke status.', '--program', 'node', '--args', 'scripts/status.mjs'])
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Smoke task', '--accept', 'smoke passes', '--json']).stdout)
  run(['mission', 'acquire', '--root', root, '--id', 'MISSION-smoke', '--objective', 'Prove the complete kit', '--owner', 'smoke', '--tasks', created.id])
  run(['resume', 'create', '--root', root, '--objective', 'Prove the complete kit', '--mission-id', 'MISSION-smoke', '--tasks', created.id, '--first-read', 'AGENTS.md,PROJECT-OS.html', '--by', 'smoke'])
  run(['task', 'claim', '--root', root, '--by', 'smoke'])
  run(['mission', 'release', '--root', root, 'MISSION-smoke', '--by', 'smoke', '--reason', 'smoke handoff complete'])
  run(['task', 'update', '--root', root, created.id, '--by', 'smoke', '--verified', '--command', 'npm test', '--evidence', 'smoke://pass', '--status', 'completed'])
  run(['sprint', 'create', '--root', root, '--title', 'Smoke sprint', '--tasks', created.id])
  run(['run', 'create', '--root', root, '--title', 'Smoke run', '--task', created.id])
  run(['ui', 'create', '--root', root, '--title', 'Smoke UI', '--task', created.id])
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json']).stdout)
  if (!checked.ok) throw new Error(JSON.stringify(checked, null, 2))
  const onboarded = JSON.parse(run(['onboard', root, '--json']).stdout)
  if (!onboarded.ok || onboarded.guide !== '.project-os/generated/onboarding.html') {
    throw new Error(`unexpected onboarding report: ${JSON.stringify(onboarded)}`)
  }
  const index = JSON.parse(await readFile(join(root, '.project-os', 'generated', 'project-index.json'), 'utf8'))
  if (index.counts.tasks !== 1 || index.counts.sprints !== 1 || index.counts.runs !== 1 || index.counts.campaigns !== 1) {
    throw new Error(`unexpected smoke counts: ${JSON.stringify(index.counts)}`)
  }
  for (const path of ['capabilities.html', 'capability-coverage.html', 'knowledge-onboarding.html', 'architecture.html']) {
    const content = await readFile(join(root, '.project-os', 'generated', path), 'utf8')
    if (!content.startsWith('<!doctype html>')) throw new Error(`generated HTML contract missing for ${path}`)
  }

  await writeFile(join(existingRoot, 'AGENTS.md'), '# Existing rules\n', 'utf8')
  await writeFile(join(existingRoot, 'README.md'), '# Legacy readme\n', 'utf8')
  await writeFile(join(existingRoot, 'PROJECT-OS.html'), '<!doctype html><title>Owned map</title>\n', 'utf8')
  await mkdir(join(existingRoot, 'src'), { recursive: true })
  await writeFile(join(existingRoot, 'src', 'product.js'), 'export const preserved = true\n', 'utf8')
  const adoptionPlan = JSON.parse(run(['adopt', 'plan', existingRoot, '--name', 'Existing smoke', '--json']).stdout)
  if (adoptionPlan.operational_after_apply || adoptionPlan.legacy_markdown.length !== 1) throw new Error(`unexpected adoption plan: ${JSON.stringify(adoptionPlan, null, 2)}`)
  const adopted = JSON.parse(run(['adopt', 'apply', existingRoot, '--name', 'Existing smoke', '--json'], 2).stdout)
  if (!adopted.preserved.includes('PROJECT-OS.html') || !adopted.merged_routes.includes('AGENTS.md')) throw new Error(`unsafe adoption result: ${JSON.stringify(adopted, null, 2)}`)
  if ((await readFile(join(existingRoot, 'src', 'product.js'), 'utf8')) !== 'export const preserved = true\n') throw new Error('existing source changed during adoption')
  if (!(await readFile(join(existingRoot, '.project-os', 'migration', 'project-kit-migration.html'), 'utf8')).includes('project-kit-migration-state')) throw new Error('migration HTML report missing')
  process.stdout.write(`smoke: PASS (greenfield + existing migration)\n`)
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(existingRoot, { recursive: true, force: true })
  await rm(providerRoot, { recursive: true, force: true })
}
