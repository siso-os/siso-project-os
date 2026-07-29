import { createHash } from 'node:crypto'

const DEFAULT_LIMIT = 40

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]))
}

function stableRecord(record, fallbackKind) {
  return {
    id: String(record.id ?? record.document_id ?? record.claim_id ?? record.memory_id ?? record.path ?? 'unknown'),
    kind: String(record.kind ?? fallbackKind),
    title: String(record.title ?? record.claim ?? record.question ?? record.summary ?? record.id ?? record.path ?? 'Untitled'),
    status: String(record.status ?? record.currency ?? record.verdict ?? 'unverified'),
    path: record.path ?? record.source_path ?? record.canonical_pointer ?? null,
    answers_question: record.answers_question ?? record.question ?? null,
    updated_at: record.updated_at ?? record.recorded_at ?? record.approved_at ?? record.created_at ?? null,
  }
}

function bounded(records, kind, limit) {
  const normalized = records.map((record) => stableRecord(record, kind)).sort((left, right) => {
    const time = String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''))
    return time || left.id.localeCompare(right.id)
  })
  return { items: normalized.slice(0, limit), total: normalized.length, omitted: Math.max(0, normalized.length - limit) }
}

function deadEnds(research) {
  const rows = []
  for (const packet of research) {
    for (const [index, deadEnd] of (packet.dead_ends ?? packet.coverage?.dead_ends ?? []).entries()) {
      const value = typeof deadEnd === 'string' ? deadEnd : deadEnd.finding ?? deadEnd.summary ?? JSON.stringify(deadEnd)
      rows.push({
        id: `${packet.id ?? packet.research_id ?? 'research'}:dead-end:${index + 1}`,
        kind: 'research-dead-end',
        title: value,
        status: 'known-dead-end',
        path: packet.path ?? packet.source_path ?? null,
      })
    }
    for (const [index, gap] of (packet.coverage_gaps ?? packet.coverage?.gaps ?? []).entries()) {
      const value = typeof gap === 'string' ? gap : gap.question ?? gap.summary ?? JSON.stringify(gap)
      rows.push({
        id: `${packet.id ?? packet.research_id ?? 'research'}:gap:${index + 1}`,
        kind: 'research-gap',
        title: value,
        status: 'unresolved',
        path: packet.path ?? packet.source_path ?? null,
      })
    }
  }
  return rows
}

export function composeKnowledgeOnboarding(input, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : DEFAULT_LIMIT
  const documents = input.documents ?? []
  const decisions = input.decisions ?? []
  const proofs = input.proofs ?? []
  const runs = input.runs ?? []
  const research = input.research ?? []
  const memories = input.memories ?? []
  const capabilities = input.capabilities ?? []
  const resumes = input.resumes ?? []
  const receipts = input.receipts ?? []

  const currentDocuments = documents.filter((document) => document.status === 'current' || document.structural_status === 'current')
  const currentDecisions = decisions.filter((decision) => !['superseded', 'rejected'].includes(decision.status))
  const currentProofs = proofs.filter((proof) => ['proven', 'verified', 'live_observed', 'code_tested'].includes(proof.status))
  const staleProofs = proofs.filter((proof) => ['stale', 'needs_review', 'expired', 'contradicted'].includes(proof.status))
  const unresolvedRuns = runs.filter((run) => ['blocked', 'failed', 'partial'].includes(run.status ?? run.verdict) || (run.open_questions ?? []).length > 0)
  const forgotten = [...deadEnds(research), ...staleProofs, ...unresolvedRuns]

  const sections = {
    docs: bounded(currentDocuments, 'document', limit),
    decisions: bounded(currentDecisions, 'decision', limit),
    proofs: bounded(currentProofs, 'proof', limit),
    runs: bounded(runs, 'run', limit),
    research: bounded(research, 'research', limit),
    memory: bounded(memories, 'memory', limit),
    forgotten: bounded(forgotten, 'anti-amnesia', limit),
    capabilities: bounded(capabilities, 'capability', limit),
    resume: bounded(resumes, 'resume', limit),
    receipts: bounded(receipts, 'receipt', limit),
  }
  const payload = {
    schema_version: 1,
    generator: 'siso-project-os/knowledge-onboarding.v1',
    limit,
    sections,
  }
  return { ...payload, input_digest: sha256(JSON.stringify(payload)) }
}

function cards(section) {
  if (section.items.length === 0) return '<p class="empty">No matching authored records.</p>'
  return `<ul>${section.items.map((item) => `<li><strong>${htmlEscape(item.title)}</strong><span>${htmlEscape(item.kind)} · ${htmlEscape(item.status)}${item.path ? ` · <code>${htmlEscape(item.path)}</code>` : ''}</span></li>`).join('')}</ul>${section.omitted ? `<p class="bounded">${section.omitted} more records are available in canonical storage.</p>` : ''}`
}

export function renderKnowledgeOnboardingHtml(model) {
  const state = JSON.stringify(model).replace(/</g, '\\u003c')
  const contracts = [
    ['already-known', 'Already known', ['docs', 'decisions', 'proofs', 'memory']],
    ['anti-amnesia', 'Forgotten, stale, or unresolved', ['forgotten', 'research', 'runs']],
    ['capability-routes', 'Capability routes', ['capabilities']],
    ['resume-history', 'Resume history', ['resume']],
    ['verifier-landing', 'Verifier and landing receipts', ['receipts']],
  ]
  const sections = contracts.map(([contract, title, keys]) => `<section data-contract="${contract}"><h2>${title}</h2>${keys.map((key) => `<div class="group"><h3>${htmlEscape(key)} <small>${model.sections[key].total}</small></h3>${cards(model.sections[key])}</div>`).join('')}</section>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project knowledge and capability map</title><style>:root{font-family:system-ui;color:#16202a;background:#f6f8fb}body{margin:0}main{width:min(76rem,calc(100% - 2rem));margin:auto;padding:2rem 0 4rem}header,section{background:#fff;border:1px solid #dce2ea;border-radius:1rem;padding:1.2rem;margin:1rem 0}section{display:grid;grid-template-columns:minmax(13rem,.35fr) 1fr;gap:1rem}section h2{margin:0}.group{min-width:0}.group h3{margin:.1rem 0 .5rem;text-transform:capitalize}small,.empty,.bounded,li span{color:#5f6b78;font-weight:400}ul{display:grid;gap:.5rem;list-style:none;margin:0;padding:0}li{display:grid;gap:.15rem;border-left:3px solid #8da2bd;padding:.35rem .7rem}code{overflow-wrap:anywhere}@media(max-width:42rem){main{width:min(100% - 1rem,76rem);padding-top:.5rem}section{grid-template-columns:1fr}}</style></head><body><main><header data-contract="joined-onboarding"><p>Generated, read-only projection</p><h1>Knowledge, capabilities, and recovery</h1><p>Follow links back to authored records. This page never becomes a writer.</p></header>${sections}</main><script id="project-os-joined-state" type="application/json">${state}</script><script>window.__verify=Object.freeze({version:'project-os-joined-onboarding.v1',contracts:${JSON.stringify(contracts.map(([contract]) => contract))},inputDigest:${JSON.stringify(model.input_digest)},check(){return this.contracts.every((name)=>document.querySelector('[data-contract="'+name+'"]'))&&Boolean(document.querySelector('#project-os-joined-state'))}})</script></body></html>`
}
