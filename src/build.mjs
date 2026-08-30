import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { listDirectories, pathExists, readJson, walkFiles, writeJsonAtomic } from './shared.mjs'
import { scanTasks } from './work.mjs'
import { renderOnboardingHtml } from './console.mjs'
import { architectureSnapshot } from './architecture.mjs'
import { discoverProjectCapabilities } from './capabilities.mjs'
import { composeKnowledgeOnboarding, renderKnowledgeOnboardingHtml } from './knowledge-onboarding.mjs'
import { readCapabilityCoverage, renderCapabilityCoverageHtml } from './provenance.mjs'
import { expectedUiCampaignProjections } from './ui-projections.mjs'
import { expectedFleetBuild } from './fleet.mjs'
import { PROJECT_OS_VERSION } from './version.mjs'

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceCommit(root) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

async function readRecords(base, fileName) {
  const records = []
  for (const id of await listDirectories(base)) {
    const path = join(base, id, fileName)
    if (!(await pathExists(path))) continue
    try {
      records.push(await readJson(path))
    } catch {
      records.push({ id, invalid: true, path })
    }
  }
  return records.sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

async function readJsonLines(path) {
  if (!(await pathExists(path))) return []
  const records = []
  for (const [index, line] of (await readFile(path, 'utf8')).split('\n').entries()) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      records.push({ id: `invalid-line-${index + 1}`, status: 'invalid', path: `${path}:${index + 1}` })
    }
  }
  return records
}

async function readJsonTree(root, relativeRoot, predicate = () => true) {
  const base = join(root, relativeRoot)
  const records = []
  for (const file of (await walkFiles(base)).filter((path) => path.endsWith('.json') && predicate(path))) {
    try {
      records.push({ ...(await readJson(join(base, file))), path: `${relativeRoot}/${file}` })
    } catch {
      records.push({ id: file, status: 'invalid', path: `${relativeRoot}/${file}` })
    }
  }
  return records
}

async function knowledgeModel(root, snapshot, capabilities) {
  const documents = snapshot.docs.map((document) => ({ ...document, ...(document.metadata ?? {}) }))
  const decisions = await readJsonLines(join(root, 'docs', 'ledgers', 'decisions.jsonl'))
  const proofs = await readJsonLines(join(root, 'docs', 'ledgers', 'proofs.jsonl'))
  const runDiscoveries = await readJsonLines(join(root, 'docs', 'ledgers', 'runs.jsonl'))
  const research = await readJsonTree(root, 'docs/research', (path) => path.endsWith('/packet.json'))
  const memories = await readJsonTree(root, '.agents/memory')
  const resumes = await readJsonTree(root, '.agents/briefs/snapshots', (path) => path.endsWith('.snapshot.json'))
  const receipts = [
    ...await readJsonTree(root, '.agents/runs', (path) => /(?:attempt|verification)\.receipt\.json$/.test(path) || /\/result\.json$/.test(path)),
    ...await readJsonTree(root, '.agents/delivery', (path) => path.endsWith('landing.receipt.json')),
  ]
  return composeKnowledgeOnboarding({
    documents,
    decisions,
    proofs,
    runs: [...snapshot.runs, ...runDiscoveries],
    research,
    memories,
    capabilities: capabilities.items,
    resumes,
    receipts,
  })
}

function renderCapabilityInventoryHtml(inventory) {
  const rows = inventory.items.map((item) => `<tr><td>${htmlEscape(item.kind)}</td><td>${htmlEscape(item.id)}</td><td>${htmlEscape(item.engine)}</td><td><code>${htmlEscape(item.path)}</code></td></tr>`).join('')
  const state = JSON.stringify(inventory).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project capability inventory</title><style>body{font:15px/1.5 system-ui;max-width:72rem;margin:auto;padding:2rem}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #ccd4df;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}@media(max-width:42rem){body{padding:.5rem}table,tbody,tr,th,td{display:block}th,td{border:0;padding:.15rem 0}tr{padding:.7rem 0}}</style></head><body><main data-contract="capability-inventory"><h1>Project capability inventory</h1><p>Generated discovery projection. Canonical capability definitions remain at the listed paths.</p><table><thead><tr><th>Kind</th><th>ID</th><th>Engine</th><th>Path</th></tr></thead><tbody>${rows}</tbody></table></main><script id="project-os-capability-inventory" type="application/json">${state}</script></body></html>`
}

function renderArchitectureHtml(snapshot) {
  const rows = [...snapshot.required.map((item) => ({ kind: 'required', ...item })), ...snapshot.operations.map((item) => ({ kind: 'operation', ...item }))]
    .map((item) => `<tr><td>${htmlEscape(item.kind)}</td><td><code>${htmlEscape(item.path)}</code></td><td>${item.exists ? 'present' : 'missing'}</td></tr>`).join('')
  const state = JSON.stringify(snapshot).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project architecture profile</title><style>body{font:15px/1.5 system-ui;max-width:68rem;margin:auto;padding:2rem}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #ccd4df;text-align:left}@media(max-width:42rem){body{padding:.5rem}}</style></head><body><main data-contract="architecture-profile"><h1>Architecture score ${snapshot.score}/100</h1><p>Generated non-regression view. The profile and baseline JSON remain canonical.</p><table><thead><tr><th>Kind</th><th>Path</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></main><script id="project-os-architecture" type="application/json">${state}</script></body></html>`
}

async function docsSnapshot(root) {
  const docsRoot = join(root, 'docs')
  const files = (await walkFiles(docsRoot)).filter((file) => ['.md', '.html'].includes(extname(file)))
  return Promise.all(files.map(async (file) => {
    const content = await readFile(join(docsRoot, file), 'utf8')
    const markdownTitle = content.match(/^#\s+(.+)$/m)?.[1]
    const htmlTitle = content.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
    const metadataMatch = content.match(/<!-- project-os-meta\s*\n([\s\S]*?)\n-->/)
    let metadata = null
    let metadataError = null
    if (metadataMatch) {
      try {
        metadata = JSON.parse(metadataMatch[1])
      } catch (error) {
        metadataError = error.message
      }
    }
    return {
      path: `docs/${file}`,
      title: metadata?.title || markdownTitle || htmlTitle || basename(file),
      structural_status: metadata?.status ?? 'unverified',
      content_sha256: sha256(content),
      metadata,
      ...(metadataError ? { metadata_error: metadataError } : {}),
    }
  })).then((docs) => docs.sort((left, right) => left.path.localeCompare(right.path)))
}

export async function docsCorpus(root) {
  const documents = await docsSnapshot(root)
  const inputs = documents.map((document) => ({ path: document.path, sha256: document.content_sha256 }))
  const inputDigest = sha256(JSON.stringify(inputs))
  const payload = {
    schema_version: 1,
    generator: `siso-project-os@${PROJECT_OS_VERSION}/docs-corpus`,
    source_commit: sourceCommit(root),
    inputs,
    input_digest: inputDigest,
    documents,
  }
  return { ...payload, output_digest: sha256(JSON.stringify(payload)) }
}

export async function projectSnapshot(root) {
  const project = await readJson(join(root, '.project-os', 'project.json'))
  const taskEntries = await scanTasks(root)
  const tasks = taskEntries.map((entry) => ({
    id: entry.task?.id ?? entry.name,
    title: entry.task?.title ?? null,
    status: entry.task?.status ?? null,
    priority: entry.task?.priority ?? null,
    domain: entry.task?.domain ?? null,
    owner: entry.task?.owner ?? null,
    dependencies: entry.task?.dependencies ?? [],
    requires_human: entry.task?.requires_human ?? false,
    human_gate_reason: entry.task?.human_gate_reason ?? null,
    blocker: entry.task?.blocker ?? null,
    folder: entry.folder,
    path: `.agents/tasks/${entry.folder}/${entry.name}/task.json`,
    invalid: Boolean(entry.parseError),
  }))
  const sprints = await readRecords(join(root, '.agents', 'sprints'), 'sprint.json')
  const runs = await readRecords(join(root, '.agents', 'runs'), 'run.json')
  const campaigns = await readRecords(join(root, '.uihub', 'campaigns'), 'campaign.json')
  const docs = await docsSnapshot(root)
  const payload = {
    schema_version: 1,
    source: 'siso-project-os',
    project_name: project.project_name,
    project_summary: project.project_summary,
    desired_outcome: project.desired_outcome,
    tasks,
    sprints,
    runs,
    campaigns,
    docs,
    counts: {
      tasks: tasks.length,
      sprints: sprints.length,
      runs: runs.length,
      campaigns: campaigns.length,
      docs: docs.length,
    },
  }
  const generation = {
    generator: `siso-project-os@${PROJECT_OS_VERSION}/project-index`,
    source_commit: sourceCommit(root),
    input_digest: sha256(JSON.stringify(payload)),
  }
  return { ...payload, generation: { ...generation, output_digest: sha256(JSON.stringify({ payload, generation })) } }
}

export function renderProjectHtml(snapshot) {
  const taskRows = snapshot.tasks.map((task) => `<tr><td>${htmlEscape(task.id)}</td><td>${htmlEscape(task.title ?? '')}</td><td>${htmlEscape(task.status ?? 'invalid')}</td><td>${htmlEscape(task.domain ?? '')}</td></tr>`).join('')
  const campaignRows = snapshot.campaigns.map((campaign) => `<tr><td>${htmlEscape(campaign.id)}</td><td>${htmlEscape(campaign.task_id ?? '')}</td><td>${htmlEscape(campaign.stage ?? 'invalid')}</td></tr>`).join('')
  const payload = `<!doctype html><meta charset="utf-8"><meta name="generator" content="${htmlEscape(snapshot.generation.generator)}"><meta name="project-os-source-commit" content="${htmlEscape(snapshot.generation.source_commit ?? '')}"><meta name="project-os-input-digest" content="${htmlEscape(snapshot.generation.input_digest)}"><title>Project OS Index</title>
<style>body{font:14px/1.5 system-ui;max-width:1000px;margin:32px auto;padding:0 20px;color:#20242b}table{border-collapse:collapse;width:100%;margin-bottom:28px}th,td{text-align:left;border-bottom:1px solid #ddd;padding:6px}code{background:#f2f4f7;padding:2px 4px}</style>
<h1>Project OS Index</h1><p>Generated projection. Canonical writers remain under <code>.agents/</code>, <code>docs/</code>, and <code>.uihub/campaigns/</code>.</p>
<h2>Tasks (${snapshot.counts.tasks})</h2><table><tr><th>ID</th><th>Title</th><th>Status</th><th>Domain</th></tr>${taskRows}</table>
<h2>UI campaigns (${snapshot.counts.campaigns})</h2><table><tr><th>ID</th><th>Task</th><th>Stage</th></tr>${campaignRows}</table>
<h2>Other records</h2><ul><li>Sprints: ${snapshot.counts.sprints}</li><li>Runs: ${snapshot.counts.runs}</li><li>Docs: ${snapshot.counts.docs}</li></ul>`
  return payload.replace('<title>', `<meta name="project-os-output-digest" content="${sha256(payload)}"><title>`)
}

export async function expectedBuild(root) {
  const snapshot = await projectSnapshot(root)
  const corpus = await docsCorpus(root)
  const capabilities = await discoverProjectCapabilities(root)
  const knowledge = await knowledgeModel(root, snapshot, capabilities)
  const coverage = await readCapabilityCoverage(root)
  const architecture = await architectureSnapshot(root)
  const outputs = {
    '.project-os/generated/project-index.json': `${JSON.stringify(snapshot, null, 2)}\n`,
    '.project-os/generated/project-index.html': `${renderProjectHtml(snapshot)}\n`,
    '.project-os/generated/onboarding.html': `${renderOnboardingHtml(snapshot)}\n`,
    '.project-os/generated/docs-corpus.json': `${JSON.stringify(corpus, null, 2)}\n`,
    '.project-os/generated/capabilities.json': `${JSON.stringify(capabilities, null, 2)}\n`,
    '.project-os/generated/capabilities.html': `${renderCapabilityInventoryHtml(capabilities)}\n`,
    '.project-os/generated/capability-coverage.html': `${renderCapabilityCoverageHtml(coverage)}\n`,
    '.project-os/generated/knowledge-onboarding.json': `${JSON.stringify(knowledge, null, 2)}\n`,
    '.project-os/generated/knowledge-onboarding.html': `${renderKnowledgeOnboardingHtml(knowledge)}\n`,
    '.project-os/generated/architecture.json': `${JSON.stringify(architecture, null, 2)}\n`,
    '.project-os/generated/architecture.html': `${renderArchitectureHtml(architecture)}\n`,
  }
  for (const campaign of snapshot.campaigns) {
    if (!campaign.invalid && typeof campaign.candidate_manifest === 'string' && campaign.candidate_manifest) {
      Object.assign(outputs, await expectedUiCampaignProjections(root, campaign.id))
    }
  }
  Object.assign(outputs, await expectedFleetBuild(root))
  return outputs
}

export async function buildProject(root) {
  const outputs = await expectedBuild(root)
  for (const [relativePath, content] of Object.entries(outputs)) {
    if (relativePath.endsWith('.json')) await writeJsonAtomic(join(root, relativePath), JSON.parse(content))
    else {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const path = join(root, relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
    }
  }
  return outputs
}
