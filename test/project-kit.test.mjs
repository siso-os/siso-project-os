import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyProjectAdoption, planProjectAdoption } from '../src/adoption.mjs'
import { validateSchema } from '../src/schema.mjs'
import { walkFiles } from '../src/shared.mjs'

const RUNTIME_SOURCE = Object.freeze({
  transport: 'git',
  repository: 'https://github.com/sisodias/siso-project-os.git',
  tag: 'v0.5.1',
  tag_object: '1'.repeat(40),
  commit: '2'.repeat(40),
  tree: '3'.repeat(40),
  bin: 'bin/siso-project-os.mjs',
})

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function write(root, path, content) {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

async function treeDigest(root) {
  const hash = createHash('sha256')
  for (const path of await walkFiles(root)) {
    hash.update(path)
    hash.update(await readFile(join(root, path)))
  }
  return hash.digest('hex')
}

test('complete project adoption installs every pack and is idempotent', async (t) => {
  const root = await fixture(t, 'siso-project-kit-greenfield-')
  const first = await applyProjectAdoption(root, {
    name: 'Complete & "fixture"',
    summary: 'Exercises every Project Kit pack.',
    outcome: 'A cold agent can safely resume and deliver.',
    runtimeSource: RUNTIME_SOURCE,
  })
  assert.equal(first.ok, true)
  assert.equal(first.plan.operational_after_apply, true)
  assert.ok(first.created.includes('.agents/tasks/index.html'))
  assert.ok(first.created.includes('.agents/skills/project-operator/SKILL.md'))
  assert.ok(first.created.includes('.uihub/README.html'))
  assert.ok(first.created.includes('docs/spine/REPO-FACTS.html'))
  assert.ok(first.created.includes('.project-os/schemas/verification-receipt.schema.json'))
  const operatingMap = await readFile(join(root, 'PROJECT-OS.html'), 'utf8')
  assert.match(operatingMap, /Complete &amp; &quot;fixture&quot;/)
  const configuration = JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8'))
  assert.equal(configuration.project_name, 'Complete & "fixture"')
  assert.deepEqual(configuration.launcher, {
    schema_version: 2,
    program: 'node',
    arguments: ['.project-os/project-os-launcher.mjs'],
    cwd: 'project-root',
    source: RUNTIME_SOURCE,
    cache: { scope: 'user', key: 'tag-object', environment_override: 'SISO_PROJECT_OS_CACHE_DIR' },
  })
  assert.match(await readFile(join(root, '.project-os', 'project.json'), 'utf8'), /cold agent can safely resume/i)
  const onboardCommand = JSON.parse(await readFile(join(root, '.agents', 'commands', 'project-os-onboard.json'), 'utf8'))
  assert.equal(onboardCommand.program, configuration.launcher.program)
  assert.deepEqual(onboardCommand.arguments.slice(0, 1), configuration.launcher.arguments)
  assert.match(await readFile(join(root, '.project-os', 'migration', 'project-kit-migration.html'), 'utf8'), /data-contract="project-kit-migration"/)

  const markdown = (await walkFiles(root)).filter((path) => path.endsWith('.md')).sort()
  assert.deepEqual(markdown, ['AGENTS.md', 'CLAUDE.md', '.agents/skills/project-operator/SKILL.md'].sort())
  const beforeSecond = await treeDigest(root)
  const second = await applyProjectAdoption(root, { runtimeSource: RUNTIME_SOURCE })
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.preserved, [])
  assert.equal(second.plan.operational_after_apply, true)
  assert.equal(await treeDigest(root), beforeSecond)
})

test('existing-project adoption preserves authorities, merges only runtime routes, and reports HTML migration work', async (t) => {
  const root = await fixture(t, 'siso-project-kit-existing-')
  const agents = '# Existing agent rules\n\nNever delete project-specific policy.\n'
  const claude = '# Existing Claude rules\n'
  const operatingMap = '<!doctype html><title>Project-owned map</title>\n'
  await write(root, 'AGENTS.md', agents)
  await write(root, 'CLAUDE.md', claude)
  await write(root, 'PROJECT-OS.html', operatingMap)
  await write(root, 'README.md', '# Legacy project readme\n')
  await write(root, 'src/product.js', 'export const untouched = true\n')

  const plan = await planProjectAdoption(root, { name: 'Existing fixture', runtimeSource: RUNTIME_SOURCE })
  assert.equal(plan.mode, 'existing')
  assert.equal(plan.operational_after_apply, false)
  assert.ok(plan.preserved_collisions.some((entry) => entry.path === 'PROJECT-OS.html'))
  assert.deepEqual(plan.legacy_markdown, ['README.md'])
  assert.ok(plan.operations.some((entry) => entry.path === 'AGENTS.md' && entry.action === 'merge-route'))
  assert.ok(plan.operations.some((entry) => entry.path === 'CLAUDE.md' && entry.action === 'merge-route'))

  const applied = await applyProjectAdoption(root, { name: 'Existing fixture', runtimeSource: RUNTIME_SOURCE })
  assert.equal(await readFile(join(root, 'PROJECT-OS.html'), 'utf8'), operatingMap)
  assert.equal(await readFile(join(root, 'src', 'product.js'), 'utf8'), 'export const untouched = true\n')
  const mergedAgents = await readFile(join(root, 'AGENTS.md'), 'utf8')
  const mergedClaude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
  assert.ok(mergedAgents.startsWith(agents.trimEnd()))
  assert.ok(mergedClaude.startsWith(claude.trimEnd()))
  assert.match(mergedAgents, /\.agents\/skills\/project-operator\/SKILL\.md/)
  assert.match(mergedClaude, /\.agents\/skills\/project-operator\/SKILL\.md/)
  assert.deepEqual(applied.merged_routes, ['AGENTS.md', 'CLAUDE.md'])
  assert.ok(applied.preserved.includes('PROJECT-OS.html'))
  const report = await readFile(join(root, applied.report), 'utf8')
  assert.match(report, /Project OS authority conflicts remain|Review the preserved authorities/)
  assert.match(report, /id="project-kit-migration-state" type="application\/json"/)
})

test('project schema accepts only the portable launcher v2 contract', async (t) => {
  const root = await fixture(t, 'siso-project-kit-schema-')
  await applyProjectAdoption(root, { name: 'Schema fixture', runtimeSource: RUNTIME_SOURCE })
  const schema = JSON.parse(await readFile(join(root, '.project-os', 'schemas', 'project.schema.json'), 'utf8'))
  const configuration = JSON.parse(await readFile(join(root, '.project-os', 'project.json'), 'utf8'))
  assert.deepEqual(validateSchema(configuration, schema), [])

  const unsafe = [
    (value) => { value.launcher.program = 'npx' },
    (value) => { value.launcher.arguments = ['/tmp/project-os.mjs'] },
    (value) => { value.launcher.arguments = ['C:\\runtime\\project-os.mjs'] },
    (value) => { value.launcher.arguments = ['\\\\server\\runtime\\project-os.mjs'] },
    (value) => { value.launcher.arguments = ['file:///tmp/project-os.mjs'] },
    (value) => { value.launcher.source.repository = 'ssh://git@example.invalid/private.git' },
    (value) => { value.launcher.source.bin = '/tmp/siso-project-os.mjs' },
  ]
  for (const mutate of unsafe) {
    const candidate = structuredClone(configuration)
    mutate(candidate)
    assert.notDeepEqual(validateSchema(candidate, schema), [])
  }
})
