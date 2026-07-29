import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REQUIRED_COVERAGE_AREAS = Object.freeze([
  'boot-routing',
  'runtime-boundary',
  'capability-discovery',
  'specialist-roles',
  'task-lifecycle',
  'run-coordination',
  'resume-and-mission',
  'documentation-routing',
  'repo-facts',
  'edit-maps',
  'decisions',
  'proof-currency',
  'prior-run-discovery',
  'research-and-dead-ends',
  'anti-amnesia',
  'durable-memory',
  'ui-campaigns',
  'verification-and-landing',
  'archive',
  'timeline',
  'security-playbooks',
  'fleet-runtime',
  'code-context',
  'external-adapters',
])

const DISPOSITIONS = new Set(['install', 'depend', 'project_local', 'adapter', 'omit'])
const PRIVATE_MARKERS = [
  /\/(?:Users|home)\//i,
  /(?:password|secret|token|credential)[=:]\s*[^\s]/i,
  /customer[_ -]?(?:name|email|id)/i,
]

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]))
}

export function capabilityCoverageProblems(contract) {
  const problems = []
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['coverage contract must be an object']
  if (contract.schema_version !== 1) problems.push('schema_version must be 1')
  if (contract.source_scope !== 'sanitized-protected-evidence') problems.push('source_scope must be sanitized-protected-evidence')
  if (!Array.isArray(contract.areas)) return [...problems, 'areas must be an array']

  const byId = new Map()
  for (const [index, area] of contract.areas.entries()) {
    const prefix = `areas[${index}]`
    if (!area || typeof area !== 'object' || Array.isArray(area)) {
      problems.push(`${prefix} must be an object`)
      continue
    }
    if (typeof area.id !== 'string' || !area.id) problems.push(`${prefix}.id is required`)
    else {
      if (byId.has(area.id)) problems.push(`duplicate coverage area ${area.id}`)
      byId.set(area.id, area)
    }
    if (!DISPOSITIONS.has(area.disposition)) problems.push(`${prefix}.disposition is uncategorized: ${area.disposition ?? 'missing'}`)
    if (typeof area.concern !== 'string' || !area.concern.trim()) problems.push(`${prefix}.concern is required`)
    if (area.disposition === 'install' && (!Array.isArray(area.public_surfaces) || area.public_surfaces.length === 0)) {
      problems.push(`${area.id ?? prefix} install disposition requires public_surfaces`)
    }
    if (area.disposition === 'depend' && (!Array.isArray(area.runtime_routes) || area.runtime_routes.length === 0)) {
      problems.push(`${area.id ?? prefix} depend disposition requires runtime_routes`)
    }
    if (['project_local', 'adapter', 'omit'].includes(area.disposition) && (typeof area.boundary !== 'string' || !area.boundary.trim())) {
      problems.push(`${area.id ?? prefix} ${area.disposition} disposition requires a boundary`)
    }
  }

  for (const id of REQUIRED_COVERAGE_AREAS) if (!byId.has(id)) problems.push(`missing required coverage area ${id}`)
  for (const id of byId.keys()) if (!REQUIRED_COVERAGE_AREAS.includes(id)) problems.push(`unknown coverage area ${id}`)

  const serialized = JSON.stringify(contract)
  for (const marker of PRIVATE_MARKERS) if (marker.test(serialized)) problems.push(`public coverage contains private marker ${marker}`)
  return problems
}

export async function readCapabilityCoverage(root) {
  return JSON.parse(await readFile(join(root, 'docs', 'capability-coverage.json'), 'utf8'))
}

export function renderCapabilityCoverageHtml(contract) {
  const problems = capabilityCoverageProblems(contract)
  if (problems.length > 0) throw new Error(`invalid capability coverage:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  const rows = [...contract.areas]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((area) => `<tr data-area-id="${htmlEscape(area.id)}" data-disposition="${htmlEscape(area.disposition)}"><th scope="row">${htmlEscape(area.concern)}</th><td><code>${htmlEscape(area.disposition)}</code></td><td>${htmlEscape(area.boundary ?? (area.public_surfaces ?? []).join(', '))}</td></tr>`)
    .join('')
  const state = JSON.stringify({ schema_version: 1, area_count: contract.areas.length, uncategorized: 0 }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project capability coverage</title><style>body{font:15px/1.5 system-ui;max-width:72rem;margin:0 auto;padding:2rem;color:#17202a}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d8dee6;padding:.7rem;text-align:left;vertical-align:top}code{font-weight:700}@media(max-width:42rem){table,tbody,tr,th,td{display:block}tr{padding:.75rem 0}th,td{border:0;padding:.2rem 0}}</style></head><body><main data-contract="capability-coverage"><h1>Project capability coverage</h1><p>Sanitized disposition contract. Source-specific evidence remains outside the public package.</p><table><thead><tr><th>Concern</th><th>Disposition</th><th>Boundary or public surface</th></tr></thead><tbody>${rows}</tbody></table></main><script id="project-os-capability-coverage" type="application/json">${state}</script></body></html>`
}
