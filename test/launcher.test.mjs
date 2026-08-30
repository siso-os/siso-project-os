import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcherTemplate = join(packageRoot, 'template', '.project-os', 'project-os-launcher.mjs')
const repository = 'https://github.com/sisodias/siso-project-os.git'

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
}

function git(root, args, expected = 0) {
  const result = run('git', args, { cwd: root })
  assert.equal(result.status, expected, `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result.stdout.trim()
}

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-launcher-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, 'bin', 'siso-project-os.mjs'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
`, 'utf8')
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Launcher fixture'])
  git(root, ['config', 'user.email', 'launcher@example.invalid'])
  git(root, ['remote', 'add', 'origin', repository])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'Create synthetic Project OS release'])
  git(root, ['tag', '-a', 'v0.5.1', '-m', 'Synthetic v0.5.1'])
  return {
    root,
    source: {
      transport: 'git',
      repository,
      tag: 'v0.5.1',
      tag_object: git(root, ['rev-parse', 'refs/tags/v0.5.1']),
      commit: git(root, ['rev-parse', 'refs/tags/v0.5.1^{}']),
      tree: git(root, ['rev-parse', 'refs/tags/v0.5.1^{}^{tree}']),
      bin: 'bin/siso-project-os.mjs',
    },
  }
}

function launcherBinding(source) {
  return {
    schema_version: 2,
    program: 'node',
    arguments: ['.project-os/project-os-launcher.mjs'],
    cwd: 'project-root',
    source,
    cache: {
      scope: 'user',
      key: 'tag-object',
      environment_override: 'SISO_PROJECT_OS_CACHE_DIR',
    },
  }
}

async function projectFixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-launcher-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.project-os'), { recursive: true })
  await copyFile(launcherTemplate, join(root, '.project-os', 'project-os-launcher.mjs'))
  await writeFile(join(root, '.project-os', 'project.json'), `${JSON.stringify({
    schema_version: 1,
    project_os_version: '0.5.1',
    launcher: launcherBinding(source),
  }, null, 2)}\n`, 'utf8')
  return root
}

async function cacheFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-os-launcher-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function acquisitionEnvironment(releaseRoot, cacheRoot, overrides = {}) {
  return {
    ...process.env,
    SISO_PROJECT_OS_CACHE_DIR: cacheRoot,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${releaseRoot}/.insteadOf`,
    GIT_CONFIG_VALUE_0: repository,
    ...overrides,
  }
}

function launch(projectRoot, args, env, cwd = projectRoot) {
  return run(process.execPath, [join(projectRoot, '.project-os', 'project-os-launcher.mjs'), ...args], { cwd, env })
}

function runAsync(program, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(program, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
  })
}

test('cold acquisition verifies the annotated release and warm cache runs without clone or fetch', async (t) => {
  const release = await releaseFixture(t)
  const project = await projectFixture(t, release.source)
  const cache = await cacheFixture(t)
  const nonRoot = await mkdtemp(join(tmpdir(), 'project-os-launcher-caller-'))
  t.after(() => rm(nonRoot, { recursive: true, force: true }))
  const environment = acquisitionEnvironment(release.root, cache)

  const cold = launch(project, ['check', '.', '--json'], environment, nonRoot)
  assert.equal(cold.status, 0, cold.stderr)
  assert.deepEqual(JSON.parse(cold.stdout), { args: ['check', '.', '--json'], cwd: project })
  const cached = join(cache, release.source.tag_object)
  assert.equal(git(cached, ['remote', 'get-url', 'origin']), repository)
  assert.equal(git(cached, ['rev-parse', 'HEAD']), release.source.commit)
  assert.equal(git(cached, ['status', '--porcelain']), '')

  const wrapperRoot = await mkdtemp(join(tmpdir(), 'project-os-git-wrapper-'))
  t.after(() => rm(wrapperRoot, { recursive: true, force: true }))
  const actualGit = run('which', ['git']).stdout.trim()
  const wrapper = join(wrapperRoot, 'git')
  await writeFile(wrapper, `#!/bin/sh
case "$1" in
  clone|fetch) exit 97 ;;
esac
exec "${actualGit}" "$@"
`, 'utf8')
  await chmod(wrapper, 0o755)
  const warm = launch(project, ['onboard', '.', '--json'], {
    ...process.env,
    PATH: `${wrapperRoot}:${process.env.PATH}`,
    SISO_PROJECT_OS_CACHE_DIR: cache,
  }, nonRoot)
  assert.equal(warm.status, 0, warm.stderr)
  assert.deepEqual(JSON.parse(warm.stdout), { args: ['onboard', '.', '--json'], cwd: project })
})

test('concurrent cold launchers share one verified cache and recover a proven same-host stale lock', async (t) => {
  const release = await releaseFixture(t)
  const project = await projectFixture(t, release.source)
  const cache = await cacheFixture(t)
  const environment = acquisitionEnvironment(release.root, cache)
  const launcher = join(project, '.project-os', 'project-os-launcher.mjs')
  const options = { cwd: project, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  const [first, second] = await Promise.all([
    runAsync(process.execPath, [launcher, 'check', '.', '--json'], options),
    runAsync(process.execPath, [launcher, 'check', '.', '--json'], options),
  ])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(git(join(cache, release.source.tag_object), ['status', '--porcelain']), '')

  await rm(join(cache, release.source.tag_object), { recursive: true, force: true })
  await writeFile(join(cache, `.lock-${release.source.tag_object}`), `${JSON.stringify({
    pid: 2_147_483_647,
    host: hostname(),
    created_at: '2026-08-30T00:00:00Z',
  })}\n`, 'utf8')
  const recovered = launch(project, ['check', '.', '--json'], environment)
  assert.equal(recovered.status, 0, recovered.stderr)
})

test('invalid launcher shapes and unsafe executable locators fail before cache acquisition', async (t) => {
  const release = await releaseFixture(t)
  const variants = [
    ['missing provenance', (value) => { delete value.source.tag_object }],
    ['version and tag mismatch', (_value, configuration) => { configuration.project_os_version = '0.5.0' }],
    ['npm program', (value) => { value.program = 'npm' }],
    ['npx program', (value) => { value.program = 'npx' }],
    ['shell program', (value) => { value.program = 'sh' }],
    ['POSIX absolute launcher', (value) => { value.arguments = ['/tmp/project-os.mjs'] }],
    ['Windows launcher', (value) => { value.arguments = ['C:\\runtime\\project-os.mjs'] }],
    ['UNC launcher', (value) => { value.arguments = ['\\\\server\\runtime\\project-os.mjs'] }],
    ['file URL launcher', (value) => { value.arguments = ['file:///tmp/project-os.mjs'] }],
    ['shell fragment launcher', (value) => { value.arguments = ['.project-os/project-os-launcher.mjs; rm -rf project'] }],
    ['private repository', (value) => { value.source.repository = 'ssh://git@example.invalid/private.git' }],
    ['absolute bin', (value) => { value.source.bin = '/tmp/siso-project-os.mjs' }],
    ['Windows bin', (value) => { value.source.bin = 'C:\\runtime\\siso-project-os.mjs' }],
    ['UNC bin', (value) => { value.source.bin = '\\\\server\\runtime\\siso-project-os.mjs' }],
    ['file URL bin', (value) => { value.source.bin = 'file:///tmp/siso-project-os.mjs' }],
  ]

  for (const [name, mutate] of variants) {
    await t.test(name, async (t) => {
      const project = await projectFixture(t, release.source)
      const cache = await cacheFixture(t)
      const configPath = join(project, '.project-os', 'project.json')
      const configuration = JSON.parse(await readFile(configPath, 'utf8'))
      mutate(configuration.launcher, configuration)
      const bytes = `${JSON.stringify(configuration, null, 2)}\n`
      await writeFile(configPath, bytes, 'utf8')
      const result = launch(project, ['check', '.', '--json'], acquisitionEnvironment(release.root, cache))
      assert.equal(result.status, 2, `${name}\n${result.stderr}`)
      assert.equal(await readFile(configPath, 'utf8'), bytes)
      await assert.rejects(readFile(join(cache, release.source.tag_object, 'bin', 'siso-project-os.mjs'), 'utf8'), /ENOENT/)
    })
  }
})

test('missing Git and cold-cache acquisition failure do not execute Project OS or change project bytes', async (t) => {
  const release = await releaseFixture(t)
  const project = await projectFixture(t, release.source)
  const cache = await cacheFixture(t)
  const configPath = join(project, '.project-os', 'project.json')
  const before = await readFile(configPath, 'utf8')
  const emptyPath = await mkdtemp(join(tmpdir(), 'project-os-no-git-'))
  t.after(() => rm(emptyPath, { recursive: true, force: true }))
  const missingGit = launch(project, ['check', '.', '--json'], {
    ...process.env,
    PATH: emptyPath,
    SISO_PROJECT_OS_CACHE_DIR: cache,
  })
  assert.equal(missingGit.status, 3)
  assert.match(missingGit.stderr, /git is required/)
  assert.equal(await readFile(configPath, 'utf8'), before)

  const actualGit = run('which', ['git']).stdout.trim()
  const wrapper = join(emptyPath, 'git')
  await writeFile(wrapper, `#!/bin/sh
if [ "$1" = clone ] || [ "$1" = fetch ]; then exit 97; fi
exec "${actualGit}" "$@"
`, 'utf8')
  await chmod(wrapper, 0o755)
  const unavailable = launch(project, ['check', '.', '--json'], {
    ...process.env,
    PATH: emptyPath,
    SISO_PROJECT_OS_CACHE_DIR: cache,
  })
  assert.equal(unavailable.status, 2)
  assert.match(unavailable.stderr, /Git provenance check failed: clone/)
  assert.equal(unavailable.stdout, '')
  assert.equal(await readFile(configPath, 'utf8'), before)
})

test('warm cache fails closed on dirty bytes, missing bin, changed origin, tag, commit, or tree', async (t) => {
  const release = await releaseFixture(t)
  const cases = [
    ['dirty cache', async ({ cached }) => { await writeFile(join(cached, 'dirty.txt'), 'dirty\n', 'utf8') }],
    ['ignored dirty cache', async ({ cached }) => {
      await writeFile(join(cached, '.git', 'info', 'exclude'), 'ignored-dirty.txt\n', 'utf8')
      await writeFile(join(cached, 'ignored-dirty.txt'), 'dirty\n', 'utf8')
    }],
    ['missing bin', async ({ cached }) => { await unlink(join(cached, 'bin', 'siso-project-os.mjs')) }],
    ['changed origin', async ({ cached }) => { git(cached, ['remote', 'set-url', 'origin', 'https://example.invalid/wrong.git']) }],
    ['missing tag', async ({ cached }) => { git(cached, ['tag', '-d', 'v0.5.1']) }],
    ['changed commit', async ({ configuration }) => { configuration.launcher.source.commit = '0'.repeat(40) }],
    ['changed tree', async ({ configuration }) => { configuration.launcher.source.tree = '0'.repeat(40) }],
  ]

  for (const [name, corrupt] of cases) {
    await t.test(name, async (t) => {
      const project = await projectFixture(t, release.source)
      const cache = await cacheFixture(t)
      const environment = acquisitionEnvironment(release.root, cache)
      assert.equal(launch(project, ['check', '.', '--json'], environment).status, 0)
      const cached = join(cache, release.source.tag_object)
      const configPath = join(project, '.project-os', 'project.json')
      const configuration = JSON.parse(await readFile(configPath, 'utf8'))
      await corrupt({ cached, configuration })
      await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
      const result = launch(project, ['check', '.', '--json'], environment)
      assert.equal(result.status, 2, `${name}\n${result.stderr}`)
      assert.equal(result.stdout, '')
    })
  }

  await t.test('changed origin with command-scope spoof', async (t) => {
    const project = await projectFixture(t, release.source)
    const cache = await cacheFixture(t)
    const environment = acquisitionEnvironment(release.root, cache)
    assert.equal(launch(project, ['check', '.', '--json'], environment).status, 0)
    const cached = join(cache, release.source.tag_object)
    git(cached, ['remote', 'set-url', 'origin', 'https://example.invalid/wrong.git'])
    const result = launch(project, ['check', '.', '--json'], {
      ...environment,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'remote.origin.url',
      GIT_CONFIG_VALUE_1: repository,
    })
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
  })

  await t.test('changed tag object', async (t) => {
    const project = await projectFixture(t, { ...release.source, tag_object: '0'.repeat(40) })
    const cache = await cacheFixture(t)
    const result = launch(project, ['check', '.', '--json'], acquisitionEnvironment(release.root, cache))
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
  })
})
