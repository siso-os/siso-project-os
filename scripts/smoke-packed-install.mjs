#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(program, args, cwd, expected = 0) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, expected, `${program} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

const proofRoot = await mkdtemp(join(tmpdir(), 'siso-project-os-packed-proof-'))
try {
  const packageDirectory = join(proofRoot, 'package')
  const consumerDirectory = join(proofRoot, 'consumer')
  const projectDirectory = join(consumerDirectory, 'project')
  await mkdir(packageDirectory, { recursive: true })
  await mkdir(consumerDirectory, { recursive: true })
  await writeFile(join(consumerDirectory, 'package.json'), '{"private":true}\n', 'utf8')

  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packageDirectory], packageRoot).stdout)[0]
  const tarball = join(packageDirectory, packed.filename)
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumerDirectory)

  const installedPackageRoot = join(consumerDirectory, 'node_modules', '@siso', 'project-os')
  const installedPackage = JSON.parse(await readFile(join(installedPackageRoot, 'package.json'), 'utf8'))
  const bin = join(installedPackageRoot, 'bin', 'siso-project-os.mjs')
  run(process.execPath, [bin, 'init', projectDirectory, '--name', 'Packed restore proof'], consumerDirectory)

  const bootstrapPath = join(projectDirectory, 'fleet.bootstrap.json')
  await writeFile(bootstrapPath, await readFile(join(installedPackageRoot, 'packs', 'fleet', 'fleet.bootstrap.example.json'), 'utf8'))
  const plan = JSON.parse(run(process.execPath, [bin, 'fleet', 'plan', projectDirectory, '--config', bootstrapPath, '--json'], consumerDirectory).stdout)
  const installed = JSON.parse(run(process.execPath, [bin, 'fleet', 'init', projectDirectory, '--config', bootstrapPath, '--json'], consumerDirectory).stdout)
  const repeated = JSON.parse(run(process.execPath, [bin, 'fleet', 'init', projectDirectory, '--config', bootstrapPath, '--json'], consumerDirectory).stdout)
  const fleetCheck = JSON.parse(run(process.execPath, [bin, 'fleet', 'check', projectDirectory, '--json'], consumerDirectory).stdout)
  const projectCheck = JSON.parse(run(process.execPath, [bin, 'check', projectDirectory, '--json'], consumerDirectory).stdout)
  const manifest = JSON.parse(await readFile(join(projectDirectory, '.agents', 'fleet', 'PACK.json'), 'utf8'))

  assert.equal(installedPackage.version, '0.5.0')
  assert.equal(plan.ok, true)
  assert.equal(plan.summary.collision, 0)
  assert.equal(installed.ok, true)
  assert.equal(repeated.installed.length, 0)
  assert.ok(repeated.retained.includes('.agents/fleet/PACK.json'))
  assert.equal(fleetCheck.ok, true)
  assert.equal(projectCheck.ok, true)
  assert.equal(manifest.pack_version, '1.0.0')

  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    kind: 'packed-install-proof',
    package: `${installedPackage.name}@${installedPackage.version}`,
    tarball: {
      filename: packed.filename,
      shasum: packed.shasum,
      integrity: packed.integrity,
      entry_count: packed.entryCount,
    },
    install: {
      plan_ok: plan.ok,
      collisions: plan.summary.collision,
      pack_version: manifest.pack_version,
      idempotent_reinstall: repeated.installed.length === 0,
    },
    checks: { fleet: 'PASS', project: 'PASS' },
    temporary_state_removed: true,
  }, null, 2)}\n`)
} finally {
  await rm(proofRoot, { recursive: true, force: true })
}
