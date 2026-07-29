import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UI_STAGES, isoNow, listDirectories, pathExists, readJson, resolveProjectPointer, splitList, withExclusiveLock, writeJsonAtomic } from './shared.mjs'
import { assertProjectRecord } from './schema.mjs'
import { findTask } from './work.mjs'
import { uiCandidateManifestProblems, uiDecisionCompletenessProblems, uiReceiptLinkProblems, uiReviewResponseProblems, uiTaskEvidenceProblems } from './ui-contracts.mjs'

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]))
}

async function nextCampaignId(base) {
  let maximum = 0
  for (const id of await listDirectories(base)) {
    const match = id.match(/^UI-(\d{4})$/)
    if (match) maximum = Math.max(maximum, Number(match[1]))
  }
  if (maximum >= 9999) throw new Error('UI campaign registry exhausted the UI-0001..UI-9999 namespace')
  return `UI-${String(maximum + 1).padStart(4, '0')}`
}

export async function createUiCampaign(root, flags) {
  const title = typeof flags.title === 'string' ? flags.title.trim() : ''
  const taskId = typeof flags.task === 'string' ? flags.task.trim() : ''
  if (!title) throw new Error('ui create requires --title')
  if (!taskId) throw new Error('ui create requires --task TASK-NNNN')
  await findTask(root, taskId)
  return withExclusiveLock(root, join('.uihub', '.locks', 'registry.lock'), async () => {
    const base = join(root, '.uihub', 'campaigns')
    const id = await nextCampaignId(base)
    const timestamp = isoNow(flags)
    const by = typeof flags.by === 'string' ? flags.by : 'human'
    const intentPath = `.uihub/campaigns/${id}/intent/brief.html`
    const campaign = {
      schema_version: 1,
      id,
      task_id: taskId,
      title,
      surface: typeof flags.surface === 'string' ? flags.surface : 'unspecified',
      stage: 'intent',
      intent_path: intentPath,
      direction_ids: [],
      candidate_ids: [],
      created_at: timestamp,
      updated_at: timestamp,
      history: [{ stage: 'intent', at: timestamp, by, note: 'Campaign created from an existing canonical task.' }],
    }
    const directory = join(base, id)
    const children = ['intent', 'research', 'directions', 'candidates', 'review', 'decided', 'implemented', 'verified']
    for (const child of children) {
      await mkdir(join(directory, child), { recursive: true })
      await writeFile(join(directory, child, '.gitkeep'), '', 'utf8')
    }
    const briefState = {
      schema_version: 1,
      campaign_id: id,
      task_id: taskId,
      surface: campaign.surface,
      audience: typeof flags.audience === 'string' ? flags.audience : 'TBD',
      primary_job: typeof flags.job === 'string' ? flags.job : 'TBD',
      source_revision: typeof flags.commit === 'string' ? flags.commit : 'TBD',
      canonical_writer: false,
    }
    const briefJson = JSON.stringify(briefState).replace(/</g, '\\u003c')
    const brief = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)} — UI intent</title><style>body{font:15px/1.55 system-ui;max-width:68rem;margin:auto;padding:2rem;color:#17202a}dl{display:grid;grid-template-columns:max-content 1fr;gap:.5rem 1rem}dd{margin:0}@media(max-width:40rem){body{padding:.5rem}dl{grid-template-columns:1fr}}</style></head><body><main data-contract="ui-intent"><h1>${htmlEscape(title)}</h1><dl><dt>Canonical task</dt><dd><code>${htmlEscape(taskId)}</code></dd><dt>Surface</dt><dd>${htmlEscape(briefState.surface)}</dd><dt>Audience</dt><dd>${htmlEscape(briefState.audience)}</dd><dt>Primary job</dt><dd>${htmlEscape(briefState.primary_job)}</dd><dt>Source revision</dt><dd><code>${htmlEscape(briefState.source_revision)}</code></dd></dl><p>Expand this authored brief with current truth, scope, acceptance, and open questions before advancing.</p></main><script id="ui-intent-contract" type="application/json">${briefJson}</script></body></html>\n`
    await assertProjectRecord(root, 'ui-campaign', campaign)
    await writeFile(join(directory, 'intent', 'brief.html'), brief, 'utf8')
    await writeJsonAtomic(join(directory, 'campaign.json'), campaign)
    return campaign
  })
}

export async function findUiCampaign(root, id) {
  const base = join(root, '.uihub', 'campaigns')
  if (!(await listDirectories(base)).includes(id)) throw new Error(`${id} was not found`)
  const path = join(base, id, 'campaign.json')
  return { path, directory: join(base, id), campaign: await readJson(path) }
}

export async function advanceUiCampaign(root, id, flags) {
  const entry = await findUiCampaign(root, id)
  await findTask(root, entry.campaign.task_id)
  const requested = typeof flags.stage === 'string' ? flags.stage : ''
  if (!UI_STAGES.includes(requested)) throw new Error(`ui advance --stage must be one of: ${UI_STAGES.join(', ')}`)
  const currentIndex = UI_STAGES.indexOf(entry.campaign.stage)
  const requestedIndex = UI_STAGES.indexOf(requested)
  const isSupersede = requested === 'superseded'
  if (entry.campaign.stage === 'superseded') throw new Error('superseded campaigns are terminal')
  if (!isSupersede && requestedIndex !== currentIndex + 1) {
    throw new Error(`campaign may advance only one stage at a time (${entry.campaign.stage} -> ${UI_STAGES[currentIndex + 1] ?? 'none'})`)
  }
  let receipt = null
  if (requested === 'research') {
    entry.campaign.research_path = await requirePointer(root, flags.research, 'research stage requires --research <path>')
    receipt = entry.campaign.research_path
  }
  if (requested === 'directions') {
    const directions = splitList(flags.directions)
    if (directions.length < 2) throw new Error('directions stage requires at least two --directions IDs')
    if (directions.some((direction) => !/^DIR-[A-Z0-9][A-Z0-9-]*$/.test(direction))) throw new Error('direction IDs must match DIR-NAME')
    for (const directionId of directions) {
      const path = join(entry.directory, 'directions', `${directionId}.json`)
      if (!(await pathExists(path))) throw new Error(`missing direction record: ${directionId}.json`)
      const direction = await readJson(path)
      await assertProjectRecord(root, 'ui-direction', direction)
      assertLinkedRecord(entry.campaign, direction, `direction ${directionId}`)
      if (direction.id !== directionId) throw new Error(`${directionId}.json contains ${direction.id}`)
    }
    entry.campaign.direction_ids = directions
  }
  if (requested === 'candidates') {
    const candidates = splitList(flags.candidates)
    if (candidates.length < 2) throw new Error('candidates stage requires at least two --candidates IDs')
    if (candidates.some((candidate) => !/^CAN-[A-Z0-9][A-Z0-9-]*$/.test(candidate))) throw new Error('candidate IDs must match CAN-NAME')
    for (const candidateId of candidates) {
      if (!(await pathExists(join(entry.directory, 'candidates', candidateId)))) throw new Error(`missing candidate artifact: ${candidateId}`)
    }
    entry.campaign.candidate_ids = candidates
    if (typeof flags.manifest === 'string') {
      entry.campaign.candidate_manifest = await requirePointer(root, flags.manifest, 'candidates stage --manifest must reference a candidate manifest')
      const manifest = await readJson(resolveProjectPointer(root, entry.campaign.candidate_manifest))
      await assertProjectRecord(root, 'ui-candidate-manifest', manifest)
      const problems = await uiCandidateManifestProblems(root, entry.campaign, manifest)
      if (problems.length > 0) throw new Error(`candidate manifest is incomplete:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    }
  }
  if (requested === 'review') {
    entry.campaign.review_path = await requirePointer(root, flags.review, 'review stage requires --review <path>')
    if (entry.campaign.candidate_manifest) {
      const manifest = await readJson(resolveProjectPointer(root, entry.campaign.candidate_manifest))
      const response = await readJson(resolveProjectPointer(root, entry.campaign.review_path))
      await assertProjectRecord(root, 'ui-review-response', response)
      const problems = uiReviewResponseProblems(entry.campaign, manifest, response)
      if (problems.length > 0) throw new Error(`review response is incomplete:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    }
    receipt = entry.campaign.review_path
  }
  if (requested === 'decided') {
    const decision = typeof flags.decision === 'string' ? flags.decision : ''
    if (!decision) throw new Error('decided stage requires --decision <path>')
    entry.campaign.decision_record = await requirePointer(root, decision, 'decided stage requires --decision <path>')
    const decisionRecord = await readJson(resolveProjectPointer(root, entry.campaign.decision_record))
    await assertProjectRecord(root, 'ui-decision', decisionRecord)
    assertLinkedRecord(entry.campaign, decisionRecord, 'decision')
    if (!entry.campaign.direction_ids.includes(decisionRecord.chosen_direction_id)) throw new Error(`decision chooses unknown direction ${decisionRecord.chosen_direction_id}`)
    for (const directionId of decisionRecord.rejected_direction_ids ?? []) {
      if (!entry.campaign.direction_ids.includes(directionId)) throw new Error(`decision rejects unknown direction ${directionId}`)
    }
    if ((decisionRecord.rejected_direction_ids ?? []).includes(decisionRecord.chosen_direction_id)) throw new Error('decision cannot both choose and reject the same direction')
    const accountedDirections = [decisionRecord.chosen_direction_id, ...(decisionRecord.rejected_direction_ids ?? [])]
    if (new Set(accountedDirections).size !== accountedDirections.length || accountedDirections.length !== entry.campaign.direction_ids.length || entry.campaign.direction_ids.some((directionId) => !accountedDirections.includes(directionId))) {
      throw new Error('decision must choose or reject every campaign direction exactly once')
    }
    if (entry.campaign.candidate_manifest) {
      const manifest = await readJson(resolveProjectPointer(root, entry.campaign.candidate_manifest))
      const response = await readJson(resolveProjectPointer(root, entry.campaign.review_path))
      const problems = uiDecisionCompletenessProblems(entry.campaign, manifest, response, decisionRecord)
      if (problems.length > 0) throw new Error(`decision is incomplete:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    }
    receipt = entry.campaign.decision_record
  }
  if (requested === 'implemented') {
    entry.campaign.implementation_receipt = await requirePointer(root, flags.receipt, 'implemented stage requires --receipt <path>')
    const implementation = await readJson(resolveProjectPointer(root, entry.campaign.implementation_receipt))
    await assertProjectRecord(root, 'ui-receipt', implementation)
    assertLinkedRecord(entry.campaign, implementation, 'implementation receipt')
    if (implementation.kind !== 'implementation' || implementation.verdict !== 'pass') throw new Error('implemented stage requires a passing implementation receipt')
    await assertReceiptSemantics(root, entry.campaign, implementation, 'implementation')
    const decision = await readJson(resolveProjectPointer(root, entry.campaign.decision_record))
    if (implementation.direction_id !== decision.chosen_direction_id) throw new Error(`implementation receipt is for ${implementation.direction_id}, not chosen direction ${decision.chosen_direction_id}`)
    receipt = entry.campaign.implementation_receipt
  }
  if (requested === 'verified') {
    entry.campaign.verification_receipt = await requirePointer(root, flags.receipt, 'verified stage requires --receipt <path>')
    const verification = await readJson(resolveProjectPointer(root, entry.campaign.verification_receipt))
    await assertProjectRecord(root, 'ui-receipt', verification)
    assertLinkedRecord(entry.campaign, verification, 'verification receipt')
    if (verification.kind !== 'verification' || verification.verdict !== 'pass') throw new Error('verified stage requires a passing verification receipt')
    await assertReceiptSemantics(root, entry.campaign, verification, 'verification')
    const decision = await readJson(resolveProjectPointer(root, entry.campaign.decision_record))
    const implementation = await readJson(resolveProjectPointer(root, entry.campaign.implementation_receipt))
    const linkageProblems = uiReceiptLinkProblems(entry.campaign, decision, implementation, verification)
    if (linkageProblems.length > 0) throw new Error(`verification receipt linkage is incomplete:\n${linkageProblems.map((problem) => `- ${problem}`).join('\n')}`)
    const foldPointer = flags.fold ?? flags['task-evidence']
    if (typeof foldPointer === 'string') {
      entry.campaign.task_evidence_receipt = await requirePointer(root, foldPointer, 'verified stage task evidence pointer is invalid')
      const fold = await readJson(resolveProjectPointer(root, entry.campaign.task_evidence_receipt))
      await assertProjectRecord(root, 'ui-task-evidence', fold)
      const foldProblems = await uiTaskEvidenceProblems(root, entry.campaign, fold)
      if (foldProblems.length > 0) throw new Error(`task evidence fold is incomplete:\n${foldProblems.map((problem) => `- ${problem}`).join('\n')}`)
    }
    receipt = entry.campaign.verification_receipt
  }
  if (requested === 'superseded') {
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
    if (!reason) throw new Error('superseded stage requires --reason')
    entry.campaign.superseded = {
      at: isoNow(flags),
      by: typeof flags.by === 'string' ? flags.by : 'human',
      reason,
      ...(typeof flags.replacement === 'string' ? { replacement_campaign_id: flags.replacement } : {}),
    }
  }
  entry.campaign.stage = requested
  entry.campaign.updated_at = isoNow(flags)
  entry.campaign.history.push({
    stage: requested,
    at: entry.campaign.updated_at,
    by: typeof flags.by === 'string' ? flags.by : 'human',
    ...(receipt ? { receipt } : {}),
    ...(typeof flags.note === 'string' ? { note: flags.note } : {}),
  })
  await assertProjectRecord(root, 'ui-campaign', entry.campaign)
  await writeJsonAtomic(entry.path, entry.campaign)
  return entry.campaign
}

async function assertReceiptSemantics(root, campaign, record, expectedKind) {
  const problems = await uiReceiptProblems(root, campaign, record, expectedKind)
  if (problems.length > 0) throw new Error(`${expectedKind} receipt is contradictory:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
}

export async function uiReceiptProblems(root, campaign, record, expectedKind) {
  const problems = []
  const excepted = (check) => (record.exceptions ?? []).some((exception) => exception.check === check || exception.check === `${expectedKind}:${check}`)
  if (record.kind !== expectedKind) problems.push(`kind is ${record.kind}, expected ${expectedKind}`)
  if (record.verdict !== 'pass') problems.push(`top-level verdict is ${record.verdict}`)
  if (!campaign.direction_ids?.includes(record.direction_id)) problems.push(`direction ${record.direction_id} is not part of ${campaign.id}`)
  const detail = record[expectedKind]
  if (!detail) return [...problems, `missing ${expectedKind} detail`]
  for (const check of detail.checks ?? []) {
    if (check.verdict !== 'pass' && !excepted(check.name)) problems.push(`check ${check.name} is ${check.verdict}`)
    if (check.evidence_path) await inspectEvidence(root, check.evidence_path, null, problems)
  }
  for (const evidence of record.evidence ?? []) await inspectEvidence(root, evidence.path, evidence.sha256, problems)
  if (expectedKind === 'implementation') {
    if (!detail.source_commit) problems.push('passing implementation lacks source_commit')
    if (!Array.isArray(detail.changed_files) || detail.changed_files.length === 0) problems.push('passing implementation has no changed_files')
    for (const path of [...(detail.target_paths ?? []), ...(detail.changed_files ?? [])]) {
      if (!(await pointerExists(root, path))) problems.push(`implementation path does not exist: ${path}`)
    }
    if (campaign.decision_record) {
      try {
        const decision = await readJson(resolveProjectPointer(root, campaign.decision_record))
        if (record.direction_id !== decision.chosen_direction_id) problems.push(`implementation direction ${record.direction_id} differs from chosen ${decision.chosen_direction_id}`)
      } catch (error) {
        problems.push(`implementation cannot resolve decision: ${error.message}`)
      }
    }
  }
  if (expectedKind === 'verification') {
    for (const evidence of detail.visual_evidence ?? []) await inspectEvidence(root, evidence.path, evidence.sha256, problems)
    for (const [fault, count] of Object.entries(detail.browser_faults ?? {})) {
      if (count !== 0 && !excepted(fault)) problems.push(`${fault} is ${count}`)
    }
    if (campaign.decision_record && campaign.implementation_receipt) {
      try {
        const decision = await readJson(resolveProjectPointer(root, campaign.decision_record))
        const implementation = await readJson(resolveProjectPointer(root, campaign.implementation_receipt))
        problems.push(...uiReceiptLinkProblems(campaign, decision, implementation, record))
      } catch (error) {
        problems.push(`verification cannot resolve implementation linkage: ${error.message}`)
      }
    }
  }
  return problems
}

async function pointerExists(root, pointer) {
  try {
    return await pathExists(resolveProjectPointer(root, pointer))
  } catch {
    return false
  }
}

async function inspectEvidence(root, pointer, expectedSha, problems) {
  let path
  try {
    path = resolveProjectPointer(root, pointer)
  } catch (error) {
    problems.push(error.message)
    return
  }
  if (!(await pathExists(path))) {
    problems.push(`evidence does not exist: ${pointer}`)
    return
  }
  try {
    if (!(await stat(path)).isFile()) {
      problems.push(`evidence is not a file: ${pointer}`)
      return
    }
    if (expectedSha) {
      const actual = createHash('sha256').update(await readFile(path)).digest('hex')
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) problems.push(`evidence digest mismatch: ${pointer}`)
    }
  } catch (error) {
    problems.push(`evidence cannot be read: ${pointer} (${error.message})`)
  }
}

function assertLinkedRecord(campaign, record, label) {
  if (record.campaign_id !== campaign.id) throw new Error(`${label} belongs to ${record.campaign_id}, not ${campaign.id}`)
  if (record.task_id !== campaign.task_id) throw new Error(`${label} belongs to ${record.task_id}, not ${campaign.task_id}`)
}

async function requirePointer(root, pointer, message) {
  if (typeof pointer !== 'string' || pointer.trim() === '') throw new Error(message)
  const absolute = resolveProjectPointer(root, pointer)
  if (!(await pathExists(absolute))) throw new Error(`referenced artifact does not exist: ${pointer}`)
  return pointer
}
