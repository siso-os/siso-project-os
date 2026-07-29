import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson, resolveProjectPointer } from './shared.mjs'
import { assertProjectRecord } from './schema.mjs'
import { MAX_UI_CANDIDATES, uiCandidateManifestProblems } from './ui-contracts.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]))
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]))
  return value
}

function artifactUrl(path) {
  return `../../../${String(path).replace(/^\.\//, '')}`
}

function candidateArtifact(candidate) {
  const url = htmlEscape(artifactUrl(candidate.artifact.path))
  const label = htmlEscape(candidate.title)
  if (candidate.artifact.media_type === 'text/html') return `<iframe src="${url}" title="${label}" loading="lazy"></iframe>`
  if (candidate.artifact.media_type.startsWith('image/')) return `<img src="${url}" alt="${htmlEscape(candidate.artifact.alt ?? label)}" loading="lazy">`
  return `<a class="artifact-link" href="${url}">Open candidate artifact</a>`
}

export function createUiProjectionModel({ campaign, manifest, directions }) {
  const sortedDirections = [...directions].sort((left, right) => left.id.localeCompare(right.id))
  const sortedCandidates = [...manifest.candidates].sort((left, right) => left.id.localeCompare(right.id))
  if (sortedCandidates.length > MAX_UI_CANDIDATES) throw new Error(`UI projection is bounded to ${MAX_UI_CANDIDATES} candidates`)
  const payload = stable({
    schema_version: 1,
    generator: 'siso-project-os/ui-campaign-projection.v1',
    campaign: {
      id: campaign.id,
      task_id: campaign.task_id,
      title: campaign.title,
      surface: campaign.surface,
      stage: campaign.stage,
      candidate_manifest: campaign.candidate_manifest,
    },
    comparison_contract: manifest.comparison_contract,
    candidate_manifest_sha256: sha256(JSON.stringify(manifest)),
    directions: sortedDirections.map((direction) => ({
      id: direction.id,
      title: direction.title,
      thesis: direction.thesis,
      divergence_axis: direction.divergence_axis,
      known_tradeoffs: direction.known_tradeoffs ?? [],
    })),
    candidates: sortedCandidates,
  })
  return { ...payload, input_digest: sha256(JSON.stringify(payload)) }
}

export async function loadUiProjectionModel(root, campaignId) {
  const campaign = await readJson(join(root, '.uihub', 'campaigns', campaignId, 'campaign.json'))
  if (!campaign.candidate_manifest) throw new Error(`${campaignId} has no candidate_manifest`)
  const manifest = await readJson(resolveProjectPointer(root, campaign.candidate_manifest))
  await assertProjectRecord(root, 'ui-candidate-manifest', manifest)
  const problems = await uiCandidateManifestProblems(root, campaign, manifest)
  if (problems.length > 0) throw new Error(`invalid candidate manifest:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  const directions = []
  for (const directionId of [...campaign.direction_ids].sort()) {
    const direction = await readJson(join(root, '.uihub', 'campaigns', campaignId, 'directions', `${directionId}.json`))
    await assertProjectRecord(root, 'ui-direction', direction)
    directions.push(direction)
  }
  return createUiProjectionModel({ campaign, manifest, directions })
}

function candidateCards(model, selectable) {
  const directions = new Map(model.directions.map((direction) => [direction.id, direction]))
  return model.candidates.map((candidate) => {
    const direction = directions.get(candidate.direction_id)
    const input = selectable && candidate.eligibility === 'review_candidate'
      ? `<input type="radio" name="direction" value="${htmlEscape(candidate.direction_id)}" required>`
      : ''
    return `<article class="candidate" data-candidate-id="${htmlEscape(candidate.id)}" data-direction-id="${htmlEscape(candidate.direction_id)}">${input}<div class="artifact">${candidateArtifact(candidate)}</div><p class="eyebrow">${htmlEscape(candidate.id)} · ${htmlEscape(candidate.eligibility)}</p><h3>${htmlEscape(candidate.title)}</h3><p><strong>${htmlEscape(direction?.title ?? candidate.direction_id)}</strong> — ${htmlEscape(direction?.thesis ?? '')}</p><p>${htmlEscape(candidate.summary ?? direction?.divergence_axis ?? '')}</p></article>`
  }).join('')
}

function pageShell(model, title, body, script = '') {
  const state = JSON.stringify(model).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="project-os-input-digest" content="${model.input_digest}"><title>${htmlEscape(title)}</title><style>:root{font-family:system-ui;color:#17202a;background:#f4f6f9}*{box-sizing:border-box}body{margin:0}main{width:min(90rem,calc(100% - 2rem));margin:auto;padding:2rem 0 4rem}.hero,.context,.candidate,.response{background:#fff;border:1px solid #dce2ea;border-radius:1rem}.hero,.context,.response{padding:1.2rem;margin-bottom:1rem}.eyebrow{color:#687586;font-size:.78rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));gap:1rem}.candidate{position:relative;padding:1rem;min-width:0}.candidate input{position:absolute;top:1.35rem;right:1.35rem;width:1.2rem;height:1.2rem}.artifact{display:grid;place-items:center;min-height:16rem;overflow:hidden;background:#edf1f5;border-radius:.7rem}.artifact iframe,.artifact img{width:100%;height:22rem;border:0;object-fit:contain}.artifact-link{padding:1rem}textarea,input[type=text]{width:100%;padding:.7rem;font:inherit}.response{display:grid;gap:.8rem;margin-top:1rem}.response label span{display:block;font-weight:700;margin-bottom:.3rem}button{width:fit-content;padding:.75rem 1rem;border:0;border-radius:999px;background:#2457d6;color:#fff;font-weight:800}@media(max-width:40rem){main{width:min(100% - 1rem,90rem);padding-top:.5rem}.artifact iframe,.artifact img{height:18rem}}</style></head><body><main>${body}</main><script id="ui-campaign-state" type="application/json">${state}</script>${script}<script>window.__verify=Object.freeze({version:'project-os-ui-projection.v1',campaignId:${JSON.stringify(model.campaign.id)},candidateCount:${model.candidates.length},inputDigest:${JSON.stringify(model.input_digest)},check(){return document.querySelectorAll('[data-candidate-id]').length===this.candidateCount&&Boolean(document.querySelector('#ui-campaign-state'))}})</script></body></html>`
}

export function renderUiGalleryHtml(model) {
  return pageShell(model, `${model.campaign.title} candidate gallery`, `<header class="hero" data-contract="ui-campaign-context"><p class="eyebrow">${htmlEscape(model.campaign.id)} · canonical task ${htmlEscape(model.campaign.task_id)}</p><h1>${htmlEscape(model.campaign.title)}</h1><p>Read-only candidate gallery for ${htmlEscape(model.campaign.surface)}. Approval lives in the review response and decision records.</p></header><section class="grid" data-contract="ui-candidates">${candidateCards(model, false)}</section>`)
}

export function renderUiReviewHtml(model) {
  const body = `<header class="hero" data-contract="ui-review-context"><p class="eyebrow">${htmlEscape(model.campaign.id)} · canonical task ${htmlEscape(model.campaign.task_id)}</p><h1>Review ${htmlEscape(model.campaign.title)}</h1><p>Every candidate uses the same declared comparison contract. Choose one direction; the downloaded JSON is evidence, not the durable decision.</p></header><section class="context"><h2>Comparison contract</h2><p>${htmlEscape((model.comparison_contract.screen_ids ?? []).join(', '))} · ${htmlEscape((model.comparison_contract.viewports ?? []).map((viewport) => `${viewport.name} ${viewport.width}×${viewport.height}`).join(', '))}</p></section><form id="review-form" data-contract="ui-review-form"><section class="grid">${candidateCards(model, true)}</section><section class="response"><h2>Record response</h2><label><span>Reviewer name</span><input name="reviewer_name" type="text" required></label><label><span>Reviewer role</span><input name="reviewer_role" type="text" required></label><label><span>Rationale</span><textarea name="rationale" rows="4" required></textarea></label><label><span>Verbatim notes, one per line</span><textarea name="notes" rows="5"></textarea></label><button type="submit">Download review response</button><p>This page has no writable backend and stores no canonical state in the browser.</p></section></form>`
  const script = `<script>document.querySelector('#review-form').addEventListener('submit',(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);const chosen=String(form.get('direction'));const directions=[...new Set(${JSON.stringify(model.candidates.filter((candidate) => candidate.eligibility === 'review_candidate').map((candidate) => candidate.direction_id))})];const response={schema_version:1,campaign_id:${JSON.stringify(model.campaign.id)},task_id:${JSON.stringify(model.campaign.task_id)},candidate_manifest:${JSON.stringify(model.campaign.candidate_manifest)},candidate_manifest_sha256:${JSON.stringify(model.candidate_manifest_sha256)},selected_direction_id:chosen,rejected_direction_ids:directions.filter((id)=>id!==chosen),reviewer:{name:String(form.get('reviewer_name')).trim(),role:String(form.get('reviewer_role')).trim()},recorded_at:new Date().toISOString(),rationale:String(form.get('rationale')).trim(),verbatim_notes:String(form.get('notes')).split('\\n').map((line)=>line.trim()).filter(Boolean)};const blob=new Blob([JSON.stringify(response,null,2)+'\\n'],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=response.campaign_id+'-review-response.json';link.click();URL.revokeObjectURL(link.href)})</script>`
  return pageShell(model, `${model.campaign.title} review`, body, script)
}

export async function expectedUiCampaignProjections(root, campaignId) {
  const model = await loadUiProjectionModel(root, campaignId)
  const prefix = `.uihub/generated/${campaignId}`
  return {
    [`${prefix}/projection.json`]: `${JSON.stringify(model, null, 2)}\n`,
    [`${prefix}/gallery.html`]: `${renderUiGalleryHtml(model)}\n`,
    [`${prefix}/review.html`]: `${renderUiReviewHtml(model)}\n`,
  }
}
