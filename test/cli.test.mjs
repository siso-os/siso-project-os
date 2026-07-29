import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderOnboardingHtml } from '../src/console.mjs'
import { walkFiles } from '../src/shared.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(repoRoot, 'bin', 'siso-project-os.mjs')

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
  assert.equal(result.status, expected, `unexpected exit for ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

function runAsync(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { encoding: 'utf8' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
  })
}

async function project(t, name = 'fixture', initOptions = []) {
  const root = await mkdtemp(join(tmpdir(), 'siso-project-os-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  run(['init', root, '--name', name, ...initOptions])
  return root
}

async function digestTree(root) {
  const hash = createHash('sha256')
  for (const file of await walkFiles(root)) {
    hash.update(file)
    hash.update(await readFile(join(root, file)))
  }
  return hash.digest('hex')
}

test('clean adoption supports the core task, sprint, run, and UI lifecycle', async (t) => {
  const root = await project(t, 'Golden fixture')
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Golden task', '--json']).stdout)
  assert.equal(created.id, 'TASK-0001')
  run(['task', 'update', '--root', root, created.id, '--by', 'test', '--status', 'in_progress', '--log', 'started'])
  run(['task', 'update', '--root', root, created.id, '--by', 'test', '--verified', '--command', 'node --test', '--evidence', 'receipt://test', '--status', 'completed'])
  run(['sprint', 'create', '--root', root, '--title', 'Golden sprint', '--tasks', created.id])
  const runRecord = JSON.parse(run(['run', 'create', '--root', root, '--title', 'Golden run', '--task', created.id, '--json']).stdout)
  const closedRun = JSON.parse(run(['run', 'close', '--root', root, runRecord.id, '--by', 'test', '--verdict', 'passed', '--summary', 'Run landed', '--json']).stdout)
  assert.equal(closedRun.status, 'completed')
  run(['run', 'create', '--root', root, '--title', 'Golden open run', '--task', created.id])
  run(['ui', 'create', '--root', root, '--title', 'Golden UI', '--task', created.id])
  const checked = JSON.parse(run(['check', root, '--json']).stdout)
  assert.equal(checked.ok, true)
  const index = JSON.parse(await readFile(join(root, '.project-os', 'generated', 'project-index.json'), 'utf8'))
  assert.deepEqual(index.counts, { tasks: 1, sprints: 1, runs: 2, campaigns: 1, docs: index.counts.docs })
  const corpus = JSON.parse(await readFile(join(root, '.project-os', 'generated', 'docs-corpus.json'), 'utf8'))
  assert.equal(corpus.documents.length, index.counts.docs)
  assert.match(corpus.input_digest, /^[a-f0-9]{64}$/)
  const onboarding = await readFile(join(root, '.project-os', 'generated', 'onboarding.html'), 'utf8')
  assert.match(onboarding, /Golden fixture · Project OS/)
  assert.match(onboarding, /Golden sprint/)
  assert.match(onboarding, /Golden open run/)
  for (const contract of ['agent-start', 'human-attention', 'next-work', 'delivery-trunk', 'truth-map', 'commands']) {
    assert.match(onboarding, new RegExp(`data-contract="${contract}"`))
  }
  assert.match(onboarding, /id="project-os-state" type="application\/json"/)
})

test('onboard is read-only and projects human attention separately from unblocked next work', async (t) => {
  const root = await project(t, 'Operator fixture', [
    '--summary', 'Release coordination system',
    '--outcome', 'Every release has a proven landing receipt',
  ])
  const human = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Choose launch window', '--requires-human', '--human-reason', 'Shaan must choose the date', '--json']).stdout)
  const ready = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Prepare release notes', '--priority', 'high', '--json']).stdout)
  const blocked = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Publish release', '--json']).stdout)
  run(['task', 'update', '--root', root, blocked.id, '--by', 'test', '--status', 'in_progress', '--log', 'started'])
  run(['task', 'update', '--root', root, blocked.id, '--by', 'test', '--status', 'blocked', '--blocker', 'Waiting for registry access'])

  const before = await digestTree(root)
  const report = JSON.parse(run(['onboard', root, '--json']).stdout)
  const after = await digestTree(root)
  assert.equal(after, before)
  assert.equal(report.ok, true)
  assert.equal(report.guide, '.project-os/generated/onboarding.html')
  assert.equal(report.project_summary, 'Release coordination system')
  assert.equal(report.desired_outcome, 'Every release has a proven landing receipt')
  assert.deepEqual(report.boot_order, [
    'AGENTS.md',
    'PROJECT-OS.md',
    'project-os onboard --json',
    'canonical task.json',
    'linked run packet',
    'verification and handoff',
  ])
  assert.ok(report.human_attention.some((item) => item.id === human.id && item.kind === 'human_gate'))
  assert.ok(report.human_attention.some((item) => item.id === blocked.id && item.kind === 'blocked_task'))
  assert.ok(report.next_work.some((item) => item.id === ready.id))
  assert.equal(report.next_work.some((item) => item.id === human.id), false)
  assert.equal(report.next_work.some((item) => item.id === blocked.id), false)

  const onboarding = await readFile(join(root, report.guide), 'utf8')
  assert.match(onboarding, /Shaan must choose the date/)
  assert.match(onboarding, /Waiting for registry access/)
  assert.match(onboarding, /Prepare release notes/)
  assert.match(onboarding, /Every release has a proven landing receipt/)
  assert.match(onboarding, /data-contract="active-delivery"/)
  assert.match(onboarding, /window\.__verify=Object\.freeze/)
  assert.match(onboarding, /version:'project-os-cockpit\.v1'/)
  assert.match(onboarding, /p,footer,code,a\{overflow-wrap:anywhere\}/)

  const orderedTokens = ['AGENTS.md', 'PROJECT-OS', 'project-os onboard --json', 'task.json', 'linked run packet', 'Verify']
  for (const source of [
    await readFile(join(root, 'AGENTS.md'), 'utf8'),
    await readFile(join(root, 'docs', 'project-os', 'ONBOARDING.html'), 'utf8'),
    onboarding,
  ]) {
    const normalized = source.replace(/\s+/g, ' ')
    let previous = -1
    for (const token of orderedTokens) {
      const index = normalized.indexOf(token)
      assert.ok(index > previous, `${token} is out of order in onboarding surface`)
      previous = index
    }
  }
})

test('cockpit bounds the visible task trunk while preserving the full count', () => {
  const tasks = Array.from({ length: 51 }, (_, index) => ({
    id: `TASK-${String(index + 1).padStart(4, '0')}`,
    title: `Task ${index + 1}`,
    status: 'backlog',
    priority: 'medium',
    domain: 'general',
    owner: null,
    dependencies: [],
    requires_human: false,
    path: `.agents/tasks/backlog/TASK-${String(index + 1).padStart(4, '0')}/task.json`,
  }))
  const html = renderOnboardingHtml({
    project_name: 'Large fixture',
    project_summary: '',
    desired_outcome: '',
    tasks,
    sprints: [],
    runs: [],
    campaigns: [],
    docs: [],
    counts: { tasks: 51, sprints: 0, runs: 0, campaigns: 0, docs: 0 },
    generation: { generator: 'fixture', source_commit: null, input_digest: 'a'.repeat(64), output_digest: 'b'.repeat(64) },
  })
  assert.match(html, /Showing 50 of 51 tasks/)
  assert.match(html, /data-contract="delivery-trunk" data-item-count="51"/)
})

test('init refuses ordinary collisions without leaving a partial install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'siso-project-os-collision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'PROJECT-OS.html'), 'existing\n', 'utf8')
  run(['init', root], 2)
  await assert.rejects(readFile(join(root, '.project-os', 'project.json'), 'utf8'))
})

test('init preserves existing AGENTS.md and stages the merge contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'siso-project-os-adopt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'AGENTS.md'), '# Existing rules\n', 'utf8')
  run(['init', root, '--name', 'Adopted'])
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n')
  assert.match(await readFile(join(root, '.project-os', 'AGENTS.project-os.md'), 'utf8'), /Adopted/)
})

test('task completion fails closed without verification receipts', async (t) => {
  const root = await project(t)
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Receipt gate', '--json']).stdout)
  run(['task', 'update', '--root', root, created.id, '--by', 'test', '--status', 'completed'], 1)
  const task = JSON.parse(await readFile(join(root, '.agents', 'tasks', 'backlog', created.id, 'task.json'), 'utf8'))
  assert.equal(task.status, 'backlog')
})

test('terminal tasks are immutable and dependency gates fail closed', async (t) => {
  const root = await project(t)
  const prerequisite = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Prerequisite', '--json']).stdout)
  const dependent = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Dependent', '--deps', prerequisite.id, '--json']).stdout)
  run(['task', 'update', '--root', root, dependent.id, '--by', 'test', '--status', 'in_progress'], 1)
  run(['task', 'update', '--root', root, prerequisite.id, '--by', 'test', '--status', 'in_progress'])
  run(['task', 'update', '--root', root, prerequisite.id, '--by', 'test', '--status', 'completed', '--verified', '--command', 'node --test', '--evidence', 'receipt://pass'])
  run(['task', 'update', '--root', root, dependent.id, '--by', 'test', '--status', 'in_progress'])
  run(['task', 'update', '--root', root, dependent.id, '--by', 'test', '--status', 'completed', '--verified', '--command', 'node --test', '--evidence', 'receipt://pass'])
  const terminalPath = join(root, '.agents', 'tasks', 'completed', dependent.id, 'task.json')
  const before = await readFile(terminalPath, 'utf8')
  run(['task', 'update', '--root', root, dependent.id, '--by', 'test', '--status', 'in_progress'], 1)
  assert.equal(await readFile(terminalPath, 'utf8'), before)

  const cancelled = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Cancelled', '--json']).stdout)
  run(['task', 'update', '--root', root, cancelled.id, '--by', 'test', '--status', 'cancelled', '--reason', 'No longer needed'])
  const cancelledPath = join(root, '.agents', 'tasks', 'cancelled', cancelled.id, 'task.json')
  const cancelledBefore = await readFile(cancelledPath, 'utf8')
  run(['task', 'update', '--root', root, cancelled.id, '--by', 'test', '--status', 'backlog'], 1)
  assert.equal(await readFile(cancelledPath, 'utf8'), cancelledBefore)
})

test('check rejects duplicate task IDs across lifecycle folders', async (t) => {
  const root = await project(t)
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Duplicate guard', '--json']).stdout)
  await cp(
    join(root, '.agents', 'tasks', 'backlog', created.id),
    join(root, '.agents', 'tasks', 'in_progress', created.id),
    { recursive: true },
  )
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((error) => error.code === 'duplicate_task_id'))
})

test('check rejects folder/status drift', async (t) => {
  const root = await project(t)
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Folder guard', '--json']).stdout)
  const path = join(root, '.agents', 'tasks', 'backlog', created.id, 'task.json')
  const task = JSON.parse(await readFile(path, 'utf8'))
  task.status = 'blocked'
  task.blocker = 'fixture'
  await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((error) => error.code === 'task_folder_mismatch'))
})

test('check validates canonical records against installed schemas', async (t) => {
  const root = await project(t)
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Schema guard', '--json']).stdout)
  const path = join(root, '.agents', 'tasks', 'backlog', created.id, 'task.json')
  const task = JSON.parse(await readFile(path, 'utf8'))
  task.undeclared_field = true
  await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((error) => error.code === 'schema_violation'))
})

test('check validates project identity and outcome configuration', async (t) => {
  const root = await project(t)
  const path = join(root, '.project-os', 'project.json')
  const config = JSON.parse(await readFile(path, 'utf8'))
  config.desired_outcome = 42
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((error) => error.code === 'schema_violation' && error.path === '.project-os/project.json'))

  await writeFile(path, '{\n', 'utf8')
  const malformed = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(malformed.errors.some((error) => error.code === 'invalid_config_json'))
  assert.ok(malformed.errors.some((error) => error.code === 'projection_build_failed'))
})

test('check returns structured errors for non-object task records', async (t) => {
  const root = await project(t)
  const created = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Null record guard', '--json']).stdout)
  const path = join(root, '.agents', 'tasks', 'backlog', created.id, 'task.json')
  await writeFile(path, 'null\n', 'utf8')
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((error) => error.code === 'invalid_task_record'))
})

test('schema validation rejects impossible and timezone-less timestamps', async (t) => {
  const root = await project(t)
  const task = JSON.parse(run(['task', 'create', '--root', root, '--title', 'Date guard', '--json']).stdout)
  const sprint = JSON.parse(run(['sprint', 'create', '--root', root, '--title', 'Date sprint', '--tasks', task.id, '--json']).stdout)
  const runRecord = JSON.parse(run(['run', 'create', '--root', root, '--title', 'Date run', '--task', task.id, '--json']).stdout)
  const records = [
    [join(root, '.agents', 'tasks', 'backlog', task.id, 'task.json'), '2026-02-30T00:00:00Z'],
    [join(root, '.agents', 'sprints', sprint.id, 'sprint.json'), '2026-01-01T00:00:00'],
    [join(root, '.agents', 'runs', runRecord.id, 'run.json'), '2026-13-01T00:00:00Z'],
  ]
  for (const [path, timestamp] of records) {
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.created_at = timestamp
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.filter((error) => error.code === 'schema_violation').length >= 3)
})

test('knowledge checks reject meaningless ledgers and broken proof or document pointers', async (t) => {
  const root = await project(t)
  await writeFile(join(root, 'docs', 'ledgers', 'decisions.jsonl'), '{}\n', 'utf8')
  await writeFile(join(root, 'docs', 'ledgers', 'runs.jsonl'), '{}\n', 'utf8')

  const source = await readFile(join(root, 'docs', 'domains', 'INDEX.html'), 'utf8')
  const match = source.match(/<!-- project-os-meta\s*\n([\s\S]*?)\n-->/)
  const metadata = JSON.parse(match[1])
  metadata.document_id = 'domain.stale-fixture'
  metadata.path = 'docs/domains/stale-fixture.md'
  metadata.title = 'Stale fixture'
  metadata.status = 'stale'
  metadata.authority_key = null
  metadata.canonical_pointer = 'docs/domains/missing-current.md'
  metadata.superseded_by = 'docs/domains/missing-current.md'
  const stale = source.replace(match[1], JSON.stringify(metadata, null, 2)).replace('<h1>Domain knowledge</h1>', '<h1>Stale fixture</h1>')
  await writeFile(join(root, metadata.path), stale, 'utf8')

  const claim = {
    schema_version: 1,
    claim_id: 'CLAIM-001',
    claim_key: 'fixture.missing-proof',
    source_path: 'docs/ledgers/proofs.jsonl',
    claim: 'This validly shaped claim has deliberately broken evidence pointers.',
    status: 'proven',
    evidence_grade: 'inspection',
    observed_at: '2026-07-29T00:00:00Z',
    verified_at: '2026-07-29T00:00:00Z',
    proof_commit: 'deadbee',
    depends_on: ['src/missing-dependency.js'],
    proof_artifacts: [{ path: 'docs/missing-proof.txt', kind: 'report', sha256: '0'.repeat(64), observed_at: '2026-07-29T00:00:00Z' }],
    provenance: { source_kind: 'inspection', source_ref: 'fixture', method: 'Adversarial pointer probe', verifier: 'test' },
    expiry_policy: { mode: 'dependency_change', review_due_at: null, event: null },
    supersedes: [],
    superseded_by: null,
    notes: '',
  }
  const directoryArtifactClaim = {
    ...claim,
    claim_id: 'CLAIM-002',
    claim_key: 'fixture.directory-proof',
    status: 'proposed',
    evidence_grade: 'hypothesis',
    verified_at: null,
    proof_commit: null,
    depends_on: [],
    proof_artifacts: [{ path: 'docs', kind: 'report', sha256: '0'.repeat(64), observed_at: '2026-07-29T00:00:00Z' }],
    expiry_policy: { mode: 'manual', review_due_at: null, event: null },
  }
  await writeFile(join(root, 'docs', 'ledgers', 'proofs.jsonl'), `${JSON.stringify(claim)}\n${JSON.stringify(directoryArtifactClaim)}\n`, 'utf8')
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  const codes = new Set(checked.errors.map((error) => error.code))
  assert.ok(codes.has('schema_violation'))
  assert.ok(codes.has('broken_document_pointer'))
  assert.ok(codes.has('missing_claim_dependency'))
  assert.ok(codes.has('missing_artifact'))
  assert.ok(codes.has('missing_proof_commit'))
  assert.ok(codes.has('artifact_not_file'))
})

test('locked allocation never returns duplicate task IDs under contention', async (t) => {
  const root = await project(t)
  const attempts = await Promise.all([
    runAsync(['task', 'create', '--root', root, '--title', 'Concurrent A', '--json']),
    runAsync(['task', 'create', '--root', root, '--title', 'Concurrent B', '--json']),
  ])
  const successes = attempts.filter((attempt) => attempt.status === 0).map((attempt) => JSON.parse(attempt.stdout))
  assert.ok(successes.length >= 1)
  assert.equal(new Set(successes.map((task) => task.id)).size, successes.length)
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json']).stdout)
  assert.equal(checked.errors.some((error) => error.code === 'duplicate_task_id'), false)
})

test('check rejects a UI campaign that points to a missing canonical task', async (t) => {
  const root = await project(t)
  const task = JSON.parse(run(['task', 'create', '--root', root, '--title', 'UI owner', '--json']).stdout)
  const campaign = JSON.parse(run(['ui', 'create', '--root', root, '--title', 'UI work', '--task', task.id, '--json']).stdout)
  const path = join(root, '.uihub', 'campaigns', campaign.id, 'campaign.json')
  campaign.task_id = 'TASK-9999'
  await writeFile(path, `${JSON.stringify(campaign, null, 2)}\n`, 'utf8')
  run(['build', root])
  const checked = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(checked.errors.some((error) => error.code === 'missing_campaign_task'))
})

test('UI campaign advances through grounded artifacts, decision, implementation, and proof', async (t) => {
  const root = await project(t)
  const task = JSON.parse(run(['task', 'create', '--root', root, '--title', 'UI lifecycle owner', '--json']).stdout)
  const campaign = JSON.parse(run(['ui', 'create', '--root', root, '--title', 'UI lifecycle', '--task', task.id, '--surface', 'settings', '--json']).stdout)
  const campaignRoot = join(root, '.uihub', 'campaigns', campaign.id)
  const researchPath = `.uihub/campaigns/${campaign.id}/research/findings.html`
  await writeFile(join(root, researchPath), '<!doctype html><title>Grounded findings</title>\n', 'utf8')

  for (const id of ['DIR-A', 'DIR-B']) {
    const direction = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'direction.json'), 'utf8'))
    direction.id = id
    direction.campaign_id = campaign.id
    direction.task_id = task.id
    await writeFile(join(campaignRoot, 'directions', `${id}.json`), `${JSON.stringify(direction, null, 2)}\n`, 'utf8')
  }
  for (const id of ['CAN-A', 'CAN-B']) await mkdir(join(campaignRoot, 'candidates', id), { recursive: true })
  const reviewPath = `.uihub/campaigns/${campaign.id}/review/response.json`
  await writeFile(join(root, reviewPath), '{"chosen":"DIR-A"}\n', 'utf8')

  const decision = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'decision.json'), 'utf8'))
  decision.id = `DEC-${campaign.id}-001`
  decision.campaign_id = campaign.id
  decision.task_id = task.id
  decision.review_response = reviewPath
  const decisionPath = `.uihub/campaigns/${campaign.id}/decided/decision.json`
  await writeFile(join(root, decisionPath), `${JSON.stringify(decision, null, 2)}\n`, 'utf8')

  const implementation = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'implementation-receipt.json'), 'utf8'))
  implementation.id = `RCP-${campaign.id}-IMPLEMENTATION`
  implementation.campaign_id = campaign.id
  implementation.task_id = task.id
  implementation.verdict = 'pass'
  implementation.implementation.source_commit = '0000000'
  implementation.implementation.changed_files = ['src/settings.js']
  implementation.implementation.checks[0].verdict = 'pass'
  implementation.implementation.unresolved = []
  const implementationPath = `.uihub/campaigns/${campaign.id}/implemented/receipt.json`
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'settings.js'), 'export {}\n', 'utf8')
  await mkdir(join(root, 'src', 'path', 'to'), { recursive: true })
  await writeFile(join(root, 'src', 'path', 'to', 'surface'), 'fixture\n', 'utf8')
  await writeFile(join(root, implementationPath), `${JSON.stringify(implementation, null, 2)}\n`, 'utf8')

  const verification = JSON.parse(await readFile(join(repoRoot, 'template', '.uihub', '_templates', 'verification-receipt.json'), 'utf8'))
  verification.id = `RCP-${campaign.id}-VERIFICATION`
  verification.campaign_id = campaign.id
  verification.task_id = task.id
  verification.verdict = 'pass'
  verification.verification.checks[0].verdict = 'fail'
  verification.verification.browser_faults.console_errors = 2
  verification.verification.visual_evidence[0].path = `.uihub/campaigns/${campaign.id}/verified/proof.png`
  const verificationPath = `.uihub/campaigns/${campaign.id}/verified/receipt.json`
  await writeFile(join(root, verificationPath), `${JSON.stringify(verification, null, 2)}\n`, 'utf8')

  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'research', '--research', researchPath])
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'directions', '--directions', 'DIR-A,DIR-B'])
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'candidates', '--candidates', 'CAN-A,CAN-B'])
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'review', '--review', reviewPath])
  const beforeRejectedDecision = await readFile(join(campaignRoot, 'campaign.json'), 'utf8')
  decision.rejected_direction_ids = ['DIR-A', 'DIR-Z']
  await writeFile(join(root, decisionPath), `${JSON.stringify(decision, null, 2)}\n`, 'utf8')
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'decided', '--decision', decisionPath], 1)
  assert.equal(await readFile(join(campaignRoot, 'campaign.json'), 'utf8'), beforeRejectedDecision)
  decision.rejected_direction_ids = ['DIR-B']
  await writeFile(join(root, decisionPath), `${JSON.stringify(decision, null, 2)}\n`, 'utf8')
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'decided', '--decision', decisionPath])
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'implemented', '--receipt', implementationPath])
  const beforeRejectedProof = await readFile(join(campaignRoot, 'campaign.json'), 'utf8')
  run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'verified', '--receipt', verificationPath], 1)
  assert.equal(await readFile(join(campaignRoot, 'campaign.json'), 'utf8'), beforeRejectedProof)

  verification.verification.checks[0].verdict = 'pass'
  verification.verification.browser_faults.console_errors = 0
  await writeFile(join(campaignRoot, 'verified', 'proof.png'), 'fixture\n', 'utf8')
  await writeFile(join(root, verificationPath), `${JSON.stringify(verification, null, 2)}\n`, 'utf8')
  const verified = JSON.parse(run(['ui', 'advance', '--root', root, campaign.id, '--stage', 'verified', '--receipt', verificationPath, '--json']).stdout)
  assert.equal(verified.stage, 'verified')
  const checked = JSON.parse(run(['check', root, '--json']).stdout)
  assert.equal(checked.ok, true)

  verification.verification.checks[0].verdict = 'fail'
  verification.verification.browser_faults.broken_assets = 3
  await writeFile(join(root, verificationPath), `${JSON.stringify(verification, null, 2)}\n`, 'utf8')
  run(['build', root])
  const rejected = JSON.parse(run(['check', root, '--json'], 1).stdout)
  assert.ok(rejected.errors.some((error) => error.code === 'invalid_ui_receipt_semantics'))
})

test('check is read-only and deterministic builds are byte-stable', async (t) => {
  const root = await project(t)
  run(['task', 'create', '--root', root, '--title', 'Determinism'])
  run(['build', root])
  const beforeBuild = await digestTree(root)
  run(['build', root])
  const afterBuild = await digestTree(root)
  assert.equal(afterBuild, beforeBuild)
  const beforeCheck = await digestTree(root)
  run(['check', root])
  const afterCheck = await digestTree(root)
  assert.equal(afterCheck, beforeCheck)
})
