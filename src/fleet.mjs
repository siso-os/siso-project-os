import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, open, readFile, realpath, rm, stat, statfs, unlink } from 'node:fs/promises'
import { cpus, freemem, hostname, loadavg, platform } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { validateSchema } from './schema.mjs'
import {
  packageRoot,
  pathExists,
  readJson,
  schemasRoot,
  walkFiles,
  withExclusiveLock,
  writeJsonAtomic,
} from './shared.mjs'
import { writeTextAtomic } from './lifecycle-core.mjs'
import { scanTasks } from './work.mjs'
import { PROJECT_OS_VERSION } from './version.mjs'

export const FLEET_PACK_VERSION = '1.0.0'
export const FLEET_PROJECT_OS_MINIMUM_VERSION = '0.5.0'
export const FLEET_ROOT = '.agents/fleet'

const fleetTemplateRoot = join(packageRoot, 'packs', 'fleet', 'template')
const generatedPaths = [
  `${FLEET_ROOT}/generated/TASK-GRAPH.json`,
  `${FLEET_ROOT}/generated/TEAM-STATE.json`,
  `${FLEET_ROOT}/generated/FLEET.html`,
]
const reservedWritePaths = [
  '.agents',
  '.project-os',
  '.git',
  'docs/ledgers',
  'AGENTS.md',
  'CLAUDE.md',
  'SKILL.md',
  'PROJECT-OS.html',
  'fleet.bootstrap.json',
]
const fleetSchemaNames = [
  'fleet-admission-input',
  'fleet-admission-receipt',
  'fleet-bootstrap',
  'fleet-callback',
  'fleet-domain',
  'fleet-pack',
  'fleet-policy',
  'fleet-process-plan',
  'fleet-program',
  'fleet-repositories',
  'fleet-source-contract',
  'fleet-task-graph',
  'fleet-team-state',
]
const rolePlan = [
  ['fleet-pm', 'sol-goal', 'long-running', 'lead', 'lead'],
  ['fleet-domain-owner', 'sol-goal', 'long-running', 'lead', 'lead'],
  ['fleet-implementer', 'luna-task', 'task-scoped', 'worker', 'worker'],
  ['fleet-verifier', 'luna-task', 'task-scoped', 'verifier', 'worker'],
  ['fleet-portfolio', 'project-os-role', 'event-driven', 'portfolio', 'lead'],
  ['fleet-front-door', 'project-os-role', 'event-driven', 'front-door', 'lead'],
  ['fleet-maintenance', 'project-os-role', 'event-driven', 'maintenance', 'lead'],
]

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function problem(code, message, path = null) {
  return { code, message, ...(path ? { path } : {}) }
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '').replace(/\/$/, '')
  if (normalized === '' || normalized === '/' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

function pathKey(value) {
  return normalizePath(value)?.normalize('NFC').toLowerCase() ?? null
}

function pathContains(parent, child) {
  const normalizedParent = pathKey(parent)
  const normalizedChild = pathKey(child)
  if (!normalizedParent || !normalizedChild) return false
  if (normalizedParent === '.') return true
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left)
}

function admissionReceiptDigest(record) {
  const { integrity: _integrity, ...payload } = record
  return hash(JSON.stringify(payload))
}

function withAdmissionReceiptIntegrity(record) {
  return {
    ...record,
    integrity: {
      algorithm: 'sha256',
      scope: 'canonical-json-without-integrity',
      digest: admissionReceiptDigest(record),
    },
  }
}

function verifierCapable(machine, domains) {
  return machine.roles.some((role) => role === 'verifier' || role === 'fleet-verifier' || domains.some((domain) => domain.verifier_role === role))
}

function uniqueIdProblems(records, label) {
  const seen = new Set()
  const errors = []
  for (const record of records ?? []) {
    if (seen.has(record.id)) errors.push(problem(`duplicate_${label}_id`, `${label} id ${record.id} is duplicated`))
    seen.add(record.id)
  }
  return errors
}

function secretProblems(value, pointer = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretProblems(item, `${pointer}[${index}]`, errors))
    return errors
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}.${key}`
      if (/^(?:.*[-_])?(?:secret|password|token|api[-_]?key|private[-_]?key|credential)s?$/i.test(key)) {
        errors.push(problem('secret_key_forbidden', `secret-bearing key ${key} is forbidden in fleet artifacts`, childPointer))
      }
      secretProblems(child, childPointer, errors)
    }
    return errors
  }
  if (typeof value === 'string' && (
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/i.test(value)
  )) errors.push(problem('secret_value_forbidden', 'credential-shaped value is forbidden in fleet artifacts', pointer))
  return errors
}

function structuralProblems(config, options = {}) {
  const errors = [
    ...uniqueIdProblems(config.repositories, 'repository'),
    ...uniqueIdProblems(config.domains, 'domain'),
    ...uniqueIdProblems(config.machines, 'machine'),
    ...(options.scanSecrets === false ? [] : secretProblems(config)),
  ]
  const repositories = new Map((config.repositories ?? []).map((record) => [record.id, record]))
  const machines = new Map((config.machines ?? []).map((record) => [record.id, record]))
  const domains = config.domains ?? []
  const capacity = config.policy?.capacity

  if (capacity) {
    const minimumReserve = Math.ceil(capacity.max_live * capacity.verifier_ratio)
    if (capacity.verifier_reserve < minimumReserve) {
      errors.push(problem('insufficient_verifier_reserve', `verifier_reserve ${capacity.verifier_reserve} is below ceil(max_live × verifier_ratio) ${minimumReserve}`))
    }
    if (capacity.verifier_reserve >= capacity.max_live) {
      errors.push(problem('no_implementer_capacity', 'verifier_reserve must leave at least one non-verifier slot'))
    }
    const machineCapacity = [...machines.values()].reduce((sum, machine) => sum + machine.max_live, 0)
    if (machineCapacity < capacity.max_live) {
      errors.push(problem('insufficient_machine_capacity', `machine capacity ${machineCapacity} is below policy max_live ${capacity.max_live}`))
    }
    const verifierMachineCapacity = [...machines.values()]
      .filter((machine) => verifierCapable(machine, domains))
      .reduce((sum, machine) => sum + machine.max_live, 0)
    if (verifierMachineCapacity < capacity.verifier_reserve) {
      errors.push(problem('insufficient_verifier_machine_capacity', `verifier-capable machine capacity ${verifierMachineCapacity} is below verifier_reserve ${capacity.verifier_reserve}`))
    }
  }

  if (!machines.has(config.bootstrap_machine_id)) {
    errors.push(problem('missing_bootstrap_machine', `bootstrap_machine_id ${config.bootstrap_machine_id} is not declared`))
  }
  const verifierRoles = new Set(domains.map((domain) => domain.verifier_role))
  if (![...machines.values()].some((machine) => machine.roles.some((role) => verifierRoles.has(role) || role === 'verifier'))) {
    errors.push(problem('missing_verifier_placement', 'at least one machine must accept a declared verifier role'))
  }
  for (const [roleId, , , machineRole] of rolePlan) {
    if (![...machines.values()].some((machine) => machine.roles.includes(machineRole) || machine.roles.includes(roleId))) {
      errors.push(problem('missing_role_placement', `${roleId} requires a machine accepting ${machineRole} or ${roleId}`))
    }
  }
  for (const domain of domains) {
    if (!repositories.has(domain.repository_id)) {
      errors.push(problem('missing_domain_repository', `${domain.id} references undeclared repository ${domain.repository_id}`, `$.domains.${domain.id}`))
    }
    if (domain.owner_role === domain.verifier_role) {
      errors.push(problem('domain_role_collision', `${domain.id} must use distinct owner and verifier roles`, `$.domains.${domain.id}`))
    }
    for (const writePath of domain.write_paths ?? []) {
      const reserved = reservedWritePaths.find((boundary) => pathsOverlap(writePath, boundary))
      if (reserved) errors.push(problem('reserved_write_scope', `${domain.id}:${writePath} overlaps Project OS control state ${reserved}`, `$.domains.${domain.id}.write_paths`))
    }
    for (const evidencePath of domain.evidence_paths ?? []) {
      if (!pathContains(config.programme?.evidence_root, evidencePath)) {
        errors.push(problem('evidence_path_outside_root', `${domain.id} evidence path ${evidencePath} is outside ${config.programme?.evidence_root}`, `$.domains.${domain.id}.evidence_paths`))
      }
    }
  }
  for (let leftIndex = 0; leftIndex < domains.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < domains.length; rightIndex += 1) {
      const left = domains[leftIndex]
      const right = domains[rightIndex]
      if (left.repository_id !== right.repository_id) continue
      for (const leftPath of left.write_paths ?? []) {
        for (const rightPath of right.write_paths ?? []) {
          if (pathsOverlap(leftPath, rightPath)) {
            errors.push(problem('overlapping_domain_ownership', `${left.id}:${leftPath} overlaps ${right.id}:${rightPath} in ${left.repository_id}`))
          }
        }
      }
    }
  }
  if (config.programme?.evidence_root !== `${FLEET_ROOT}/evidence`) {
    errors.push(problem('invalid_evidence_root', `programme evidence_root must be ${FLEET_ROOT}/evidence`))
  }
  if (config.programme?.callback_ledger !== `${FLEET_ROOT}/callbacks.ndjson`) {
    errors.push(problem('invalid_callback_ledger', `programme callback_ledger must be ${FLEET_ROOT}/callbacks.ndjson`))
  }
  if (config.front_door?.projection_root !== `${FLEET_ROOT}/generated` || config.front_door?.source_contract !== `${FLEET_ROOT}/SOURCE-CONTRACT.json`) {
    errors.push(problem('invalid_front_door_boundary', 'front-door paths must use the fixed pack projection and source-contract locations'))
  }
  return errors
}

async function sourceSchema(name) {
  return readJson(join(schemasRoot, `${name}.schema.json`))
}

function schemaProblems(value, schema, name, path) {
  return validateSchema(value, schema).map((violation) => problem('schema_violation', `${name}${violation.path}: ${violation.message}`, path))
}

function compareVersions(left, right) {
  const parse = (value) => /^\d+\.\d+\.\d+$/.test(value ?? '') ? value.split('.').map(Number) : null
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

function availableMemoryBytes() {
  if (platform() !== 'darwin') return freemem()
  const result = spawnSync('vm_stat', [], { encoding: 'utf8' })
  if (result.status !== 0) return freemem()
  const pageSize = Number(result.stdout.match(/page size of ([0-9]+) bytes/i)?.[1])
  if (!Number.isFinite(pageSize)) return freemem()
  const pages = ['free', 'inactive', 'speculative'].reduce((sum, label) => {
    const count = Number(result.stdout.match(new RegExp(`Pages ${label}:\\s+([0-9]+)\\.`, 'i'))?.[1] ?? 0)
    return sum + count
  }, 0)
  return pages > 0 ? pages * pageSize : freemem()
}

async function observeLocalMachine(root, machine) {
  const disk = await statfs(root)
  let onAcPower = null
  if (platform() === 'darwin' && ['macbook', 'mac-mini'].includes(machine.host_class)) {
    const result = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' })
    onAcPower = result.status === 0 ? /AC Power/i.test(result.stdout) : null
  }
  return {
    id: machine.id,
    available_disk_bytes: Number(disk.bavail) * Number(disk.bsize),
    available_memory_bytes: availableMemoryBytes(),
    load_per_cpu: loadavg()[0] / Math.max(cpus().length, 1),
    on_ac_power: onAcPower,
  }
}

function machineThresholdProblems(machine, observation, prefix = 'bootstrap') {
  const errors = []
  const thresholds = machine.thresholds
  if (observation.available_disk_bytes < thresholds.minimum_available_disk_bytes) {
    errors.push(problem('disk_pressure', `${prefix} machine has ${observation.available_disk_bytes} available bytes; requires ${thresholds.minimum_available_disk_bytes}`))
  }
  if (observation.available_memory_bytes < thresholds.minimum_available_memory_bytes) {
    errors.push(problem('memory_pressure', `${prefix} machine has ${observation.available_memory_bytes} available bytes; requires ${thresholds.minimum_available_memory_bytes}`))
  }
  if (observation.load_per_cpu > thresholds.maximum_load_per_cpu) {
    errors.push(problem('load_pressure', `${prefix} machine load per CPU ${observation.load_per_cpu} exceeds ${thresholds.maximum_load_per_cpu}`))
  }
  if (thresholds.require_ac_power && observation.on_ac_power !== true) {
    errors.push(problem(observation.on_ac_power === false ? 'ac_power_required' : 'ac_power_unknown', `${prefix} machine must have confirmed AC power`))
  }
  return errors
}

export async function validateFleetBootstrap(root, config, options = {}) {
  const schema = await sourceSchema('fleet-bootstrap')
  const schemaErrors = schemaProblems(config, schema, 'fleet-bootstrap', options.configPath ?? null)
  const errors = [...schemaErrors]
  if (schemaErrors.length === 0) {
    try { errors.push(...structuralProblems(config)) } catch (error) {
      errors.push(problem('invalid_fleet_structure', error instanceof Error ? error.message : String(error), options.configPath ?? null))
    }
  } else errors.push(...secretProblems(config))
  try {
    const project = await readJson(join(root, '.project-os', 'project.json'))
    const comparison = compareVersions(project.project_os_version, FLEET_PROJECT_OS_MINIMUM_VERSION)
    if (comparison === null) {
      errors.push(problem('invalid_project_os_version', `installed Project OS version must be semantic x.y.z; received ${String(project.project_os_version)}`, '.project-os/project.json'))
    } else if (comparison === -1) {
      errors.push(problem('fleet_project_os_incompatible', `installed Project OS ${project.project_os_version} is older than required ${FLEET_PROJECT_OS_MINIMUM_VERSION}`, '.project-os/project.json'))
    }
  } catch (error) {
    errors.push(problem('invalid_project_os_installation', error instanceof Error ? error.message : String(error), '.project-os/project.json'))
  }
  let machineObservation = null
  const machine = (config.machines ?? []).find((record) => record.id === config.bootstrap_machine_id)
  if (machine && options.observeMachine !== false) {
    try {
      machineObservation = await observeLocalMachine(root, machine)
      errors.push(...machineThresholdProblems(machine, machineObservation))
    } catch (error) {
      errors.push(problem('machine_observation_failed', error instanceof Error ? error.message : String(error)))
    }
  }
  return { ok: errors.length === 0, errors, machine_observation: machineObservation }
}

export async function loadFleetBootstrap(root, pointer) {
  if (typeof pointer !== 'string' || pointer.trim() === '') throw new Error('fleet command requires --config <fleet.bootstrap.json>')
  const path = isAbsolute(pointer) ? pointer : resolve(root, pointer)
  try {
    return { path, config: await readJson(path) }
  } catch (error) {
    const failure = new Error(`could not read fleet bootstrap ${pointer}: ${error instanceof Error ? error.message : String(error)}`)
    failure.exitCode = 2
    throw failure
  }
}

function programmeRecord(config) {
  return {
    schema_version: 1,
    ...config.programme,
    canonical_sources: {
      tasks: '.agents/tasks',
      runs: '.agents/runs',
      missions: '.agents/missions',
      claims: '.agents/work-claims',
      decisions: 'docs/ledgers/decisions.jsonl',
      qualification: '.agents/runs',
    },
  }
}

function domainRecord(domain) {
  return {
    schema_version: 1,
    ...domain,
    worktree_mode: 'isolated',
    write_policy: 'work-claim-required',
  }
}

function repositoriesRecord(config) {
  return { schema_version: 1, repositories: config.repositories }
}

function policyRecord(config) {
  return { schema_version: 1, ...config.policy, machines: config.machines }
}

function processPlanRecord(config) {
  const computeProfiles = {
    lead: {
      model: config.process_controller.lead_profile,
      reasoning_effort: 'max',
    },
    worker: {
      model: config.process_controller.worker_profile,
      reasoning_effort: config.process_controller.worker_reasoning_effort,
    },
  }
  return {
    schema_version: 1,
    provider: config.process_controller.provider,
    workspace: config.process_controller.workspace,
    durable_identity_field: config.process_controller.durable_identity_field,
    volatile_identity_fields: config.process_controller.volatile_identity_fields,
    callback_transport: config.process_controller.callback_transport,
    admission_receipt_authority: 'eligibility-only',
    process_start_authority: 'provider-atomic-compare-and-start',
    required_start_revalidation: ['active-work-claims', 'provider-live-assignments', 'verifier-backlog', 'machine-thresholds'],
    compute_profiles: computeProfiles,
    roles: rolePlan.map(([roleId, contract, lifecycle, machineRole, computeProfile]) => ({
      role_id: roleId,
      contract,
      lifecycle,
      profile: `.agents/agents/${roleId}.agent.json`,
      compute_profile: computeProfile,
      reasoning_effort: computeProfiles[computeProfile].reasoning_effort,
      machine_roles: [machineRole],
    })),
  }
}

function sourceContractRecord(config) {
  return {
    schema_version: 1,
    authority: 'read-only-projection',
    consumer: config.front_door.consumer,
    canonical_sources: [
      { name: 'tasks', kind: 'canonical-records', path: '.agents/tasks' },
      { name: 'runs', kind: 'canonical-records', path: '.agents/runs' },
      { name: 'missions', kind: 'canonical-records', path: '.agents/missions' },
      { name: 'claims', kind: 'canonical-records', path: '.agents/work-claims' },
      { name: 'decisions', kind: 'append-only-ledger', path: 'docs/ledgers/decisions.jsonl' },
      { name: 'callbacks', kind: 'append-only-ledger', path: config.programme.callback_ledger },
      { name: 'qualification', kind: 'evidence-receipts', path: '.agents/runs' },
    ],
    projections: generatedPaths,
    write_rule: 'Consumers must never write task, ownership, completion, admission, or qualification state through a projection.',
  }
}

async function sourceEntries(config) {
  const entries = new Map()
  for (const file of await walkFiles(fleetTemplateRoot)) entries.set(file, await readFile(join(fleetTemplateRoot, file), 'utf8'))
  for (const name of fleetSchemaNames) {
    const relativePath = `.project-os/schemas/${name}.schema.json`
    entries.set(relativePath, await readFile(join(schemasRoot, `${name}.schema.json`), 'utf8'))
  }
  entries.set(`${FLEET_ROOT}/PROGRAM.json`, json(programmeRecord(config)))
  entries.set(`${FLEET_ROOT}/REPOS.json`, json(repositoriesRecord(config)))
  entries.set(`${FLEET_ROOT}/POLICY.json`, json(policyRecord(config)))
  entries.set(`${FLEET_ROOT}/PROCESS-PLAN.json`, json(processPlanRecord(config)))
  entries.set(`${FLEET_ROOT}/SOURCE-CONTRACT.json`, json(sourceContractRecord(config)))
  for (const domain of config.domains) entries.set(`${FLEET_ROOT}/domains/${domain.id}.json`, json(domainRecord(domain)))
  entries.set(config.programme.callback_ledger, '')
  entries.set(`${FLEET_ROOT}/evidence/.gitkeep`, '')
  entries.set(`${FLEET_ROOT}/admissions/.gitkeep`, '')

  const installedFiles = [...entries.keys(), `${FLEET_ROOT}/PACK.json`].sort()
  const mutableInstalledPaths = new Set([
    config.programme.callback_ledger,
    `${FLEET_ROOT}/evidence/.gitkeep`,
    `${FLEET_ROOT}/admissions/.gitkeep`,
  ])
  const managedArtifacts = [...entries.entries()]
    .filter(([path]) => !mutableInstalledPaths.has(path))
    .map(([path, content]) => ({ path, sha256: hash(content) }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const manifest = {
    schema_version: 1,
    pack_id: 'siso-agent-fleet-runtime',
    pack_version: FLEET_PACK_VERSION,
    project_os_minimum_version: FLEET_PROJECT_OS_MINIMUM_VERSION,
    canonical_root: FLEET_ROOT,
    source_repository: 'https://github.com/sisodias/siso-project-os',
    contracts: {
      programme: `${FLEET_ROOT}/PROGRAM.json`,
      domains: `${FLEET_ROOT}/domains`,
      repositories: `${FLEET_ROOT}/REPOS.json`,
      policy: `${FLEET_ROOT}/POLICY.json`,
      process_plan: `${FLEET_ROOT}/PROCESS-PLAN.json`,
      callbacks: config.programme.callback_ledger,
      source_contract: `${FLEET_ROOT}/SOURCE-CONTRACT.json`,
      sol_goal: `${FLEET_ROOT}/contracts/SOL-GOAL.template.json`,
      luna_task: `${FLEET_ROOT}/contracts/LUNA-TASK.template.json`,
    },
    reused_contracts: [
      '.agents/tasks',
      '.agents/runs',
      '.agents/missions',
      '.agents/work-claims',
      '.agents/delivery',
      'docs/ledgers/decisions.jsonl',
    ],
    installed_files: installedFiles,
    managed_artifacts: managedArtifacts,
    generated_files: generatedPaths,
  }
  entries.set(`${FLEET_ROOT}/PACK.json`, json(manifest))
  return entries
}

async function inspectFile(root, relativePath, expected) {
  const path = join(root, relativePath)
  if (!(await pathExists(path))) return { path: relativePath, action: 'create' }
  try {
    return (await readFile(path, 'utf8')) === expected
      ? { path: relativePath, action: 'retain' }
      : { path: relativePath, action: 'collision' }
  } catch {
    return { path: relativePath, action: 'collision' }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return null
  }
}

async function withFleetInstallLock(root, managedPaths, operation) {
  const relativeLockPath = `${FLEET_ROOT}/.install.lock`
  const lockPath = join(root, relativeLockPath)
  await mkdir(dirname(lockPath), { recursive: true })
  let recovered = null
  let handle
  const acquire = async () => {
    handle = await open(lockPath, 'wx')
    await handle.writeFile(`${JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      host: hostname(),
      created_at: new Date().toISOString(),
    })}\n`)
  }
  try {
    await acquire()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let existing
    try { existing = await readJson(lockPath) } catch {}
    const sameHost = existing?.host === hostname()
    const dead = sameHost ? processIsAlive(existing?.pid) === false : false
    if (!dead) {
      const locked = new Error(`fleet install lock exists: ${relativeLockPath}; automatic recovery requires a same-host lock whose process is confirmed dead`)
      locked.exitCode = 3
      throw locked
    }
    await unlink(lockPath)
    for (const path of managedPaths) await rm(`${join(root, path)}.tmp-${existing.pid}`, { force: true }).catch(() => {})
    recovered = { pid: existing.pid, host: existing.host, created_at: existing.created_at ?? null }
    try {
      await acquire()
    } catch (retryError) {
      const locked = new Error(`fleet install lock changed during stale-lock recovery: ${relativeLockPath}`)
      locked.exitCode = 3
      locked.cause = retryError
      throw locked
    }
  }
  try {
    return { value: await operation(), recovered }
  } finally {
    await handle.close()
    await unlink(lockPath).catch(() => {})
  }
}

async function writeFleetTransactionFile(root, relativePath, content, changes) {
  const path = join(root, relativePath)
  const before = await pathExists(path) ? await readFile(path, 'utf8') : null
  await writeTextAtomic(path, content)
  changes.push({ relativePath, before, written: content })
}

async function rollbackFleetTransaction(root, changes) {
  const conflicts = []
  for (const change of [...changes].reverse()) {
    const path = join(root, change.relativePath)
    const current = await pathExists(path) ? await readFile(path, 'utf8') : null
    if (current !== change.written) {
      conflicts.push(change.relativePath)
      continue
    }
    if (change.before === null) await rm(path, { force: true })
    else await writeTextAtomic(path, change.before)
  }
  return conflicts
}

export async function planFleetInstall(root, config, options = {}) {
  const initialized = await pathExists(join(root, '.project-os', 'project.json'))
  const validation = initialized
    ? await validateFleetBootstrap(root, config, { configPath: options.configPath, observeMachine: options.observeMachine })
    : { ok: false, errors: [problem('project_not_initialized', 'run project-os init before installing the optional fleet pack')], machine_observation: null }
  let entries = new Map()
  const operations = []
  if (initialized) {
    try {
      entries = await sourceEntries(config)
      for (const [path, content] of entries) operations.push(await inspectFile(root, path, content))
      if (!(await pathExists(join(root, FLEET_ROOT, 'PACK.json')))) {
        for (const path of generatedPaths) {
          if (await pathExists(join(root, path))) operations.push({ path, action: 'collision' })
        }
      }
    } catch (error) {
      validation.errors.push(problem('pack_source_unavailable', error instanceof Error ? error.message : String(error)))
    }
  }
  const collisions = operations.filter((entry) => entry.action === 'collision')
  const errors = [...validation.errors, ...collisions.map((entry) => problem('install_collision', 'fleet install would overwrite non-matching content', entry.path))]
  return {
    ok: errors.length === 0,
    pack_id: 'siso-agent-fleet-runtime',
    pack_version: FLEET_PACK_VERSION,
    root,
    errors,
    machine_observation: validation.machine_observation,
    operations,
    summary: {
      create: operations.filter((entry) => entry.action === 'create').length,
      retain: operations.filter((entry) => entry.action === 'retain').length,
      collision: collisions.length,
    },
    _entries: entries,
  }
}

export async function initFleet(root, config, options = {}) {
  const initial = await planFleetInstall(root, config, options)
  if (options.dryRun) return { ...initial, dry_run: true, _entries: undefined }
  if (!initial.ok) {
    const error = new Error(`fleet init refused:\n${initial.errors.map((entry) => `- ${entry.code}: ${entry.message}${entry.path ? ` (${entry.path})` : ''}`).join('\n')}`)
    error.exitCode = 2
    throw error
  }
  const lock = await withFleetInstallLock(root, [...initial._entries.keys(), ...generatedPaths], async () => {
    const plan = await planFleetInstall(root, config, options)
    if (!plan.ok) {
      const error = new Error('fleet install changed while acquiring its lock; run fleet plan again')
      error.exitCode = 3
      throw error
    }
    const changes = []
    try {
      for (const operation of plan.operations.filter((entry) => entry.action === 'create')) {
        await writeFleetTransactionFile(root, operation.path, plan._entries.get(operation.path), changes)
      }
      const outputs = await expectedFleetBuild(root)
      for (const [relativePath, content] of Object.entries(outputs)) {
        await writeFleetTransactionFile(root, relativePath, content, changes)
      }
      return { plan, outputs }
    } catch (error) {
      const rollbackConflicts = await rollbackFleetTransaction(root, changes)
      if (rollbackConflicts.length > 0) {
        error.message = `${error.message}\nfleet install rollback preserved externally changed paths: ${rollbackConflicts.join(', ')}`
      }
      throw error
    }
  })
  const result = lock.value.plan
  return {
    ok: true,
    pack_id: result.pack_id,
    pack_version: result.pack_version,
    root,
    installed: result.operations.filter((entry) => entry.action === 'create').map((entry) => entry.path),
    retained: result.operations.filter((entry) => entry.action === 'retain').map((entry) => entry.path),
    generated: Object.keys(lock.value.outputs),
    recovered_stale_install: lock.recovered,
  }
}

async function readJsonLines(path) {
  if (!(await pathExists(path))) return []
  const records = []
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch {}
  }
  return records
}

async function readJsonFiles(root, relativeRoot, predicate = () => true) {
  const records = []
  for (const file of (await walkFiles(join(root, relativeRoot))).filter((path) => path.endsWith('.json') && predicate(path))) {
    try { records.push(await readJson(join(root, relativeRoot, file))) } catch {}
  }
  return records
}

function generatedRecord(payload, input) {
  const generation = {
    generator: `siso-project-os@${PROJECT_OS_VERSION}/fleet`,
    input_digest: hash(JSON.stringify(input)),
  }
  return {
    ...payload,
    generation: {
      ...generation,
      output_digest: hash(JSON.stringify({ ...payload, generation })),
    },
  }
}

async function fleetTaskGraph(root, programme) {
  const entries = (await scanTasks(root)).filter((entry) => entry.task && !entry.parseError)
  const tasks = new Map(entries.map((entry) => [entry.task.id, entry.task]))
  const nodes = entries.map(({ task }) => {
    const dependencies = [...(task.dependencies ?? [])].sort()
    const blockedBy = dependencies.filter((id) => tasks.get(id)?.status !== 'completed')
    const ready = task.status === 'backlog' && blockedBy.length === 0 && task.requires_human !== true && !task.blocker
    return {
      id: task.id,
      title: task.title ?? null,
      status: task.status ?? null,
      priority: task.priority ?? null,
      domain: task.domain ?? null,
      owner: task.owner ?? null,
      dependencies,
      blocked_by: blockedBy,
      ready,
      requires_human: task.requires_human === true,
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
  const edges = nodes.flatMap((node) => node.dependencies.map((dependency) => ({ from: dependency, to: node.id, kind: 'blocks' })))
    .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`))
  const payload = {
    schema_version: 1,
    kind: 'fleet-task-graph-projection',
    programme_id: programme.id,
    nodes,
    edges,
    counts: {
      total: nodes.length,
      ready: nodes.filter((node) => node.ready).length,
      blocked: nodes.filter((node) => node.status === 'blocked' || node.blocked_by.length > 0 || node.requires_human).length,
      completed: nodes.filter((node) => node.status === 'completed').length,
    },
  }
  return generatedRecord(payload, { programme_id: programme.id, nodes, edges })
}

async function fleetTeamState(root, programme, policy, domains) {
  const missions = (await readJsonFiles(root, '.agents/missions', (path) => path.endsWith('/meta.json')))
    .filter((record) => record.state === 'acquired')
    .map((record) => ({
      id: record.id,
      owner: record.owner?.actor ?? null,
      heartbeat_at: record.heartbeat_at ?? null,
      task_ids: record.active_task_ids ?? [],
      run_id: record.active_run_id ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id))
  const claims = (await readJsonFiles(root, '.agents/work-claims/active'))
    .filter((record) => record.state === 'active')
    .map((record) => ({
      id: record.id,
      task_id: record.task_id,
      run_id: record.run_id,
      actor: record.actor,
      seat: record.seat ?? null,
      write_set: record.write_set ?? [],
      acquired_at: record.acquired_at,
    })).sort((left, right) => left.id.localeCompare(right.id))
  const runs = (await readJsonFiles(root, '.agents/runs', (path) => path.endsWith('/run.json')))
    .map((record) => ({
      id: record.id,
      status: record.status ?? null,
      task_ids: record.task_ids ?? [],
      units: record.units?.length ?? 0,
      receipts: record.receipts?.length ?? 0,
      gates: record.gates?.length ?? 0,
    })).sort((left, right) => left.id.localeCompare(right.id))
  const callbacks = await readJsonLines(join(root, programme.callback_ledger))
  const admissions = await readJsonFiles(root, `${FLEET_ROOT}/admissions`)
  const maxLive = policy.capacity.max_live
  const payload = {
    schema_version: 1,
    kind: 'fleet-team-state-projection',
    programme_id: programme.id,
    capacity: {
      max_live: maxLive,
      verifier_ratio: policy.capacity.verifier_ratio,
      verifier_reserve: policy.capacity.verifier_reserve,
      max_non_verifiers: maxLive - policy.capacity.verifier_reserve,
      active_claims: claims.length,
      remaining_claim_slots: Math.max(0, maxLive - claims.length),
    },
    domains: domains.map((domain) => ({
      id: domain.id,
      owner: domain.owner,
      owner_role: domain.owner_role,
      verifier_role: domain.verifier_role,
      repository_id: domain.repository_id,
      write_paths: domain.write_paths,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    active_missions: missions,
    active_claims: claims,
    runs,
    callbacks: {
      total: callbacks.length,
      unacknowledged: callbacks.filter((record) => record.ack_required && record.status !== 'acknowledged').length,
    },
    admissions: {
      total: admissions.length,
      admit: admissions.filter((record) => record.verdict === 'admit').length,
      hold: admissions.filter((record) => record.verdict === 'hold').length,
      reject: admissions.filter((record) => record.verdict === 'reject').length,
    },
  }
  return generatedRecord(payload, { programme, policy, domains, missions, claims, runs, callbacks, admissions })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function renderFleetHtml(taskGraph, teamState) {
  const domains = teamState.domains.map((domain) => `<tr><td>${escapeHtml(domain.id)}</td><td>${escapeHtml(domain.owner)}</td><td>${escapeHtml(domain.repository_id)}</td><td><code>${escapeHtml(domain.write_paths.join(', '))}</code></td></tr>`).join('')
  const tasks = taskGraph.nodes.map((task) => `<tr><td>${escapeHtml(task.id)}</td><td>${escapeHtml(task.title ?? '')}</td><td>${escapeHtml(task.status ?? '')}</td><td>${task.ready ? 'ready' : 'gated'}</td></tr>`).join('')
  const state = JSON.stringify({ task_graph: taskGraph, team_state: teamState }).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fleet Mission Control</title><style>body{font:15px/1.5 system-ui;max-width:76rem;margin:auto;padding:2rem}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{padding:.55rem;border-bottom:1px solid #ccd4df;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}@media(max-width:42rem){body{padding:.6rem}}</style></head><body><main data-contract="fleet-mission-control"><h1>Fleet Mission Control</h1><p>Read-only projection. Canonical task, ownership, admission, completion, and qualification records remain at the source paths in SOURCE-CONTRACT.json.</p><p>Capacity: ${teamState.capacity.active_claims}/${teamState.capacity.max_live} live claims · ${teamState.capacity.verifier_reserve} verifier slots reserved · ${teamState.admissions.hold} held admissions.</p><h2>Domains</h2><table><thead><tr><th>Domain</th><th>Owner</th><th>Repository</th><th>Write scope</th></tr></thead><tbody>${domains}</tbody></table><h2>Task graph</h2><table><thead><tr><th>Task</th><th>Title</th><th>Status</th><th>Admission state</th></tr></thead><tbody>${tasks}</tbody></table></main><script id="project-os-fleet-state" type="application/json">${state}</script></body></html>`
}

export async function expectedFleetBuild(root) {
  if (!(await pathExists(join(root, FLEET_ROOT, 'PACK.json')))) return {}
  const programme = await readJson(join(root, FLEET_ROOT, 'PROGRAM.json'))
  const policy = await readJson(join(root, FLEET_ROOT, 'POLICY.json'))
  const domains = await readJsonFiles(root, `${FLEET_ROOT}/domains`)
  const taskGraph = await fleetTaskGraph(root, programme)
  const teamState = await fleetTeamState(root, programme, policy, domains)
  return {
    [generatedPaths[0]]: json(taskGraph),
    [generatedPaths[1]]: json(teamState),
    [generatedPaths[2]]: `${renderFleetHtml(taskGraph, teamState)}\n`,
  }
}

export async function buildFleet(root) {
  const outputs = await expectedFleetBuild(root)
  for (const [relativePath, content] of Object.entries(outputs)) {
    const path = join(root, relativePath)
    await mkdir(dirname(path), { recursive: true })
    if (relativePath.endsWith('.json')) await writeJsonAtomic(path, JSON.parse(content))
    else await writeTextAtomic(path, content)
  }
  return outputs
}

async function installedSchemas(root) {
  const schemas = new Map()
  for (const file of (await walkFiles(join(root, '.project-os/schemas'))).filter((path) => path.endsWith('.schema.json'))) {
    try { schemas.set(file.replace(/\.schema\.json$/, ''), await readJson(join(root, '.project-os/schemas', file))) } catch {}
  }
  return schemas
}

function addSchemaChecks(errors, schemas, name, value, path) {
  const schema = schemas.get(name)
  if (!schema) {
    errors.push(problem('missing_fleet_schema', `missing ${name}.schema.json`, path))
    return
  }
  errors.push(...schemaProblems(value, schema, name, path))
}

export async function checkFleetInstallation(root, providedSchemas = null) {
  const packPath = `${FLEET_ROOT}/PACK.json`
  if (!(await pathExists(join(root, packPath)))) return { installed: false, ok: true, errors: [], warnings: [] }
  const errors = []
  const warnings = []
  const schemas = providedSchemas ?? await installedSchemas(root)
  const records = new Map()
  const callbackRecords = []
  const admissionRecords = []
  const roleRecords = []
  const contractRecords = []
  const declarations = [
    [packPath, 'fleet-pack'],
    [`${FLEET_ROOT}/PROGRAM.json`, 'fleet-program'],
    [`${FLEET_ROOT}/REPOS.json`, 'fleet-repositories'],
    [`${FLEET_ROOT}/POLICY.json`, 'fleet-policy'],
    [`${FLEET_ROOT}/PROCESS-PLAN.json`, 'fleet-process-plan'],
    [`${FLEET_ROOT}/SOURCE-CONTRACT.json`, 'fleet-source-contract'],
  ]
  for (const [path, schemaName] of declarations) {
    try {
      const record = await readJson(join(root, path))
      records.set(schemaName, record)
      addSchemaChecks(errors, schemas, schemaName, record, path)
    } catch (error) {
      errors.push(problem('invalid_fleet_json', error instanceof Error ? error.message : String(error), path))
    }
  }
  const domains = []
  for (const file of (await walkFiles(join(root, FLEET_ROOT, 'domains'))).filter((path) => path.endsWith('.json'))) {
    const path = `${FLEET_ROOT}/domains/${file}`
    try {
      const record = await readJson(join(root, path))
      domains.push(record)
      addSchemaChecks(errors, schemas, 'fleet-domain', record, path)
      if (file !== `${record.id}.json`) errors.push(problem('domain_filename_mismatch', `${record.id} must be stored as ${record.id}.json`, path))
    } catch (error) { errors.push(problem('invalid_fleet_json', error instanceof Error ? error.message : String(error), path)) }
  }
  for (const file of (await walkFiles(join(root, '.agents/agents'))).filter((path) => /^fleet-.*\.agent\.json$/.test(path))) {
    const path = `.agents/agents/${file}`
    try {
      const record = await readJson(join(root, path))
      roleRecords.push(record)
      addSchemaChecks(errors, schemas, 'agent-profile', record, path)
      const expectedRoleId = file.replace(/\.agent\.json$/, '')
      if (record.role_id !== expectedRoleId) errors.push(problem('fleet_role_profile_mismatch', `${path} must declare role_id ${expectedRoleId}`, path))
    } catch (error) { errors.push(problem('invalid_fleet_json', error.message, path)) }
  }
  for (const [file, schemaName] of [['SOL-GOAL.template.json', 'agent-packet'], ['LUNA-TASK.template.json', 'agent-packet']]) {
    const path = `${FLEET_ROOT}/contracts/${file}`
    try {
      const record = await readJson(join(root, path))
      contractRecords.push(record)
      addSchemaChecks(errors, schemas, schemaName, record, path)
    } catch (error) { errors.push(problem('invalid_fleet_json', error.message, path)) }
  }
  const callbackPath = records.get('fleet-program')?.callback_ledger ?? `${FLEET_ROOT}/callbacks.ndjson`
  if (!(await pathExists(join(root, callbackPath)))) errors.push(problem('missing_callback_ledger', 'fleet callback ledger is missing', callbackPath))
  else {
    const lines = (await readFile(join(root, callbackPath), 'utf8')).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue
      try {
        const record = JSON.parse(lines[index])
        callbackRecords.push(record)
        addSchemaChecks(errors, schemas, 'fleet-callback', record, `${callbackPath}:${index + 1}`)
        if (record.status === 'acknowledged' && (typeof record.acknowledged_at !== 'string' || typeof record.acknowledged_by !== 'string')) {
          errors.push(problem('invalid_callback_acknowledgement', 'acknowledged callbacks require acknowledged_at and acknowledged_by', `${callbackPath}:${index + 1}`))
        }
      } catch (error) { errors.push(problem('invalid_fleet_callback', error.message, `${callbackPath}:${index + 1}`)) }
    }
    errors.push(...uniqueIdProblems(callbackRecords, 'callback'))
  }
  for (const file of (await walkFiles(join(root, FLEET_ROOT, 'admissions'))).filter((path) => path.endsWith('.json'))) {
    const path = `${FLEET_ROOT}/admissions/${file}`
    try {
      const record = await readJson(join(root, path))
      admissionRecords.push(record)
      addSchemaChecks(errors, schemas, 'fleet-admission-receipt', record, path)
      addSchemaChecks(errors, schemas, 'fleet-admission-input', {
        schema_version: record.schema_version,
        id: record.id,
        evaluated_at: record.evaluated_at,
        candidate: record.candidate,
        observations: record.observations,
      }, path)
      if (file !== `${record.id}.json`) errors.push(problem('admission_filename_mismatch', `${record.id} must be stored as ${record.id}.json`, path))
      const expectedVerdict = record.checks?.some((entry) => entry.status === 'reject') ? 'reject' : record.checks?.some((entry) => entry.status === 'hold') ? 'hold' : 'admit'
      const expectedReasons = [...new Set((record.checks ?? []).filter((entry) => entry.status !== 'pass').map((entry) => entry.id))]
      if (record.verdict !== expectedVerdict || JSON.stringify(record.reason_codes) !== JSON.stringify(expectedReasons)) {
        errors.push(problem('inconsistent_admission_receipt', 'verdict and reason_codes must be derived from checks', path))
      }
      if (record.integrity?.digest !== admissionReceiptDigest(record)) {
        errors.push(problem('admission_receipt_digest_mismatch', 'receipt bytes do not match the recorded canonical digest', path))
      }
      errors.push(...uniqueIdProblems(record.checks, 'admission_check').map((entry) => ({ ...entry, path })))
    } catch (error) { errors.push(problem('invalid_fleet_admission', error.message, path)) }
  }
  errors.push(...uniqueIdProblems(admissionRecords, 'admission'))
  const pack = records.get('fleet-pack')
  let installedProjectVersion = null
  try {
    installedProjectVersion = (await readJson(join(root, '.project-os', 'project.json'))).project_os_version
  } catch (error) {
    errors.push(problem('invalid_project_os_installation', error instanceof Error ? error.message : String(error), '.project-os/project.json'))
  }
  if (pack) {
    const comparison = compareVersions(installedProjectVersion, pack.project_os_minimum_version)
    if (comparison === null) {
      errors.push(problem('invalid_project_os_version', `installed Project OS version must be semantic x.y.z; received ${String(installedProjectVersion)}`, '.project-os/project.json'))
    } else if (comparison === -1) {
      errors.push(problem('fleet_project_os_incompatible', `installed Project OS ${installedProjectVersion} is older than required ${pack.project_os_minimum_version}`, '.project-os/project.json'))
    }
  }
  if (pack) {
    const requiredInstalledPaths = [
      packPath,
      ...declarations.slice(1).map(([path]) => path),
      ...rolePlan.map(([roleId]) => `.agents/agents/${roleId}.agent.json`),
      `${FLEET_ROOT}/contracts/SOL-GOAL.template.json`,
      `${FLEET_ROOT}/contracts/LUNA-TASK.template.json`,
      callbackPath,
      ...domains.map((domain) => `${FLEET_ROOT}/domains/${domain.id}.json`),
      ...fleetSchemaNames.map((name) => `.project-os/schemas/${name}.schema.json`),
    ]
    for (const path of requiredInstalledPaths) {
      if (!(pack.installed_files ?? []).includes(path)) errors.push(problem('fleet_manifest_omission', 'required managed artifact is absent from installed_files', path))
    }
    const declaredGenerated = [...(pack.generated_files ?? [])].sort()
    if (JSON.stringify(declaredGenerated) !== JSON.stringify([...generatedPaths].sort())) {
      errors.push(problem('fleet_generated_manifest_mismatch', 'generated_files must exactly match the pack projection set', packPath))
    }
    const mutableInstalledPaths = new Set([
      packPath,
      callbackPath,
      `${FLEET_ROOT}/evidence/.gitkeep`,
      `${FLEET_ROOT}/admissions/.gitkeep`,
    ])
    const expectedManagedPaths = (pack.installed_files ?? []).filter((path) => !mutableInstalledPaths.has(path)).sort((left, right) => left.localeCompare(right))
    const managedArtifacts = [...(pack.managed_artifacts ?? [])].sort((left, right) => left.path.localeCompare(right.path))
    const declaredManagedPaths = managedArtifacts.map((entry) => entry.path)
    if (JSON.stringify(declaredManagedPaths) !== JSON.stringify(expectedManagedPaths)) {
      errors.push(problem('fleet_managed_manifest_mismatch', 'managed_artifacts must cover every immutable installed artifact exactly once', packPath))
    }
    for (const artifact of managedArtifacts) {
      const artifactPath = join(root, artifact.path)
      if (!(await pathExists(artifactPath))) continue
      if (hash(await readFile(artifactPath)) !== artifact.sha256) {
        errors.push(problem('managed_fleet_artifact_changed', 'installed artifact differs from its install-time digest', artifact.path))
      }
    }
    const processPlan = records.get('fleet-process-plan')
    if (processPlan?.compute_profiles) {
      const expectedRoles = rolePlan.map(([roleId, contract, lifecycle, machineRole, computeProfile]) => ({
        role_id: roleId,
        contract,
        lifecycle,
        profile: `.agents/agents/${roleId}.agent.json`,
        compute_profile: computeProfile,
        reasoning_effort: processPlan.compute_profiles[computeProfile]?.reasoning_effort,
        machine_roles: [machineRole],
      }))
      if (JSON.stringify(processPlan.roles) !== JSON.stringify(expectedRoles)) {
        errors.push(problem('fleet_process_plan_mismatch', 'process-plan roles must exactly match the versioned role contract', `${FLEET_ROOT}/PROCESS-PLAN.json`))
      }
    }
    if (pack.pack_version === FLEET_PACK_VERSION) {
      for (const file of await walkFiles(fleetTemplateRoot)) {
        const expected = await readFile(join(fleetTemplateRoot, file), 'utf8')
        const path = join(root, file)
        if (await pathExists(path) && await readFile(path, 'utf8') !== expected) {
          errors.push(problem('managed_fleet_artifact_changed', 'installed role or contract differs from its versioned pack source', file))
        }
      }
      for (const name of fleetSchemaNames) {
        const relativePath = `.project-os/schemas/${name}.schema.json`
        const expected = await readFile(join(schemasRoot, `${name}.schema.json`), 'utf8')
        const path = join(root, relativePath)
        if (await pathExists(path) && await readFile(path, 'utf8') !== expected) {
          errors.push(problem('managed_fleet_artifact_changed', 'installed fleet schema differs from its versioned pack source', relativePath))
        }
      }
    }
  }
  for (const path of [...(pack?.installed_files ?? []), ...(pack?.generated_files ?? [])]) {
    if (!(await pathExists(join(root, path)))) errors.push(problem('missing_fleet_artifact', 'declared fleet artifact is missing', path))
  }
  const programme = records.get('fleet-program')
  const repositories = records.get('fleet-repositories')?.repositories ?? []
  const policy = records.get('fleet-policy')
  if (programme && policy) {
    const policySchema = schemas.get('fleet-policy')
    const policyValid = Boolean(policySchema) && validateSchema(policy, policySchema).length === 0
    if (!policyValid) {
      errors.push(problem('invalid_fleet_structure', 'fleet policy must pass schema validation before structural evaluation', `${FLEET_ROOT}/POLICY.json`))
    } else try {
      const machines = Array.isArray(policy.machines) ? policy.machines : []
      errors.push(...structuralProblems({
        programme,
        repositories,
        domains,
        policy,
        machines,
        bootstrap_machine_id: machines[0]?.id,
        front_door: {
          projection_root: `${FLEET_ROOT}/generated`,
          source_contract: `${FLEET_ROOT}/SOURCE-CONTRACT.json`,
        },
      }, { scanSecrets: false }).filter((entry) => entry.code !== 'missing_bootstrap_machine'))
    } catch (error) {
      errors.push(problem('invalid_fleet_structure', error instanceof Error ? error.message : String(error), `${FLEET_ROOT}/POLICY.json`))
    }
  }
  errors.push(...secretProblems([
    ...records.values(),
    ...domains,
    ...roleRecords,
    ...contractRecords,
    ...callbackRecords,
    ...admissionRecords,
  ]))
  try {
    const outputs = await expectedFleetBuild(root)
    for (const [path, expected] of Object.entries(outputs)) {
      if (!(await pathExists(join(root, path)))) continue
      if ((await readFile(join(root, path), 'utf8')) !== expected) errors.push(problem('stale_fleet_projection', 'run project-os fleet build', path))
    }
  } catch (error) { errors.push(problem('fleet_projection_failed', error.message, `${FLEET_ROOT}/generated`)) }
  return { installed: true, ok: errors.length === 0, errors, warnings }
}

function configuredVerifier(role, domain) {
  return Boolean(domain) && role === domain.verifier_role
}

function roleAllowedForDomain(role, domain) {
  return Boolean(domain) && (role === 'fleet-implementer' || role === domain.owner_role || role === domain.verifier_role)
}

function machineRoleFor(role, domain) {
  if (!roleAllowedForDomain(role, domain)) return null
  if (configuredVerifier(role, domain)) return 'verifier'
  const configured = rolePlan.find(([roleId]) => roleId === role)
  return configured?.[3] ?? null
}

function admissionCheck(checks, id, status, detail) {
  checks.push({ id, status, detail })
}

function gitCommand(repositoryRoot, args) {
  return spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
}

async function repositoryState(root, repository, candidate) {
  if (!repository) return { boundary: false, sha: false, clean: false, root: null }
  const repositoryRoot = resolve(root, repository.root)
  const boundary = relative(root, repositoryRoot)
  if (boundary === '..' || boundary.startsWith(`..${sep}`) || !(await pathExists(repositoryRoot))) {
    return { boundary: false, sha: false, clean: false, root: repositoryRoot }
  }
  let directory = false
  try { directory = (await stat(repositoryRoot)).isDirectory() } catch {}
  if (!directory) return { boundary: false, sha: false, clean: false, root: repositoryRoot }
  const topLevel = gitCommand(repositoryRoot, ['rev-parse', '--show-toplevel'])
  const exactBoundary = topLevel.status === 0 && resolve(topLevel.stdout.trim()) === repositoryRoot
  if (!exactBoundary) return { boundary: false, sha: false, clean: false, root: repositoryRoot }
  const sha = gitCommand(repositoryRoot, ['cat-file', '-e', `${candidate.candidate_sha}^{commit}`]).status === 0
  const status = gitCommand(repositoryRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.',
    ':(exclude).agents', ':(exclude).project-os',
  ])
  return {
    boundary: true,
    sha,
    clean: status.status === 0 && status.stdout.trim() === '',
    root: repositoryRoot,
  }
}

async function activeClaimState(root, schemas) {
  const relativeRoot = '.agents/work-claims/active'
  const records = []
  const errors = []
  const schema = schemas.get('work-claim')
  for (const file of (await walkFiles(join(root, relativeRoot))).filter((path) => path.endsWith('.json'))) {
    const path = `${relativeRoot}/${file}`
    try {
      const record = await readJson(join(root, path))
      if (!schema) errors.push(`${path} cannot be validated because work-claim.schema.json is missing`)
      else if (validateSchema(record, schema).length > 0) errors.push(`${path} violates work-claim.schema.json`)
      if (record.state !== 'active') errors.push(`${path} is in the active directory with state ${record.state}`)
      if (file !== `${record.id}.json`) errors.push(`${path} filename does not match ${record.id}`)
      records.push(record)
    } catch (error) {
      errors.push(`${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { records, errors }
}

async function checkpointState(root, pointer, schemas) {
  if (typeof pointer !== 'string' || !pathContains('.agents/briefs/snapshots', pointer)) return { ok: false, record: null }
  const path = join(root, pointer)
  if (!(await pathExists(path))) return { ok: false, record: null }
  try {
    const record = await readJson(path)
    const schema = schemas.get('resume-snapshot')
    return { ok: Boolean(schema) && validateSchema(record, schema).length === 0, record }
  } catch {
    return { ok: false, record: null }
  }
}

async function roleProfileMatchesPack(root, role) {
  const relativePath = `.agents/agents/${role}.agent.json`
  const sourcePath = join(fleetTemplateRoot, relativePath)
  const installedPath = join(root, relativePath)
  if (!(await pathExists(sourcePath)) || !(await pathExists(installedPath))) return false
  return await readFile(sourcePath, 'utf8') === await readFile(installedPath, 'utf8')
}

async function readTrustedManagedJson(root, pack, relativePath) {
  const artifact = (pack.managed_artifacts ?? []).find((entry) => entry.path === relativePath)
  if (!artifact) throw new Error(`fleet manifest does not bind ${relativePath}`)
  const bytes = await readFile(join(root, relativePath))
  if (hash(bytes) !== artifact.sha256) throw new Error(`managed fleet artifact changed: ${relativePath}`)
  return JSON.parse(bytes.toString('utf8'))
}

function absolutePathContains(parent, child) {
  const result = relative(parent, child)
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result))
}

function sameFilesystemPath(left, right) {
  return resolve(left).normalize('NFC').toLowerCase() === resolve(right).normalize('NFC').toLowerCase()
}

async function evidenceFilesystemState(root, candidate, evidenceRefs) {
  try {
    const projectRoot = await realpath(root)
    const evidencePath = await realpath(join(root, candidate.evidence_path))
    const evidenceStat = await stat(evidencePath)
    const expectedEvidencePath = resolve(projectRoot, candidate.evidence_path)
    const pathOk = evidenceStat.isDirectory()
      && absolutePathContains(projectRoot, evidencePath)
      && sameFilesystemPath(evidencePath, expectedEvidencePath)
    const refs = await Promise.all(evidenceRefs.map(async (pointer) => {
      try {
        const referencePath = await realpath(join(root, pointer))
        const referenceStat = await stat(referencePath)
        return referenceStat.isFile()
          && absolutePathContains(evidencePath, referencePath)
          && sameFilesystemPath(referencePath, resolve(projectRoot, pointer))
      } catch {
        return false
      }
    }))
    return { path_ok: pathOk, refs_ok: refs.every(Boolean) }
  } catch {
    return { path_ok: false, refs_ok: false }
  }
}

export async function evaluateFleetAdmission(root, input) {
  const schemas = await installedSchemas(root)
  const schema = schemas.get('fleet-admission-input') ?? await sourceSchema('fleet-admission-input')
  const violations = validateSchema(input, schema)
  if (violations.length > 0) {
    const error = new Error(`fleet admission input violates its schema:\n${violations.map((entry) => `- ${entry.path}: ${entry.message}`).join('\n')}`)
    error.exitCode = 2
    throw error
  }
  const secrets = secretProblems(input)
  if (secrets.length > 0) {
    const error = new Error(`fleet admission input contains forbidden secret material:\n${secrets.map((entry) => `- ${entry.code}: ${entry.message} (${entry.path})`).join('\n')}`)
    error.exitCode = 2
    throw error
  }
  const installedProject = await readJson(join(root, '.project-os', 'project.json'))
  const installedVersionComparison = compareVersions(installedProject.project_os_version, FLEET_PROJECT_OS_MINIMUM_VERSION)
  if (installedVersionComparison === null) throw new Error(`installed Project OS version must be semantic x.y.z; received ${String(installedProject.project_os_version)}`)
  if (installedVersionComparison === -1) throw new Error(`installed Project OS ${installedProject.project_os_version} is older than required ${FLEET_PROJECT_OS_MINIMUM_VERSION}`)
  const pack = await readJson(join(root, FLEET_ROOT, 'PACK.json'))
  const packViolations = validateSchema(pack, await sourceSchema('fleet-pack'))
  if (packViolations.length > 0) throw new Error(`installed fleet manifest is invalid: ${packViolations[0].path} ${packViolations[0].message}`)
  const policy = await readTrustedManagedJson(root, pack, `${FLEET_ROOT}/POLICY.json`)
  const processPlan = await readTrustedManagedJson(root, pack, `${FLEET_ROOT}/PROCESS-PLAN.json`)
  const repositories = (await readTrustedManagedJson(root, pack, `${FLEET_ROOT}/REPOS.json`)).repositories
  const domains = []
  for (const file of (await walkFiles(join(root, FLEET_ROOT, 'domains'))).filter((path) => path.endsWith('.json'))) {
    domains.push(await readTrustedManagedJson(root, pack, `${FLEET_ROOT}/domains/${file}`))
  }
  const tasks = new Map((await scanTasks(root)).filter((entry) => entry.task && !entry.parseError).map((entry) => [entry.task.id, entry.task]))
  const claimState = await activeClaimState(root, schemas)
  const activeClaims = claimState.records
  const activeMissions = (await readJsonFiles(root, '.agents/missions', (path) => path.endsWith('/meta.json'))).filter((record) => record.state === 'acquired')
  const { candidate, observations } = input
  const checks = []
  const task = tasks.get(candidate.task_id)
  const domain = domains.find((record) => record.id === candidate.domain_id)
  const repository = repositories.find((record) => record.id === candidate.repository_id)
  const machine = policy.machines.find((record) => record.id === candidate.machine_id)
  const candidateMachineRole = machineRoleFor(candidate.role, domain)
  const isVerifier = configuredVerifier(candidate.role, domain)
  const repositoryObservation = await repositoryState(root, repository, candidate)

  admissionCheck(checks, 'task_exists', task ? 'pass' : 'reject', task ? `${task.id} exists` : `${candidate.task_id} is not canonical`)
  if (task) {
    const blockedBy = (task.dependencies ?? []).filter((id) => tasks.get(id)?.status !== 'completed')
    admissionCheck(checks, 'dependency_blocked', blockedBy.length === 0 && task.status !== 'blocked' && !task.requires_human ? 'pass' : 'hold', blockedBy.length > 0 ? `waiting for ${blockedBy.join(', ')}` : task.requires_human ? 'task requires human action' : task.status === 'blocked' ? 'task is blocked' : 'dependencies complete')
    const allowedStatus = candidate.mode === 'resume' ? ['backlog', 'in_progress'].includes(task.status) : task.status === 'backlog'
    admissionCheck(checks, 'task_state', allowedStatus ? 'pass' : 'hold', allowedStatus ? `${task.status} permits ${candidate.mode}` : `${task.status} does not permit ${candidate.mode}`)
    admissionCheck(checks, 'task_domain', task.domain === candidate.domain_id ? 'pass' : 'reject', task.domain === candidate.domain_id ? 'task and candidate domains match' : `${task.id} belongs to ${task.domain}`)
    const implementationActor = candidate.implementation_actor
    const implementationBound = typeof implementationActor === 'string'
      && (task.owner === implementationActor || activeClaims.some((claim) => claim.task_id === task.id && claim.actor === implementationActor))
    const ownerMatches = isVerifier
      ? implementationBound
      : candidate.mode === 'resume' ? task.owner === candidate.actor : task.owner === null || task.owner === candidate.actor
    admissionCheck(checks, 'task_owner', ownerMatches ? 'pass' : 'reject', ownerMatches ? `${candidate.actor} may ${candidate.mode} this task` : `${task.id} is owned by ${task.owner ?? 'nobody'}`)
  }
  admissionCheck(checks, 'domain_exists', domain ? 'pass' : 'reject', domain ? `${domain.id} exists` : `${candidate.domain_id} is not declared`)
  admissionCheck(checks, 'repository_exists', repository ? 'pass' : 'reject', repository ? `${repository.id} exists` : `${candidate.repository_id} is not declared`)
  admissionCheck(checks, 'repository_boundary', repositoryObservation.boundary ? 'pass' : 'reject', repositoryObservation.boundary ? `repository root is ${repository.root}` : 'declared repository root is missing or is not an exact Git worktree root')
  admissionCheck(checks, 'candidate_role', candidateMachineRole ? 'pass' : 'reject', candidateMachineRole ? `${candidate.role} is authorized for ${candidate.domain_id}` : `${candidate.role} is not an authorized role for this domain`)
  const roleProfileValid = candidateMachineRole ? await roleProfileMatchesPack(root, candidate.role) : false
  admissionCheck(checks, 'role_profile', roleProfileValid ? 'pass' : 'reject', roleProfileValid ? `${candidate.role} matches its versioned pack profile` : `${candidate.role} profile is missing, renamed, or changed`)
  const reservedCandidatePaths = candidate.write_paths.filter((path) => reservedWritePaths.some((boundary) => pathsOverlap(path, boundary)))
  admissionCheck(checks, 'reserved_write_scope', reservedCandidatePaths.length === 0 ? 'pass' : 'reject', reservedCandidatePaths.length === 0 ? 'write paths exclude Project OS control state' : `reserved control paths: ${reservedCandidatePaths.join(', ')}`)
  if (domain) {
    admissionCheck(checks, 'domain_repository', domain.repository_id === candidate.repository_id ? 'pass' : 'reject', domain.repository_id === candidate.repository_id ? 'candidate matches domain repository' : `${domain.id} belongs to ${domain.repository_id}`)
    const escaped = candidate.write_paths.filter((path) => !domain.write_paths.some((boundary) => pathContains(boundary, path)))
    admissionCheck(checks, 'write_scope', escaped.length === 0 ? 'pass' : 'reject', escaped.length === 0 ? 'write paths remain inside domain ownership' : `outside domain ownership: ${escaped.join(', ')}`)
    const expectedEvidenceRoots = domain.evidence_paths.map((boundary) => `${normalizePath(boundary)}/${candidate.task_id}`)
    const taskEvidenceBound = expectedEvidenceRoots.includes(normalizePath(candidate.evidence_path))
    admissionCheck(checks, 'evidence_boundary', taskEvidenceBound ? 'pass' : 'reject', taskEvidenceBound ? 'evidence path is the candidate task evidence root' : `${candidate.evidence_path} must equal one of: ${expectedEvidenceRoots.join(', ')}`)
    const refsInside = observations.evidence_refs.every((path) => pathContains(candidate.evidence_path, path))
    admissionCheck(checks, 'evidence_refs', refsInside ? 'pass' : 'reject', refsInside ? 'evidence references remain inside the candidate task evidence root' : 'one or more evidence references escape the candidate task evidence root')
    if (isVerifier) {
      const implementationActor = candidate.implementation_actor
      const independent = typeof implementationActor === 'string' && candidate.actor !== implementationActor && candidate.actor !== domain.owner
      admissionCheck(checks, 'verifier_independence', independent ? 'pass' : 'reject', independent ? `verifier differs from implementation actor ${implementationActor} and domain owner` : 'verifier requires a distinct implementation_actor and cannot be the domain owner')
      const implementationBound = typeof implementationActor === 'string' && Boolean(task)
        && (task.owner === implementationActor || activeClaims.some((claim) => claim.task_id === candidate.task_id && claim.actor === implementationActor))
      admissionCheck(checks, 'verifier_implementation_actor', implementationBound ? 'pass' : 'reject', implementationBound ? `${implementationActor} is bound by canonical task ownership or an active task claim` : 'implementation_actor must match canonical task ownership or an active claim for this task')
      admissionCheck(checks, 'verifier_write_scope', candidate.write_paths.length === 0 ? 'pass' : 'reject', candidate.write_paths.length === 0 ? 'verifier has no implementation write paths' : 'verifier cannot request implementation write paths')
    }
  }

  const evidenceState = await evidenceFilesystemState(root, candidate, observations.evidence_refs)
  admissionCheck(checks, 'evidence_path', evidenceState.path_ok ? 'pass' : 'reject', evidenceState.path_ok ? 'evidence destination is a real in-project directory' : 'evidence destination is missing, redirected, or outside the project')
  admissionCheck(checks, 'evidence_files', evidenceState.refs_ok ? 'pass' : 'reject', evidenceState.refs_ok ? 'evidence references are real in-boundary files' : 'one or more evidence references are missing, redirected, outside the evidence root, or not files')
  admissionCheck(checks, 'candidate_sha', repositoryObservation.sha ? 'pass' : 'reject', repositoryObservation.sha ? 'candidate SHA exists as a commit in the declared repository' : 'candidate SHA is not a commit in the declared repository')
  admissionCheck(checks, 'worktree_clean', candidate.write_paths.length === 0 || repositoryObservation.clean ? 'pass' : 'reject', candidate.write_paths.length === 0 ? 'read-only candidate does not require a clean implementation worktree' : repositoryObservation.clean ? 'implementation worktree is clean' : 'implementation worktree is dirty')

  admissionCheck(checks, 'canonical_claim_state', claimState.errors.length === 0 ? 'pass' : 'reject', claimState.errors.length === 0 ? 'active work claims are readable and schema-valid' : claimState.errors.join('; '))
  const requestedClaim = typeof candidate.claim_id === 'string' ? activeClaims.find((claim) => claim.id === candidate.claim_id) : null
  if (candidate.write_paths.length > 0) {
    if (!candidate.claim_id) admissionCheck(checks, 'claim_required', 'hold', 'write-capable admission requires an active canonical work claim')
    else if (!requestedClaim) admissionCheck(checks, 'claim_binding', 'reject', `${candidate.claim_id} is not active`)
    else {
      const expectedWriteSet = [...candidate.write_paths].sort()
      const actualWriteSet = [...(requestedClaim.write_set ?? [])].sort()
      const claimMatches = requestedClaim.task_id === candidate.task_id
        && requestedClaim.actor === candidate.actor
        && requestedClaim.seat === candidate.machine_id
        && requestedClaim.base_sha === candidate.candidate_sha
        && JSON.stringify(actualWriteSet) === JSON.stringify(expectedWriteSet)
      admissionCheck(checks, 'claim_binding', claimMatches ? 'pass' : 'reject', claimMatches ? `${requestedClaim.id} binds task, actor, machine, base SHA, and write set` : `${requestedClaim.id} does not exactly bind this candidate`)
    }
    const conflicts = activeClaims.filter((claim) => claim.id !== candidate.claim_id && candidate.write_paths.some((path) => (claim.write_set ?? []).some((claimed) => pathsOverlap(path, claimed))))
    admissionCheck(checks, 'active_claim_collision', conflicts.length === 0 ? 'pass' : 'reject', conflicts.length === 0 ? 'no other active work claim overlaps this write set' : `conflicts with ${conflicts.map((claim) => claim.id).join(', ')}`)
  } else {
    admissionCheck(checks, 'claim_required', candidate.claim_id ? 'reject' : 'pass', candidate.claim_id ? 'read-only verifier admission must not hold an implementation work claim' : 'read-only verifier uses receipt-only authority')
  }
  const unplacedClaims = activeClaims.filter((claim) => !policy.machines.some((record) => record.id === claim.seat))
  admissionCheck(checks, 'canonical_claim_placement', unplacedClaims.length === 0 ? 'pass' : 'reject', unplacedClaims.length === 0 ? 'every active work claim names a declared machine seat' : `unplaced claims: ${unplacedClaims.map((claim) => claim.id).join(', ')}`)

  const effectiveAssignments = observations.live_assignments.filter((assignment) => assignment.recovery_disposition !== 'abandoned')
  const assignmentActors = new Set()
  const duplicateAssignmentActors = []
  for (const assignment of effectiveAssignments) {
    if (assignmentActors.has(assignment.actor)) duplicateAssignmentActors.push(assignment.actor)
    assignmentActors.add(assignment.actor)
  }
  const invalidAssignments = effectiveAssignments.filter((assignment) => {
    const assignmentDomain = domains.find((record) => record.id === assignment.domain_id)
    const assignmentMachine = policy.machines.find((record) => record.id === assignment.machine_id)
    const assignmentTask = tasks.get(assignment.task_id)
    const assignmentMachineRole = machineRoleFor(assignment.role, assignmentDomain)
    return !assignmentDomain || !assignmentMachine || !assignmentTask || assignmentTask.domain !== assignment.domain_id
      || !assignmentMachineRole || !(assignmentMachine.roles.includes(assignmentMachineRole) || assignmentMachine.roles.includes(assignment.role))
  })
  admissionCheck(checks, 'assignment_declarations', invalidAssignments.length === 0 && duplicateAssignmentActors.length === 0 ? 'pass' : 'reject', invalidAssignments.length === 0 && duplicateAssignmentActors.length === 0 ? 'live assignments bind declared tasks, domains, roles, and machine placements' : `invalid or duplicate live assignments: ${[...new Set([...invalidAssignments.map((entry) => entry.actor), ...duplicateAssignmentActors])].join(', ')}`)

  const assignmentsByActor = new Map(effectiveAssignments.map((assignment) => [assignment.actor, assignment]))
  const occupancy = activeClaims.map((claim) => {
    const assignment = assignmentsByActor.get(claim.actor)
    const candidateClaim = claim.id === candidate.claim_id
    return {
      id: claim.id,
      actor: claim.actor,
      role: candidateClaim ? candidate.role : assignment?.role ?? null,
      domain: candidateClaim ? domain : domains.find((record) => record.id === assignment?.domain_id),
      machine_id: claim.seat,
    }
  })
  const claimActors = new Set(activeClaims.map((claim) => claim.actor))
  for (const assignment of effectiveAssignments) {
    if (!claimActors.has(assignment.actor)) occupancy.push({
      id: `assignment:${assignment.actor}`,
      actor: assignment.actor,
      role: assignment.role,
      domain: domains.find((record) => record.id === assignment.domain_id),
      machine_id: assignment.machine_id,
    })
  }
  const occupiedActors = new Set(occupancy.map((entry) => entry.actor))
  for (const mission of activeMissions) {
    const actor = mission.owner?.actor
    if (actor && !occupiedActors.has(actor)) {
      occupancy.push({ id: mission.id, actor, role: null, domain: null, machine_id: null })
      occupiedActors.add(actor)
    }
  }
  const candidateHasReservation = Boolean(requestedClaim) || effectiveAssignments.some((assignment) => assignment.actor === candidate.actor)
  const candidateIncrement = candidateHasReservation ? 0 : 1
  const capacity = policy.capacity
  const occupiedAfterStart = occupancy.length + candidateIncrement
  admissionCheck(checks, 'live_capacity', occupiedAfterStart <= capacity.max_live ? 'pass' : 'hold', `${occupancy.length} canonical/provider slots occupied; ${occupiedAfterStart}/${capacity.max_live} after candidate start`)
  const liveNonVerifiers = occupancy.filter((entry) => !configuredVerifier(entry.role, entry.domain)).length + (!isVerifier && candidateIncrement ? 1 : 0)
  const maxNonVerifiers = capacity.max_live - capacity.verifier_reserve
  admissionCheck(checks, 'verifier_reserve', isVerifier || liveNonVerifiers <= maxNonVerifiers ? 'pass' : 'hold', isVerifier ? 'verifier may consume reserved capacity' : `${liveNonVerifiers}/${maxNonVerifiers} non-verifier slots after candidate start`)
  const verifierMachines = policy.machines.filter((machineRecord) => verifierCapable(machineRecord, domains))
  const verifierMachineIds = new Set(verifierMachines.map((machineRecord) => machineRecord.id))
  const verifierMachineCapacity = verifierMachines.reduce((sum, machineRecord) => sum + machineRecord.max_live, 0)
  const verifierMachineNonVerifiers = occupancy.filter((entry) => verifierMachineIds.has(entry.machine_id) && !configuredVerifier(entry.role, entry.domain)).length
    + (!isVerifier && candidateIncrement && verifierMachineIds.has(candidate.machine_id) ? 1 : 0)
  const maximumVerifierMachineNonVerifiers = verifierMachineCapacity - capacity.verifier_reserve
  admissionCheck(checks, 'verifier_machine_reserve', isVerifier || verifierMachineNonVerifiers <= maximumVerifierMachineNonVerifiers ? 'pass' : 'hold', isVerifier ? 'verifier may consume verifier-machine reserve' : `${verifierMachineNonVerifiers}/${maximumVerifierMachineNonVerifiers} non-verifier slots on verifier-capable machines after candidate start`)
  admissionCheck(checks, 'verifier_backlog', isVerifier || observations.pending_verifications < capacity.max_pending_verifications ? 'pass' : 'hold', isVerifier ? 'verifier may drain the backlog' : `${observations.pending_verifications}/${capacity.max_pending_verifications} pending verifications`)

  const stale = effectiveAssignments.filter((assignment) => Date.parse(input.evaluated_at) - Date.parse(assignment.heartbeat_at) > policy.heartbeat.stale_after_seconds * 1000 && assignment.recovery_disposition === 'none')
  admissionCheck(checks, 'stale_heartbeat_recovery', stale.length === 0 ? 'pass' : 'hold', stale.length === 0 ? 'no unrecovered stale heartbeat' : `recovery disposition required for ${stale.map((entry) => entry.actor).join(', ')}`)
  const futureHeartbeats = effectiveAssignments.filter((assignment) => Date.parse(assignment.heartbeat_at) > Date.parse(input.evaluated_at))
  admissionCheck(checks, 'heartbeat_clock', futureHeartbeats.length === 0 ? 'pass' : 'reject', futureHeartbeats.length === 0 ? 'heartbeat times do not exceed evaluation time' : `future heartbeat reported by ${futureHeartbeats.map((entry) => entry.actor).join(', ')}`)
  const invalidRecoveryCheckpoints = []
  for (const assignment of effectiveAssignments.filter((record) => record.recovery_disposition === 'checkpointed')) {
    const checkpoint = await checkpointState(root, assignment.checkpoint_ref, schemas)
    if (!checkpoint.ok || checkpoint.record.created_by !== assignment.actor || !checkpoint.record.active_task_ids.includes(assignment.task_id)) invalidRecoveryCheckpoints.push(assignment.actor)
  }
  admissionCheck(checks, 'recovery_checkpoint', invalidRecoveryCheckpoints.length === 0 ? 'pass' : 'reject', invalidRecoveryCheckpoints.length === 0 ? 'checkpointed recoveries bind readable canonical snapshots to actor and task' : `invalid recovery checkpoint for ${invalidRecoveryCheckpoints.join(', ')}`)
  if (machine) {
    admissionCheck(checks, 'machine_identity', observations.machine.id === machine.id ? 'pass' : 'reject', observations.machine.id === machine.id ? 'machine observation matches candidate placement' : `observation is for ${observations.machine.id}`)
    const acceptsRole = candidateMachineRole && (machine.roles.includes(candidateMachineRole) || machine.roles.includes(candidate.role))
    admissionCheck(checks, 'machine_role', acceptsRole ? 'pass' : 'reject', acceptsRole ? `${machine.id} accepts ${candidate.role}` : `${machine.id} does not accept ${candidate.role}`)
    const machineLiveAfterStart = occupancy.filter((entry) => entry.machine_id === machine.id).length + candidateIncrement
    admissionCheck(checks, 'machine_capacity', machineLiveAfterStart <= machine.max_live ? 'pass' : 'hold', `${machineLiveAfterStart}/${machine.max_live} machine slots after candidate start`)
    for (const issue of machineThresholdProblems(machine, observations.machine, 'candidate')) admissionCheck(checks, issue.code, 'hold', issue.message)
    if (!checks.some((entry) => ['disk_pressure', 'memory_pressure', 'load_pressure', 'ac_power_required', 'ac_power_unknown'].includes(entry.id))) {
      admissionCheck(checks, 'machine_resources', 'pass', 'machine resource thresholds pass')
    }
  } else admissionCheck(checks, 'machine_exists', 'reject', `${candidate.machine_id} is not declared`)
  if (candidate.mode === 'resume') {
    const checkpoint = await checkpointState(root, candidate.resume_checkpoint, schemas)
    const checkpointBound = checkpoint.ok && checkpoint.record.created_by === candidate.actor && checkpoint.record.active_task_ids.includes(candidate.task_id)
    admissionCheck(checks, 'resume_checkpoint', checkpointBound ? 'pass' : 'reject', checkpointBound ? 'resume checkpoint exists and binds candidate actor and task' : 'resume requires a valid canonical checkpoint created by the task owner for this task')
  }

  const verdict = checks.some((entry) => entry.status === 'reject') ? 'reject' : checks.some((entry) => entry.status === 'hold') ? 'hold' : 'admit'
  return withAdmissionReceiptIntegrity({
    schema_version: 1,
    id: input.id,
    evaluated_at: input.evaluated_at,
    candidate,
    observations,
    start_contract: {
      admission_authority: processPlan.admission_receipt_authority,
      start_authority: processPlan.process_start_authority,
      provider: processPlan.provider,
      required_revalidation: processPlan.required_start_revalidation,
      reusable: false,
    },
    verdict,
    reason_codes: [...new Set(checks.filter((entry) => entry.status !== 'pass').map((entry) => entry.id))],
    checks,
  })
}

export async function admitFleet(root, input, options = {}) {
  const receipt = await evaluateFleetAdmission(root, input)
  if (options.record === false || options.dryRun) return { ...receipt, recorded: false }
  const relativePath = `${FLEET_ROOT}/admissions/${receipt.id}.json`
  await withExclusiveLock(root, `${FLEET_ROOT}/admissions/.lock`, async () => {
    const path = join(root, relativePath)
    if (await pathExists(path)) {
      const existing = await readFile(path, 'utf8')
      if (existing !== json(receipt)) {
        const error = new Error(`admission receipt collision: ${relativePath}`)
        error.exitCode = 2
        throw error
      }
      return
    }
    await writeJsonAtomic(path, receipt)
  })
  await buildFleet(root)
  return { ...receipt, recorded: true, receipt_path: relativePath }
}
