#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY = 'https://github.com/sisodias/siso-project-os.git'
const BIN = 'bin/siso-project-os.mjs'
const OBJECT_ID = /^[0-9a-f]{40}$/
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function launcherError(message, code = 1) {
  const error = new Error(message)
  error.exitCode = code
  return error
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error?.code === 'ENOENT') throw launcherError('git is required before the Project OS runtime cache can be used', 3)
  if (result.error || result.status !== 0) throw launcherError(`Git provenance check failed: ${options.label ?? args[0]}`, 2)
  return result.stdout.trim()
}

function assertGit() {
  git(['--version'], { label: 'git prerequisite' })
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw launcherError(`${label} must be an object`, 2)
  const observed = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) throw launcherError(`${label} has an invalid shape`, 2)
}

async function readBinding() {
  let configuration
  try {
    configuration = JSON.parse(await readFile(join(PROJECT_ROOT, '.project-os', 'project.json'), 'utf8'))
  } catch {
    throw launcherError('the project launcher configuration is missing or invalid', 2)
  }
  const launcher = configuration.launcher
  exactKeys(launcher, ['schema_version', 'program', 'arguments', 'cwd', 'source', 'cache'], 'launcher')
  if (launcher.schema_version !== 2 || launcher.program !== 'node' || launcher.cwd !== 'project-root') {
    throw launcherError('the project launcher contract is unsupported', 2)
  }
  if (JSON.stringify(launcher.arguments) !== JSON.stringify(['.project-os/project-os-launcher.mjs'])) {
    throw launcherError('the project launcher path must be project-relative', 2)
  }
  exactKeys(launcher.source, ['transport', 'repository', 'tag', 'tag_object', 'commit', 'tree', 'bin'], 'launcher source')
  const source = launcher.source
  if (source.transport !== 'git' || source.repository !== REPOSITORY || source.bin !== BIN) {
    throw launcherError('the project launcher source is not the approved public Git runtime', 2)
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(source.tag)) throw launcherError('the project launcher tag is invalid', 2)
  for (const key of ['tag_object', 'commit', 'tree']) {
    if (!OBJECT_ID.test(source[key])) throw launcherError(`the project launcher ${key} is invalid`, 2)
  }
  if (configuration.project_os_version !== source.tag.slice(1)) {
    throw launcherError('the project version differs from the pinned runtime tag', 2)
  }
  exactKeys(launcher.cache, ['scope', 'key', 'environment_override'], 'launcher cache')
  if (launcher.cache.scope !== 'user' || launcher.cache.key !== 'tag-object' || launcher.cache.environment_override !== 'SISO_PROJECT_OS_CACHE_DIR') {
    throw launcherError('the project launcher cache contract is invalid', 2)
  }
  return source
}

function cacheRoot() {
  const override = process.env.SISO_PROJECT_OS_CACHE_DIR?.trim()
  if (override) return resolve(override)
  const home = homedir()
  if (!home) throw launcherError('a user cache directory is unavailable', 3)
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'siso-project-os')
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'siso-project-os')
  return join(process.env['XDG_CACHE_HOME'] || join(home, '.cache'), 'siso-project-os')
}

async function regularFile(target, label) {
  try {
    if ((await lstat(target)).isFile()) return
  } catch {}
  throw launcherError(label, 2)
}

async function verifyCheckout(root, source) {
  if (git(['config', '--local', '--get', 'remote.origin.url'], { cwd: root, label: 'origin' }) !== source.repository) {
    throw launcherError('cached runtime origin differs from the approved public repository', 2)
  }
  if (git(['rev-parse', `refs/tags/${source.tag}`], { cwd: root, label: 'tag object' }) !== source.tag_object) {
    throw launcherError('cached runtime tag object differs from the install binding', 2)
  }
  if (git(['cat-file', '-t', source.tag_object], { cwd: root, label: 'tag type' }) !== 'tag') {
    throw launcherError('cached runtime tag is not annotated', 2)
  }
  if (git(['rev-parse', `refs/tags/${source.tag}^{}`], { cwd: root, label: 'tag commit' }) !== source.commit) {
    throw launcherError('cached runtime commit differs from the install binding', 2)
  }
  if (git(['rev-parse', `refs/tags/${source.tag}^{}^{tree}`], { cwd: root, label: 'tag tree' }) !== source.tree) {
    throw launcherError('cached runtime tree differs from the install binding', 2)
  }
  if (git(['rev-parse', 'HEAD'], { cwd: root, label: 'detached HEAD' }) !== source.commit) {
    throw launcherError('cached runtime HEAD differs from the install binding', 2)
  }
  const symbolic = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (symbolic.error?.code === 'ENOENT') throw launcherError('git is required before the Project OS runtime cache can be used', 3)
  if (symbolic.status === 0 || ![1, 128].includes(symbolic.status)) throw launcherError('cached runtime HEAD is not detached', 2)
  if (git(['rev-parse', 'HEAD^{tree}'], { cwd: root, label: 'HEAD tree' }) !== source.tree) {
    throw launcherError('cached runtime checkout tree differs from the install binding', 2)
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], { cwd: root, label: 'clean status' }) !== '') {
    throw launcherError('cached runtime checkout is dirty', 2)
  }
  await regularFile(join(root, source.bin), 'cached runtime direct Node bin is missing or not a regular file')
  return join(root, source.bin)
}

function processIsDead(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

async function removeProvenStaleLock(lockPath) {
  let record
  try {
    record = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch {
    return false
  }
  if (record.host !== hostname() || !Number.isInteger(record.pid) || !processIsDead(record.pid)) return false
  await unlink(lockPath).catch(() => {})
  return true
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), created_at: new Date().toISOString() })}\n`)
      return handle
    } catch (error) {
      if (error?.code !== 'EEXIST') throw launcherError('runtime cache lock could not be created', 3)
      if (await removeProvenStaleLock(lockPath)) continue
      await delay(100)
    }
  }
  throw launcherError('runtime cache acquisition is already in progress', 3)
}

async function acquireRuntime(source) {
  assertGit()
  const root = cacheRoot()
  const cached = join(root, source.tag_object)
  try {
    return await verifyCheckout(cached, source)
  } catch (error) {
    try {
      await lstat(cached)
      throw error
    } catch (stateError) {
      if (stateError !== error && stateError?.code !== 'ENOENT') throw error
      if (stateError === error) throw error
    }
  }

  await mkdir(root, { recursive: true })
  const lockPath = join(root, `.lock-${source.tag_object}`)
  const lock = await acquireLock(lockPath)
  let temporary = null
  try {
    try {
      return await verifyCheckout(cached, source)
    } catch (error) {
      try {
        await lstat(cached)
        throw error
      } catch (stateError) {
        if (stateError !== error && stateError?.code !== 'ENOENT') throw error
        if (stateError === error) throw error
      }
    }
    temporary = join(root, `.acquire-${source.tag_object}-${process.pid}-${randomUUID()}`)
    git(['clone', '--filter=blob:none', '--no-checkout', source.repository, temporary], { label: 'clone' })
    git(['remote', 'set-url', 'origin', source.repository], { cwd: temporary, label: 'canonical origin' })
    git(['fetch', '--depth=1', 'origin', 'tag', source.tag], { cwd: temporary, label: 'tag fetch' })
    if (git(['config', '--local', '--get', 'remote.origin.url'], { cwd: temporary, label: 'origin' }) !== source.repository) {
      throw launcherError('acquired runtime origin differs from the approved public repository', 2)
    }
    if (git(['rev-parse', `refs/tags/${source.tag}`], { cwd: temporary, label: 'tag object' }) !== source.tag_object) {
      throw launcherError('acquired runtime tag object differs from the install binding', 2)
    }
    if (git(['cat-file', '-t', source.tag_object], { cwd: temporary, label: 'tag type' }) !== 'tag') {
      throw launcherError('acquired runtime tag is not annotated', 2)
    }
    if (git(['rev-parse', `refs/tags/${source.tag}^{}`], { cwd: temporary, label: 'tag commit' }) !== source.commit) {
      throw launcherError('acquired runtime commit differs from the install binding', 2)
    }
    if (git(['rev-parse', `refs/tags/${source.tag}^{}^{tree}`], { cwd: temporary, label: 'tag tree' }) !== source.tree) {
      throw launcherError('acquired runtime tree differs from the install binding', 2)
    }
    git(['checkout', '--detach', source.commit], { cwd: temporary, label: 'detached checkout' })
    await verifyCheckout(temporary, source)
    try {
      await rename(temporary, cached)
      temporary = null
    } catch {
      throw launcherError('verified runtime cache could not be installed atomically', 3)
    }
    return verifyCheckout(cached, source)
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {})
    await lock.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
  }
}

try {
  const source = await readBinding()
  const bin = await acquireRuntime(source)
  const child = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  })
  if (child.error) throw launcherError('verified Project OS runtime could not be executed', 3)
  process.exitCode = Number.isInteger(child.status) ? child.status : 1
} catch (error) {
  process.stderr.write(`project-os launcher: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
}
