import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  admitFleet,
  evaluateFleetAdmission,
  initFleet,
  planFleetInstall,
} from '../src/fleet.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(repositoryRoot, 'bin', 'siso-project-os.mjs')
let claimSequence = 0

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  assert.equal(result.status, expected, `unexpected exit for ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

function git(root, args, expected = 0) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, expected, `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result.stdout.trim()
}

async function commitAll(root, message) {
  git(root, ['add', '-A'])
  if (git(root, ['status', '--porcelain']) !== '') git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'siso-fleet-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  run(['init', root, '--name', 'Fleet fixture'])
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Fleet test'])
  git(root, ['config', 'user.email', 'fleet-test@example.invalid'])
  await commitAll(root, 'Initialize Project OS fixture')
  return root
}

function bootstrap() {
  return {
    schema_version: 1,
    pack_version: '1.0.0',
    programme: {
      id: 'PROGRAM-fixture',
      name: 'Fleet fixture',
      summary: 'Tests bounded fleet operations.',
      desired_outcome: 'Every admitted candidate has independent evidence.',
      owner: 'fleet-pm',
      evidence_root: '.agents/fleet/evidence',
      callback_ledger: '.agents/fleet/callbacks.ndjson',
    },
    repositories: [{
      id: 'primary',
      url: 'https://github.com/example/project.git',
      root: '.',
      remote: 'origin',
      base_branch: 'main',
      worktree_mode: 'isolated',
      write_policy: 'work-claim-required',
    }],
    domains: [{
      id: 'product',
      title: 'Product',
      owner: 'product-owner',
      owner_role: 'fleet-domain-owner',
      verifier_role: 'fleet-verifier',
      repository_id: 'primary',
      write_paths: ['src', 'test'],
      evidence_paths: ['.agents/fleet/evidence/product'],
    }],
    policy: {
      capacity: { max_live: 4, verifier_ratio: 0.25, verifier_reserve: 1, max_pending_verifications: 2 },
      heartbeat: { stale_after_seconds: 300, recovery_requires_checkpoint: true },
      admission: { require_clean_worktree: true, require_evidence_path: true, require_repository_boundary: true },
      qualification: { independent_verifier: true, require_candidate_sha: true, require_evidence_refs: true },
    },
    machines: [{
      id: 'fixture-machine',
      host_class: 'other',
      roles: ['lead', 'worker', 'verifier', 'portfolio', 'front-door', 'maintenance', 'fleet-verifier'],
      max_live: 4,
      thresholds: {
        minimum_available_disk_bytes: 1,
        minimum_available_memory_bytes: 1,
        maximum_load_per_cpu: 1000,
        require_ac_power: false,
      },
    }],
    bootstrap_machine_id: 'fixture-machine',
    process_controller: {
      provider: 'herdr',
      workspace: 'fleet-fixture',
      durable_identity_field: 'terminal_id',
      volatile_identity_fields: ['pane_id', 'process_id'],
      lead_profile: 'gpt-5.6-sol',
      worker_profile: 'gpt-5.6-luna',
      worker_reasoning_effort: 'max',
      callback_transport: 'provider-message-plus-callback-ledger',
    },
    front_door: {
      consumer: 'mission-control',
      projection_root: '.agents/fleet/generated',
      source_contract: '.agents/fleet/SOURCE-CONTRACT.json',
    },
  }
}

async function installedProject(t, config = bootstrap()) {
  const root = await project(t)
  await initFleet(root, config)
  await commitAll(root, 'Install fleet runtime pack')
  return root
}

function createTask(root, title, options = {}) {
  const args = ['task', 'create', '--root', root, '--title', title, '--domain', options.domain ?? 'product']
  if (options.owner) args.push('--owner', options.owner)
  if (options.deps) args.push('--deps', options.deps)
  args.push('--json')
  return JSON.parse(run(args).stdout)
}

function admission(taskId, overrides = {}) {
  const evidencePath = `.agents/fleet/evidence/product/${taskId}`
  const record = {
    schema_version: 1,
    id: `ADMISSION-${taskId}-${claimSequence + 1}`,
    evaluated_at: '2026-08-30T12:00:00Z',
    candidate: {
      task_id: taskId,
      actor: 'luna-implementer',
      role: 'fleet-implementer',
      domain_id: 'product',
      repository_id: 'primary',
      machine_id: 'fixture-machine',
      candidate_sha: '0'.repeat(40),
      write_paths: ['src/feature.mjs'],
      evidence_path: evidencePath,
      mode: 'new',
    },
    observations: {
      live_assignments: [],
      pending_verifications: 0,
      machine: {
        id: 'fixture-machine',
        available_disk_bytes: 10_000_000_000,
        available_memory_bytes: 10_000_000_000,
        load_per_cpu: 0.1,
        on_ac_power: true,
      },
      evidence_refs: [`${evidencePath}/admission.json`],
    },
  }
  return {
    ...record,
    ...overrides,
    candidate: { ...record.candidate, ...(overrides.candidate ?? {}) },
    observations: { ...record.observations, ...(overrides.observations ?? {}) },
  }
}

async function writeCheckpoint(root, input) {
  const pointer = input.candidate.resume_checkpoint
  await mkdir(dirname(join(root, pointer)), { recursive: true })
  await writeFile(join(root, pointer), `${JSON.stringify({
    schema_version: 1,
    id: `SNAPSHOT-${input.candidate.task_id}-${claimSequence + 1}`,
    objective: 'Resume the bounded fleet task.',
    mission_id: null,
    active_task_ids: [input.candidate.task_id],
    active_sprint_id: null,
    active_run_id: null,
    blocker: null,
    next_gate: 'Revalidate fleet admission.',
    evidence_refs: input.observations.evidence_refs,
    first_read: ['.agents/fleet/PROGRAM.json'],
    previous_snapshot: null,
    created_at: '2026-08-30T11:30:00Z',
    created_by: input.candidate.actor,
  }, null, 2)}\n`, 'utf8')
}

async function prepareAdmission(root, input, options = {}) {
  if (options.createEvidence !== false) {
    await mkdir(join(root, input.candidate.evidence_path), { recursive: true })
    for (const pointer of input.observations.evidence_refs) {
      await mkdir(dirname(join(root, pointer)), { recursive: true })
      await writeFile(join(root, pointer), '{"proof":"fixture"}\n', 'utf8')
    }
  }
  if (options.createCheckpoint) await writeCheckpoint(root, input)
  const committedSha = await commitAll(root, `Prepare ${input.id}`)
  input.candidate.candidate_sha = options.candidateSha ?? committedSha
  if (options.dirtyPath) {
    await mkdir(dirname(join(root, options.dirtyPath)), { recursive: true })
    await writeFile(join(root, options.dirtyPath), 'uncommitted fixture\n', 'utf8')
  }
  if (input.candidate.write_paths.length > 0 && options.createClaim !== false) {
    claimSequence += 1
    const runRecord = JSON.parse(run([
      'run', 'create', '--root', root, '--title', `Admission ${claimSequence}`,
      '--task', input.candidate.task_id, '--date', '2026-08-30', '--json',
    ]).stdout)
    const unitId = `unit-${claimSequence}`
    run([
      'run', 'unit-add', runRecord.id, '--root', root, '--id', unitId,
      '--tasks', input.candidate.task_id, '--paths', input.candidate.write_paths.join(','),
      '--by', input.candidate.actor, '--json',
    ])
    const claim = JSON.parse(run([
      'claim', 'acquire', '--root', root, '--id', `CLAIM-${input.candidate.task_id}-${claimSequence}`,
      '--task', input.candidate.task_id, '--run', runRecord.id, '--unit', unitId,
      '--paths', input.candidate.write_paths.join(','), '--base-sha', input.candidate.candidate_sha,
      '--actor', input.candidate.actor, '--seat', input.candidate.machine_id, '--json',
    ]).stdout)
    input.candidate.claim_id = claim.id
  }
  return input
}

test('fleet install is collision-safe, complete, idempotent, and provider-bound', async (t) => {
  const root = await project(t)
  const configPath = join(root, 'fleet.bootstrap.json')
  await writeFile(configPath, `${JSON.stringify(bootstrap(), null, 2)}\n`, 'utf8')
  const planned = JSON.parse(run(['fleet', 'plan', root, '--config', configPath, '--json']).stdout)
  assert.equal(planned.ok, true)
  assert.equal(planned.summary.collision, 0)
  const installed = JSON.parse(run(['fleet', 'init', root, '--config', configPath, '--json']).stdout)
  assert.equal(installed.ok, true)
  assert.ok(installed.installed.includes('.agents/fleet/PACK.json'))
  const processPlan = JSON.parse(await readFile(join(root, '.agents/fleet/PROCESS-PLAN.json'), 'utf8'))
  assert.equal(processPlan.admission_receipt_authority, 'eligibility-only')
  assert.equal(processPlan.process_start_authority, 'provider-atomic-compare-and-start')
  assert.deepEqual(processPlan.compute_profiles, {
    lead: { model: 'gpt-5.6-sol', reasoning_effort: 'max' },
    worker: { model: 'gpt-5.6-luna', reasoning_effort: 'max' },
  })
  const retained = JSON.parse(run(['fleet', 'init', root, '--config', configPath, '--json']).stdout)
  assert.equal(retained.installed.length, 0)
  assert.ok(retained.retained.includes('.agents/fleet/PACK.json'))
  assert.equal(JSON.parse(run(['fleet', 'check', root, '--json']).stdout).ok, true)
  assert.equal(JSON.parse(run(['check', root, '--json']).stdout).ok, true)
})

test('fleet check rejects any managed process-plan mutation', async (t) => {
  const root = await installedProject(t)
  const path = join(root, '.agents/fleet/PROCESS-PLAN.json')
  const processPlan = JSON.parse(await readFile(path, 'utf8'))
  processPlan.roles[0].profile = '.agents/agents/fleet-verifier.agent.json'
  processPlan.roles[0].contract = 'project-os-role'
  processPlan.roles[0].lifecycle = 'event-driven'
  processPlan.roles[0].compute_profile = 'worker'
  processPlan.roles[0].machine_roles = ['worker']
  processPlan.compute_profiles.worker.model = 'untrusted-model'
  await writeFile(path, `${JSON.stringify(processPlan, null, 2)}\n`, 'utf8')
  const checked = JSON.parse(run(['fleet', 'check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((entry) => entry.code === 'managed_fleet_artifact_changed' && entry.path === '.agents/fleet/PROCESS-PLAN.json'))
})

test('fleet plan refuses collisions without a partial install', async (t) => {
  const root = await project(t)
  const path = join(root, '.agents/fleet/PACK.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{"owned":"elsewhere"}\n', 'utf8')
  const planned = await planFleetInstall(root, bootstrap())
  assert.equal(planned.ok, false)
  assert.ok(planned.errors.some((entry) => entry.code === 'install_collision' && entry.path === '.agents/fleet/PACK.json'))
  await assert.rejects(initFleet(root, bootstrap()), /fleet init refused/)
  assert.equal(await readFile(path, 'utf8'), '{"owned":"elsewhere"}\n')
  await assert.rejects(readFile(join(root, '.agents/fleet/PROGRAM.json'), 'utf8'))
})

test('fleet install resumes a same-host dead process without retaining partial temp state', async (t) => {
  const root = await project(t)
  const plan = await planFleetInstall(root, bootstrap())
  const first = plan.operations.find((entry) => entry.action === 'create')
  const deadPid = 2_000_000_000
  await mkdir(dirname(join(root, first.path)), { recursive: true })
  await writeFile(join(root, first.path), plan._entries.get(first.path), 'utf8')
  await writeFile(`${join(root, first.path)}.tmp-${deadPid}`, 'partial', 'utf8')
  await mkdir(join(root, '.agents/fleet'), { recursive: true })
  await writeFile(join(root, '.agents/fleet/.install.lock'), `${JSON.stringify({ schema_version: 1, pid: deadPid, host: hostname(), created_at: '2026-08-30T00:00:00Z' })}\n`, 'utf8')
  const installed = await initFleet(root, bootstrap())
  assert.equal(installed.recovered_stale_install.pid, deadPid)
  await assert.rejects(readFile(`${join(root, first.path)}.tmp-${deadPid}`, 'utf8'))
  assert.equal(JSON.parse(run(['fleet', 'check', root, '--json']).stdout).ok, true)
})

test('fleet plan refuses overlapping ownership, verifier starvation, pressure, and secrets', async (t) => {
  const root = await project(t)
  const overlap = bootstrap()
  overlap.domains.push({ ...overlap.domains[0], id: 'product-two', write_paths: ['src/components'] })
  assert.ok((await planFleetInstall(root, overlap)).errors.some((entry) => entry.code === 'overlapping_domain_ownership'))
  const noVerifier = bootstrap()
  noVerifier.machines[0].roles = ['lead', 'worker']
  assert.ok((await planFleetInstall(root, noVerifier)).errors.some((entry) => entry.code === 'missing_verifier_placement'))
  const fullDisk = bootstrap()
  fullDisk.machines[0].thresholds.minimum_available_disk_bytes = Number.MAX_SAFE_INTEGER
  assert.ok((await planFleetInstall(root, fullDisk)).errors.some((entry) => entry.code === 'disk_pressure'))
  const secret = bootstrap()
  secret.programme.summary = `ghp_${'A'.repeat(24)}`
  assert.ok((await planFleetInstall(root, secret)).errors.some((entry) => entry.code === 'secret_value_forbidden'))
  const caseCollision = bootstrap()
  caseCollision.domains.push({ ...caseCollision.domains[0], id: 'case-collision', write_paths: ['SRC'] })
  assert.ok((await planFleetInstall(root, caseCollision)).errors.some((entry) => entry.code === 'overlapping_domain_ownership'))
  const reserved = bootstrap()
  reserved.domains[0].write_paths = ['.']
  assert.ok((await planFleetInstall(root, reserved)).errors.some((entry) => entry.code === 'reserved_write_scope'))
})

test('fleet fails closed on old, invalid, or missing installed Project OS versions', async (t) => {
  const root = await project(t)
  const projectPath = join(root, '.project-os/project.json')
  const configuration = JSON.parse(await readFile(projectPath, 'utf8'))
  configuration.project_os_version = '0.4.0'
  await writeFile(projectPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
  assert.ok((await planFleetInstall(root, bootstrap())).errors.some((entry) => entry.code === 'fleet_project_os_incompatible'))
  configuration.project_os_version = '0.5.0'
  await writeFile(projectPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
  await initFleet(root, bootstrap())
  configuration.project_os_version = 'not-a-version'
  await writeFile(projectPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
  const checked = JSON.parse(run(['fleet', 'check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((entry) => entry.code === 'invalid_project_os_version'))
  const task = createTask(root, 'Invalid version admission')
  const input = admission(task.id)
  await assert.rejects(evaluateFleetAdmission(root, input), /installed Project OS version must be semantic/)
  delete configuration.project_os_version
  await writeFile(projectPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
  assert.ok((await planFleetInstall(root, bootstrap())).errors.some((entry) => entry.code === 'invalid_project_os_version'))
  const missing = JSON.parse(run(['fleet', 'check', root, '--json'], 1).stdout)
  assert.ok(missing.errors.some((entry) => entry.code === 'invalid_project_os_version'))
})

test('admission holds a task behind an incomplete dependency', async (t) => {
  const root = await installedProject(t)
  const prerequisite = createTask(root, 'Prerequisite')
  const dependent = createTask(root, 'Dependent', { deps: prerequisite.id })
  const receipt = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(dependent.id)))
  assert.equal(receipt.verdict, 'hold')
  assert.ok(receipt.reason_codes.includes('dependency_blocked'))
})

test('admission reserves verifier capacity and stops on verifier backlog', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Backlog pressure')
  const live = Array.from({ length: 3 }, (_, index) => ({
    actor: `worker-${index}`,
    task_id: task.id,
    role: 'fleet-implementer',
    domain_id: 'product',
    machine_id: 'fixture-machine',
    state: 'working',
    heartbeat_at: '2026-08-30T11:59:00Z',
    recovery_disposition: 'none',
  }))
  const receipt = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(task.id, {
    observations: { live_assignments: live, pending_verifications: 2 },
  })))
  assert.equal(receipt.verdict, 'hold')
  assert.ok(receipt.reason_codes.includes('verifier_reserve'))
  assert.ok(receipt.reason_codes.includes('verifier_backlog'))
})

test('admission counts canonical claims and requires an exact claim for writes', async (t) => {
  const root = await installedProject(t)
  const noClaimTask = createTask(root, 'Missing claim')
  const noClaim = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(noClaimTask.id), { createClaim: false }))
  assert.equal(noClaim.verdict, 'hold')
  assert.ok(noClaim.reason_codes.includes('claim_required'))
  for (let index = 0; index < 4; index += 1) {
    const task = createTask(root, `Capacity claim ${index}`)
    await prepareAdmission(root, admission(task.id, { candidate: { actor: `worker-${index}`, write_paths: [`src/slot-${index}.mjs`] } }))
  }
  const verifierTask = createTask(root, 'Capacity verifier', { owner: 'worker-0' })
  const verifier = await prepareAdmission(root, admission(verifierTask.id, {
    candidate: { actor: 'capacity-verifier', role: 'fleet-verifier', implementation_actor: 'worker-0', write_paths: [] },
  }))
  const capacity = await evaluateFleetAdmission(root, verifier)
  assert.equal(capacity.verdict, 'hold')
  assert.ok(capacity.reason_codes.includes('live_capacity'))
  run(['fleet', 'build', root, '--json'])
  const team = JSON.parse(await readFile(join(root, '.agents/fleet/generated/TEAM-STATE.json'), 'utf8'))
  assert.equal(team.capacity.active_claims, 4)
})

test('admission rejects a corrupted canonical claim overlap even when the candidate claim matches', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Canonical collision')
  const input = await prepareAdmission(root, admission(task.id, { candidate: { write_paths: ['src/collision.mjs'] } }))
  const claimPath = join(root, '.agents/work-claims/active', `${input.candidate.claim_id}.json`)
  const conflicting = JSON.parse(await readFile(claimPath, 'utf8'))
  conflicting.id = 'CLAIM-CORRUPTED-OVERLAP'
  conflicting.actor = 'other-worker'
  conflicting.write_set = ['SRC/COLLISION.MJS']
  await writeFile(join(root, '.agents/work-claims/active/CLAIM-CORRUPTED-OVERLAP.json'), `${JSON.stringify(conflicting, null, 2)}\n`, 'utf8')
  const receipt = await evaluateFleetAdmission(root, input)
  assert.equal(receipt.verdict, 'reject')
  assert.ok(receipt.reason_codes.includes('active_claim_collision'))
})

test('admission binds task domain, task evidence root, and direct facts', async (t) => {
  const root = await installedProject(t)
  const mismatchTask = createTask(root, 'Wrong domain', { domain: 'general' })
  const mismatch = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(mismatchTask.id)))
  assert.equal(mismatch.verdict, 'reject')
  assert.ok(mismatch.reason_codes.includes('task_domain'))
  const task = createTask(root, 'Evidence boundary')
  const crossTask = admission(task.id, {
    candidate: { evidence_path: '.agents/fleet/evidence/product/TASK-9999', write_paths: ['src/cross-task.mjs'] },
    observations: { evidence_refs: ['.agents/fleet/evidence/product/TASK-9999/proof.json'] },
  })
  const crossReceipt = await evaluateFleetAdmission(root, await prepareAdmission(root, crossTask))
  assert.equal(crossReceipt.verdict, 'reject')
  assert.ok(crossReceipt.reason_codes.includes('evidence_boundary'))
  const spoofed = admission(task.id)
  spoofed.observations.candidate_sha_exists = true
  await assert.rejects(evaluateFleetAdmission(root, spoofed), /additional property is not allowed/)
})

test('admission rejects unauthorized resume and invalid checkpoint lineage', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Owned resume', { owner: 'other-worker' })
  const input = admission(task.id, {
    candidate: { mode: 'resume', resume_checkpoint: `.agents/briefs/snapshots/SNAPSHOT-${task.id}-resume.json` },
  })
  const receipt = await evaluateFleetAdmission(root, await prepareAdmission(root, input, { createCheckpoint: true }))
  assert.equal(receipt.verdict, 'reject')
  assert.ok(receipt.reason_codes.includes('task_owner'))
})

test('admission rejects dirty worktrees, missing evidence, and missing SHAs from direct probes', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Direct probes', { owner: 'luna-implementer' })
  const input = admission(task.id, {
    candidate: { mode: 'resume', resume_checkpoint: '.agents/briefs/snapshots/missing.snapshot.json' },
  })
  const receipt = await evaluateFleetAdmission(root, await prepareAdmission(root, input, {
    createEvidence: false,
    candidateSha: 'f'.repeat(40),
    dirtyPath: 'src/uncommitted.mjs',
  }))
  assert.equal(receipt.verdict, 'reject')
  for (const reason of ['resume_checkpoint', 'worktree_clean', 'evidence_path', 'evidence_files', 'candidate_sha']) assert.ok(receipt.reason_codes.includes(reason), reason)
})

test('admission rejects write-scope escape and non-independent verification', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Authority boundaries')
  const receipt = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(task.id, {
    candidate: { actor: 'product-owner', role: 'fleet-verifier', implementation_actor: 'product-owner', write_paths: ['scripts/outside.mjs'] },
  })))
  assert.equal(receipt.verdict, 'reject')
  for (const reason of ['write_scope', 'verifier_independence', 'verifier_write_scope']) assert.ok(receipt.reason_codes.includes(reason))

  const reservedTask = createTask(root, 'Reserved state boundary')
  const reserved = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(reservedTask.id, {
    candidate: { write_paths: ['.agents/tasks'] },
  })))
  assert.equal(reserved.verdict, 'reject')
  assert.ok(reserved.reason_codes.includes('reserved_write_scope'))
})

test('verifier identity must bind to canonical implementation ownership', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Verifier actor lineage', { owner: 'real-implementer' })
  const input = await prepareAdmission(root, admission(task.id, {
    candidate: { actor: 'independent-verifier', role: 'fleet-verifier', implementation_actor: 'made-up-implementer', write_paths: [] },
  }))
  const receipt = await evaluateFleetAdmission(root, input)
  assert.equal(receipt.verdict, 'reject')
  assert.ok(receipt.reason_codes.includes('verifier_implementation_actor'))
})

test('evidence must resolve inside the project and references must be regular files', async (t) => {
  const root = await installedProject(t)
  const outside = await mkdtemp(join(tmpdir(), 'siso-fleet-outside-evidence-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const task = createTask(root, 'Evidence symlink', { owner: 'real-implementer' })
  const symlinkInput = admission(task.id, {
    candidate: { actor: 'independent-verifier', role: 'fleet-verifier', implementation_actor: 'real-implementer', write_paths: [] },
  })
  await writeFile(join(outside, 'proof.json'), '{"outside":true}\n', 'utf8')
  await mkdir(dirname(join(root, symlinkInput.candidate.evidence_path)), { recursive: true })
  await symlink(outside, join(root, symlinkInput.candidate.evidence_path), 'dir')
  symlinkInput.candidate.candidate_sha = await commitAll(root, 'Add evidence symlink fixture')
  const escaped = await evaluateFleetAdmission(root, symlinkInput)
  assert.equal(escaped.verdict, 'reject')
  assert.ok(escaped.reason_codes.includes('evidence_path'))

  const fileTask = createTask(root, 'Evidence file type', { owner: 'real-implementer' })
  const directoryInput = admission(fileTask.id, {
    candidate: { actor: 'independent-verifier-two', role: 'fleet-verifier', implementation_actor: 'real-implementer', write_paths: [] },
  })
  await mkdir(join(root, directoryInput.observations.evidence_refs[0]), { recursive: true })
  directoryInput.candidate.candidate_sha = await commitAll(root, 'Add evidence directory fixture')
  const directory = await evaluateFleetAdmission(root, directoryInput)
  assert.equal(directory.verdict, 'reject')
  assert.ok(directory.reason_codes.includes('evidence_files'))
})

test('admission fails closed on stale recovery, unknown roles, and unknown AC state', async (t) => {
  const config = bootstrap()
  config.machines[0].thresholds.require_ac_power = true
  const root = await project(t)
  await initFleet(root, config, { observeMachine: false })
  await commitAll(root, 'Install AC-gated fleet runtime pack')
  const task = createTask(root, 'Recovery and role checks')
  const stale = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(task.id, {
    observations: {
      live_assignments: [{
        actor: 'crashed-worker', task_id: task.id, role: 'fleet-implementer', domain_id: 'product',
        machine_id: 'fixture-machine', state: 'working', heartbeat_at: '2026-08-30T11:00:00Z', recovery_disposition: 'none',
      }],
    },
  })))
  assert.ok(stale.reason_codes.includes('stale_heartbeat_recovery'))
  const unknownTask = createTask(root, 'Unknown role')
  const unknown = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(unknownTask.id, { candidate: { role: 'unknown-specialist', write_paths: ['src/unknown-role.mjs'] } })))
  assert.equal(unknown.verdict, 'reject')
  assert.ok(unknown.reason_codes.includes('candidate_role'))
  const acTask = createTask(root, 'Unknown AC')
  const ac = await evaluateFleetAdmission(root, await prepareAdmission(root, admission(acTask.id, {
    candidate: { write_paths: ['src/ac-state.mjs'] },
    observations: { machine: { ...admission(acTask.id).observations.machine, on_ac_power: null } },
  })))
  assert.equal(ac.verdict, 'hold')
  assert.ok(ac.reason_codes.includes('ac_power_unknown'))
})

test('admission and fleet check reject swapped role profiles', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Profile integrity', { owner: 'luna-implementer' })
  const input = await prepareAdmission(root, admission(task.id, {
    candidate: { actor: 'independent-verifier', role: 'fleet-verifier', implementation_actor: 'luna-implementer', write_paths: [] },
  }))
  const frontDoor = await readFile(join(root, '.agents/agents/fleet-front-door.agent.json'), 'utf8')
  await writeFile(join(root, '.agents/agents/fleet-verifier.agent.json'), frontDoor, 'utf8')
  const receipt = await evaluateFleetAdmission(root, input)
  assert.equal(receipt.verdict, 'reject')
  assert.ok(receipt.reason_codes.includes('role_profile'))
  const checked = JSON.parse(run(['fleet', 'check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((entry) => entry.code === 'fleet_role_profile_mismatch'))
  assert.ok(checked.errors.some((entry) => entry.code === 'managed_fleet_artifact_changed'))
})

test('fleet check rejects weakened source contracts and tampered receipts', async (t) => {
  const root = await installedProject(t)
  const task = createTask(root, 'Durable receipt integrity')
  const recorded = await admitFleet(root, await prepareAdmission(root, admission(task.id)))
  assert.equal(recorded.start_contract.start_authority, 'provider-atomic-compare-and-start')
  const receiptPath = join(root, recorded.receipt_path)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.checks[0].status = 'reject'
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  const packPath = join(root, '.agents/fleet/PACK.json')
  const pack = JSON.parse(await readFile(packPath, 'utf8'))
  pack.contracts = {}
  await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8')
  await writeFile(join(root, '.agents/fleet/callbacks.ndjson'), `${JSON.stringify({
    schema_version: 1,
    id: 'CALLBACK-secret-test',
    recorded_at: '2026-08-30T12:00:00Z',
    from: 'worker',
    to: 'lead',
    event: 'handoff',
    status: 'acknowledged',
    task_ids: [task.id],
    message: `ghp_${'A'.repeat(24)}`,
    evidence_refs: [`.agents/fleet/evidence/product/${task.id}/admission.json`],
    ack_required: true,
  })}\n`, 'utf8')
  const checked = JSON.parse(run(['fleet', 'check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((entry) => entry.code === 'schema_violation' && entry.path === '.agents/fleet/PACK.json'))
  assert.ok(checked.errors.some((entry) => entry.code === 'inconsistent_admission_receipt'))
  assert.ok(checked.errors.some((entry) => entry.code === 'invalid_callback_acknowledgement'))
  assert.ok(checked.errors.some((entry) => entry.code === 'secret_value_forbidden'))
  assert.ok(checked.errors.some((entry) => entry.code === 'admission_receipt_digest_mismatch'))
})

test('fleet check reports malformed policy as structured errors', async (t) => {
  const root = await installedProject(t)
  await writeFile(join(root, '.agents/fleet/POLICY.json'), '{"schema_version":1}\n', 'utf8')
  const checked = JSON.parse(run(['fleet', 'check', root, '--json'], 1).stdout)
  assert.equal(checked.ok, false)
  assert.ok(checked.errors.some((entry) => entry.path === '.agents/fleet/POLICY.json'))
  assert.ok(checked.errors.some((entry) => entry.code === 'invalid_fleet_structure'))
})

test('published Actionist dog-food contains synthetic identities only', async () => {
  const exampleRoot = join(repositoryRoot, 'examples', 'actionist-fleet')
  const source = JSON.parse(await readFile(join(exampleRoot, 'source-snapshot.json'), 'utf8'))
  const config = JSON.parse(await readFile(join(exampleRoot, 'fleet.bootstrap.json'), 'utf8'))
  const admissions = await Promise.all(['admission.qualifier.json', 'admission.conversion.json']
    .map(async (file) => JSON.parse(await readFile(join(exampleRoot, file), 'utf8'))))
  const serialized = JSON.stringify({ source, config, admissions })

  assert.equal(source.source_revision_kind, 'synthetic_fixture')
  assert.match(source.source_revision, /^synthetic-/)
  assert.equal(Object.hasOwn(source, 'source_commit'), false)
  assert.ok(config.repositories.every((repository) => repository.url.startsWith('https://github.com/example/')))
  assert.ok(config.domains.every((domain) => domain.owner.startsWith('ACTIONIST-')))
  assert.equal(config.programme.owner, 'ACTIONIST-PM')
  assert.equal(config.process_controller.workspace, 'ACTIONIST-FIXTURE')
  assert.ok(admissions.every((input) => input.candidate.candidate_sha === '0000000000000000000000000000000000000001'))
  assert.doesNotMatch(serialized, /(?:\/Users\/|SISO_(?:Agency|Workspace)|term_[0-9a-f]{8,}|w[0-9a-f]{12,})/)
})
