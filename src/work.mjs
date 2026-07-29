import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TASK_FOLDERS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  appendJsonLine,
  isoNow,
  listDirectories,
  pathExists,
  readJson,
  slugify,
  splitList,
  taskFolderForStatus,
  utcDate,
  withRegistryLock,
  writeJsonAtomic,
} from './shared.mjs'
import { assertProjectRecord } from './schema.mjs'
import {
  assertRunCloseReady,
  createDirectoryAtomic,
  mutateDirectoryAtomic,
  readJsonLines,
  withLifecycleLock,
} from './lifecycle-core.mjs'

const TASK_ID = /^TASK-(\d{4})$/

export async function scanTasks(root) {
  const tasksRoot = join(root, '.agents', 'tasks')
  const entries = []
  for (const folder of TASK_FOLDERS) {
    for (const name of await listDirectories(join(tasksRoot, folder))) {
      if (!TASK_ID.test(name)) continue
      const directory = join(tasksRoot, folder, name)
      const taskPath = join(directory, 'task.json')
      let task = null
      let parseError = null
      try {
        task = await readJson(taskPath)
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error)
      }
      entries.push({ folder, name, directory, taskPath, task, parseError })
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name) || left.folder.localeCompare(right.folder))
}

export async function findTask(root, id) {
  const matches = (await scanTasks(root)).filter((entry) => entry.name === id)
  if (matches.length === 0) throw new Error(`${id} was not found`)
  if (matches.length > 1) throw new Error(`${id} exists in multiple lifecycle folders; run check and repair the registry first`)
  if (matches[0].parseError) throw new Error(`${id}/task.json is unreadable: ${matches[0].parseError}`)
  return matches[0]
}

async function nextTaskId(root) {
  let maximum = 0
  for (const entry of await scanTasks(root)) {
    const match = entry.name.match(TASK_ID)
    if (match) maximum = Math.max(maximum, Number(match[1]))
  }
  if (maximum >= 9999) throw new Error('task registry exhausted the TASK-0001..TASK-9999 namespace')
  return `TASK-${String(maximum + 1).padStart(4, '0')}`
}

export async function createTask(root, flags) {
  const title = typeof flags.title === 'string' ? flags.title.trim() : ''
  if (!title) throw new Error('task create requires --title')
  const priority = typeof flags.priority === 'string' ? flags.priority : 'medium'
  if (!TASK_PRIORITIES.includes(priority)) throw new Error(`priority must be one of: ${TASK_PRIORITIES.join(', ')}`)
  return withRegistryLock(root, async () => {
    const dependencies = splitList(flags.deps)
    for (const dependency of dependencies) await findTask(root, dependency)
    const id = await nextTaskId(root)
    const timestamp = isoNow(flags)
    const requiresHuman = flags['requires-human'] === true
    const task = {
      schema_version: 1,
      id,
      title,
      status: 'backlog',
      priority,
      domain: typeof flags.domain === 'string' ? flags.domain : 'general',
      category: typeof flags.category === 'string'
        ? flags.category
        : (typeof flags.kind === 'string' ? flags.kind : 'task'),
      created_at: timestamp,
      created_by: typeof flags.by === 'string' ? flags.by : 'human',
      owner: typeof flags.owner === 'string' ? flags.owner : null,
      dependencies,
      requires_human: requiresHuman,
      ...(requiresHuman ? { human_gate_reason: typeof flags['human-reason'] === 'string' ? flags['human-reason'] : 'Human decision required' } : {}),
      spec: {
        description: typeof flags.description === 'string' ? flags.description : '',
        objectives: splitList(flags.objectives),
        acceptance_criteria: splitList(flags.accept),
        files_affected: splitList(flags.files),
      },
      blocker: null,
      evidence: [],
      verification: {
        state: 'unverified',
        verified_by: null,
        commands: [],
        evidence_refs: [],
        verified_at: null,
      },
      sprint_ids: [],
      run_ids: [],
    }
    const tasksRoot = join(root, '.agents', 'tasks')
    await assertProjectRecord(root, 'task', task)
    const temporary = join(tasksRoot, `.tmp-${id}-${process.pid}`)
    const destination = join(tasksRoot, 'backlog', id)
    if (await pathExists(destination)) throw new Error(`${id} already exists`)
    await mkdir(join(temporary, 'evidence'), { recursive: true })
    await writeFile(join(temporary, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    await writeFile(join(temporary, 'events.jsonl'), `${JSON.stringify({ seq: 1, at: timestamp, by: task.created_by, action: 'created', status: 'backlog' })}\n`, 'utf8')
    await writeFile(join(temporary, 'evidence', '.gitkeep'), '', 'utf8')
    await mkdir(join(tasksRoot, 'backlog'), { recursive: true })
    await rename(temporary, destination)
    return task
  })
}

export async function updateTask(root, id, flags) {
  if (!TASK_ID.test(id)) throw new Error('task update requires a TASK-NNNN identifier')
  const by = typeof flags.by === 'string' ? flags.by.trim() : ''
  if (!by) throw new Error('task update requires --by')
  return withRegistryLock(root, async () => {
    const entry = await findTask(root, id)
    const task = entry.task
    const nextStatus = typeof flags.status === 'string' ? flags.status : task.status
    if (!TASK_STATUSES.includes(nextStatus)) throw new Error(`status must be one of: ${TASK_STATUSES.join(', ')}`)
    if (['completed', 'cancelled'].includes(task.status)) throw new Error(`${id} is terminal and immutable`)
    const allowed = {
      backlog: ['backlog', 'in_progress', 'cancelled'],
      in_progress: ['in_progress', 'blocked', 'completed', 'cancelled'],
      blocked: ['blocked', 'in_progress', 'cancelled'],
    }
    if (!allowed[task.status]?.includes(nextStatus)) throw new Error(`invalid task transition ${task.status} -> ${nextStatus}`)
    if (nextStatus === 'in_progress' && task.status !== 'in_progress') {
      if (task.status === 'blocked' && (typeof flags.log !== 'string' || !flags.log.trim())) throw new Error('blocked -> in_progress requires --log describing the resolution')
      for (const dependencyId of task.dependencies ?? []) {
        const dependency = await findTask(root, dependencyId)
        if (dependency.task.status !== 'completed') throw new Error(`${id} cannot start: dependency ${dependencyId} is ${dependency.task.status}`)
      }
    }
    if (flags.verified === true) {
      const verifier = typeof flags.verifier === 'string' ? flags.verifier.trim() : by
      const commands = splitList(flags.command)
      const evidence = splitList(flags.evidence)
      if (commands.length === 0 || evidence.length === 0) {
        throw new Error('--verified requires --command and --evidence receipts')
      }
      task.verification = {
        state: 'passed',
        verified_by: verifier,
        commands: commands.map((command) => ({ command, exit_code: 0 })),
        evidence_refs: evidence,
        verified_at: isoNow(flags),
      }
    }
    if (nextStatus === 'completed' && !['passed', 'waived'].includes(task.verification?.state)) {
      throw new Error('completed tasks require verified command and evidence receipts')
    }
    const blocker = typeof flags.blocker === 'string' ? flags.blocker.trim() : ''
    if (nextStatus === 'blocked' && !blocker && !task.blocker) throw new Error('blocked status requires --blocker')
    const timestamp = isoNow(flags)
    if (['in_progress', 'blocked'].includes(nextStatus)) {
      task.owner = typeof flags.owner === 'string' ? flags.owner : (task.owner || by)
      task.claimed_at = task.claimed_at || timestamp
    } else if (typeof flags.owner === 'string') {
      task.owner = flags.owner
    }
    task.status = nextStatus
    task.updated_at = timestamp
    task.blocker = nextStatus === 'blocked'
      ? (blocker ? { reason: blocker, since: timestamp, ...(typeof flags.requires === 'string' ? { requires: flags.requires } : {}) } : task.blocker)
      : null
    if (nextStatus === 'completed') {
      task.completion = {
        completed_at: timestamp,
        completed_by: by,
        summary: typeof flags.summary === 'string' ? flags.summary : (typeof flags.log === 'string' ? flags.log : `Completed ${task.title}`),
        evidence_refs: task.verification.evidence_refs,
      }
    }
    if (nextStatus === 'cancelled') {
      const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
      if (!reason) throw new Error('cancelled status requires --reason')
      task.cancellation = { cancelled_at: timestamp, cancelled_by: by, reason }
    }
    const eventsPath = join(entry.directory, 'events.jsonl')
    let seq = 1
    if (await pathExists(eventsPath)) {
      const lines = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean)
      seq = lines.length + 1
    }
    const event = {
      seq,
      at: timestamp,
      by,
      action: typeof flags.log === 'string' ? flags.log : 'updated',
      status: nextStatus,
      blocker: task.blocker?.reason ?? null,
      verification: task.verification?.state,
    }
    await assertProjectRecord(root, 'task', task)
    const targetFolder = taskFolderForStatus(nextStatus)
    const target = join(root, '.agents', 'tasks', targetFolder, id)
    if (target !== entry.directory && await pathExists(target)) throw new Error(`cannot move ${id}: destination already exists`)
    await replaceTaskDirectory(root, entry, target, task, event)
    return task
  })
}

export async function claimNextTask(root, flags = {}) {
  const by = typeof flags.by === 'string' ? flags.by.trim() : ''
  const owner = typeof flags.owner === 'string' ? flags.owner.trim() : by
  if (!by || !owner) throw new Error('task claim-next requires --by or --owner')
  const requestedDomain = typeof flags.domain === 'string' ? flags.domain.trim() : null
  const requestedPriority = typeof flags.priority === 'string' ? flags.priority.trim() : null
  if (requestedPriority && !TASK_PRIORITIES.includes(requestedPriority)) {
    throw new Error(`priority must be one of: ${TASK_PRIORITIES.join(', ')}`)
  }
  return withRegistryLock(root, async () => {
    const entries = await scanTasks(root)
    const byId = new Map()
    for (const entry of entries) {
      if (entry.task && !entry.parseError) {
        if (byId.has(entry.name)) throw new Error(`${entry.name} exists in multiple lifecycle folders; repair the registry before claiming work`)
        byId.set(entry.name, entry.task)
      }
    }
    const candidates = entries.filter((entry) => {
      const task = entry.task
      if (!task || entry.parseError || entry.folder !== 'backlog' || task.status !== 'backlog') return false
      if (requestedDomain && task.domain !== requestedDomain) return false
      if (requestedPriority && task.priority !== requestedPriority) return false
      if (task.requires_human && flags['allow-human'] !== true && flags.allow_human !== true) return false
      return (task.dependencies ?? []).every((dependencyId) => byId.get(dependencyId)?.status === 'completed')
    })
    candidates.sort((left, right) => {
      const priority = TASK_PRIORITIES.indexOf(left.task.priority) - TASK_PRIORITIES.indexOf(right.task.priority)
      return priority || left.name.localeCompare(right.name)
    })
    const entry = candidates[0]
    if (!entry) throw new Error('no dependency-ready backlog task matches the claim filters')
    const timestamp = isoNow(flags)
    const task = structuredClone(entry.task)
    task.status = 'in_progress'
    task.owner = owner
    task.claimed_at = task.claimed_at ?? timestamp
    task.updated_at = timestamp
    task.blocker = null
    if (typeof flags.profile === 'string' || typeof flags.stage === 'string') {
      task.workflow = {
        profile: typeof flags.profile === 'string' ? flags.profile : 'default',
        stage: typeof flags.stage === 'string' ? flags.stage : 'prepping',
      }
    }
    const eventsPath = join(entry.directory, 'events.jsonl')
    const seq = (await pathExists(eventsPath))
      ? (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).length + 1
      : 1
    const event = { seq, at: timestamp, by, action: 'claimed_next', status: 'in_progress', owner }
    await assertProjectRecord(root, 'task', task)
    const target = join(root, '.agents', 'tasks', 'in_progress', entry.name)
    if (await pathExists(target)) throw new Error(`cannot claim ${entry.name}: destination already exists`)
    await replaceTaskDirectory(root, entry, target, task, event)
    return task
  })
}

export async function archiveTask(root, id, flags = {}) {
  if (!TASK_ID.test(id)) throw new Error('task archive requires a TASK-NNNN identifier')
  const by = typeof flags.by === 'string' ? flags.by.trim() : ''
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
  if (!by || !reason) throw new Error('task archive requires --by and --reason')
  return withRegistryLock(root, async () => {
    const entry = await findTask(root, id)
    if (entry.folder === 'archived') {
      if (entry.task.archive?.archived_by === by && entry.task.archive?.reason === reason) return entry.task
      throw new Error(`${id} is already archived with a different receipt`)
    }
    if (!['completed', 'cancelled'].includes(entry.task.status)) throw new Error('only completed or cancelled tasks can be archived')
    const target = join(root, '.agents', 'tasks', 'archived', id)
    if (await pathExists(target)) throw new Error(`cannot archive ${id}: destination already exists`)
    const plan = {
      id,
      source: `.agents/tasks/${entry.folder}/${id}`,
      destination: `.agents/tasks/archived/${id}`,
      prior_status: entry.task.status,
      reason,
      by,
    }
    if (flags.dry_run === true || flags['dry-run'] === true) return { ...plan, dry_run: true }
    const timestamp = isoNow(flags)
    const task = structuredClone(entry.task)
    task.archive = { archived_at: timestamp, archived_by: by, reason, previous_folder: entry.folder }
    task.updated_at = timestamp
    const eventsPath = join(entry.directory, 'events.jsonl')
    const seq = (await pathExists(eventsPath))
      ? (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).length + 1
      : 1
    const event = { seq, at: timestamp, by, action: 'archived', status: task.status, reason, previous_folder: entry.folder }
    await assertProjectRecord(root, 'task', task)
    await replaceTaskDirectory(root, entry, target, task, event)
    return task
  })
}

async function replaceTaskDirectory(root, entry, target, task, event) {
  const tasksRoot = join(root, '.agents', 'tasks')
  const nonce = `${process.pid}-${Date.now()}`
  const temporary = join(tasksRoot, `.tmp-update-${entry.name}-${nonce}`)
  const backup = join(tasksRoot, `.backup-${entry.name}-${nonce}`)
  try {
    await cp(entry.directory, temporary, { recursive: true, errorOnExist: true, force: false })
    await writeJsonAtomic(join(temporary, 'task.json'), task)
    await appendJsonLine(join(temporary, 'events.jsonl'), event)
    await mkdir(join(target, '..'), { recursive: true })
    await rename(entry.directory, backup)
    try {
      await rename(temporary, target)
    } catch (error) {
      await rename(backup, entry.directory)
      throw error
    }
    await rm(backup, { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function uniqueRecordDirectory(base, requested) {
  let candidate = requested
  let suffix = 2
  while (await pathExists(join(base, candidate))) {
    candidate = `${requested}-${suffix}`
    suffix += 1
  }
  return candidate
}

export async function createSprint(root, flags) {
  const title = typeof flags.title === 'string' ? flags.title.trim() : ''
  if (!title) throw new Error('sprint create requires --title')
  const taskIds = splitList(flags.tasks)
  for (const taskId of taskIds) await findTask(root, taskId)
  const base = join(root, '.agents', 'sprints')
  const id = await uniqueRecordDirectory(base, `SPRINT-${utcDate(flags)}-${slugify(title)}`)
  const record = {
    schema_version: 1,
    id,
    title,
    objective: typeof flags.objective === 'string' ? flags.objective : title,
    status: 'planned',
    base_ref: typeof flags.base === 'string' ? flags.base : null,
    created_at: isoNow(flags),
    created_by: typeof flags.by === 'string' ? flags.by : 'human',
    task_ids: taskIds,
    waves: [],
    lanes: [],
    gates: splitList(flags.gates).map((description, index) => ({
      id: `gate-${index + 1}`,
      description,
      required: true,
      status: 'pending',
      evidence_refs: [],
    })),
  }
  const directory = join(base, id)
  await assertProjectRecord(root, 'sprint', record)
  await createDirectoryAtomic(directory, async (temporary) => {
    await mkdir(join(temporary, 'lanes'), { recursive: true })
    await mkdir(join(temporary, 'evidence'), { recursive: true })
    await writeJsonAtomic(join(temporary, 'sprint.json'), record)
    await writeFile(join(temporary, 'lanes', '.gitkeep'), '', 'utf8')
    await writeFile(join(temporary, 'evidence', '.gitkeep'), '', 'utf8')
    await writeFile(join(temporary, 'ledger.jsonl'), `${JSON.stringify({ seq: 1, at: record.created_at, by: record.created_by, action: 'created' })}\n`, 'utf8')
  })
  return record
}

export async function createRun(root, flags) {
  const title = typeof flags.title === 'string' ? flags.title.trim() : ''
  if (!title) throw new Error('run create requires --title')
  const taskIds = splitList(flags.task || flags.tasks)
  if (taskIds.length === 0) throw new Error('run create requires --task TASK-NNNN')
  for (const taskId of taskIds) await findTask(root, taskId)
  if (typeof flags.sprint === 'string') {
    const sprintPath = join(root, '.agents', 'sprints', flags.sprint, 'sprint.json')
    if (!(await pathExists(sprintPath))) throw new Error(`run references missing sprint ${flags.sprint}`)
  }
  const base = join(root, '.agents', 'runs')
  const id = await uniqueRecordDirectory(base, `RUN-${utcDate(flags)}-${slugify(title)}`)
  const record = {
    schema_version: 1,
    id,
    title,
    objective: typeof flags.objective === 'string' ? flags.objective : title,
    status: 'planned',
    task_ids: taskIds,
    sprint_id: typeof flags.sprint === 'string' ? flags.sprint : null,
    base_ref: typeof flags.base === 'string' ? flags.base : null,
    branch: typeof flags.branch === 'string' ? flags.branch : null,
    worktree: typeof flags.worktree === 'string' ? flags.worktree : null,
    constraints: splitList(flags.constraints),
    units: [],
    packets: [],
    receipts: [],
    gates: splitList(flags.verify).map((description, index) => ({
      id: `gate-${index + 1}`,
      description,
      required: true,
      status: 'pending',
      evidence_refs: [],
    })),
    created_at: isoNow(flags),
    created_by: typeof flags.by === 'string' ? flags.by : 'human',
  }
  const directory = join(base, id)
  const queue = {
    schema_version: 1,
    run_id: id,
    revision: 0,
    updated_at: record.created_at,
    units: [],
    packet_digests: [],
  }
  const createdEvent = { schema_version: 1, run_id: id, seq: 1, at: record.created_at, by: record.created_by, action: 'created' }
  await assertProjectRecord(root, 'run', record)
  await assertProjectRecord(root, 'run-queue', queue)
  await assertProjectRecord(root, 'run-event', createdEvent)
  await createDirectoryAtomic(directory, async (temporary) => {
    for (const child of ['briefs', 'returns', 'evidence', 'attempts']) {
      await mkdir(join(temporary, child), { recursive: true })
      await writeFile(join(temporary, child, '.gitkeep'), '', 'utf8')
    }
    await writeJsonAtomic(join(temporary, 'run.json'), record)
    await writeJsonAtomic(join(temporary, 'queue.json'), queue)
    await writeFile(join(temporary, 'ledger.jsonl'), `${JSON.stringify(createdEvent)}\n`, 'utf8')
  })
  return record
}

export async function closeRun(root, id, flags) {
  const by = typeof flags.by === 'string' ? flags.by.trim() : ''
  const verdict = typeof flags.verdict === 'string' ? flags.verdict : ''
  const summary = typeof flags.summary === 'string' ? flags.summary.trim() : ''
  if (!by || !summary) throw new Error('run close requires --by and --summary')
  if (!['passed', 'failed', 'cancelled'].includes(verdict)) throw new Error('run close --verdict must be passed, failed, or cancelled')
  const directory = join(root, '.agents', 'runs', id)
  const path = join(directory, 'run.json')
  if (!(await pathExists(path))) throw new Error(`${id} was not found`)
  const outputs = Array.isArray(flags.outputs) ? structuredClone(flags.outputs) : []
  return withLifecycleLock(root, 'runs', id, async () => {
    const current = await readJson(path)
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      const expectedStatus = verdict === 'passed' ? 'completed' : verdict
      const same = current.status === expectedStatus && current.closeout?.closed_by === by
        && current.closeout?.verdict === verdict && current.closeout?.summary === summary
        && JSON.stringify(current.closeout?.outputs ?? []) === JSON.stringify(outputs)
      if (same) return current
      throw new Error(`${id} is already closed with a different receipt`)
    }
    await assertRunCloseReady(root, id, current, { verdict, outputs })
    return mutateDirectoryAtomic(directory, async (temporary) => {
      const recordPath = join(temporary, 'run.json')
      const record = await readJson(recordPath)
      const timestamp = isoNow(flags)
      record.status = verdict === 'passed' ? 'completed' : verdict
      record.closeout = {
        closed_at: timestamp,
        closed_by: by,
        verdict,
        summary,
        outputs,
      }
      await assertProjectRecord(root, 'run', record)
      await writeJsonAtomic(recordPath, record)
      const ledgerPath = join(temporary, 'ledger.jsonl')
      const ledger = await readJsonLines(ledgerPath)
      const event = { schema_version: 1, run_id: id, seq: ledger.length + 1, at: timestamp, by, action: 'closed', verdict }
      await assertProjectRecord(root, 'run-event', event)
      await appendJsonLine(ledgerPath, event)
      return record
    })
  })
}
