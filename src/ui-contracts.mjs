import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveProjectPointer } from './shared.mjs'
import { findTask } from './work.mjs'

export const MAX_UI_CANDIDATES = 24

export function uiRecordDigest(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value))
}

async function fileProblems(root, pointer, expectedSha256, label) {
  const problems = []
  let path
  try {
    path = resolveProjectPointer(root, pointer)
  } catch (error) {
    return [error.message]
  }
  try {
    if (!(await stat(path)).isFile()) return [`${label} is not a file: ${pointer}`]
    if (expectedSha256) {
      const actual = createHash('sha256').update(await readFile(path)).digest('hex')
      if (actual !== expectedSha256.toLowerCase()) problems.push(`${label} digest mismatch: ${pointer}`)
    }
  } catch {
    problems.push(`${label} does not exist: ${pointer}`)
  }
  return problems
}

export async function uiCandidateManifestProblems(root, campaign, manifest) {
  const problems = []
  if (manifest.campaign_id !== campaign.id) problems.push(`candidate manifest belongs to ${manifest.campaign_id}, not ${campaign.id}`)
  if (manifest.task_id !== campaign.task_id) problems.push(`candidate manifest belongs to ${manifest.task_id}, not ${campaign.task_id}`)
  const candidates = manifest.candidates ?? []
  if (candidates.length < 2) problems.push('candidate manifest requires at least two candidates')
  if (candidates.length > MAX_UI_CANDIDATES) problems.push(`candidate manifest exceeds the ${MAX_UI_CANDIDATES}-candidate projection bound`)
  const ids = candidates.map((candidate) => candidate.id)
  if (new Set(ids).size !== ids.length) problems.push('candidate manifest contains duplicate candidate IDs')
  if (!sameSet(ids, campaign.candidate_ids ?? [])) problems.push('candidate manifest must account for every campaign candidate exactly once')
  const directionIds = [...new Set(candidates.filter((candidate) => candidate.eligibility === 'review_candidate').map((candidate) => candidate.direction_id))]
  if (!sameSet(directionIds, campaign.direction_ids ?? [])) problems.push('review candidates must cover every campaign direction')
  for (const candidate of candidates) {
    if (!(campaign.direction_ids ?? []).includes(candidate.direction_id)) problems.push(`${candidate.id} references unknown direction ${candidate.direction_id}`)
    problems.push(...await fileProblems(root, candidate.artifact.path, candidate.artifact.sha256, `candidate ${candidate.id} artifact`))
  }
  return problems
}

export function uiReviewResponseProblems(campaign, manifest, response) {
  const problems = []
  if (response.campaign_id !== campaign.id) problems.push(`review response belongs to ${response.campaign_id}, not ${campaign.id}`)
  if (response.task_id !== campaign.task_id) problems.push(`review response belongs to ${response.task_id}, not ${campaign.task_id}`)
  if (response.candidate_manifest !== campaign.candidate_manifest) problems.push('review response does not link the campaign candidate manifest path')
  const manifestDigest = uiRecordDigest(manifest)
  if (response.candidate_manifest_sha256 !== manifestDigest) problems.push('review response candidate manifest digest does not match')
  const eligible = [...new Set((manifest.candidates ?? []).filter((candidate) => candidate.eligibility === 'review_candidate').map((candidate) => candidate.direction_id))]
  if (!eligible.includes(response.selected_direction_id)) problems.push(`review selected unknown or ineligible direction ${response.selected_direction_id}`)
  const expectedRejected = eligible.filter((id) => id !== response.selected_direction_id)
  if (!sameSet(response.rejected_direction_ids ?? [], expectedRejected)) problems.push('review response must reject every other review-eligible direction exactly once')
  return problems
}

export function uiDecisionCompletenessProblems(campaign, manifest, response, decision) {
  const problems = [...uiReviewResponseProblems(campaign, manifest, response)]
  if (decision.campaign_id !== campaign.id || decision.task_id !== campaign.task_id) problems.push('decision does not belong to the campaign and canonical task')
  if (decision.chosen_direction_id !== response.selected_direction_id) problems.push('decision choice does not match the raw review response')
  if (!sameSet(decision.rejected_direction_ids ?? [], response.rejected_direction_ids ?? [])) problems.push('decision rejected directions do not match the raw review response')
  if (decision.review_response !== campaign.review_path) problems.push('decision does not link the campaign review response path')
  if (decision.candidate_manifest !== campaign.candidate_manifest) problems.push('decision does not link the campaign candidate manifest')
  if (decision.candidate_manifest_sha256 !== uiRecordDigest(manifest)) problems.push('decision candidate manifest digest does not match')
  if (decision.review_response_sha256 !== uiRecordDigest(response)) problems.push('decision review response digest does not match')
  const accounted = [decision.chosen_direction_id, ...(decision.rejected_direction_ids ?? [])]
  if (!sameSet(accounted, campaign.direction_ids ?? [])) problems.push('decision must choose or reject every campaign direction exactly once')
  return problems
}

export function uiReceiptLinkProblems(campaign, decision, implementation, verification) {
  const problems = []
  for (const [label, record] of [['implementation', implementation], ['verification', verification]]) {
    if (record.campaign_id !== campaign.id || record.task_id !== campaign.task_id) problems.push(`${label} receipt does not belong to the campaign and canonical task`)
    if (record.direction_id !== decision.chosen_direction_id) problems.push(`${label} receipt is for ${record.direction_id}, not chosen direction ${decision.chosen_direction_id}`)
  }
  if (implementation.kind !== 'implementation' || implementation.verdict !== 'pass') problems.push('implementation linkage requires a passing implementation receipt')
  if (verification.kind !== 'verification' || verification.verdict !== 'pass') problems.push('verification linkage requires a passing verification receipt')
  const implementationCommit = implementation.implementation?.source_commit
  const verificationCommit = verification.verification?.source_commit
  if (!implementationCommit || !verificationCommit || implementationCommit !== verificationCommit) problems.push('verification must prove the exact implementation source commit')
  return problems
}

export function decisionFromUiReview({ campaign, manifest, response, decision_id, response_path, implementation_target, approved_at, exceptions = [], supersedes = null }) {
  const problems = uiReviewResponseProblems(campaign, manifest, response)
  if (problems.length > 0) throw new Error(`cannot import incomplete UI review:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  if (typeof decision_id !== 'string' || !/^DEC-UI-[0-9]{4}-[A-Z0-9][A-Z0-9-]*$/.test(decision_id)) throw new Error('review import requires a DEC-UI-####-NAME decision_id')
  if (response_path !== campaign.review_path) throw new Error('review import response_path must equal campaign.review_path')
  if (!implementation_target || !Array.isArray(implementation_target.paths) || implementation_target.paths.length === 0 || !Array.isArray(implementation_target.acceptance) || implementation_target.acceptance.length === 0) {
    throw new Error('review import requires implementation_target paths and acceptance')
  }
  return {
    schema_version: 1,
    id: decision_id,
    campaign_id: campaign.id,
    task_id: campaign.task_id,
    chosen_direction_id: response.selected_direction_id,
    rejected_direction_ids: [...response.rejected_direction_ids],
    rationale: response.rationale,
    approver: { ...response.reviewer },
    approved_at: approved_at ?? response.recorded_at,
    review_response: response_path,
    candidate_manifest: campaign.candidate_manifest,
    candidate_manifest_sha256: uiRecordDigest(manifest),
    review_response_sha256: uiRecordDigest(response),
    implementation_target,
    verbatim_notes: [...(response.verbatim_notes ?? [])],
    exceptions,
    ...(supersedes ? { supersedes } : {}),
  }
}

export async function uiTaskEvidenceProblems(root, campaign, fold) {
  const problems = []
  if (fold.campaign_id !== campaign.id || fold.task_id !== campaign.task_id) problems.push('task evidence fold does not belong to the campaign and canonical task')
  if (fold.decision_record !== campaign.decision_record) problems.push('task evidence fold decision pointer differs from the campaign')
  if (fold.implementation_receipt !== campaign.implementation_receipt) problems.push('task evidence fold implementation pointer differs from the campaign')
  if (fold.verification_receipt !== campaign.verification_receipt) problems.push('task evidence fold verification pointer differs from the campaign')
  if (fold.verdict !== 'promoted') problems.push(`task evidence fold verdict is ${fold.verdict}, expected promoted`)
  if (typeof fold.task_evidence_file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(fold.task_evidence_file)) problems.push('task evidence fold requires a stable JSON filename without directories')
  else {
    try {
      const task = await findTask(root, campaign.task_id)
      const path = join(task.directory, 'evidence', fold.task_evidence_file)
      if (!(await stat(path)).isFile()) problems.push(`promoted task evidence is not a file: ${fold.task_evidence_file}`)
    } catch (error) {
      problems.push(`promoted task evidence cannot be resolved through ${campaign.task_id}: ${error.message}`)
    }
  }
  return problems
}

async function readPointer(root, pointer, label, problems) {
  if (typeof pointer !== 'string' || !pointer) {
    problems.push(`missing ${label} pointer`)
    return null
  }
  try {
    return JSON.parse(await readFile(resolveProjectPointer(root, pointer), 'utf8'))
  } catch (error) {
    problems.push(`cannot read ${label}: ${error.message}`)
    return null
  }
}

export async function uiCampaignCompletionProblems(root, campaign) {
  if (campaign.stage !== 'verified') return [`${campaign.id} is ${campaign.stage}, expected verified`]
  const problems = []
  const manifest = await readPointer(root, campaign.candidate_manifest, 'candidate manifest', problems)
  const response = await readPointer(root, campaign.review_path, 'review response', problems)
  const decision = await readPointer(root, campaign.decision_record, 'decision', problems)
  const implementation = await readPointer(root, campaign.implementation_receipt, 'implementation receipt', problems)
  const verification = await readPointer(root, campaign.verification_receipt, 'verification receipt', problems)
  const fold = await readPointer(root, campaign.task_evidence_receipt, 'task evidence receipt', problems)
  if (manifest) problems.push(...await uiCandidateManifestProblems(root, campaign, manifest))
  if (manifest && response && decision) problems.push(...uiDecisionCompletenessProblems(campaign, manifest, response, decision))
  if (decision && implementation && verification) problems.push(...uiReceiptLinkProblems(campaign, decision, implementation, verification))
  if (fold) {
    problems.push(...await uiTaskEvidenceProblems(root, campaign, fold))
    if (implementation && fold.source_commit !== implementation.implementation?.source_commit) problems.push('task evidence fold source commit differs from implementation')
  }
  return problems
}
