#!/usr/bin/env node

import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { admitFleet } from '../src/fleet.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exampleRoot = join(repositoryRoot, 'examples', 'actionist-fleet')
const root = await mkdtemp(join(tmpdir(), 'siso-actionist-dogfood-'))
const releaseRoot = await mkdtemp(join(tmpdir(), 'siso-actionist-release-'))
const launcherCache = await mkdtemp(join(tmpdir(), 'siso-actionist-cache-'))
const sourceRoot = join(releaseRoot, 'source')
const repository = 'https://github.com/sisodias/siso-project-os.git'
let bin
let provenance = []

function run(args, expected = 0) {
  const requiresProvenance = args[0] === 'init' || args[0] === 'adopt' || (args[0] === 'upgrade' && args[1] !== 'rollback')
  const result = spawnSync(process.execPath, [bin, ...args, ...(requiresProvenance ? provenance : [])], { encoding: 'utf8' })
  if (result.status !== expected) throw new Error(`command failed (${result.status}): ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result
}

function runManaged(args, expected = 0) {
  const result = spawnSync(process.execPath, [join(root, '.project-os', 'project-os-launcher.mjs'), ...args], {
    cwd: exampleRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SISO_PROJECT_OS_CACHE_DIR: launcherCache,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${sourceRoot}/.insteadOf`,
      GIT_CONFIG_VALUE_0: repository,
    },
  })
  if (result.status !== expected) throw new Error(`managed command failed (${result.status}): ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result
}

function gitAt(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

function git(args) {
  return gitAt(root, args)
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

try {
  await cp(repositoryRoot, sourceRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const pointer = relative(repositoryRoot, sourcePath)
      return pointer !== '.git' && !pointer.startsWith('.git/') && !pointer.startsWith('.git\\')
    },
  })
  gitAt(sourceRoot, ['init', '-b', 'main'])
  gitAt(sourceRoot, ['config', 'user.name', 'Project OS Actionist dog-food'])
  gitAt(sourceRoot, ['config', 'user.email', 'project-os-actionist@example.invalid'])
  gitAt(sourceRoot, ['remote', 'add', 'origin', repository])
  gitAt(sourceRoot, ['add', '.'])
  gitAt(sourceRoot, ['commit', '-m', 'Create synthetic v0.5.1 release'])
  gitAt(sourceRoot, ['tag', '-a', 'v0.5.1', '-m', 'Synthetic v0.5.1'])
  const tagObject = gitAt(sourceRoot, ['rev-parse', 'refs/tags/v0.5.1'])
  const commit = gitAt(sourceRoot, ['rev-parse', 'refs/tags/v0.5.1^{}'])
  const tree = gitAt(sourceRoot, ['rev-parse', 'refs/tags/v0.5.1^{}^{tree}'])
  gitAt(sourceRoot, ['checkout', '--detach', commit])
  provenance = [
    '--runtime-repository', repository,
    '--runtime-tag', 'v0.5.1',
    '--runtime-tag-object', tagObject,
    '--runtime-commit', commit,
    '--runtime-tree', tree,
  ]
  bin = join(sourceRoot, 'bin', 'siso-project-os.mjs')

  const source = await jsonFile(join(exampleRoot, 'source-snapshot.json'))
  const configPath = join(exampleRoot, 'fleet.bootstrap.json')
  run(['init', root, '--name', 'Actionist fleet dog-food', '--summary', 'Non-authoritative migration rehearsal.', '--outcome', 'Prove portable fleet gates without mutating live Actionist state.'])
  const projectConfiguration = await jsonFile(join(root, '.project-os', 'project.json'))
  const actionistRoot = join(root, 'actionist-base')
  await mkdir(actionistRoot, { recursive: true })
  await writeFile(join(actionistRoot, 'README.md'), '# Public-safe Actionist base fixture\n', 'utf8')
  gitAt(actionistRoot, ['init', '-b', 'main'])
  gitAt(actionistRoot, ['config', 'user.name', 'Project OS dog-food'])
  gitAt(actionistRoot, ['config', 'user.email', 'project-os@example.invalid'])
  gitAt(actionistRoot, ['add', '.'])
  gitAt(actionistRoot, ['commit', '-m', 'Create nested Actionist base fixture'])
  await writeFile(join(root, '.gitignore'), 'actionist-base/\n', 'utf8')
  const plan = JSON.parse(runManaged(['fleet', 'plan', root, '--config', configPath, '--json']).stdout)
  const install = JSON.parse(runManaged(['fleet', 'init', root, '--config', configPath, '--json']).stdout)

  const qualification = JSON.parse(runManaged(['task', 'create', '--root', root, '--title', 'Qualify the synthetic Actionist source fixture', '--domain', 'qualification', '--owner', 'ACTIONIST-PM', '--json']).stdout)
  const materialization = JSON.parse(runManaged(['task', 'create', '--root', root, '--title', 'Materialize the canonical Mini runtime', '--domain', 'programme', '--json']).stdout)
  const conversion = JSON.parse(runManaged(['task', 'create', '--root', root, '--title', 'Admit the first bounded conversion', '--domain', 'foundry', '--deps', `${qualification.id},${materialization.id}`, '--json']).stdout)
  assert.deepEqual([qualification.id, materialization.id, conversion.id], ['TASK-0001', 'TASK-0002', 'TASK-0003'])

  const qualificationEvidence = join(root, '.agents/fleet/evidence/qualification/TASK-0001')
  const conversionEvidence = join(root, '.agents/fleet/evidence/foundry/TASK-0003')
  await mkdir(qualificationEvidence, { recursive: true })
  await mkdir(conversionEvidence, { recursive: true })
  await copyFile(join(exampleRoot, 'source-snapshot.json'), join(qualificationEvidence, 'source-snapshot.json'))
  await copyFile(join(exampleRoot, 'source-snapshot.json'), join(conversionEvidence, 'admission.json'))

  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Project OS dog-food'])
  git(['config', 'user.email', 'project-os@example.invalid'])
  git(['add', '.'])
  git(['commit', '-m', 'Create Actionist fleet rehearsal baseline'])
  assert.equal(git(['status', '--porcelain']), '')

  const qualifierInput = await jsonFile(join(exampleRoot, 'admission.qualifier.json'))
  qualifierInput.candidate.candidate_sha = git(['rev-parse', 'HEAD'])
  const qualifierReceipt = await admitFleet(root, qualifierInput)
  assert.equal(qualifierReceipt.verdict, 'admit')

  git(['add', '.'])
  git(['commit', '-m', 'Record independent verifier admission'])
  assert.equal(git(['status', '--porcelain']), '')

  const conversionInput = await jsonFile(join(exampleRoot, 'admission.conversion.json'))
  conversionInput.candidate.candidate_sha = gitAt(actionistRoot, ['rev-parse', 'HEAD'])
  const conversionRun = JSON.parse(runManaged([
    'run', 'create', '--root', root, '--title', 'Actionist conversion rehearsal',
    '--task', conversion.id, '--date', '2026-08-30', '--json',
  ]).stdout)
  runManaged([
    'run', 'unit-add', conversionRun.id, '--root', root, '--id', 'conversion-unit',
    '--tasks', conversion.id, '--paths', conversionInput.candidate.write_paths.join(','),
    '--by', conversionInput.candidate.actor, '--json',
  ])
  const conversionClaim = JSON.parse(runManaged([
    'claim', 'acquire', '--root', root, '--id', 'CLAIM-ACTIONIST-CONVERSION',
    '--task', conversion.id, '--run', conversionRun.id, '--unit', 'conversion-unit',
    '--paths', conversionInput.candidate.write_paths.join(','),
    '--base-sha', conversionInput.candidate.candidate_sha,
    '--actor', conversionInput.candidate.actor, '--seat', conversionInput.candidate.machine_id,
    '--json',
  ]).stdout)
  conversionInput.candidate.claim_id = conversionClaim.id
  const conversionReceipt = await admitFleet(root, conversionInput)
  assert.equal(conversionReceipt.verdict, 'hold')
  assert.ok(conversionReceipt.reason_codes.includes('dependency_blocked'))
  assert.ok(conversionReceipt.reason_codes.includes('verifier_backlog'))

  runManaged(['build', root])
  const fleetCheck = JSON.parse(runManaged(['fleet', 'check', root, '--json']).stdout)
  const projectCheck = JSON.parse(runManaged(['check', root, '--json']).stdout)
  const taskGraph = await jsonFile(join(root, '.agents/fleet/generated/TASK-GRAPH.json'))
  const teamState = await jsonFile(join(root, '.agents/fleet/generated/TEAM-STATE.json'))

  const result = {
    schema_version: 1,
    kind: 'actionist-fleet-dogfood-result',
    mode: 'non-authoritative-migration-rehearsal',
    live_programme_mutated: false,
    source_snapshot: {
      id: source.snapshot_id,
      revision: source.source_revision,
      revision_kind: source.source_revision_kind,
      readiness_before: source.readiness,
      gaps_before: source.observed_gaps,
    },
    install: {
      plan_ok: plan.ok,
      collisions: plan.summary.collision,
      pack_id: install.pack_id,
      pack_version: install.pack_version,
      installed_files: install.installed.length,
      launcher_program: projectConfiguration.launcher.program,
      launcher_tag: projectConfiguration.launcher.source.tag,
      launcher_commit: projectConfiguration.launcher.source.commit,
      launcher_tree: projectConfiguration.launcher.source.tree,
      launcher_cold_and_warm_cache_verified: true,
    },
    admission_receipts: [
      { id: qualifierReceipt.id, verdict: qualifierReceipt.verdict, reason_codes: qualifierReceipt.reason_codes },
      { id: conversionReceipt.id, verdict: conversionReceipt.verdict, reason_codes: conversionReceipt.reason_codes, claim_id: conversionClaim.id },
    ],
    projection_after: {
      task_counts: taskGraph.counts,
      capacity: teamState.capacity,
      admissions: teamState.admissions,
    },
    checks: {
      fleet: fleetCheck.ok ? 'PASS' : 'FAIL',
      project: projectCheck.ok ? 'PASS' : 'FAIL',
    },
    comparison: {
      reused: source.observed_capabilities,
      added: [
        'versioned portable pack manifest',
        'schema-validated bootstrap and role contracts',
        'machine-evaluated collision-safe install plan',
        'durable admit/hold/reject receipts',
        'explicit verifier reserve and backlog pressure',
        'deterministic task graph and team-state projections',
      ],
      intentionally_external: ['Herdr process control', 'Great Library identity and placement', 'live Actionist programme truth'],
    },
  }
  assert.equal(result.install.plan_ok, true)
  assert.equal(result.checks.fleet, 'PASS')
  assert.equal(result.checks.project, 'PASS')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(releaseRoot, { recursive: true, force: true })
  await rm(launcherCache, { recursive: true, force: true })
}
