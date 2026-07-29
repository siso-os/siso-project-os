import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildExtractionLedger, extractionLedgerProblems } from '../src/extraction-ledger.mjs'
import { composeKnowledgeOnboarding, renderKnowledgeOnboardingHtml } from '../src/knowledge-onboarding.mjs'
import { capabilityCoverageProblems, readCapabilityCoverage, renderCapabilityCoverageHtml } from '../src/provenance.mjs'
import { validateSchema } from '../src/schema.mjs'
import { walkFiles } from '../src/shared.mjs'
import { decisionFromUiReview, uiCampaignCompletionProblems, uiRecordDigest } from '../src/ui-contracts.mjs'
import { expectedUiCampaignProjections } from '../src/ui-projections.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(repoRoot, 'bin', 'siso-project-os.mjs')

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  assert.equal(result.status, expected, `unexpected exit for ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-docs-ui-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  run(['init', root, '--name', 'Docs UI fixture'])
  return root
}

test('HTML-first authored surfaces expose embedded machine contracts', async () => {
  const paths = [
    'docs/onboarding.html',
    'docs/knowledge-spine.html',
    'docs/provenance.html',
    'docs/ui-loop.html',
    'template/PROJECT-OS.html',
    'template/docs/project-os/ONBOARDING.html',
    'template/docs/spine/REPO-FACTS.html',
    'template/docs/spine/EDIT-MAPS.html',
    'template/.uihub/README.html',
  ]
  for (const path of paths) {
    assert.equal(path.endsWith('.md'), false)
    const content = await readFile(join(repoRoot, path), 'utf8')
    assert.match(content, /<!doctype html>/i)
    assert.match(content, /type="application\/json"/)
  }

  const agents = await readFile(join(repoRoot, 'template', 'AGENTS.md'), 'utf8')
  assert.match(agents, /PROJECT-OS\.html/)
  assert.match(agents, /docs\/project-os\/ONBOARDING\.html/)
  assert.match(agents, /\.uihub\/README\.html/)
  assert.doesNotMatch(agents, /PROJECT-OS\.md|\.uihub\/README\.md/)

  const ownedTemplateMarkdown = [
    ...(await walkFiles(join(repoRoot, 'template', 'docs'))),
    ...(await walkFiles(join(repoRoot, 'template', '.uihub'))),
  ].filter((path) => path.endsWith('.md'))
  assert.deepEqual(ownedTemplateMarkdown, [])

  const schema = JSON.parse(await readFile(join(repoRoot, 'schemas', 'document.schema.json'), 'utf8'))
  for (const path of ['template/docs/project-os/ONBOARDING.html', 'template/docs/spine/REPO-FACTS.html', 'template/docs/spine/EDIT-MAPS.html']) {
    const content = await readFile(join(repoRoot, path), 'utf8')
    const metadata = JSON.parse(content.match(/<!-- project-os-meta\s*\n([\s\S]*?)\n-->/)[1])
    assert.deepEqual(validateSchema(metadata, schema), [])
    assert.equal(metadata.path, path.replace(/^template\//, ''))
  }
})

test('public capability coverage is exhaustive, sanitized, and deterministic', async () => {
  const contract = await readCapabilityCoverage(repoRoot)
  assert.deepEqual(capabilityCoverageProblems(contract), [])
  assert.equal(contract.areas.length, 24)
  const first = renderCapabilityCoverageHtml(contract)
  const second = renderCapabilityCoverageHtml(contract)
  assert.equal(first, second)
  assert.match(first, /data-contract="capability-coverage"/)
  assert.match(first, /"uncategorized":0/)
  const serialized = JSON.stringify(contract)
  assert.doesNotMatch(serialized, /\/(?:Users|home)\//)
  assert.doesNotMatch(serialized, /source_revision|tracked_manifest_digest|"files"/)

  const broken = structuredClone(contract)
  broken.areas.pop()
  assert.ok(capabilityCoverageProblems(broken).some((problem) => problem.startsWith('missing required coverage area')))
})

test('private extraction ledger accounts for every tracked path exactly once', () => {
  const input = {
    source: 'private-source-root',
    source_revision: 'a'.repeat(40),
    requested_scopes: ['docs', '.agents/.uihub'],
    actual_scopes: ['docs', '.uihub'],
    tracked_files: [
      { path: 'docs/spine/INDEX.html', blob: '1'.repeat(40), mode: '100644', stage: 0 },
      { path: 'docs/runs/proof.json', blob: '2'.repeat(40), mode: '100644', stage: 0 },
      { path: '.uihub/gallery.html', blob: '3'.repeat(40), mode: '100644', stage: 0 },
    ],
    clusters: [
      { id: 'spine', pattern: '^docs/spine/', disposition: 'install', rationale: 'generic contract' },
      { id: 'runs', pattern: '^docs/runs/', disposition: 'project_local', rationale: 'private evidence' },
      { id: 'ui', pattern: '^\\.uihub/', disposition: 'omit', rationale: 'source artifacts' },
    ],
  }
  const ledger = buildExtractionLedger(input)
  assert.deepEqual(extractionLedgerProblems(ledger), [])
  assert.equal(ledger.complete, true)
  assert.equal(ledger.clusters.reduce((sum, cluster) => sum + cluster.file_count, 0), 3)
  assert.match(ledger.ledger_digest, /^[a-f0-9]{64}$/)

  const incomplete = buildExtractionLedger({ ...input, clusters: input.clusters.slice(0, 2) })
  assert.ok(extractionLedgerProblems(incomplete).some((problem) => problem.includes('uncategorized')))
})

test('joined knowledge onboarding is bounded, deterministic, and recovery-oriented', () => {
  const input = {
    documents: [
      { document_id: 'doc-b', title: 'B', status: 'current', path: 'docs/domains/b.html' },
      { document_id: 'doc-a', title: 'A', status: 'current', path: 'docs/domains/a.html' },
    ],
    decisions: [{ id: 'DEC-1', title: 'Choose A', status: 'accepted', path: 'docs/decisions/DEC-1.html' }],
    proofs: [
      { claim_id: 'CLAIM-1', claim: 'Observed', status: 'proven', source_path: 'docs/ledgers/proofs.jsonl' },
      { claim_id: 'CLAIM-2', claim: 'Recheck', status: 'needs_review', source_path: 'docs/ledgers/proofs.jsonl' },
    ],
    research: [{ id: 'RES-1', question: 'Prior attempt', dead_ends: ['Known dead end'], coverage_gaps: ['Still unknown'] }],
    runs: [{ id: 'RUN-1', title: 'Blocked attempt', status: 'blocked' }],
    memories: [{ id: 'MEM-1', title: 'Durable lesson', status: 'current' }],
    capabilities: [{ id: 'CAP-1', title: 'UI verifier', status: 'available' }],
    resumes: [{ id: 'RESUME-1', title: 'Current mission', status: 'active', updated_at: '2026-07-29T00:00:00Z' }],
    receipts: [{ id: 'RCP-1', title: 'Independent verdict', verdict: 'pass' }],
  }
  const first = composeKnowledgeOnboarding(input, { limit: 1 })
  const second = composeKnowledgeOnboarding(input, { limit: 1 })
  assert.deepEqual(first, second)
  assert.equal(first.sections.docs.items.length, 1)
  assert.equal(first.sections.docs.omitted, 1)
  assert.ok(first.sections.forgotten.total >= 3)
  const html = renderKnowledgeOnboardingHtml(first)
  assert.equal(html, renderKnowledgeOnboardingHtml(second))
  for (const contract of ['already-known', 'anti-amnesia', 'capability-routes', 'resume-history', 'verifier-landing']) assert.match(html, new RegExp(`data-contract="${contract}"`))
  assert.match(html, /window\.__verify=Object\.freeze/)
})

test('strict UI campaign rejects stale linkage, renders deterministically, and folds proof by stable task evidence filename', async (t) => {
  const root = await project(t)
  const task = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Settings outcome', '--json']).stdout)
  const campaign = JSON.parse(run(['ui', 'create', '--root', root, '--task', task.id, '--title', 'Settings campaign', '--surface', 'settings', '--json']).stdout)
  const campaignRoot = join(root, '.uihub', 'campaigns', campaign.id)
  const researchPath = `.uihub/campaigns/${campaign.id}/research/findings.html`
  await writeFile(join(root, researchPath), '<!doctype html><title>Research</title>\n', 'utf8')

  for (const id of ['DIR-A', 'DIR-B']) {
    const direction = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'direction.json'), 'utf8'))
    direction.id = id
    direction.campaign_id = campaign.id
    direction.task_id = task.id
    await writeFile(join(campaignRoot, 'directions', `${id}.json`), `${JSON.stringify(direction, null, 2)}\n`, 'utf8')
  }
  for (const id of ['CAN-A', 'CAN-B']) {
    const directory = join(campaignRoot, 'candidates', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.html'), `<!doctype html><title>${id}</title>\n`, 'utf8')
  }
  const manifestPath = `.uihub/campaigns/${campaign.id}/candidates/manifest.json`
  const manifest = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'candidate-manifest.json'), 'utf8'))
  manifest.campaign_id = campaign.id
  manifest.task_id = task.id
  manifest.source_revision = 'aaaaaaa'
  for (const candidate of manifest.candidates) candidate.artifact.path = `.uihub/campaigns/${campaign.id}/candidates/${candidate.id}/index.html`
  await writeFile(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'research', '--research', researchPath])
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'directions', '--directions', 'DIR-A,DIR-B'])
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'candidates', '--candidates', 'CAN-A,CAN-B', '--manifest', manifestPath])

  const projectionsA = await expectedUiCampaignProjections(root, campaign.id)
  const projectionsB = await expectedUiCampaignProjections(root, campaign.id)
  assert.deepEqual(projectionsA, projectionsB)
  assert.match(projectionsA[`.uihub/generated/${campaign.id}/gallery.html`], /data-contract="ui-candidates"/)
  assert.match(projectionsA[`.uihub/generated/${campaign.id}/review.html`], /data-contract="ui-review-form"/)

  const reviewPath = `.uihub/campaigns/${campaign.id}/review/response.json`
  const response = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'review-response.json'), 'utf8'))
  response.campaign_id = campaign.id
  response.task_id = task.id
  response.candidate_manifest = manifestPath
  response.candidate_manifest_sha256 = uiRecordDigest(manifest)
  response.reviewer = { name: 'Reviewer', role: 'owner' }
  response.recorded_at = '2026-07-29T00:00:00Z'
  response.rationale = 'Direction A best serves the declared job.'
  await writeFile(join(root, reviewPath), `${JSON.stringify(response, null, 2)}\n`, 'utf8')
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'review', '--review', reviewPath])

  const decisionPath = `.uihub/campaigns/${campaign.id}/decided/decision.json`
  const reviewedCampaign = JSON.parse(await readFile(join(campaignRoot, 'campaign.json'), 'utf8'))
  const decision = decisionFromUiReview({
    campaign: reviewedCampaign,
    manifest,
    response,
    decision_id: `DEC-${campaign.id}-001`,
    response_path: reviewPath,
    implementation_target: {
      surface: 'settings',
      paths: ['src/path/to/surface'],
      acceptance: ['The chosen settings direction is observable.'],
    },
  })
  await writeFile(join(root, decisionPath), `${JSON.stringify(decision, null, 2)}\n`, 'utf8')
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'decided', '--decision', decisionPath])

  await mkdir(join(root, 'src', 'path', 'to'), { recursive: true })
  await writeFile(join(root, 'src', 'path', 'to', 'surface'), 'fixture\n', 'utf8')
  await writeFile(join(root, 'src', 'settings.js'), 'export {}\n', 'utf8')
  const implementationPath = `.uihub/campaigns/${campaign.id}/implemented/receipt.json`
  const implementation = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'implementation-receipt.json'), 'utf8'))
  implementation.id = `RCP-${campaign.id}-IMPLEMENTATION`
  implementation.campaign_id = campaign.id
  implementation.task_id = task.id
  implementation.verdict = 'pass'
  implementation.implementation.source_commit = 'aaaaaaa'
  implementation.implementation.changed_files = ['src/settings.js']
  implementation.implementation.checks[0].verdict = 'pass'
  implementation.implementation.unresolved = []
  await writeFile(join(root, implementationPath), `${JSON.stringify(implementation, null, 2)}\n`, 'utf8')
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'implemented', '--receipt', implementationPath])

  const verificationPath = `.uihub/campaigns/${campaign.id}/verified/receipt.json`
  const verification = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'verification-receipt.json'), 'utf8'))
  verification.id = `RCP-${campaign.id}-VERIFICATION`
  verification.campaign_id = campaign.id
  verification.task_id = task.id
  verification.verdict = 'pass'
  verification.verification.source_commit = 'bbbbbbb'
  verification.verification.checks[0].verdict = 'pass'
  verification.verification.visual_evidence[0].path = `.uihub/campaigns/${campaign.id}/verified/proof.png`
  await writeFile(join(campaignRoot, 'verified', 'proof.png'), 'fixture\n', 'utf8')
  await writeFile(join(root, verificationPath), `${JSON.stringify(verification, null, 2)}\n`, 'utf8')

  const foldPath = `.uihub/campaigns/${campaign.id}/verified/task-evidence.json`
  const fold = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'task-evidence.json'), 'utf8'))
  fold.id = `FOLD-${campaign.id}-VERIFIED`
  fold.campaign_id = campaign.id
  fold.task_id = task.id
  fold.decision_record = decisionPath
  fold.implementation_receipt = implementationPath
  fold.verification_receipt = verificationPath
  fold.source_commit = 'aaaaaaa'
  fold.task_evidence_file = `${campaign.id}-verified.json`
  const taskEvidence = join(root, '.agents', 'tasks', 'backlog', task.id, 'evidence', fold.task_evidence_file)
  await writeFile(taskEvidence, `${JSON.stringify({ campaign_id: campaign.id, verdict: 'verified' }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, foldPath), `${JSON.stringify(fold, null, 2)}\n`, 'utf8')

  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'verified', '--receipt', verificationPath, '--fold', foldPath], 1)
  verification.verification.source_commit = 'aaaaaaa'
  await writeFile(join(root, verificationPath), `${JSON.stringify(verification, null, 2)}\n`, 'utf8')
  const verified = JSON.parse(run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'verified', '--receipt', verificationPath, '--fold', foldPath, '--json']).stdout)
  assert.deepEqual(await uiCampaignCompletionProblems(root, verified), [])

  const missingFold = { ...verified }
  delete missingFold.task_evidence_receipt
  assert.ok((await uiCampaignCompletionProblems(root, missingFold)).some((problem) => problem.includes('missing task evidence receipt pointer')))

  const oldTaskDirectory = join(root, '.agents', 'tasks', 'backlog', task.id)
  const movedTaskDirectory = join(root, '.agents', 'tasks', 'in_progress', task.id)
  await rename(oldTaskDirectory, movedTaskDirectory)
  const movedTask = JSON.parse(await readFile(join(movedTaskDirectory, 'task.json'), 'utf8'))
  movedTask.status = 'in_progress'
  movedTask.owner = 'test'
  movedTask.claimed_at = '2026-07-29T00:00:00Z'
  await writeFile(join(movedTaskDirectory, 'task.json'), `${JSON.stringify(movedTask, null, 2)}\n`, 'utf8')
  assert.deepEqual(await uiCampaignCompletionProblems(root, verified), [])
})
