import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkArchitecture } from './architecture.mjs'
import { UI_STAGES, listDirectories, pathExists, resolveProjectPointer, taskFolderForStatus, walkFiles } from './shared.mjs'
import { expectedBuild } from './build.mjs'
import { checkFleetInstallation } from './fleet.mjs'
import { inspectRunCloseCensus } from './lifecycle.mjs'
import { capabilityCoverageProblems, readCapabilityCoverage } from './provenance.mjs'
import { validateSchema } from './schema.mjs'
import { scanTasks } from './work.mjs'
import { uiReceiptProblems } from './ui.mjs'
import { uiCampaignCompletionProblems } from './ui-contracts.mjs'

function add(list, code, message, path = null) {
  list.push({ code, message, ...(path ? { path } : {}) })
}

function detectCycle(graph) {
  const visiting = new Set()
  const visited = new Set()
  const visit = (id, path = []) => {
    if (visiting.has(id)) return [...path, id]
    if (visited.has(id)) return null
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency, [...path, id])
      if (cycle) return cycle
    }
    visiting.delete(id)
    visited.add(id)
    return null
  }
  for (const id of graph.keys()) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
  return null
}

export async function checkProject(root) {
  const errors = []
  const warnings = []
  const configPath = join(root, '.project-os', 'project.json')
  if (!(await pathExists(configPath))) add(errors, 'missing_config', 'missing .project-os/project.json', '.project-os/project.json')

  const schemas = new Map()
  const schemaFiles = (await walkFiles(join(root, '.project-os', 'schemas'))).filter((file) => file.endsWith('.json'))
  for (const schemaFile of schemaFiles) {
    try {
      schemas.set(schemaFile.replace(/\.schema\.json$/, ''), JSON.parse(await readFile(join(root, '.project-os', 'schemas', schemaFile), 'utf8')))
    } catch (error) {
      add(errors, 'invalid_schema_json', error.message, `.project-os/schemas/${schemaFile}`)
    }
  }

  if (await pathExists(configPath)) {
    try {
      addSchemaErrors(errors, schemas, 'project', JSON.parse(await readFile(configPath, 'utf8')), '.project-os/project.json')
    } catch (error) {
      add(errors, 'invalid_config_json', error.message, '.project-os/project.json')
    }
  }

  const installManifestPath = join(root, '.project-os', 'install-manifest.json')
  if (await pathExists(installManifestPath)) {
    try {
      addSchemaErrors(errors, schemas, 'install-manifest', JSON.parse(await readFile(installManifestPath, 'utf8')), '.project-os/install-manifest.json')
    } catch (error) {
      add(errors, 'invalid_install_manifest_json', error.message, '.project-os/install-manifest.json')
    }
  } else {
    add(warnings, 'missing_install_manifest', 'upgrade guard manifest is absent; run project-os upgrade plan', '.project-os/install-manifest.json')
  }

  for (const upgradeId of (await listDirectories(join(root, '.project-os', 'upgrades'))).filter((id) => id.startsWith('UPGRADE-'))) {
    const relativePath = `.project-os/upgrades/${upgradeId}/upgrade.json`
    try {
      addSchemaErrors(errors, schemas, 'upgrade-record', JSON.parse(await readFile(join(root, relativePath), 'utf8')), relativePath)
    } catch (error) {
      add(errors, 'invalid_upgrade_record_json', error.message, relativePath)
    }
  }

  const entries = await scanTasks(root)
  const byId = new Map()
  for (const entry of entries) {
    const path = `.agents/tasks/${entry.folder}/${entry.name}/task.json`
    if (!byId.has(entry.name)) byId.set(entry.name, [])
    byId.get(entry.name).push(entry)
    if (entry.parseError) {
      add(errors, 'invalid_task_json', entry.parseError, path)
      continue
    }
    if (!entry.task || typeof entry.task !== 'object' || Array.isArray(entry.task)) {
      addSchemaErrors(errors, schemas, 'task', entry.task, path)
      add(errors, 'invalid_task_record', 'task.json must contain an object', path)
      continue
    }
    if (entry.task.id !== entry.name) add(errors, 'task_id_mismatch', `directory ${entry.name} contains id ${entry.task.id}`, path)
    addSchemaErrors(errors, schemas, 'task', entry.task, path)
    if (entry.folder !== 'archived') {
      try {
        const expectedFolder = taskFolderForStatus(entry.task.status)
        if (expectedFolder !== entry.folder) add(errors, 'task_folder_mismatch', `status ${entry.task.status} belongs in ${expectedFolder}`, path)
      } catch (error) {
        add(errors, 'invalid_task_status', error.message, path)
      }
    } else if (!['completed', 'cancelled'].includes(entry.task.status)) {
      add(errors, 'invalid_archive_status', 'archived records must preserve completed or cancelled status', path)
    }
    if (entry.task.status === 'completed' && !['passed', 'waived'].includes(entry.task.verification?.state)) {
      add(errors, 'unverified_completion', 'completed task lacks verified receipts', path)
    }
    if (entry.task.status === 'blocked' && !entry.task.blocker) add(errors, 'missing_blocker', 'blocked task lacks blocker metadata', path)
  }
  for (const [id, matches] of byId) if (matches.length > 1) add(errors, 'duplicate_task_id', `${id} exists in ${matches.map((entry) => entry.folder).join(', ')}`)

  const taskById = new Map(entries.filter((entry) => entry.task && !entry.parseError).map((entry) => [entry.name, entry.task]))
  const dependencyGraph = new Map()
  for (const [id, task] of taskById) {
    const dependencies = Array.isArray(task.dependencies) ? task.dependencies : []
    dependencyGraph.set(id, dependencies)
    for (const dependency of dependencies) if (!taskById.has(dependency)) add(errors, 'missing_dependency', `${id} depends on missing ${dependency}`)
  }
  const cycle = detectCycle(dependencyGraph)
  if (cycle) add(errors, 'dependency_cycle', cycle.join(' -> '))

  for (const sprintId of (await listDirectories(join(root, '.agents', 'sprints'))).filter((id) => id.startsWith('SPRINT-'))) {
    await checkReferenceRecord(root, join('.agents', 'sprints', sprintId, 'sprint.json'), 'task_ids', taskById, errors, schemas, 'sprint')
  }
  for (const runId of (await listDirectories(join(root, '.agents', 'runs'))).filter((id) => id.startsWith('RUN-'))) {
    await checkReferenceRecord(root, join('.agents', 'runs', runId, 'run.json'), 'task_ids', taskById, errors, schemas, 'run')
  }
  await checkLifecycle(root, schemas, errors)
  for (const campaignId of (await listDirectories(join(root, '.uihub', 'campaigns'))).filter((id) => id.startsWith('UI-'))) {
    const relativePath = join('.uihub', 'campaigns', campaignId, 'campaign.json')
    const path = join(root, relativePath)
    try {
      const campaign = JSON.parse(await readFile(path, 'utf8'))
      addSchemaErrors(errors, schemas, 'ui-campaign', campaign, relativePath)
      if (!taskById.has(campaign.task_id)) add(errors, 'missing_campaign_task', `${campaignId} references missing ${campaign.task_id}`, relativePath)
      if (!UI_STAGES.includes(campaign.stage)) add(errors, 'invalid_campaign_stage', `${campaignId} has invalid stage ${campaign.stage}`, relativePath)
      const stageIndex = UI_STAGES.indexOf(campaign.stage)
      const requiredArtifacts = [['intent_path', campaign.intent_path]]
      if (campaign.stage !== 'superseded' && stageIndex >= UI_STAGES.indexOf('research')) requiredArtifacts.push(['research_path', campaign.research_path])
      if (campaign.stage !== 'superseded' && stageIndex >= UI_STAGES.indexOf('review')) requiredArtifacts.push(['review_path', campaign.review_path])
      for (const [field, pointer] of requiredArtifacts) {
        try {
          if (typeof pointer !== 'string' || !(await pathExists(resolveProjectPointer(root, pointer)))) add(errors, 'missing_campaign_artifact', `${campaignId} requires existing ${field}`, relativePath)
        } catch (error) {
          add(errors, 'invalid_campaign_artifact_path', error.message, relativePath)
        }
      }
      for (const directionId of campaign.direction_ids ?? []) {
        const directionPath = join('.uihub', 'campaigns', campaignId, 'directions', `${directionId}.json`)
        if (!(await pathExists(join(root, directionPath)))) add(errors, 'missing_direction_record', `${campaignId} references missing ${directionId}.json`, directionPath)
      }
      for (const candidateId of campaign.candidate_ids ?? []) {
        const candidatePath = join('.uihub', 'campaigns', campaignId, 'candidates', candidateId)
        if (!(await pathExists(join(root, candidatePath)))) add(errors, 'missing_candidate_artifact', `${campaignId} references missing candidate ${candidateId}`, candidatePath)
      }
      const requiredPointers = []
      if (stageIndex >= UI_STAGES.indexOf('decided') && campaign.stage !== 'superseded') requiredPointers.push(['decision_record', campaign.decision_record, 'ui-decision'])
      if (stageIndex >= UI_STAGES.indexOf('implemented') && campaign.stage !== 'superseded') requiredPointers.push(['implementation_receipt', campaign.implementation_receipt])
      if (stageIndex >= UI_STAGES.indexOf('verified') && campaign.stage !== 'superseded') requiredPointers.push(['verification_receipt', campaign.verification_receipt])
      for (const [field, pointer, recordSchema = 'ui-receipt'] of requiredPointers) {
        if (typeof pointer !== 'string' || pointer === '') add(errors, 'missing_campaign_receipt', `${campaignId} ${campaign.stage} stage requires ${field}`, relativePath)
        else {
          try {
            const pointerPath = resolveProjectPointer(root, pointer)
            if (!(await pathExists(pointerPath))) add(errors, 'missing_campaign_receipt_file', `${campaignId} references missing ${pointer}`, relativePath)
            else {
              const record = JSON.parse(await readFile(pointerPath, 'utf8'))
              addSchemaErrors(errors, schemas, recordSchema, record, pointer)
              if (record.campaign_id !== campaign.id || record.task_id !== campaign.task_id) add(errors, 'campaign_receipt_link_mismatch', `${field} does not belong to ${campaign.id}/${campaign.task_id}`, pointer)
              if (field === 'implementation_receipt' && (record.kind !== 'implementation' || record.verdict !== 'pass')) add(errors, 'invalid_implementation_receipt', 'implemented campaign requires a passing implementation receipt', pointer)
              if (field === 'verification_receipt' && (record.kind !== 'verification' || record.verdict !== 'pass')) add(errors, 'invalid_verification_receipt', 'verified campaign requires a passing verification receipt', pointer)
              if (recordSchema === 'ui-decision') {
                const referenced = [record.chosen_direction_id, ...(record.rejected_direction_ids ?? [])]
                for (const directionId of referenced) if (!campaign.direction_ids?.includes(directionId)) add(errors, 'decision_direction_mismatch', `decision references unknown ${directionId}`, pointer)
                if ((record.rejected_direction_ids ?? []).includes(record.chosen_direction_id)) add(errors, 'decision_direction_conflict', 'chosen direction is also rejected', pointer)
              } else {
                const kind = field === 'implementation_receipt' ? 'implementation' : 'verification'
                for (const problem of await uiReceiptProblems(root, campaign, record, kind)) add(errors, 'invalid_ui_receipt_semantics', problem, pointer)
              }
            }
          } catch (error) {
            add(errors, 'invalid_campaign_receipt_path', error.message, relativePath)
          }
        }
      }
      for (const file of (await walkFiles(join(root, '.uihub', 'campaigns', campaignId, 'directions'))).filter((name) => name.endsWith('.json'))) {
        const directionPath = join('.uihub', 'campaigns', campaignId, 'directions', file)
        try {
          const direction = JSON.parse(await readFile(join(root, directionPath), 'utf8'))
          addSchemaErrors(errors, schemas, 'ui-direction', direction, directionPath)
          if (direction.campaign_id !== campaign.id || direction.task_id !== campaign.task_id) add(errors, 'direction_link_mismatch', `${direction.id} does not belong to ${campaign.id}/${campaign.task_id}`, directionPath)
        } catch (error) {
          add(errors, 'invalid_direction_json', error.message, directionPath)
        }
      }
      if (campaign.stage === 'verified' && campaign.candidate_manifest) {
        for (const problem of await uiCampaignCompletionProblems(root, campaign)) {
          add(errors, 'incomplete_verified_ui_campaign', problem, relativePath)
        }
      }
    } catch (error) {
      add(errors, 'invalid_campaign_json', error.message, relativePath)
    }
  }

  await checkKnowledge(root, schemas, taskById, errors)

  try {
    for (const problem of capabilityCoverageProblems(await readCapabilityCoverage(root))) {
      add(errors, 'invalid_capability_coverage', problem, 'docs/capability-coverage.json')
    }
  } catch (error) {
    add(errors, 'capability_coverage_check_failed', error.message, 'docs/capability-coverage.json')
  }

  try {
    const architecture = await checkArchitecture(root)
    for (const entry of architecture.errors) add(errors, entry.code, formatStructuredProblem(entry), entry.path)
    for (const entry of architecture.warnings) add(warnings, entry.code, formatStructuredProblem(entry), entry.path)
  } catch (error) {
    add(errors, 'architecture_check_failed', error.message, '.project-os/architecture')
  }

  try {
    const fleet = await checkFleetInstallation(root, schemas)
    errors.push(...fleet.errors)
    warnings.push(...fleet.warnings)
  } catch (error) {
    add(errors, 'fleet_check_failed', error.message, '.agents/fleet')
  }

  try {
    const outputs = await expectedBuild(root)
    for (const [relativePath, expected] of Object.entries(outputs)) {
      const path = join(root, relativePath)
      if (!(await pathExists(path))) add(errors, 'missing_projection', 'generated projection is missing; run project-os build', relativePath)
      else if ((await readFile(path, 'utf8')) !== expected) add(errors, 'stale_projection', 'generated projection is stale; run project-os build', relativePath)
    }
  } catch (error) {
    add(errors, 'projection_build_failed', error.message, '.project-os/generated')
  }

  if (!(await pathExists(join(root, 'AGENTS.md')))) add(warnings, 'missing_agent_router', 'AGENTS.md is absent; merge .project-os/AGENTS.project-os.html into the canonical rules source if adopting an existing repo')
  return { ok: errors.length === 0, errors, warnings, counts: { tasks: entries.length, schemas: schemaFiles.length } }
}

function formatStructuredProblem(problem) {
  return Object.entries(problem)
    .filter(([key]) => !['code', 'path'].includes(key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ') || problem.code
}

async function checkJsonArtifact(root, schemas, errors, relativePath, schemaName) {
  const path = join(root, relativePath)
  if (!(await pathExists(path))) {
    add(errors, 'missing_lifecycle_artifact', `${schemaName} artifact is missing`, relativePath)
    return null
  }
  try {
    const record = JSON.parse(await readFile(path, 'utf8'))
    addSchemaErrors(errors, schemas, schemaName, record, relativePath)
    return record
  } catch (error) {
    add(errors, 'invalid_lifecycle_json', error.message, relativePath)
    return null
  }
}

async function checkRunLedger(root, schemas, errors, runId) {
  const relativePath = `.agents/runs/${runId}/ledger.jsonl`
  const path = join(root, relativePath)
  if (!(await pathExists(path))) {
    add(errors, 'missing_run_ledger', 'run ledger is missing', relativePath)
    return
  }
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim())
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = JSON.parse(lines[index])
      addSchemaErrors(errors, schemas, 'run-event', event, `${relativePath}:${index + 1}`)
      if (event.run_id !== runId) add(errors, 'run_event_link_mismatch', `event belongs to ${event.run_id}`, `${relativePath}:${index + 1}`)
      if (event.seq !== index + 1) add(errors, 'run_event_sequence_gap', `expected sequence ${index + 1}, got ${event.seq}`, `${relativePath}:${index + 1}`)
    } catch (error) {
      add(errors, 'invalid_run_event_json', error.message, `${relativePath}:${index + 1}`)
    }
  }
}

async function checkLifecycle(root, schemas, errors) {
  const mappings = [
    ['.agents/missions', (path) => path.endsWith('/meta.json'), 'mission'],
    ['.agents/briefs/snapshots', (path) => path.endsWith('.snapshot.json'), 'resume-snapshot'],
    ['.agents/work-claims/active', (path) => path.endsWith('.json'), 'work-claim'],
    ['.agents/work-claims/released', (path) => path.endsWith('.json'), 'work-claim'],
  ]
  for (const [directory, matches, schemaName] of mappings) {
    for (const file of (await walkFiles(join(root, directory))).filter(matches)) {
      await checkJsonArtifact(root, schemas, errors, `${directory}/${file}`, schemaName)
    }
  }

  for (const sprintId of (await listDirectories(join(root, '.agents', 'sprints'))).filter((id) => id.startsWith('SPRINT-'))) {
    const directory = `.agents/sprints/${sprintId}`
    for (const file of await walkFiles(join(root, directory))) {
      let schemaName = null
      if (/^lanes\/[^/]+\/brief\.packet\.json$/.test(file)) schemaName = 'lane-packet'
      else if (/^lanes\/[^/]+\/state\.json$/.test(file)) schemaName = 'lane-state'
      else if (/^lanes\/[^/]+\/returns\/[^/]+\.json$/.test(file)) schemaName = 'run-return'
      else if (/^evidence\/gates\/[^/]+\.json$/.test(file)) schemaName = 'gate-receipt'
      if (schemaName) await checkJsonArtifact(root, schemas, errors, `${directory}/${file}`, schemaName)
    }
  }

  for (const runId of (await listDirectories(join(root, '.agents', 'runs'))).filter((id) => id.startsWith('RUN-'))) {
    const directory = `.agents/runs/${runId}`
    let runRecord = null
    try {
      runRecord = JSON.parse(await readFile(join(root, directory, 'run.json'), 'utf8'))
    } catch {}
    for (const file of await walkFiles(join(root, directory))) {
      let schemaName = null
      if (file === 'queue.json') schemaName = 'run-queue'
      else if (/^briefs\/[^/]+\.json$/.test(file)) schemaName = 'agent-packet'
      else if (/^returns\/[^/]+\.json$/.test(file)) schemaName = 'run-return'
      else if (/^attempts\/[^/]+\/attempt-[0-9]+\/attempt\.receipt\.json$/.test(file)) schemaName = 'attempt-receipt'
      else if (/^attempts\/[^/]+\/attempt-[0-9]+\/verification\.receipt\.json$/.test(file)) schemaName = 'verification-receipt'
      else if (/^attempts\/[^/]+\/attempt-[0-9]+\/result\.json$/.test(file)) schemaName = 'failure-result'
      else if (/^evidence\/gates\/[^/]+\.json$/.test(file)) schemaName = 'gate-receipt'
      if (schemaName) await checkJsonArtifact(root, schemas, errors, `${directory}/${file}`, schemaName)
    }
    await checkRunLedger(root, schemas, errors, runId)
    if (runRecord && ['completed', 'failed', 'cancelled'].includes(runRecord.status)) {
      try {
        await inspectRunCloseCensus(root, runId, runRecord.closeout ?? {})
      } catch (error) {
        add(errors, 'terminal_run_census_failed', error.message, `${directory}/run.json`)
      }
    }
  }

  for (const deliveryId of (await listDirectories(join(root, '.agents', 'delivery'))).filter((id) => id.startsWith('DELIVERY-'))) {
    const directory = `.agents/delivery/${deliveryId}`
    await checkJsonArtifact(root, schemas, errors, `${directory}/plan.json`, 'delivery-plan')
    if (await pathExists(join(root, directory, 'landing.receipt.json'))) {
      await checkJsonArtifact(root, schemas, errors, `${directory}/landing.receipt.json`, 'landing-receipt')
    }
  }
}

function addSchemaErrors(errors, schemas, schemaName, value, path) {
  const schema = schemas.get(schemaName)
  if (!schema) {
    add(errors, 'missing_schema', `missing ${schemaName}.schema.json`, path)
    return
  }
  for (const violation of validateSchema(value, schema)) add(errors, 'schema_violation', `${schemaName}${violation.path}: ${violation.message}`, path)
}

async function checkReferenceRecord(root, relativePath, field, taskById, errors, schemas, schemaName) {
  const path = join(root, relativePath)
  if (!(await pathExists(path))) {
    add(errors, 'missing_record', 'record file is missing', relativePath)
    return
  }
  try {
    const record = JSON.parse(await readFile(path, 'utf8'))
    addSchemaErrors(errors, schemas, schemaName, record, relativePath)
    for (const id of Array.isArray(record[field]) ? record[field] : []) {
      if (!taskById.has(id)) add(errors, 'missing_record_task', `${record.id} references missing ${id}`, relativePath)
    }
  } catch (error) {
    add(errors, 'invalid_record_json', error.message, relativePath)
  }
}

async function checkKnowledge(root, schemas, taskById, errors) {
  const authoredFiles = (await walkFiles(join(root, 'docs'))).filter((file) => ['.html', '.md'].some((extension) => file.endsWith(extension)))
  const authorities = new Map()
  const documents = new Map()
  for (const file of authoredFiles) {
    const relativePath = `docs/${file}`
    const content = await readFile(join(root, relativePath), 'utf8')
    const match = content.match(/<!-- project-os-meta\s*\n([\s\S]*?)\n-->/)
    if (!match) {
      continue
    }
    if (file.endsWith('.md')) add(errors, 'legacy_markdown_authority', 'Project OS authority must migrate to deterministic HTML with embedded metadata', relativePath)
    let metadata
    try {
      metadata = JSON.parse(match[1])
    } catch (error) {
      add(errors, 'invalid_document_metadata', error.message, relativePath)
      continue
    }
    addSchemaErrors(errors, schemas, 'document', metadata, relativePath)
    documents.set(relativePath, metadata)
    if (metadata.path !== relativePath) add(errors, 'document_path_mismatch', `metadata path is ${metadata.path}`, relativePath)
    if (metadata.status === 'current' && metadata.authority_key) {
      const owners = authorities.get(metadata.authority_key) ?? []
      owners.push(relativePath)
      authorities.set(metadata.authority_key, owners)
      if (metadata.canonical_pointer !== relativePath) add(errors, 'invalid_current_pointer', 'current document must point canonically to itself', relativePath)
    }
    if (metadata.status === 'stale' && metadata.canonical_pointer === relativePath) add(errors, 'invalid_stale_pointer', 'stale document cannot point canonically to itself', relativePath)
    if (relativePath.startsWith('docs/archive/') && relativePath !== 'docs/archive/INDEX.html' && metadata.status === 'current') add(errors, 'current_archive_document', 'archive content cannot be current', relativePath)
  }
  for (const [key, owners] of authorities) if (owners.length > 1) add(errors, 'duplicate_document_authority', `${key} is current in ${owners.join(', ')}`)
  for (const [relativePath, metadata] of documents) {
    const supersedes = Array.isArray(metadata.supersedes) ? metadata.supersedes : []
    const proofPointers = Array.isArray(metadata.evidence?.proof_pointers) ? metadata.evidence.proof_pointers : []
    for (const pointer of [metadata.canonical_pointer, metadata.superseded_by, ...supersedes, ...proofPointers].filter(Boolean)) {
      if (!(await repoPointerExists(root, pointer))) add(errors, 'broken_document_pointer', `document references missing ${pointer}`, relativePath)
    }
    for (const pointer of Array.isArray(metadata.source_pointers) ? metadata.source_pointers : []) {
      if (/^https?:\/\//.test(pointer)) continue
      if (!(await repoPointerExists(root, pointer))) add(errors, 'broken_document_source', `document source is missing: ${pointer}`, relativePath)
    }
    if (metadata.status === 'stale' && metadata.canonical_pointer) {
      const target = documents.get(metadata.canonical_pointer)
      if (!target || target.status !== 'current') add(errors, 'invalid_stale_target', 'stale document must point to a current document', relativePath)
    }
    if (metadata.status === 'current' && metadata.canonical_pointer?.startsWith('docs/archive/') && relativePath !== 'docs/archive/INDEX.html') add(errors, 'archive_canonical_pointer', 'current authority cannot point into the archive', relativePath)
  }

  const claims = await checkJsonLines(root, 'docs/ledgers/proofs.jsonl', schemas, 'claim', errors)
  await checkClaims(root, claims, errors)
  const decisions = await checkJsonLines(root, 'docs/ledgers/decisions.jsonl', schemas, 'decision', errors)
  await checkDecisions(root, decisions, taskById, errors)
  const runs = await checkJsonLines(root, 'docs/ledgers/runs.jsonl', schemas, 'run-discovery', errors)
  await checkRunDiscovery(root, runs, taskById, errors)
  for (const directory of (await listDirectories(join(root, 'docs', 'research'))).filter((name) => name.startsWith('RESEARCH-'))) {
    const relativePath = join('docs', 'research', directory, 'packet.json')
    if (!(await pathExists(join(root, relativePath)))) add(errors, 'missing_research_packet', 'research directory lacks packet.json', relativePath)
    else {
      try {
        const packet = JSON.parse(await readFile(join(root, relativePath), 'utf8'))
        addSchemaErrors(errors, schemas, 'research-packet', packet, relativePath)
        for (const taskId of Array.isArray(packet.parent_tasks) ? packet.parent_tasks : []) if (!taskById.has(taskId)) add(errors, 'missing_research_task', `${packet.packet_id} references missing ${taskId}`, relativePath)
        const evidenceArtifacts = Array.isArray(packet.evidence_artifacts) ? packet.evidence_artifacts : []
        const rawReceipts = Array.isArray(packet.raw_receipts) ? packet.raw_receipts : []
        for (const artifact of [...evidenceArtifacts, ...rawReceipts]) await checkHashedArtifact(root, artifact, relativePath, errors)
        if (packet.status === 'closed') {
          for (const output of Array.isArray(packet.closeout?.outputs) ? packet.closeout.outputs : []) {
            if (!output || typeof output !== 'object' || Array.isArray(output)) {
              add(errors, 'invalid_research_output', 'closeout output must be an object', relativePath)
              continue
            }
            if (output.status === 'planned') add(errors, 'unclosed_research_output', `closed packet retains planned output ${output.source_path}`, relativePath)
            if (!(await repoPointerExists(root, output.source_path))) add(errors, 'missing_research_output_source', `missing ${output.source_path}`, relativePath)
            if (!(await repoPointerExists(root, output.target_path))) add(errors, 'missing_research_output_target', `missing ${output.target_path}`, relativePath)
          }
        }
      } catch (error) {
        add(errors, 'invalid_research_packet', error.message, relativePath)
      }
    }
  }
}

async function checkJsonLines(root, relativePath, schemas, schemaName, errors) {
  const path = join(root, relativePath)
  const records = []
  if (!(await pathExists(path))) return records
  const lines = (await readFile(path, 'utf8')).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue
    try {
      const record = JSON.parse(lines[index])
      const recordPath = `${relativePath}:${index + 1}`
      addSchemaErrors(errors, schemas, schemaName, record, recordPath)
      records.push({ record, path: recordPath })
    } catch (error) {
      add(errors, 'invalid_jsonl', `line ${index + 1}: ${error.message}`, relativePath)
    }
  }
  return records
}

async function checkClaims(root, entries, errors) {
  const byId = new Map(entries.map((entry) => [entry.record.claim_id, entry]))
  const currentKeys = new Map()
  for (const entry of entries) {
    const { record, path } = entry
    if (['proven', 'shipped', 'deployed'].includes(record.status)) {
      const owners = currentKeys.get(record.claim_key) ?? []
      owners.push(record.claim_id)
      currentKeys.set(record.claim_key, owners)
    }
    if (!(await repoPointerExists(root, record.source_path))) add(errors, 'missing_claim_source', `missing ${record.source_path}`, path)
    for (const pointer of Array.isArray(record.depends_on) ? record.depends_on : []) if (!(await repoPointerExists(root, pointer))) add(errors, 'missing_claim_dependency', `missing ${pointer}`, path)
    for (const artifact of Array.isArray(record.proof_artifacts) ? record.proof_artifacts : []) await checkHashedArtifact(root, artifact, path, errors)
    for (const claimId of [...(Array.isArray(record.supersedes) ? record.supersedes : []), record.superseded_by].filter(Boolean)) if (!byId.has(claimId)) add(errors, 'missing_claim_link', `missing claim ${claimId}`, path)
    if (record.expiry_policy?.mode === 'time' && Date.parse(record.expiry_policy.review_due_at) <= Date.now()) add(errors, 'expired_claim', `review was due at ${record.expiry_policy.review_due_at}`, path)
    if (record.expiry_policy?.mode === 'dependency_change') {
      if (typeof record.proof_commit !== 'string') add(errors, 'missing_dependency_proof_commit', 'dependency-change expiry requires proof_commit', path)
      else await checkProofCommit(root, record, path, errors)
    } else if (typeof record.proof_commit === 'string') {
      const commit = spawnSync('git', ['cat-file', '-e', `${record.proof_commit}^{commit}`], { cwd: root, encoding: 'utf8' })
      if (commit.status !== 0) add(errors, 'missing_proof_commit', `commit ${record.proof_commit} does not resolve`, path)
    }
  }
  for (const [key, owners] of currentKeys) if (owners.length > 1) add(errors, 'duplicate_current_claim', `${key} is asserted by ${owners.join(', ')}`)
}

async function checkProofCommit(root, record, path, errors) {
  const commit = spawnSync('git', ['cat-file', '-e', `${record.proof_commit}^{commit}`], { cwd: root, encoding: 'utf8' })
  if (commit.status !== 0) {
    add(errors, 'missing_proof_commit', `commit ${record.proof_commit} does not resolve`, path)
    return
  }
  for (const dependency of Array.isArray(record.depends_on) ? record.depends_on : []) {
    const tracked = spawnSync('git', ['ls-tree', '-r', '--name-only', record.proof_commit, '--', dependency], { cwd: root, encoding: 'utf8' })
    const changed = spawnSync('git', ['diff', '--quiet', record.proof_commit, '--', dependency], { cwd: root })
    if (!tracked.stdout?.trim() || changed.status === 1) add(errors, 'decayed_claim', `${dependency} changed after ${record.proof_commit}`, path)
    else if (changed.status !== 0) add(errors, 'proof_decay_check_failed', `could not compare ${dependency} with ${record.proof_commit}`, path)
  }
}

async function checkDecisions(root, entries, taskById, errors) {
  const byId = new Map(entries.map((entry) => [entry.record.decision_id, entry]))
  const currentKeys = new Map()
  for (const { record, path } of entries) {
    if (record.status === 'current') {
      const owners = currentKeys.get(record.decision_key) ?? []
      owners.push(record.decision_id)
      currentKeys.set(record.decision_key, owners)
    }
    for (const id of Array.isArray(record.task_ids) ? record.task_ids : []) if (!taskById.has(id)) add(errors, 'missing_decision_task', `${record.decision_id} references missing ${id}`, path)
    for (const pointer of [record.source_path, ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : [])]) if (!(await repoPointerExists(root, pointer))) add(errors, 'missing_decision_pointer', `missing ${pointer}`, path)
    for (const id of [...(Array.isArray(record.supersedes) ? record.supersedes : []), record.superseded_by].filter(Boolean)) if (!byId.has(id)) add(errors, 'missing_decision_link', `missing ${id}`, path)
  }
  for (const [key, owners] of currentKeys) if (owners.length > 1) add(errors, 'duplicate_current_decision', `${key} is current in ${owners.join(', ')}`)
}

async function checkRunDiscovery(root, entries, taskById, errors) {
  for (const { record, path } of entries) {
    for (const id of Array.isArray(record.task_ids) ? record.task_ids : []) if (!taskById.has(id)) add(errors, 'missing_run_discovery_task', `${record.receipt_id} references missing ${id}`, path)
    for (const pointer of [record.source_path, ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : [])]) if (!(await repoPointerExists(root, pointer))) add(errors, 'missing_run_discovery_pointer', `missing ${pointer}`, path)
  }
}

async function checkHashedArtifact(root, artifact, ownerPath, errors) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    add(errors, 'invalid_artifact', 'artifact must be an object', ownerPath)
    return
  }
  let path
  try {
    path = resolveProjectPointer(root, artifact.path)
  } catch (error) {
    add(errors, 'invalid_artifact_path', error.message, ownerPath)
    return
  }
  if (!(await pathExists(path))) {
    add(errors, 'missing_artifact', `missing ${artifact.path}`, ownerPath)
    return
  }
  try {
    if (!(await stat(path)).isFile()) {
      add(errors, 'artifact_not_file', `${artifact.path} is not a file`, ownerPath)
      return
    }
    const actual = createHash('sha256').update(await readFile(path)).digest('hex')
    if (typeof artifact.sha256 === 'string' && actual !== artifact.sha256.toLowerCase()) add(errors, 'artifact_digest_mismatch', `${artifact.path} digest does not match`, ownerPath)
  } catch (error) {
    add(errors, 'artifact_read_failed', `${artifact.path}: ${error.message}`, ownerPath)
  }
}

async function repoPointerExists(root, pointer) {
  if (typeof pointer !== 'string' || pointer === '') return false
  try {
    return await pathExists(resolveProjectPointer(root, pointer))
  } catch {
    return false
  }
}
