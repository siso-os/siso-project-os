import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyProjectAdoption, planProjectAdoption } from '../src/adoption.mjs'
import { checkProject } from '../src/check.mjs'
import { buildProject } from '../src/build.mjs'
import { planUpgrade } from '../src/upgrade.mjs'
import { walkFiles } from '../src/shared.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-spine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function digest(root) {
  const hash = createHash('sha256')
  for (const file of await walkFiles(root)) hash.update(file).update(await readFile(join(root, file)))
  return hash.digest('hex')
}

test('clean adoption installs a usable spine and keeps source links and publication unclaimed', async (t) => {
  const root = await fixture(t)
  const adoption = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/siso-project-os.mjs', import.meta.url)), 'adopt', 'apply', root, '--name', 'Spine fixture', '--json'], { encoding: 'utf8' })
  assert.equal(adoption.status, 0, adoption.stderr)
  const result = JSON.parse(adoption.stdout)
  assert.equal(result.ok, true)
  const page = await readFile(join(root, '.agents/PAGE.md'), 'utf8')
  assert.match(page, /^# Spine fixture/)
  for (const [, href] of page.matchAll(/\]\(([^)]+)\)/g)) await readFile(join(root, '.agents', href))
  assert.equal(await readFile(join(root, '.agents/owners.log'), 'utf8'), '')
  assert.equal(await readFile(join(root, '.agents/page.url'), 'utf8'), '')
  assert.deepEqual(JSON.parse(await readFile(join(root, '.agents/repos.json'))), { schema_version: 1, repository_url: null, parent_url: null, library_work_id: null, satellites: [] })
  const before = await digest(root)
  assert.equal((await checkProject(root)).ok, true)
  assert.equal(await digest(root), before, 'check is read-only')
  assert.equal((await planProjectAdoption(root)).legacy_markdown.length, 0)
})

test('adoption and upgrade preserve every owned spine file and private intake', async (t) => {
  const root = await fixture(t)
  const owned = {
    '.agents/PAGE.md': '# Existing public page\n',
    '.agents/HANDOFF.md': '# Existing owner handoff\n',
    '.agents/owners.log': '2026-09-06T00:00:00Z · FIXTURE · Existing result · docs/result.html\n',
    '.agents/page.url': 'https://fixture.pages.dev/\n',
    '.agents/repos.json': '{"schema_version":1,"repository_url":"https://github.com/example/project","parent_url":null,"library_work_id":null,"satellites":[]}\n',
    'intake/notes.txt': 'Private fixture, preserve in place.\n',
  }
  for (const [file, bytes] of Object.entries(owned)) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), bytes) }
  const adoption = await applyProjectAdoption(root, { name: 'Existing fixture' })
  for (const file of Object.keys(owned).filter(file => file.startsWith('.agents/'))) assert.ok(adoption.preserved.includes(file))
  for (const [file, bytes] of Object.entries(owned)) assert.equal(await readFile(join(root, file), 'utf8'), bytes)
  const upgrade = await planUpgrade(root)
  for (const file of Object.keys(owned).filter(file => file.startsWith('.agents/'))) assert.equal(upgrade.operations.find(operation => operation.path === file)?.action, 'preserve')
})

test('checks reject duplicate repositories, invalid URLs, missing files and symlinked manifests', async (t) => {
  const root = await fixture(t)
  await applyProjectAdoption(root, { name: 'Invalid fixture' })
  const path = join(root, '.agents/repos.json')
  const original = await readFile(path, 'utf8')
  const repository = 'https://github.com/example/project'
  await writeFile(path, JSON.stringify({ schema_version: 1, repository_url: repository, parent_url: null, library_work_id: null, satellites: [{ role: 'code', repository_url: repository, visibility: 'public' }] }))
  await buildProject(root)
  assert.ok((await checkProject(root)).errors.some(error => error.code === 'duplicate_spine_repository'))
  await writeFile(path, original)
  await writeFile(join(root, '.agents/page.url'), 'javascript:fixture')
  assert.ok((await checkProject(root)).errors.some(error => error.code === 'invalid_page_url'))
  await writeFile(join(root, '.agents/page.url'), '')
  await rm(path)
  await symlink(join(root, '.project-os/project.json'), path)
  assert.ok((await checkProject(root)).errors.some(error => error.code === 'invalid_spine_file'))
  await rm(join(root, '.agents/PAGE.md'))
  assert.ok((await checkProject(root)).errors.some(error => error.code === 'missing_spine_file'))
})
