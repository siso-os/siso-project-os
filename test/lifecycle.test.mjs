import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  acquireMission,
  acquireWorkClaim,
  addRunUnit,
  amendRunPacket,
  appendRunEvent,
  archiveSprint,
  closeSprint,
  createDeliveryPlan,
  createResumeSnapshot,
  createRunPacket,
  createSprintLane,
  missionStatus,
  recordAttemptReceipt,
  recordFailureResult,
  recordLandingReceipt,
  recordRunGate,
  recordRunReturn,
  recordSprintGate,
  recordSprintLaneReturn,
  recordUnitResult,
  recordVerificationReceipt,
  releaseMission,
  releaseWorkClaim,
  startRun,
  startSprint,
  updateSprintLane,
} from '../src/lifecycle.mjs'
import {
  archiveTask,
  claimNextTask,
  closeRun,
  createRun,
  createSprint,
  createTask,
  updateTask,
} from '../src/work.mjs'
import { pathExists, readJson, walkFiles } from '../src/shared.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(repoRoot, 'bin', 'siso-project-os.mjs')

async function project(t, name = 'Lifecycle fixture') {
  const root = await mkdtemp(join(tmpdir(), 'siso-project-os-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [bin, 'init', root, '--name', name], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return root
}

function timestamp(second) {
  return `2026-07-29T00:00:${String(second).padStart(2, '0')}.000Z`
}

async function completeTask(root, taskId, by = 'test') {
  const current = (await import('../src/work.mjs')).findTask
  const entry = await current(root, taskId)
  if (entry.task.status === 'backlog') {
    await updateTask(root, taskId, { by, status: 'in_progress', log: 'started', now: timestamp(1) })
  }
  return updateTask(root, taskId, {
    by,
    status: 'completed',
    verified: true,
    command: 'node --test',
    evidence: `receipt://${taskId}`,
    log: 'completed',
    now: timestamp(2),
  })
}

function packet(runId, taskId, unitId, createdAt = timestamp(4)) {
  return {
    schema_version: 1,
    id: `PACKET-${unitId}`,
    to: 'worker',
    from: 'executive',
    thread: runId,
    objective: 'Implement the bounded unit',
    state: 'ready',
    mode: 'implementation',
    task_ids: [taskId],
    sprint_id: null,
    run_id: runId,
    anchors: [{ id: 'A1', path: 'AGENTS.md', description: 'Runtime contract', required: true }],
    facts: [],
    decisions: [],
    constraints: [{ id: 'C1', text: 'Stay inside the write fence' }],
    actions: [{ id: 'T1', text: 'Implement and verify', status: 'pending' }],
    verification: [{ id: 'V1', check: 'Tests pass', command: 'node --test' }],
    open_questions: [],
    write_fence: ['src/lifecycle.mjs'],
    return_contract: {
      destination: `.agents/runs/${runId}/returns/`,
      format: 'json',
      required_fields: ['status', 'summary'],
      final_verdict: 'PASS or FAIL',
    },
    stop_conditions: ['Stop on a write-fence conflict'],
    created_at: createdAt,
  }
}

test('mission ownership and resume snapshots fail closed and remain HTML-first', async (t) => {
  const root = await project(t)
  const task = await createTask(root, { title: 'Mission task', by: 'lead', now: timestamp(0) })
  const flags = {
    id: 'MISSION-lifecycle',
    objective: 'Carry lifecycle work to proof',
    owner: 'worker',
    owner_ancestry: ['lead'],
    task_ids: [task.id],
    now: timestamp(3),
  }
  const acquired = await acquireMission(root, flags)
  assert.equal(acquired.owner.actor, 'worker')
  assert.deepEqual(await acquireMission(root, flags), acquired, 'exact acquire retry is idempotent')
  await assert.rejects(
    acquireMission(root, { id: 'MISSION-other', objective: 'Conflicting mission', owner: 'other', now: timestamp(4) }),
    /already held/,
  )

  const snapshotFlags = {
    slug: 'lifecycle-resume',
    objective: 'Carry lifecycle work to proof',
    mission_id: acquired.id,
    task_ids: [task.id],
    first_read: ['AGENTS.md', '.agents/tasks/backlog/TASK-0001/task.json'],
    evidence_refs: ['receipt://mission'],
    next_gate: 'run verification',
    by: 'worker',
    now: timestamp(5),
  }
  const snapshot = await createResumeSnapshot(root, snapshotFlags)
  assert.deepEqual(await createResumeSnapshot(root, snapshotFlags), snapshot, 'snapshot retry is idempotent')
  await assert.rejects(createResumeSnapshot(root, { ...snapshotFlags, objective: 'Different bytes' }), /immutable/)
  const currentHtml = await readFile(join(root, '.agents', 'briefs', 'CURRENT.html'), 'utf8')
  assert.match(currentHtml, /id="project-os-current" type="application\/json"/)
  assert.match(currentHtml, new RegExp(snapshot.path.replaceAll('.', '\\.')))

  const released = await releaseMission(root, acquired.id, { by: 'lead', reason: 'handoff complete', now: timestamp(6) })
  assert.equal(released.state, 'released')
  assert.deepEqual(await missionStatus(root), [])
  const lifecycleMarkdown = (await walkFiles(join(root, '.agents'))).filter((path) => path.endsWith('.md'))
  assert.deepEqual(lifecycleMarkdown, [], 'lifecycle-owned template surfaces are HTML, JSON, or JSONL')
  for (const relativePath of (await walkFiles(join(root, '.agents'))).filter((path) => path.endsWith('.html'))) {
    const html = await readFile(join(root, '.agents', relativePath), 'utf8')
    assert.match(html, /^<!doctype html>/)
    const contracts = [...html.matchAll(/<script id="[^"]+" type="application\/json">([^<]+)<\/script>/g)]
    assert.ok(contracts.length > 0, `${relativePath} exposes an embedded JSON contract`)
    for (const contract of contracts) assert.doesNotThrow(() => JSON.parse(contract[1]))
  }
})

test('dependency-aware claim-next and safe archive preserve canonical task integrity', async (t) => {
  const root = await project(t)
  const dependency = await createTask(root, { title: 'Dependency', priority: 'high', by: 'lead', now: timestamp(0) })
  await completeTask(root, dependency.id)
  const human = await createTask(root, { title: 'Human gate', priority: 'critical', by: 'lead', 'requires-human': true, now: timestamp(3) })
  const ready = await createTask(root, { title: 'Ready task', priority: 'medium', deps: dependency.id, by: 'lead', now: timestamp(4) })
  await createTask(root, { title: 'Lower task', priority: 'low', by: 'lead', now: timestamp(5) })

  const claimed = await claimNextTask(root, { by: 'worker', owner: 'worker', now: timestamp(6) })
  assert.equal(claimed.id, ready.id)
  assert.equal(claimed.status, 'in_progress')
  assert.notEqual(claimed.id, human.id, 'explicit human gates are skipped by default')
  await completeTask(root, claimed.id, 'worker')

  const plan = await archiveTask(root, claimed.id, { by: 'lead', reason: 'delivered', dry_run: true, now: timestamp(7) })
  assert.equal(plan.dry_run, true)
  assert.equal(await pathExists(join(root, plan.destination)), false)
  const archived = await archiveTask(root, claimed.id, { by: 'lead', reason: 'delivered', now: timestamp(8) })
  assert.equal(archived.status, 'completed')
  assert.equal(archived.archive.previous_folder, 'completed')
  assert.equal(await pathExists(join(root, '.agents', 'tasks', 'archived', claimed.id, 'task.json')), true)
})

test('sprint lanes materialize artifacts, serialize overlapping fences, and gate close', async (t) => {
  const root = await project(t)
  const task = await createTask(root, { title: 'Sprint task', by: 'lead', now: timestamp(0) })
  const sprint = await createSprint(root, {
    title: 'Lifecycle sprint',
    tasks: task.id,
    gates: 'npm test',
    by: 'lead',
    now: timestamp(1),
    date: '2026-07-29',
  })
  await createSprintLane(root, sprint.id, {
    id: 'lane-a', owner: 'worker-a', by: 'lead', task_ids: [task.id], write_fence: ['src/lifecycle.mjs'], now: timestamp(2),
  })
  await assert.rejects(
    createSprintLane(root, sprint.id, {
      id: 'lane-conflict', owner: 'worker-b', by: 'lead', task_ids: [task.id], write_fence: ['src'], now: timestamp(3),
    }),
    /overlaps lane-a without explicit sequencing/,
  )
  await createSprintLane(root, sprint.id, {
    id: 'lane-b', owner: 'worker-b', by: 'lead', task_ids: [task.id], write_fence: ['src'], depends_on: ['lane-a'], now: timestamp(3),
  })
  await startSprint(root, sprint.id, { by: 'lead', base: 'base-sha', now: timestamp(4) })
  for (const [laneId, second] of [['lane-a', 5], ['lane-b', 8]]) {
    await updateSprintLane(root, sprint.id, laneId, { by: `worker-${laneId}`, status: 'running', now: timestamp(second) })
    await recordSprintLaneReturn(root, sprint.id, laneId, {
      by: `worker-${laneId}`,
      status: 'passed',
      summary: `${laneId} complete`,
      candidate_sha: `${laneId}-sha`,
      evidence_refs: [`receipt://${laneId}`],
      now: timestamp(second + 1),
    })
    await updateSprintLane(root, sprint.id, laneId, { by: 'lead', status: 'passed', now: timestamp(second + 2) })
  }
  await assert.rejects(closeSprint(root, sprint.id, { by: 'lead', summary: 'not gated', now: timestamp(11) }), /unresolved gates/)
  await recordSprintGate(root, sprint.id, 'gate-1', {
    by: 'verifier', status: 'passed', command: 'npm test', exit_code: 0, evidence_refs: ['receipt://sprint-gate'], now: timestamp(11),
  })
  const closed = await closeSprint(root, sprint.id, { by: 'lead', summary: 'all lanes passed', now: timestamp(12) })
  assert.equal(closed.status, 'completed')
  await archiveSprint(root, sprint.id, { by: 'lead', reason: 'sprint complete', now: timestamp(13) })
  assert.equal(await pathExists(join(root, '.agents', 'sprints', 'archived', sprint.id, 'sprint.json')), true)
})

test('run close refuses unsafe state and accepts independently verified landed census', async (t) => {
  const root = await project(t)
  const task = await createTask(root, { title: 'Run task', by: 'lead', now: timestamp(0) })
  const run = await createRun(root, {
    title: 'Lifecycle run', task: task.id, verify: 'npm test', base: 'base-sha', by: 'lead', now: timestamp(1), date: '2026-07-29',
  })
  await addRunUnit(root, run.id, {
    id: 'unit-a', task_ids: [task.id], write_fence: ['src/lifecycle.mjs'], by: 'lead', now: timestamp(2),
  })
  const dispatched = packet(run.id, task.id, 'unit-a', timestamp(3))
  await createRunPacket(root, run.id, dispatched, { unit_id: 'unit-a' })
  await assert.rejects(
    createRunPacket(root, run.id, { ...dispatched, objective: 'Silently edited objective' }, { unit_id: 'unit-a' }),
    /immutable/,
  )
  const amended = { ...dispatched, id: 'PACKET-unit-a-v2', objective: 'Implement the clarified bounded unit', amends: dispatched.id, created_at: timestamp(4) }
  await amendRunPacket(root, run.id, amended, { unit_id: 'unit-a' })
  await startRun(root, run.id, { by: 'lead', base: 'base-sha', now: timestamp(4) })
  await appendRunEvent(root, run.id, { at: timestamp(5), by: 'lead', action: 'dispatch_observed', description: 'Worker accepted amended packet' })
  const claim = await acquireWorkClaim(root, {
    id: 'CLAIM-run-unit-a', task_id: task.id, run_id: run.id, unit_id: 'unit-a', actor: 'worker', base_sha: 'base-sha', write_set: ['src/lifecycle.mjs'], now: timestamp(4),
  })
  assert.deepEqual(await acquireWorkClaim(root, {
    id: claim.id, task_id: task.id, run_id: run.id, unit_id: 'unit-a', actor: 'worker', base_sha: 'base-sha', write_set: ['src/lifecycle.mjs'], now: timestamp(5),
  }), claim)
  await assert.rejects(
    acquireWorkClaim(root, {
      id: 'CLAIM-conflict', task_id: task.id, run_id: run.id, unit_id: 'unit-a', actor: 'other', base_sha: 'base-sha', write_set: ['src'], now: timestamp(5),
    }),
    /conflicts with CLAIM-run-unit-a/,
  )
  await recordAttemptReceipt(root, run.id, 'unit-a', {
    schema_version: 1,
    run_id: run.id,
    unit_id: 'unit-a',
    attempt: 1,
    task_ids: [task.id],
    base_sha: 'base-sha',
    revalidated_base_sha: 'base-sha',
    checkout_sha: 'base-sha',
    detached: true,
    clean: true,
    worktree_ref: '.worktrees/unit-a',
    prerequisites: [{ name: 'node', mode: 'present', status: 'passed' }],
    status: 'ready',
    created_at: timestamp(5),
    created_by: 'runtime-adapter',
  })
  await recordRunReturn(root, run.id, 'unit-a', {
    packet_id: amended.id,
    actor: 'worker',
    role: 'implementer',
    status: 'passed',
    summary: 'Candidate ready',
    candidate_sha: 'candidate-sha',
    evidence_refs: ['receipt://candidate'],
    now: timestamp(6),
  })
  await assert.rejects(
    closeRun(root, run.id, { by: 'lead', verdict: 'passed', summary: 'unsafe', outputs: [{ path: 'result.json', classification: 'raw_run_history', rationale: 'retain' }], now: timestamp(7) }),
    /active work claims|unit unit-a is returned/,
  )
  await assert.rejects(
    recordVerificationReceipt(root, run.id, 'unit-a', {
      schema_version: 1,
      run_id: run.id,
      unit_id: 'unit-a',
      attempt: 1,
      actor: 'worker',
      verifier: 'worker',
      verifier_role: 'self',
      candidate_sha: 'candidate-sha',
      base_sha: 'base-sha',
      checks: [{ id: 'tests', command: 'npm test', status: 'passed', exit_code: 0, duration_ms: 100, evidence_ref: 'receipt://tests' }],
      changed_files: ['src/lifecycle.mjs'],
      overall: 'passed',
      evidence_refs: ['receipt://verification'],
      verified_at: timestamp(7),
    }),
    /distinct actor and verifier/,
  )
  const verification = await recordVerificationReceipt(root, run.id, 'unit-a', {
    schema_version: 1,
    run_id: run.id,
    unit_id: 'unit-a',
    attempt: 1,
    actor: 'worker',
    verifier: 'reviewer',
    verifier_role: 'independent',
    candidate_sha: 'candidate-sha',
    base_sha: 'base-sha',
    checks: [{ id: 'tests', command: 'npm test', status: 'passed', exit_code: 0, duration_ms: 100, evidence_ref: 'receipt://tests' }],
    changed_files: ['src/lifecycle.mjs'],
    overall: 'passed',
    evidence_refs: ['receipt://verification'],
    verified_at: timestamp(7),
  })
  await releaseWorkClaim(root, claim.id, { by: 'reviewer', receipt: verification.path, now: timestamp(8) })
  const gate = await recordRunGate(root, run.id, 'gate-1', {
    by: 'reviewer', status: 'passed', command: 'npm test', exit_code: 0, evidence_refs: ['receipt://run-gate'], now: timestamp(8),
  })
  const delivery = {
    schema_version: 1,
    id: 'DELIVERY-unit-a',
    objective: 'Serialize unit-a landing',
    task_ids: [task.id],
    run_id: run.id,
    base_ref: 'base-sha',
    ordered_refs: ['candidate-sha'],
    invariants: ['Only verified bytes land'],
    conflict_decisions: [],
    regeneration_steps: [],
    gates: ['npm test'],
    stop_ask_items: [],
    allowed_destination: 'refs/heads/main',
    push_policy: 'authorized',
    created_at: timestamp(9),
    created_by: 'lead',
  }
  await createDeliveryPlan(root, delivery)
  const landing = await recordLandingReceipt(root, delivery.id, {
    schema_version: 1,
    delivery_id: delivery.id,
    run_id: run.id,
    unit_id: 'unit-a',
    candidate_sha: 'candidate-sha',
    pre_sha: 'base-sha',
    post_sha: 'landed-sha',
    remote_sha: 'landed-sha',
    integrator: 'lander',
    verifier: 'reviewer',
    verification_receipt: verification.path,
    gate_receipts: [`.agents/runs/${run.id}/evidence/gates/${gate.id}.json`],
    push_policy: 'authorized',
    remote_equality: { status: 'passed', evidence_ref: 'receipt://remote-equality' },
    rollback: { required: false, status: 'not_required', evidence_ref: null },
    disposition: 'landed',
    recorded_at: timestamp(10),
  })
  await recordUnitResult(root, run.id, 'unit-a', {
    schema_version: 1,
    run_id: run.id,
    unit_id: 'unit-a',
    attempt: 1,
    disposition: 'landed',
    type: 'none',
    summary: 'Verified candidate landed',
    process: { exit_code: 0, signal: null, stderr_ref: null },
    candidate_sha: 'candidate-sha',
    worktree_ref: '.worktrees/unit-a',
    verification_receipt: verification.path,
    landing_receipt: landing.path,
    retained_artifacts: [verification.path, landing.path],
    recovery_action: 'No recovery required',
    next_attempt_policy: 'No next attempt',
    recorded_at: timestamp(11),
    recorded_by: 'lead',
  })
  const closed = await closeRun(root, run.id, {
    by: 'lead',
    verdict: 'passed',
    summary: 'Lifecycle census passed',
    outputs: [{ path: `.agents/runs/${run.id}/attempts/unit-a/attempt-1/result.json`, classification: 'raw_run_history', rationale: 'Retain terminal census' }],
    now: timestamp(12),
  })
  assert.equal(closed.status, 'completed')
  assert.equal(closed.closeout.outputs.length, 1)
  const retried = await closeRun(root, run.id, {
    by: 'lead',
    verdict: 'passed',
    summary: 'Lifecycle census passed',
    outputs: closed.closeout.outputs,
    now: timestamp(13),
  })
  assert.deepEqual(retried, closed, 'exact close retry is idempotent')
})

test('typed blocked result satisfies terminal failure census for a failed run', async (t) => {
  const root = await project(t)
  const task = await createTask(root, { title: 'Blocked unit task', by: 'lead', now: timestamp(0) })
  const run = await createRun(root, { title: 'Blocked run', task: task.id, base: 'base-sha', by: 'lead', now: timestamp(1), date: '2026-07-29' })
  await addRunUnit(root, run.id, { id: 'unit-blocked', task_ids: [task.id], write_fence: ['src/lifecycle.mjs'], by: 'lead', now: timestamp(2) })
  await createRunPacket(root, run.id, packet(run.id, task.id, 'unit-blocked', timestamp(3)), { unit_id: 'unit-blocked' })
  await startRun(root, run.id, { by: 'lead', base: 'base-sha', now: timestamp(4) })
  const claim = await acquireWorkClaim(root, {
    id: 'CLAIM-blocked-unit', task_id: task.id, run_id: run.id, unit_id: 'unit-blocked', actor: 'worker', base_sha: 'base-sha', write_set: ['src/lifecycle.mjs'], now: timestamp(4),
  })
  await recordFailureResult(root, run.id, 'unit-blocked', {
    schema_version: 1,
    run_id: run.id,
    unit_id: 'unit-blocked',
    attempt: 1,
    disposition: 'blocked',
    type: 'dependency',
    summary: 'Required external approval is unavailable',
    process: { exit_code: null, signal: null, stderr_ref: null },
    candidate_sha: null,
    worktree_ref: '.worktrees/unit-blocked',
    verification_receipt: null,
    landing_receipt: null,
    retained_artifacts: ['receipt://blocked'],
    recovery_action: 'Obtain the approval',
    next_attempt_policy: 'Retry only after approval',
    recorded_at: timestamp(5),
    recorded_by: 'worker',
  })
  await releaseWorkClaim(root, claim.id, {
    by: 'worker',
    receipt: `.agents/runs/${run.id}/attempts/unit-blocked/attempt-1/result.json`,
    now: timestamp(5),
  })
  const closed = await closeRun(root, run.id, {
    by: 'lead',
    verdict: 'failed',
    summary: 'Closed with durable blocked result',
    outputs: [{ path: `.agents/runs/${run.id}/attempts/unit-blocked/attempt-1/result.json`, classification: 'raw_run_history', rationale: 'Retain failure evidence' }],
    now: timestamp(6),
  })
  assert.equal(closed.status, 'failed')
  assert.equal((await readJson(join(root, '.agents', 'runs', run.id, 'queue.json'))).units[0].status, 'blocked')
})
