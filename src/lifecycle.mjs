import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  appendJsonLine,
  isoNow,
  listDirectories,
  pathExists,
  readJson,
  slugify,
  withExclusiveLock,
  writeJsonAtomic,
} from './shared.mjs'
import { assertProjectRecord } from './schema.mjs'
import { findTask } from './work.mjs'
import {
  TERMINAL_RESULT_DISPOSITIONS,
  assertRunCloseReady,
  createDirectoryAtomic,
  ensureInsideRoot,
  loadRecord,
  mutateDirectoryAtomic,
  normalizeRepoPath,
  normalizeWriteSet,
  pathCoveredByFence,
  readJsonLines,
  repositoryRelative,
  requiredString,
  sha256File,
  valuesList,
  withLifecycleLock,
  writeImmutableJson,
  writeSetsIntersect,
  writeTextAtomic,
} from './lifecycle-core.mjs'

const MISSION_ID = /^MISSION-[a-z0-9][a-z0-9-]*$/
const SPRINT_ID = /^SPRINT-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/
const RUN_ID = /^RUN-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CLAIM_ID = /^CLAIM-[A-Za-z0-9][A-Za-z0-9._-]*$/
const DELIVERY_ID = /^DELIVERY-[A-Za-z0-9][A-Za-z0-9._-]*$/

function pick(flags, snake, kebab = snake.replaceAll('_', '-')) {
  return flags?.[snake] ?? flags?.[kebab]
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return structuredClone(value)
}

function compactTimestamp(timestamp) {
  return timestamp.replace(/[-:.]/g, '')
}

function assertSafeId(value, label) {
  const id = requiredString(value, label)
  if (!SAFE_ID.test(id)) throw new Error(`${label} must match ${SAFE_ID}`)
  return id
}

async function assertSprint(root, id) {
  if (!SPRINT_ID.test(id)) throw new Error('sprint id must be SPRINT-YYYY-MM-DD-slug')
  return loadRecord(root, 'sprints', id, 'sprint.json')
}

async function assertRun(root, id) {
  if (!RUN_ID.test(id)) throw new Error('run id must be RUN-YYYY-MM-DD-slug')
  return loadRecord(root, 'runs', id, 'run.json')
}

async function assertTaskIds(root, taskIds) {
  for (const taskId of taskIds) await findTask(root, taskId)
}

async function appendStagedEvent(directory, filename, event) {
  const path = join(directory, filename)
  const records = await readJsonLines(path)
  const next = { ...(event.run_id ? { schema_version: 1 } : {}), ...event, seq: records.length + 1 }
  await appendJsonLine(path, next)
  return next
}

async function syncRunQueue(root, runDirectory, record, timestamp) {
  const queuePath = join(runDirectory, 'queue.json')
  const previous = await pathExists(queuePath)
    ? await readJson(queuePath)
    : { schema_version: 1, run_id: record.id, revision: 0, updated_at: timestamp, units: [], packet_digests: [] }
  const queue = {
    ...previous,
    schema_version: 1,
    run_id: record.id,
    revision: previous.revision + 1,
    updated_at: timestamp,
    units: structuredClone(record.units),
    packet_digests: previous.packet_digests ?? [],
  }
  await assertProjectRecord(root, 'run-queue', queue)
  await writeJsonAtomic(queuePath, queue)
  return queue
}

async function mutateRun(root, runId, operation) {
  const loaded = await assertRun(root, runId)
  return withLifecycleLock(root, 'runs', runId, async () => mutateDirectoryAtomic(loaded.directory, async (directory) => {
    const recordPath = join(directory, 'run.json')
    const record = await readJson(recordPath)
    const result = await operation({ directory, record, recordPath })
    await assertProjectRecord(root, 'run', record)
    await writeJsonAtomic(recordPath, record)
    return result ?? record
  }))
}

async function mutateSprint(root, sprintId, operation) {
  const loaded = await assertSprint(root, sprintId)
  return withLifecycleLock(root, 'sprints', sprintId, async () => mutateDirectoryAtomic(loaded.directory, async (directory) => {
    const recordPath = join(directory, 'sprint.json')
    const record = await readJson(recordPath)
    const result = await operation({ directory, record, recordPath })
    await assertProjectRecord(root, 'sprint', record)
    await writeJsonAtomic(recordPath, record)
    return result ?? record
  }))
}

function missionPath(root, missionId) {
  return join(root, '.agents', 'missions', `${missionId}.lock`)
}

export async function acquireMission(root, flags = {}) {
  const slug = slugify(pick(flags, 'slug') ?? pick(flags, 'id') ?? pick(flags, 'objective'))
  const id = typeof flags.id === 'string'
    ? flags.id
    : `MISSION-${slug.replace(/^mission-/, '')}`
  if (!MISSION_ID.test(id)) throw new Error('mission id must match MISSION-slug')
  const objective = requiredString(flags.objective, 'mission objective')
  const actor = requiredString(pick(flags, 'owner') ?? flags.by, 'mission owner')
  const ancestry = valuesList(pick(flags, 'owner_ancestry'))
  const rootDirectory = join(root, '.agents', 'missions')
  const lockDirectory = missionPath(root, id)
  await mkdir(join(rootDirectory, '.quarantine'), { recursive: true })
  await mkdir(join(rootDirectory, 'history'), { recursive: true })

  const active = (await listDirectories(rootDirectory)).filter((name) => name.endsWith('.lock'))
  if (active.length > 0) {
    if (active.length === 1 && active[0] === `${id}.lock`) {
      const current = await readJson(join(lockDirectory, 'meta.json'))
      if (current.owner.actor === actor && current.objective === objective && JSON.stringify(current.owner.ancestry) === JSON.stringify(ancestry)) {
        return current
      }
    }
    throw new Error(`mission ownership is already held by: ${active.join(', ')}; inspect or quarantine explicitly`)
  }

  const timestamp = isoNow(flags)
  const record = {
    schema_version: 1,
    id,
    slug: id.slice('MISSION-'.length),
    objective,
    state: 'acquired',
    owner: { actor, ancestry },
    acquired_at: timestamp,
    heartbeat_at: timestamp,
    active_task_ids: valuesList(pick(flags, 'task_ids') ?? flags.tasks),
    active_sprint_id: pick(flags, 'sprint_id') ?? null,
    active_run_id: pick(flags, 'run_id') ?? null,
  }
  await assertTaskIds(root, record.active_task_ids)
  if (record.active_sprint_id) await assertSprint(root, record.active_sprint_id)
  if (record.active_run_id) await assertRun(root, record.active_run_id)
  await assertProjectRecord(root, 'mission', record)
  await createDirectoryAtomic(lockDirectory, async (directory) => {
    await writeJsonAtomic(join(directory, 'meta.json'), record)
  })
  return record
}

export async function missionStatus(root, missionId = null) {
  const rootDirectory = join(root, '.agents', 'missions')
  if (missionId) {
    const path = join(missionPath(root, missionId), 'meta.json')
    if (!(await pathExists(path))) throw new Error(`${missionId} is not active`)
    return readJson(path)
  }
  const records = []
  for (const directory of (await listDirectories(rootDirectory)).filter((name) => name.endsWith('.lock'))) {
    records.push(await readJson(join(rootDirectory, directory, 'meta.json')))
  }
  return records.sort((left, right) => left.id.localeCompare(right.id))
}

export async function heartbeatMission(root, missionId, flags = {}) {
  const by = requiredString(flags.by, 'mission heartbeat actor')
  const directory = missionPath(root, missionId)
  const metaPath = join(directory, 'meta.json')
  if (!(await pathExists(metaPath))) throw new Error(`${missionId} is not active`)
  const record = await readJson(metaPath)
  if (![record.owner.actor, ...(record.owner.ancestry ?? [])].includes(by)) throw new Error(`${by} is outside the mission owner ancestry`)
  record.heartbeat_at = isoNow(flags)
  await assertProjectRecord(root, 'mission', record)
  await writeJsonAtomic(metaPath, record)
  return record
}

export async function releaseMission(root, missionId, flags = {}) {
  const by = requiredString(flags.by, 'mission release actor')
  const reason = requiredString(flags.reason, 'mission release reason')
  const directory = missionPath(root, missionId)
  const metaPath = join(directory, 'meta.json')
  if (!(await pathExists(metaPath))) throw new Error(`${missionId} is not active`)
  const record = await readJson(metaPath)
  if (![record.owner.actor, ...(record.owner.ancestry ?? [])].includes(by)) throw new Error(`${by} is outside the mission owner ancestry`)
  const timestamp = isoNow(flags)
  record.state = 'released'
  record.released_at = timestamp
  record.released_by = by
  record.release_reason = reason
  await assertProjectRecord(root, 'mission', record)
  await writeJsonAtomic(metaPath, record)
  const destination = join(root, '.agents', 'missions', 'history', `${compactTimestamp(timestamp)}-${missionId}.lock`)
  if (await pathExists(destination)) throw new Error(`mission history destination already exists: ${destination}`)
  await rename(directory, destination)
  return record
}

export async function quarantineMission(root, missionId, flags = {}) {
  const by = requiredString(flags.by, 'mission quarantine actor')
  const reason = requiredString(flags.reason, 'mission quarantine reason')
  const directory = missionPath(root, missionId)
  const metaPath = join(directory, 'meta.json')
  if (!(await pathExists(metaPath))) throw new Error(`${missionId} is not active`)
  const record = await readJson(metaPath)
  const timestamp = isoNow(flags)
  record.state = 'quarantined'
  record.quarantined_at = timestamp
  record.quarantined_by = by
  record.quarantine_reason = reason
  await assertProjectRecord(root, 'mission', record)
  await writeJsonAtomic(metaPath, record)
  const destination = join(root, '.agents', 'missions', '.quarantine', `${compactTimestamp(timestamp)}-${missionId}.lock`)
  if (await pathExists(destination)) throw new Error(`mission quarantine destination already exists: ${destination}`)
  await rename(directory, destination)
  return record
}

async function currentSnapshotPointer(root) {
  const currentPath = join(root, '.agents', 'briefs', 'CURRENT.html')
  if (!(await pathExists(currentPath))) return null
  const match = (await readFile(currentPath, 'utf8')).match(/<script id="project-os-current" type="application\/json">([^<]+)<\/script>/)
  if (!match) throw new Error('.agents/briefs/CURRENT.html lacks the project-os-current JSON contract')
  return JSON.parse(match[1]).snapshot ?? null
}

export async function createResumeSnapshot(root, flags = {}) {
  return withExclusiveLock(root, join('.agents', 'briefs', '.locks', 'snapshot.lock'), async () => {
    const createdAt = isoNow(flags)
    const slug = slugify(flags.slug ?? flags.objective)
    const taskIds = valuesList(pick(flags, 'task_ids') ?? flags.tasks)
    const sprintId = pick(flags, 'sprint_id') ?? null
    const runId = pick(flags, 'run_id') ?? null
    const missionId = pick(flags, 'mission_id') ?? null
    await assertTaskIds(root, taskIds)
    if (sprintId) await assertSprint(root, sprintId)
    if (runId) await assertRun(root, runId)
    if (missionId) await missionStatus(root, missionId)
    const firstRead = valuesList(pick(flags, 'first_read')).map(normalizeRepoPath)
    if (firstRead.length === 0) throw new Error('snapshot first_read must contain at least one path')
    for (const pointer of firstRead) {
      if (!(await pathExists(join(root, pointer)))) throw new Error(`snapshot first_read path does not exist: ${pointer}`)
    }
    const evidenceRefs = valuesList(pick(flags, 'evidence_refs') ?? flags.evidence)
    const relativePath = `.agents/briefs/snapshots/${compactTimestamp(createdAt)}-${slug}.snapshot.json`
    const previousSnapshot = await currentSnapshotPointer(root)
    if (previousSnapshot === relativePath && await pathExists(join(root, relativePath))) {
      const existing = await readJson(join(root, relativePath))
      const matches = existing.objective === flags.objective
        && existing.mission_id === missionId
        && JSON.stringify(existing.active_task_ids) === JSON.stringify(taskIds)
        && existing.active_sprint_id === sprintId
        && existing.active_run_id === runId
        && existing.blocker === (pick(flags, 'blocker') ?? null)
        && existing.next_gate === (pick(flags, 'next_gate') ?? null)
        && JSON.stringify(existing.evidence_refs) === JSON.stringify(evidenceRefs)
        && JSON.stringify(existing.first_read) === JSON.stringify(firstRead)
        && existing.created_by === flags.by
      if (matches) return { snapshot: existing, path: relativePath }
      throw new Error(`${relativePath} is immutable and the retry payload differs`)
    }
    const record = {
      schema_version: 1,
      id: `SNAPSHOT-${compactTimestamp(createdAt)}-${slug}`,
      objective: requiredString(flags.objective, 'snapshot objective'),
      mission_id: missionId,
      active_task_ids: taskIds,
      active_sprint_id: sprintId,
      active_run_id: runId,
      blocker: pick(flags, 'blocker') ?? null,
      next_gate: pick(flags, 'next_gate') ?? null,
      evidence_refs: evidenceRefs,
      first_read: firstRead,
      previous_snapshot: previousSnapshot,
      created_at: createdAt,
      created_by: requiredString(flags.by, 'snapshot creator'),
    }
    await assertProjectRecord(root, 'resume-snapshot', record)
    const snapshotPath = join(root, relativePath)
    await writeImmutableJson(snapshotPath, record)
    const current = {
      schema_version: 1,
      snapshot: relativePath,
      objective: record.objective,
      mission_id: record.mission_id,
      task_ids: record.active_task_ids,
      sprint_id: record.active_sprint_id,
      run_id: record.active_run_id,
      next_gate: record.next_gate,
      updated_at: record.created_at,
      updated_by: record.created_by,
    }
    const json = JSON.stringify(current).replaceAll('<', '\\u003c')
    const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Current project resume</title></head><body>\n<main data-contract="project-os-current"><h1>Current project resume</h1><dl><dt>Objective</dt><dd>${escapeHtml(record.objective)}</dd><dt>Snapshot</dt><dd><code>${escapeHtml(relativePath)}</code></dd><dt>Mission</dt><dd>${escapeHtml(record.mission_id ?? 'none')}</dd><dt>Tasks</dt><dd>${escapeHtml(record.active_task_ids.join(', ') || 'none')}</dd><dt>Sprint</dt><dd>${escapeHtml(record.active_sprint_id ?? 'none')}</dd><dt>Run</dt><dd>${escapeHtml(record.active_run_id ?? 'none')}</dd><dt>Next gate</dt><dd>${escapeHtml(record.next_gate ?? 'none')}</dd><dt>Updated</dt><dd>${escapeHtml(`${record.created_at} by ${record.created_by}`)}</dd></dl><p>This HTML is an atomic projection. The linked JSON snapshot is immutable and canonical.</p></main>\n<script id="project-os-current" type="application/json">${json}</script>\n</body></html>\n`
    await writeTextAtomic(join(root, '.agents', 'briefs', 'CURRENT.html'), html)
    return { snapshot: record, path: relativePath }
  })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function activeWorkClaims(root) {
  const directory = join(root, '.agents', 'work-claims', 'active')
  if (!(await pathExists(directory))) return []
  const records = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) records.push(await readJson(join(directory, entry.name)))
  }
  return records.filter((record) => record.state === 'active')
}

export async function acquireWorkClaim(root, flags = {}) {
  const taskId = requiredString(pick(flags, 'task_id') ?? flags.task, 'work claim task_id')
  const runId = pick(flags, 'run_id') ?? null
  const unitId = pick(flags, 'unit_id') ?? null
  const actor = requiredString(flags.actor ?? flags.by, 'work claim actor')
  const attempt = Number(pick(flags, 'attempt') ?? 1)
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('work claim attempt must be a positive integer')
  const writeSet = normalizeWriteSet(pick(flags, 'write_set') ?? pick(flags, 'write_fence') ?? flags.paths)
  if (writeSet.length === 0) throw new Error('work claim write_set must not be empty')
  if (!runId || !unitId) throw new Error('work claim requires run_id and unit_id so it has a reachable release proof')
  await findTask(root, taskId)
  const run = await assertRun(root, runId)
  if (!run.record.task_ids.includes(taskId)) throw new Error(`${taskId} is outside ${runId}`)
  if (!run.record.units.some((unit) => unit.id === unitId)) throw new Error(`${unitId} is outside ${runId}`)
  const requestedId = flags.id ?? `CLAIM-${taskId}-${unitId ?? slugify(actor)}-${attempt}`
  if (!CLAIM_ID.test(requestedId)) throw new Error('work claim id must match CLAIM-name')
  return withExclusiveLock(root, join('.agents', 'work-claims', '.locks', 'registry.lock'), async () => {
    const activePath = join(root, '.agents', 'work-claims', 'active', `${requestedId}.json`)
    if (await pathExists(activePath)) {
      const existing = await readJson(activePath)
      const same = existing.task_id === taskId && existing.run_id === runId && existing.unit_id === unitId
        && existing.actor === actor && existing.seat === (pick(flags, 'seat') ?? null)
        && existing.attempt === attempt && existing.base_sha === pick(flags, 'base_sha')
        && JSON.stringify(existing.write_set) === JSON.stringify(writeSet)
      if (same) return existing
      throw new Error(`${requestedId} already exists with a different reservation`)
    }
    for (const existing of await activeWorkClaims(root)) {
      if (writeSetsIntersect(writeSet, existing.write_set)) {
        throw new Error(`${requestedId} conflicts with ${existing.id}: ${writeSet.join(', ')} intersects ${existing.write_set.join(', ')}`)
      }
    }
    const timestamp = isoNow(flags)
    const record = {
      schema_version: 1,
      id: requestedId,
      task_id: taskId,
      run_id: runId,
      unit_id: unitId,
      actor,
      seat: pick(flags, 'seat') ?? null,
      attempt,
      base_sha: requiredString(pick(flags, 'base_sha'), 'work claim base_sha'),
      write_set: writeSet,
      state: 'active',
      acquired_at: timestamp,
      acquire_receipt: { by: actor, at: timestamp },
    }
    await assertProjectRecord(root, 'work-claim', record)
    await writeJsonAtomic(activePath, record)
    return record
  })
}

export async function releaseWorkClaim(root, claimId, flags = {}) {
  if (!CLAIM_ID.test(claimId)) throw new Error('work claim id must match CLAIM-name')
  const by = requiredString(flags.by, 'work claim release actor')
  const receiptPointer = requiredString(pick(flags, 'receipt'), 'work claim release receipt')
  return withExclusiveLock(root, join('.agents', 'work-claims', '.locks', 'registry.lock'), async () => {
    const activePath = join(root, '.agents', 'work-claims', 'active', `${claimId}.json`)
    const releasedPath = join(root, '.agents', 'work-claims', 'released', `${claimId}.json`)
    if (!(await pathExists(activePath))) {
      if (await pathExists(releasedPath)) return readJson(releasedPath)
      throw new Error(`${claimId} is not active`)
    }
    if (await pathExists(releasedPath)) throw new Error(`${claimId} release destination already exists`)
    const record = await readJson(activePath)
    const absoluteReceipt = await ensureInsideRoot(root, receiptPointer)
    if (!(await pathExists(absoluteReceipt))) throw new Error(`release receipt does not exist: ${receiptPointer}`)
    const receipt = await readJson(absoluteReceipt)
    let releaseKind
    if (receipt.overall === 'passed') {
      await assertProjectRecord(root, 'verification-receipt', receipt)
      if (receipt.run_id !== record.run_id || receipt.unit_id !== record.unit_id) throw new Error('verification receipt does not belong to this claim')
      if (receipt.actor === receipt.verifier) throw new Error('work claim cannot release on self-verification')
      releaseKind = 'verified'
    } else if (receipt.disposition === 'blocked') {
      await assertProjectRecord(root, 'failure-result', receipt)
      if (receipt.run_id !== record.run_id || receipt.unit_id !== record.unit_id) throw new Error('blocked result does not belong to this claim')
      releaseKind = 'blocked'
    } else {
      throw new Error('work claim release requires passed independent verification or a durable blocked result')
    }
    const timestamp = isoNow(flags)
    record.state = 'released'
    record.released_at = timestamp
    record.release_receipt = { by, at: timestamp, kind: releaseKind, ref: normalizeRepoPath(receiptPointer) }
    await assertProjectRecord(root, 'work-claim', record)
    await writeJsonAtomic(activePath, record)
    await mkdir(join(root, '.agents', 'work-claims', 'released'), { recursive: true })
    await rename(activePath, releasedPath)
    return record
  })
}

export async function createSprintLane(root, sprintId, flags = {}) {
  const laneId = assertSafeId(flags.id, 'lane id')
  const owner = requiredString(flags.owner ?? flags.by, 'lane owner')
  const taskIds = valuesList(pick(flags, 'task_ids') ?? flags.tasks)
  const writeFence = normalizeWriteSet(pick(flags, 'write_fence') ?? flags.paths)
  const dependsOn = valuesList(pick(flags, 'depends_on') ?? flags.depends)
  if (taskIds.length === 0 || writeFence.length === 0) throw new Error('lane requires task_ids and a non-empty write_fence')
  await assertTaskIds(root, taskIds)
  return mutateSprint(root, sprintId, async ({ directory, record }) => {
    if (record.status !== 'planned') throw new Error('sprint lanes are frozen after sprint start')
    if (record.lanes.some((lane) => lane.id === laneId)) throw new Error(`lane ${laneId} already exists`)
    for (const taskId of taskIds) if (!record.task_ids.includes(taskId)) throw new Error(`lane task ${taskId} is outside ${sprintId}`)
    for (const dependency of dependsOn) if (!record.lanes.some((lane) => lane.id === dependency)) throw new Error(`lane dependency ${dependency} does not exist`)
    for (const existing of record.lanes) {
      if (writeSetsIntersect(writeFence, existing.write_fence) && !dependsOn.includes(existing.id)) {
        throw new Error(`lane ${laneId} write fence overlaps ${existing.id} without explicit sequencing`)
      }
    }
    const timestamp = isoNow(flags)
    const basePath = `.agents/sprints/${sprintId}/lanes/${laneId}`
    const packet = {
      schema_version: 1,
      sprint_id: sprintId,
      lane_id: laneId,
      objective: requiredString(flags.objective ?? record.objective, 'lane objective'),
      owner,
      task_ids: taskIds,
      write_fence: writeFence,
      depends_on: dependsOn,
      created_at: timestamp,
      created_by: requiredString(flags.by ?? owner, 'lane creator'),
    }
    const state = {
      schema_version: 1,
      sprint_id: sprintId,
      lane_id: laneId,
      owner,
      task_ids: taskIds,
      status: 'ready',
      write_fence: writeFence,
      depends_on: dependsOn,
      packet_path: `${basePath}/brief.packet.json`,
      log_seq: 1,
      returns: [],
      current_gate: null,
      blocker: null,
      updated_at: timestamp,
      updated_by: packet.created_by,
    }
    await assertProjectRecord(root, 'lane-packet', packet)
    await assertProjectRecord(root, 'lane-state', state)
    const laneDirectory = join(directory, 'lanes', laneId)
    await mkdir(join(laneDirectory, 'returns'), { recursive: true })
    await writeJsonAtomic(join(laneDirectory, 'brief.packet.json'), packet)
    await writeJsonAtomic(join(laneDirectory, 'state.json'), state)
    await writeFile(join(laneDirectory, 'log.jsonl'), `${JSON.stringify({ seq: 1, at: timestamp, by: packet.created_by, action: 'created', status: 'ready' })}\n`, 'utf8')
    record.lanes.push({
      id: laneId,
      owner,
      task_ids: taskIds,
      write_fence: writeFence,
      depends_on: dependsOn,
      packet_path: state.packet_path,
      state_path: `${basePath}/state.json`,
    })
    return { lane: record.lanes.at(-1), state, packet }
  })
}

export async function startSprint(root, sprintId, flags = {}) {
  return mutateSprint(root, sprintId, async ({ directory, record }) => {
    if (record.status === 'active') return record
    if (record.status !== 'planned') throw new Error(`${sprintId} cannot start from ${record.status}`)
    if (record.task_ids.length === 0) throw new Error(`${sprintId} cannot start without tasks`)
    if (record.lanes.length === 0) throw new Error(`${sprintId} cannot start without executable lanes`)
    record.base_ref = requiredString(flags.base ?? record.base_ref, 'sprint base_ref')
    for (const lane of record.lanes) {
      if (!(await pathExists(join(root, lane.packet_path))) || !(await pathExists(join(root, lane.state_path)))) {
        throw new Error(`lane ${lane.id} artifacts are incomplete`)
      }
    }
    record.status = 'active'
    record.started_at = isoNow(flags)
    await appendStagedEvent(directory, 'ledger.jsonl', { at: record.started_at, by: requiredString(flags.by, 'sprint starter'), action: 'started' })
    return record
  })
}

const LANE_TRANSITIONS = {
  ready: ['running', 'cancelled'],
  running: ['blocked', 'returned', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  returned: ['passed', 'failed', 'running'],
  passed: [],
  failed: [],
  cancelled: [],
}

export async function updateSprintLane(root, sprintId, laneId, flags = {}) {
  const nextStatus = requiredString(flags.status, 'lane status')
  const by = requiredString(flags.by, 'lane update actor')
  return mutateSprint(root, sprintId, async ({ directory, record }) => {
    if (!['active', 'blocked'].includes(record.status)) throw new Error(`${sprintId} is not active`)
    const lane = record.lanes.find((candidate) => candidate.id === laneId)
    if (!lane) throw new Error(`lane ${laneId} does not exist`)
    const statePath = join(directory, 'lanes', laneId, 'state.json')
    const state = await readJson(statePath)
    if (state.status === nextStatus) return state
    if (!LANE_TRANSITIONS[state.status]?.includes(nextStatus)) throw new Error(`invalid lane transition ${state.status} -> ${nextStatus}`)
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
    if (nextStatus === 'blocked' && !reason) throw new Error('blocked lane requires a reason')
    if (state.status === 'blocked' && nextStatus === 'running' && !reason) throw new Error('blocked lane resume requires a resolution reason')
    const timestamp = isoNow(flags)
    const event = await appendStagedEvent(join(directory, 'lanes', laneId), 'log.jsonl', {
      at: timestamp,
      by,
      action: reason || `transitioned to ${nextStatus}`,
      status: nextStatus,
    })
    state.status = nextStatus
    state.log_seq = event.seq
    state.blocker = nextStatus === 'blocked' ? { reason, since: timestamp } : null
    state.updated_at = timestamp
    state.updated_by = by
    await assertProjectRecord(root, 'lane-state', state)
    await writeJsonAtomic(statePath, state)
    return state
  })
}

export async function recordSprintLaneReturn(root, sprintId, laneId, flags = {}) {
  const by = requiredString(flags.by, 'lane return actor')
  return mutateSprint(root, sprintId, async ({ directory, record }) => {
    const lane = record.lanes.find((candidate) => candidate.id === laneId)
    if (!lane) throw new Error(`lane ${laneId} does not exist`)
    const statePath = join(directory, 'lanes', laneId, 'state.json')
    const state = await readJson(statePath)
    if (!['running', 'blocked', 'returned'].includes(state.status)) throw new Error(`lane ${laneId} cannot return from ${state.status}`)
    const timestamp = isoNow(flags)
    const returnId = flags.id ?? `RETURN-${laneId}-${compactTimestamp(timestamp)}`
    assertSafeId(returnId, 'lane return id')
    const receipt = {
      schema_version: 1,
      id: returnId,
      scope: 'sprint_lane',
      sprint_id: sprintId,
      run_id: pick(flags, 'run_id') ?? null,
      lane_id: laneId,
      unit_id: null,
      packet_id: null,
      actor: by,
      role: requiredString(flags.role ?? 'worker', 'lane return role'),
      status: requiredString(flags.status ?? 'passed', 'lane return status'),
      summary: requiredString(flags.summary, 'lane return summary'),
      candidate_sha: pick(flags, 'candidate_sha') ?? null,
      evidence_refs: valuesList(pick(flags, 'evidence_refs') ?? flags.evidence),
      result_ref: pick(flags, 'result_ref') ?? null,
      created_at: timestamp,
    }
    await assertProjectRecord(root, 'run-return', receipt)
    if (receipt.run_id) await assertRun(root, receipt.run_id)
    const relativePath = `.agents/sprints/${sprintId}/lanes/${laneId}/returns/${returnId}.json`
    const immutable = await writeImmutableJson(join(directory, 'lanes', laneId, 'returns', `${returnId}.json`), receipt)
    if (!immutable.created) return receipt
    if (!state.returns.includes(relativePath)) state.returns.push(relativePath)
    state.status = receipt.status === 'passed' ? 'returned' : receipt.status
    state.updated_at = timestamp
    state.updated_by = by
    const event = await appendStagedEvent(join(directory, 'lanes', laneId), 'log.jsonl', { at: timestamp, by, action: 'return_recorded', status: state.status, ref: relativePath })
    state.log_seq = event.seq
    await assertProjectRecord(root, 'lane-state', state)
    await writeJsonAtomic(statePath, state)
    return receipt
  })
}

async function gateReceipt(root, scope, ownerId, gate, flags) {
  const status = requiredString(flags.status, 'gate status')
  if (!['passed', 'failed', 'waived'].includes(status)) throw new Error('gate status must be passed, failed, or waived')
  const evidenceRefs = valuesList(pick(flags, 'evidence_refs') ?? flags.evidence)
  if (status !== 'waived' && evidenceRefs.length === 0) throw new Error('passed or failed gates require evidence_refs')
  const timestamp = isoNow(flags)
  const receipt = {
    schema_version: 1,
    id: `GATE-${ownerId}-${gate.id}-${compactTimestamp(timestamp)}`,
    scope,
    owner_id: ownerId,
    gate_id: gate.id,
    status,
    command: flags.command ?? gate.command ?? null,
    exit_code: Number.isInteger(flags.exit_code) ? flags.exit_code : (status === 'passed' ? 0 : null),
    evidence_refs: evidenceRefs,
    waiver_reason: status === 'waived' ? requiredString(flags.reason, 'gate waiver reason') : null,
    recorded_at: timestamp,
    recorded_by: requiredString(flags.by, 'gate recorder'),
  }
  await assertProjectRecord(root, 'gate-receipt', receipt)
  return receipt
}

export async function recordSprintGate(root, sprintId, gateId, flags = {}) {
  return mutateSprint(root, sprintId, async ({ directory, record }) => {
    const gate = record.gates.find((candidate) => candidate.id === gateId)
    if (!gate) throw new Error(`gate ${gateId} does not exist`)
    const receipt = await gateReceipt(root, 'sprint', sprintId, gate, flags)
    const relativePath = `.agents/sprints/${sprintId}/evidence/gates/${receipt.id}.json`
    const immutable = await writeImmutableJson(join(directory, 'evidence', 'gates', `${receipt.id}.json`), receipt)
    if (!immutable.created) return receipt
    gate.status = receipt.status
    gate.evidence_refs = [...new Set([...gate.evidence_refs, relativePath, ...receipt.evidence_refs])]
    await appendStagedEvent(directory, 'ledger.jsonl', { at: receipt.recorded_at, by: receipt.recorded_by, action: 'gate_recorded', gate_id: gateId, status: gate.status, ref: relativePath })
    return receipt
  })
}

export async function closeSprint(root, sprintId, flags = {}) {
  const by = requiredString(flags.by, 'sprint close actor')
  const summary = requiredString(flags.summary, 'sprint close summary')
  const status = flags.status ?? 'completed'
  if (!['completed', 'cancelled'].includes(status)) throw new Error('sprint close status must be completed or cancelled')
  return mutateSprint(root, sprintId, async ({ directory, record }) => {
    const runIds = valuesList(pick(flags, 'run_ids') ?? flags.runs)
    if (['completed', 'cancelled'].includes(record.status)) {
      const same = record.status === status && record.closeout?.closed_by === by && record.closeout?.summary === summary
        && JSON.stringify(record.closeout?.run_ids ?? []) === JSON.stringify(runIds)
      if (same) return record
      throw new Error(`${sprintId} is already closed with a different receipt`)
    }
    for (const runId of runIds) {
      const run = await assertRun(root, runId)
      if (run.record.sprint_id !== sprintId) throw new Error(`${runId} does not belong to ${sprintId}`)
      if (!['completed', 'failed', 'cancelled'].includes(run.record.status)) throw new Error(`${runId} is not terminal`)
    }
    if (status === 'completed') {
      const unresolvedGates = record.gates.filter((gate) => gate.required && !['passed', 'waived'].includes(gate.status))
      if (unresolvedGates.length > 0) throw new Error(`${sprintId} has unresolved gates: ${unresolvedGates.map((gate) => gate.id).join(', ')}`)
      for (const lane of record.lanes) {
        const state = await readJson(join(directory, 'lanes', lane.id, 'state.json'))
        if (state.status !== 'passed') throw new Error(`${sprintId} lane ${lane.id} is ${state.status}`)
      }
    }
    const timestamp = isoNow(flags)
    record.status = status
    record.closeout = {
      closed_at: timestamp,
      closed_by: by,
      summary,
      run_ids: runIds,
      archive_path: `.agents/sprints/archived/${sprintId}`,
    }
    await appendStagedEvent(directory, 'ledger.jsonl', { at: timestamp, by, action: 'closed', status })
    return record
  })
}

export async function archiveSprint(root, sprintId, flags = {}) {
  const by = requiredString(flags.by, 'sprint archive actor')
  const reason = requiredString(flags.reason, 'sprint archive reason')
  const loaded = await assertSprint(root, sprintId)
  if (!['completed', 'cancelled'].includes(loaded.record.status)) throw new Error('only terminal sprints can be archived')
  const destination = join(root, '.agents', 'sprints', 'archived', sprintId)
  if (await pathExists(destination)) throw new Error(`archive destination already exists for ${sprintId}`)
  if (flags.dry_run === true || flags['dry-run'] === true) return { id: sprintId, source: repositoryRelative(root, loaded.directory), destination: repositoryRelative(root, destination), dry_run: true }
  return withLifecycleLock(root, 'sprints', sprintId, async () => {
    await mutateDirectoryAtomic(loaded.directory, async (directory) => {
      await appendStagedEvent(directory, 'ledger.jsonl', { at: isoNow(flags), by, action: 'archived', reason })
    })
    await mkdir(join(root, '.agents', 'sprints', 'archived'), { recursive: true })
    await rename(loaded.directory, destination)
    return { id: sprintId, destination: repositoryRelative(root, destination), archived_by: by, reason }
  })
}

export async function startRun(root, runId, flags = {}) {
  return mutateRun(root, runId, async ({ directory, record }) => {
    if (record.status === 'running') return record
    if (record.status !== 'planned') throw new Error(`${runId} cannot start from ${record.status}`)
    record.base_ref = requiredString(flags.base ?? record.base_ref, 'run base_ref')
    record.status = 'running'
    record.started_at = isoNow(flags)
    const by = requiredString(flags.by, 'run starter')
    await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: record.started_at, by, action: 'started' })
    await syncRunQueue(root, directory, record, record.started_at)
    return record
  })
}

export async function addRunUnit(root, runId, flags = {}) {
  const unitId = assertSafeId(flags.id, 'run unit id')
  const taskIds = valuesList(pick(flags, 'task_ids') ?? flags.tasks)
  const dependsOn = valuesList(pick(flags, 'depends_on') ?? flags.depends)
  const writeFence = normalizeWriteSet(pick(flags, 'write_fence') ?? flags.paths)
  const packetId = flags.packet_id ?? flags['packet-id'] ?? `PACKET-${unitId}`
  if (taskIds.length === 0 || writeFence.length === 0) throw new Error('run unit requires task_ids and a non-empty write_fence')
  return mutateRun(root, runId, async ({ directory, record }) => {
    if (!['planned', 'running'].includes(record.status)) throw new Error(`${runId} cannot accept units while ${record.status}`)
    if (record.units.some((unit) => unit.id === unitId)) throw new Error(`run unit ${unitId} already exists`)
    for (const taskId of taskIds) {
      await findTask(root, taskId)
      if (!record.task_ids.includes(taskId)) throw new Error(`run unit task ${taskId} is outside ${runId}`)
    }
    for (const dependency of dependsOn) if (!record.units.some((unit) => unit.id === dependency)) throw new Error(`run unit dependency ${dependency} does not exist`)
    const unit = {
      id: unitId,
      task_ids: taskIds,
      status: 'ready',
      depends_on: dependsOn,
      packet_path: `.agents/runs/${runId}/briefs/${packetId}.json`,
      write_fence: writeFence,
    }
    if (flags.assignee) unit.assignee = requiredString(flags.assignee, 'run unit assignee')
    record.units.push(unit)
    const timestamp = isoNow(flags)
    await mkdir(join(directory, 'attempts', unitId, 'attempt-1'), { recursive: true })
    await syncRunQueue(root, directory, record, timestamp)
    await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: timestamp, by: requiredString(flags.by, 'run unit creator'), action: 'unit_added', unit_id: unitId })
    return unit
  })
}

export async function createRunPacket(root, runId, packetValue, options = {}) {
  const packet = objectValue(packetValue, 'agent packet')
  return mutateRun(root, runId, async ({ directory, record }) => {
    if (packet.run_id !== runId) throw new Error(`packet ${packet.id} belongs to ${packet.run_id}, not ${runId}`)
    packet.write_fence = normalizeWriteSet(packet.write_fence)
    for (const anchor of packet.anchors ?? []) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(anchor.path)) continue
      anchor.path = normalizeRepoPath(anchor.path)
      if (anchor.required && !(await pathExists(join(root, anchor.path)))) throw new Error(`required packet anchor does not exist: ${anchor.path}`)
    }
    for (const taskId of packet.task_ids ?? []) {
      await findTask(root, taskId)
      if (!record.task_ids.includes(taskId)) throw new Error(`packet task ${taskId} is outside ${runId}`)
    }
    if (packet.sprint_id !== undefined && packet.sprint_id !== record.sprint_id) throw new Error('packet sprint_id disagrees with run')
    if (packet.amends) {
      const priorPath = join(directory, 'briefs', `${packet.amends}.json`)
      if (!(await pathExists(priorPath))) throw new Error(`packet amendment target ${packet.amends} does not exist`)
      const prior = await readJson(priorPath)
      if (packet.created_at <= prior.created_at) throw new Error('packet amendment must be newer than the packet it amends')
    }
    await assertProjectRecord(root, 'agent-packet', packet)
    const packetPath = join(directory, 'briefs', `${packet.id}.json`)
    const immutable = await writeImmutableJson(packetPath, packet)
    const relativePath = `.agents/runs/${runId}/briefs/${packet.id}.json`
    if (!record.packets.includes(relativePath)) record.packets.push(relativePath)
    const unitId = options.unit_id ?? options.unitId
    let selectedUnit = null
    if (unitId) {
      selectedUnit = record.units.find((candidate) => candidate.id === unitId)
      if (!selectedUnit) throw new Error(`run unit ${unitId} does not exist`)
      if (JSON.stringify(selectedUnit.write_fence) !== JSON.stringify(packet.write_fence)) throw new Error(`packet write_fence disagrees with unit ${unitId}`)
      if (!packet.task_ids.every((taskId) => selectedUnit.task_ids.includes(taskId))) throw new Error(`packet tasks exceed unit ${unitId}`)
      selectedUnit.packet_path = relativePath
    }
    if (!immutable.created) {
      const currentQueue = await readJson(join(directory, 'queue.json'))
      const currentDigest = await sha256File(packetPath)
      const digestMatches = currentQueue.packet_digests.some((entry) => entry.path === `briefs/${packet.id}.json` && entry.sha256 === currentDigest)
      if (digestMatches && (!selectedUnit || selectedUnit.packet_path === relativePath)) return packet
    }
    const queue = await syncRunQueue(root, directory, record, packet.created_at)
    const digest = await sha256File(packetPath)
    const queuePacketPath = `briefs/${packet.id}.json`
    const currentDigest = queue.packet_digests.find((entry) => entry.path === queuePacketPath)
    if (currentDigest && currentDigest.sha256 !== digest) throw new Error(`packet digest changed for ${packet.id}`)
    if (!currentDigest) queue.packet_digests.push({ path: queuePacketPath, sha256: digest })
    await assertProjectRecord(root, 'run-queue', queue)
    await writeJsonAtomic(join(directory, 'queue.json'), queue)
    if (immutable.created) {
      await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: packet.created_at, by: packet.from, action: packet.amends ? 'packet_amended' : 'packet_created', packet_id: packet.id, ref: relativePath })
    }
    return packet
  })
}

export async function amendRunPacket(root, runId, packetValue, options = {}) {
  if (!packetValue?.amends) throw new Error('packet amendment requires amends')
  return createRunPacket(root, runId, packetValue, options)
}

export async function inspectRunCloseCensus(root, runId, options = {}) {
  const loaded = await assertRun(root, runId)
  return assertRunCloseReady(root, runId, loaded.record, options)
}

export async function recordRunReturn(root, runId, unitId, flags = {}) {
  return mutateRun(root, runId, async ({ directory, record }) => {
    const unit = record.units.find((candidate) => candidate.id === unitId)
    if (!unit) throw new Error(`run unit ${unitId} does not exist`)
    const packetId = requiredString(pick(flags, 'packet_id'), 'return packet_id')
    if (!record.packets.some((pointer) => basename(pointer, '.json') === packetId)) throw new Error(`return packet ${packetId} does not exist`)
    const timestamp = isoNow(flags)
    const returnId = flags.id ?? `RETURN-${unitId}-${compactTimestamp(timestamp)}`
    assertSafeId(returnId, 'run return id')
    const status = flags.status ?? 'passed'
    const receipt = {
      schema_version: 1,
      id: returnId,
      scope: 'run_unit',
      sprint_id: record.sprint_id,
      run_id: runId,
      lane_id: null,
      unit_id: unitId,
      packet_id: packetId,
      actor: requiredString(flags.actor ?? flags.by, 'return actor'),
      role: requiredString(flags.role ?? 'worker', 'return role'),
      status,
      summary: requiredString(flags.summary, 'return summary'),
      candidate_sha: pick(flags, 'candidate_sha') ?? null,
      evidence_refs: valuesList(pick(flags, 'evidence_refs') ?? flags.evidence),
      result_ref: pick(flags, 'result_ref') ?? null,
      created_at: timestamp,
    }
    await assertProjectRecord(root, 'run-return', receipt)
    const relativePath = `.agents/runs/${runId}/returns/${returnId}.json`
    const immutable = await writeImmutableJson(join(directory, 'returns', `${returnId}.json`), receipt)
    if (!immutable.created) return receipt
    unit.return_path = relativePath
    unit.status = status === 'passed' ? 'returned' : status
    record.receipts.push({ at: timestamp, kind: 'return', ref: relativePath, description: receipt.summary })
    await syncRunQueue(root, directory, record, timestamp)
    await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: timestamp, by: receipt.actor, action: 'return_recorded', unit_id: unitId, ref: relativePath, status: unit.status })
    return receipt
  })
}

export async function appendRunEvent(root, runId, eventValue) {
  const event = objectValue(eventValue, 'run event')
  return mutateRun(root, runId, async ({ directory }) => {
    const records = await readJsonLines(join(directory, 'ledger.jsonl'))
    const record = { ...event, schema_version: 1, run_id: runId, seq: records.length + 1 }
    await assertProjectRecord(root, 'run-event', record)
    await appendJsonLine(join(directory, 'ledger.jsonl'), record)
    return record
  })
}

export async function recordRunGate(root, runId, gateId, flags = {}) {
  return mutateRun(root, runId, async ({ directory, record }) => {
    const gate = record.gates.find((candidate) => candidate.id === gateId)
    if (!gate) throw new Error(`gate ${gateId} does not exist`)
    const receipt = await gateReceipt(root, 'run', runId, gate, flags)
    const relativePath = `.agents/runs/${runId}/evidence/gates/${receipt.id}.json`
    const immutable = await writeImmutableJson(join(directory, 'evidence', 'gates', `${receipt.id}.json`), receipt)
    if (!immutable.created) return receipt
    gate.status = receipt.status
    gate.evidence_refs = [...new Set([...gate.evidence_refs, relativePath, ...receipt.evidence_refs])]
    record.receipts.push({ at: receipt.recorded_at, kind: 'command', ref: relativePath, description: `Gate ${gateId}: ${receipt.status}`, ...(receipt.exit_code === null ? {} : { exit_code: receipt.exit_code }) })
    await syncRunQueue(root, directory, record, receipt.recorded_at)
    await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: receipt.recorded_at, by: receipt.recorded_by, action: 'gate_recorded', gate_id: gateId, status: gate.status, ref: relativePath })
    return receipt
  })
}

function attemptDirectory(directory, unitId, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer')
  return join(directory, 'attempts', unitId, `attempt-${attempt}`)
}

export async function recordAttemptReceipt(root, runId, unitId, receiptValue) {
  const receipt = objectValue(receiptValue, 'attempt receipt')
  return mutateRun(root, runId, async ({ directory, record }) => {
    const unit = record.units.find((candidate) => candidate.id === unitId)
    if (!unit) throw new Error(`run unit ${unitId} does not exist`)
    if (receipt.run_id !== runId || receipt.unit_id !== unitId) throw new Error('attempt receipt linkage disagrees with target unit')
    if (!receipt.task_ids.every((taskId) => unit.task_ids.includes(taskId))) throw new Error('attempt receipt tasks exceed unit tasks')
    await assertProjectRecord(root, 'attempt-receipt', receipt)
    const target = join(attemptDirectory(directory, unitId, receipt.attempt), 'attempt.receipt.json')
    const immutable = await writeImmutableJson(target, receipt)
    if (!immutable.created) return receipt
    const relativePath = repositoryRelative(root, join(root, '.agents', 'runs', runId, 'attempts', unitId, `attempt-${receipt.attempt}`, 'attempt.receipt.json'))
    record.receipts.push({ at: receipt.created_at, kind: 'artifact', ref: relativePath, description: `Attempt ${receipt.attempt} ${receipt.status}` })
    return receipt
  })
}

export async function recordVerificationReceipt(root, runId, unitId, receiptValue) {
  const receipt = objectValue(receiptValue, 'verification receipt')
  return mutateRun(root, runId, async ({ directory, record }) => {
    const unit = record.units.find((candidate) => candidate.id === unitId)
    if (!unit) throw new Error(`run unit ${unitId} does not exist`)
    if (receipt.run_id !== runId || receipt.unit_id !== unitId) throw new Error('verification receipt linkage disagrees with target unit')
    if (receipt.actor === receipt.verifier) throw new Error('independent verification requires distinct actor and verifier identities')
    receipt.changed_files = normalizeWriteSet(receipt.changed_files)
    const outside = receipt.changed_files.filter((path) => !pathCoveredByFence(path, unit.write_fence))
    receipt.write_fence_verdict = outside.length === 0 ? 'passed' : 'failed'
    receipt.outside_write_fence = outside
    if (receipt.overall === 'passed' && (outside.length > 0 || receipt.checks.some((check) => check.status !== 'passed'))) {
      throw new Error('verification cannot pass with failed checks or changed files outside the write fence')
    }
    await assertProjectRecord(root, 'verification-receipt', receipt)
    const target = join(attemptDirectory(directory, unitId, receipt.attempt), 'verification.receipt.json')
    const relativePath = `.agents/runs/${runId}/attempts/${unitId}/attempt-${receipt.attempt}/verification.receipt.json`
    const immutable = await writeImmutableJson(target, receipt)
    if (!immutable.created) return { ...receipt, path: relativePath }
    record.receipts.push({ at: receipt.verified_at, kind: 'command', ref: relativePath, description: `Independent verification ${receipt.overall}` })
    await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: receipt.verified_at, by: receipt.verifier, action: 'verification_recorded', unit_id: unitId, status: receipt.overall, ref: relativePath })
    return { ...receipt, path: relativePath }
  })
}

export async function recordUnitResult(root, runId, unitId, resultValue) {
  const result = objectValue(resultValue, 'unit result')
  return mutateRun(root, runId, async ({ directory, record }) => {
    const unit = record.units.find((candidate) => candidate.id === unitId)
    if (!unit) throw new Error(`run unit ${unitId} does not exist`)
    if (result.run_id !== runId || result.unit_id !== unitId) throw new Error('unit result linkage disagrees with target unit')
    if (!TERMINAL_RESULT_DISPOSITIONS.has(result.disposition)) throw new Error(`unsupported terminal disposition ${result.disposition}`)
    await assertProjectRecord(root, 'failure-result', result)
    if (result.disposition === 'landed') {
      const verification = await readLifecycleReceipt(root, result.verification_receipt, 'verification-receipt')
      const landing = await readLifecycleReceipt(root, result.landing_receipt, 'landing-receipt')
      if (verification.run_id !== runId || verification.unit_id !== unitId || verification.attempt !== result.attempt) throw new Error('landed result verification linkage disagrees with the unit attempt')
      if (verification.overall !== 'passed' || verification.candidate_sha !== result.candidate_sha) throw new Error('landed result requires passed verification for the same candidate')
      if (landing.run_id !== runId || landing.unit_id !== unitId || landing.candidate_sha !== result.candidate_sha) throw new Error('landed result landing linkage disagrees with the candidate')
      if (landing.disposition !== 'landed' || landing.remote_equality.status !== 'passed') throw new Error('landed result requires passed remote-equality landing proof')
    }
    const target = join(attemptDirectory(directory, unitId, result.attempt), 'result.json')
    const immutable = await writeImmutableJson(target, result)
    if (!immutable.created) return result
    const statusByDisposition = {
      landed: 'landed',
      blocked: 'blocked',
      failed: 'failed',
      cancelled: 'cancelled',
      artifact_only: 'blocked',
      prepared: 'blocked',
    }
    unit.status = statusByDisposition[result.disposition]
    const timestamp = result.recorded_at
    await syncRunQueue(root, directory, record, timestamp)
    const relativePath = `.agents/runs/${runId}/attempts/${unitId}/attempt-${result.attempt}/result.json`
    record.receipts.push({ at: timestamp, kind: 'artifact', ref: relativePath, description: `Terminal result: ${result.disposition}` })
    await appendStagedEvent(directory, 'ledger.jsonl', { run_id: runId, at: timestamp, by: result.recorded_by, action: 'unit_terminal', unit_id: unitId, status: unit.status, ref: relativePath })
    return result
  })
}

export async function recordFailureResult(root, runId, unitId, resultValue) {
  if (resultValue?.disposition === 'landed') throw new Error('recordFailureResult cannot record a landed disposition')
  return recordUnitResult(root, runId, unitId, resultValue)
}

export async function createDeliveryPlan(root, planValue) {
  const plan = objectValue(planValue, 'delivery plan')
  if (!DELIVERY_ID.test(plan.id)) throw new Error('delivery plan id must match DELIVERY-name')
  for (const taskId of plan.task_ids ?? []) await findTask(root, taskId)
  if (plan.run_id) {
    const run = await assertRun(root, plan.run_id)
    for (const taskId of plan.task_ids) if (!run.record.task_ids.includes(taskId)) throw new Error(`delivery task ${taskId} is outside ${plan.run_id}`)
  }
  plan.allowed_destination = normalizeRepoPath(plan.allowed_destination)
  await assertProjectRecord(root, 'delivery-plan', plan)
  const destination = join(root, '.agents', 'delivery', plan.id)
  return withExclusiveLock(root, join('.agents', 'delivery', '.locks', 'registry.lock'), async () => {
    if (await pathExists(join(destination, 'plan.json'))) {
      const existing = await readJson(join(destination, 'plan.json'))
      if (JSON.stringify(existing) === JSON.stringify(plan)) return existing
      throw new Error(`${plan.id} already exists with a different immutable plan`)
    }
    await createDirectoryAtomic(destination, async (directory) => {
      await mkdir(join(directory, 'evidence'), { recursive: true })
      await writeJsonAtomic(join(directory, 'plan.json'), plan)
      const event = { schema_version: 1, delivery_id: plan.id, seq: 1, at: plan.created_at, by: plan.created_by, action: 'planned' }
      await writeFile(join(directory, 'ledger.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    })
    return plan
  })
}

export async function recordLandingReceipt(root, deliveryId, receiptValue) {
  const receipt = objectValue(receiptValue, 'landing receipt')
  if (!DELIVERY_ID.test(deliveryId)) throw new Error('delivery id must match DELIVERY-name')
  const directory = join(root, '.agents', 'delivery', deliveryId)
  const planPath = join(directory, 'plan.json')
  if (!(await pathExists(planPath))) throw new Error(`${deliveryId} was not found`)
  return withExclusiveLock(root, join('.agents', 'delivery', '.locks', `${deliveryId}.lock`), async () => {
    const plan = await readJson(planPath)
    if (receipt.delivery_id !== deliveryId) throw new Error('landing receipt belongs to another delivery')
    if (receipt.integrator === receipt.verifier) throw new Error('landing integrator and verifier must be distinct')
    if (receipt.disposition === 'landed') {
      if (receipt.remote_equality.status !== 'passed') throw new Error('landed delivery requires passed remote equality proof')
      if (receipt.push_policy === 'authorized' && receipt.post_sha !== receipt.remote_sha) throw new Error('landed remote SHA must equal post-land SHA')
      const verificationPath = await ensureInsideRoot(root, receipt.verification_receipt)
      const verification = await readJson(verificationPath)
      await assertProjectRecord(root, 'verification-receipt', verification)
      if (verification.overall !== 'passed' || verification.actor === verification.verifier) throw new Error('landing requires passed independent verification')
      if (verification.verifier !== receipt.verifier || verification.candidate_sha !== receipt.candidate_sha) throw new Error('landing verifier or candidate disagrees with the verification receipt')
      if (verification.run_id !== receipt.run_id || verification.unit_id !== receipt.unit_id) throw new Error('landing run/unit linkage disagrees with the verification receipt')
      if (plan.run_id !== receipt.run_id) throw new Error('landing run linkage disagrees with the delivery plan')
      for (const pointer of receipt.gate_receipts) {
        const gatePath = await ensureInsideRoot(root, pointer)
        const gate = await readJson(gatePath)
        await assertProjectRecord(root, 'gate-receipt', gate)
        if (!['passed', 'waived'].includes(gate.status)) throw new Error(`landing gate is not satisfied: ${pointer}`)
      }
    }
    await assertProjectRecord(root, 'landing-receipt', receipt)
    const target = join(directory, 'landing.receipt.json')
    await writeImmutableJson(target, receipt)
    const ledger = await readJsonLines(join(directory, 'ledger.jsonl'))
    if (!ledger.some((event) => event.action === 'landing_recorded')) {
      await appendJsonLine(join(directory, 'ledger.jsonl'), {
        schema_version: 1,
        delivery_id: deliveryId,
        seq: ledger.length + 1,
        at: receipt.recorded_at,
        by: receipt.integrator,
        action: 'landing_recorded',
        disposition: receipt.disposition,
      })
    }
    return { ...receipt, path: `.agents/delivery/${deliveryId}/landing.receipt.json`, plan }
  })
}

export async function readLifecycleReceipt(root, pointer, schemaName) {
  const path = await ensureInsideRoot(root, pointer)
  const record = await readJson(path)
  await assertProjectRecord(root, schemaName, record)
  return record
}

export { archiveTask, claimNextTask, closeRun } from './work.mjs'
