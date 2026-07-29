import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import {
  listDirectories,
  pathExists,
  readJson,
  withExclusiveLock,
  writeJsonAtomic,
} from './shared.mjs'
import { assertProjectRecord } from './schema.mjs'

export const TERMINAL_UNIT_STATUSES = new Set(['landed', 'blocked', 'failed', 'cancelled'])
export const TERMINAL_RESULT_DISPOSITIONS = new Set([
  'landed',
  'artifact_only',
  'prepared',
  'blocked',
  'failed',
  'cancelled',
])

export function requiredString(value, label) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) throw new Error(`${label} is required`)
  return result
}

export function valuesList(value) {
  if (Array.isArray(value)) return value.map((item) => requiredString(item, 'list item'))
  if (typeof value !== 'string' || !value.trim()) return []
  return value.split(/[|,]/).map((item) => item.trim()).filter(Boolean)
}

export function normalizeRepoPath(value) {
  const input = requiredString(value, 'repository-relative path')
  if (isAbsolute(input) || input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error(`write path must be repository-relative: ${input}`)
  }
  if (input.includes('\\')) throw new Error(`write path must use forward slashes: ${input}`)
  if (/[*?\[\]{}!]/.test(input)) throw new Error(`write path must be concrete, not a glob: ${input}`)
  const segments = input.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`write path contains an ambiguous segment: ${input}`)
  }
  const normalized = posix.normalize(input)
  if (normalized === '.' || normalized.startsWith('../')) throw new Error(`write path escapes the project: ${input}`)
  return normalized.replace(/\/$/, '')
}

export function normalizeWriteSet(value) {
  const normalized = valuesList(value).map(normalizeRepoPath)
  return [...new Set(normalized)].sort()
}

export function pathsIntersect(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export function writeSetsIntersect(left, right) {
  return left.some((leftPath) => right.some((rightPath) => pathsIntersect(leftPath, rightPath)))
}

export function pathCoveredByFence(path, fence) {
  return fence.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))
}

export function repositoryRelative(root, absolutePath) {
  const result = relative(root, absolutePath).split(sep).join('/')
  if (!result || result === '..' || result.startsWith('../')) throw new Error(`path escapes project root: ${absolutePath}`)
  return result
}

export async function writeImmutableJson(path, value) {
  if (await pathExists(path)) {
    const current = await readJson(path)
    if (JSON.stringify(current) === JSON.stringify(value)) return { value: current, created: false }
    throw new Error(`${path} is immutable and already contains different bytes`)
  }
  await writeJsonAtomic(path, value)
  return { value, created: true }
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function readJsonLines(path) {
  if (!(await pathExists(path))) return []
  const content = await readFile(path, 'utf8')
  const records = []
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not valid JSON: ${error.message}`)
    }
  }
  return records
}

export function assertOrderedLedger(records, label) {
  let previousAt = null
  records.forEach((record, index) => {
    if (record.seq !== index + 1) throw new Error(`${label} sequence must be contiguous; expected ${index + 1}, found ${record.seq}`)
    if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) throw new Error(`${label} event ${record.seq} has an invalid timestamp`)
    if (previousAt && record.at < previousAt) throw new Error(`${label} timestamps are out of order at sequence ${record.seq}`)
    previousAt = record.at
  })
}

export async function createDirectoryAtomic(destination, build) {
  if (await pathExists(destination)) throw new Error(`destination already exists: ${destination}`)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.tmp-${posix.basename(destination)}-${process.pid}-${Date.now()}`)
  try {
    await mkdir(temporary, { recursive: false })
    const result = await build(temporary)
    await rename(temporary, destination)
    return result
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function mutateDirectoryAtomic(directory, mutate) {
  if (!(await pathExists(directory))) throw new Error(`record directory was not found: ${directory}`)
  const nonce = `${process.pid}-${Date.now()}`
  const temporary = join(dirname(directory), `.tmp-${posix.basename(directory)}-${nonce}`)
  const backup = join(dirname(directory), `.backup-${posix.basename(directory)}-${nonce}`)
  try {
    await cp(directory, temporary, { recursive: true, errorOnExist: true, force: false })
    const result = await mutate(temporary)
    await rename(directory, backup)
    try {
      await rename(temporary, directory)
    } catch (error) {
      await rename(backup, directory)
      throw error
    }
    await rm(backup, { recursive: true, force: true }).catch(() => {})
    return result
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function withLifecycleLock(root, area, id, operation) {
  return withExclusiveLock(root, join('.agents', area, '.locks', `${id}.lock`), operation)
}

export async function loadRecord(root, area, id, filename) {
  const path = join(root, '.agents', area, id, filename)
  if (!(await pathExists(path))) throw new Error(`${id} was not found`)
  return { path, directory: dirname(path), record: await readJson(path) }
}

async function activeClaimsForRun(root, runId) {
  const directory = join(root, '.agents', 'work-claims', 'active')
  if (!(await pathExists(directory))) return []
  const matches = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const claim = await readJson(join(directory, entry.name))
    if (claim.run_id === runId && claim.state === 'active') matches.push(claim.id)
  }
  return matches.sort()
}

async function latestAttemptResult(runDirectory, unitId) {
  const attemptsRoot = join(runDirectory, 'attempts', unitId)
  const attempts = await listDirectories(attemptsRoot)
  if (attempts.length === 0) throw new Error(`run unit ${unitId} has no attempt directory`)
  let latest = null
  for (const attempt of attempts) {
    const resultPath = join(attemptsRoot, attempt, 'result.json')
    if (!(await pathExists(resultPath))) throw new Error(`run unit ${unitId} attempt ${attempt} lacks result.json`)
    const result = await readJson(resultPath)
    if (!TERMINAL_RESULT_DISPOSITIONS.has(result.disposition)) {
      throw new Error(`run unit ${unitId} attempt ${attempt} has non-terminal disposition ${result.disposition}`)
    }
    latest = { attempt, result, resultPath }
  }
  return latest
}

async function assertPacketDigests(runDirectory, queue) {
  for (const packet of queue.packet_digests ?? []) {
    const packetPath = resolve(runDirectory, packet.path)
    const rel = relative(runDirectory, packetPath)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`packet path escapes run: ${packet.path}`)
    if (!(await pathExists(packetPath))) throw new Error(`packet is missing: ${packet.path}`)
    const digest = await sha256File(packetPath)
    if (digest !== packet.sha256) throw new Error(`immutable packet changed after dispatch: ${packet.path}`)
  }
}

async function assertLandedResult(root, unit, latest) {
  const result = latest.result
  if (result.disposition !== 'landed') throw new Error(`landed unit ${unit.id} has ${result.disposition} result`)
  if (!result.verification_receipt || !result.landing_receipt) {
    throw new Error(`landed unit ${unit.id} needs verification and landing receipt paths`)
  }
  const verificationPath = resolve(root, result.verification_receipt)
  const landingPath = resolve(root, result.landing_receipt)
  for (const [label, path] of [['verification', verificationPath], ['landing', landingPath]]) {
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`) || !(await pathExists(path))) {
      throw new Error(`landed unit ${unit.id} has unresolved ${label} receipt`)
    }
  }
  const verification = await readJson(verificationPath)
  const landing = await readJson(landingPath)
  await assertProjectRecord(root, 'verification-receipt', verification)
  await assertProjectRecord(root, 'landing-receipt', landing)
  if (verification.overall !== 'passed' || verification.write_fence_verdict !== 'passed') {
    throw new Error(`landed unit ${unit.id} lacks passed independent verification`)
  }
  if (verification.actor === verification.verifier) throw new Error(`landed unit ${unit.id} was self-verified`)
  if (verification.candidate_sha !== result.candidate_sha || landing.candidate_sha !== result.candidate_sha) {
    throw new Error(`landed unit ${unit.id} receipt candidates disagree`)
  }
  if (landing.verifier !== verification.verifier || landing.run_id !== result.run_id || landing.unit_id !== unit.id) {
    throw new Error(`landed unit ${unit.id} receipt linkage disagrees`)
  }
  if (landing.disposition !== 'landed' || landing.remote_equality.status !== 'passed') {
    throw new Error(`landed unit ${unit.id} lacks landed remote equality proof`)
  }
}

export async function assertRunCloseReady(root, runId, record, options = {}) {
  const runDirectory = join(root, '.agents', 'runs', runId)
  const queuePath = join(runDirectory, 'queue.json')
  if (!(await pathExists(queuePath))) throw new Error(`${runId} cannot close: queue.json is missing`)
  const queue = await readJson(queuePath)
  await assertProjectRecord(root, 'run-queue', queue)
  if (queue.run_id !== runId) throw new Error(`${runId} cannot close: queue belongs to ${queue.run_id}`)
  if (JSON.stringify(queue.units) !== JSON.stringify(record.units)) throw new Error(`${runId} cannot close: queue units drift from run.json`)
  await assertPacketDigests(runDirectory, queue)
  const digestedPackets = new Set((queue.packet_digests ?? []).map((packet) => packet.path))
  for (const pointer of record.packets ?? []) {
    const prefix = `.agents/runs/${runId}/`
    if (!pointer.startsWith(prefix) || !digestedPackets.has(pointer.slice(prefix.length))) {
      throw new Error(`${runId} cannot close: packet lacks an immutable digest: ${pointer}`)
    }
  }
  for (const unit of record.units ?? []) {
    const prefix = `.agents/runs/${runId}/`
    if (!unit.packet_path.startsWith(prefix) || !digestedPackets.has(unit.packet_path.slice(prefix.length))) {
      throw new Error(`${runId} cannot close: unit ${unit.id} packet is missing or undispatched`)
    }
  }

  const ledger = await readJsonLines(join(runDirectory, 'ledger.jsonl'))
  assertOrderedLedger(ledger, `${runId} ledger`)
  for (const event of ledger) await assertProjectRecord(root, 'run-event', event)

  const activeClaims = await activeClaimsForRun(root, runId)
  if (activeClaims.length > 0) throw new Error(`${runId} cannot close with active work claims: ${activeClaims.join(', ')}`)

  for (const unit of record.units ?? []) {
    if (!TERMINAL_UNIT_STATUSES.has(unit.status)) throw new Error(`${runId} cannot close: unit ${unit.id} is ${unit.status}`)
    const latest = await latestAttemptResult(runDirectory, unit.id)
    if (unit.status === 'landed') await assertLandedResult(root, unit, latest)
    if (unit.status === 'blocked' && latest.result.disposition !== 'blocked') {
      throw new Error(`blocked unit ${unit.id} lacks a blocked terminal result`)
    }
    if (unit.status === 'failed' && latest.result.disposition !== 'failed') {
      throw new Error(`failed unit ${unit.id} lacks a failed terminal result`)
    }
    if (unit.status === 'cancelled' && latest.result.disposition !== 'cancelled') {
      throw new Error(`cancelled unit ${unit.id} lacks a cancelled terminal result`)
    }
  }

  if (options.verdict === 'passed') {
    const incompleteGates = (record.gates ?? []).filter((gate) => gate.required && !['passed', 'waived'].includes(gate.status))
    if (incompleteGates.length > 0) throw new Error(`${runId} cannot pass with unresolved gates: ${incompleteGates.map((gate) => gate.id).join(', ')}`)
    if ((record.units ?? []).some((unit) => unit.status !== 'landed')) {
      throw new Error(`${runId} cannot pass unless every unit is landed`)
    }
  }

  const outputs = Array.isArray(options.outputs) ? options.outputs : []
  if ((record.units ?? []).length > 0 && outputs.length === 0) {
    throw new Error(`${runId} cannot close units without classifying run outputs`)
  }
  return { units: record.units?.length ?? 0, active_claims: 0, outputs: outputs.length }
}

export async function ensureInsideRoot(root, pointer) {
  const absolute = resolve(root, requiredString(pointer, 'repository-relative pointer'))
  const rel = relative(root, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`pointer escapes project root: ${pointer}`)
  return absolute
}

export async function writeTextAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}
