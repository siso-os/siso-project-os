#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildExtractionLedger, extractionLedgerProblems } from '../src/extraction-ledger.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const sourceRoot = option('--source')
const configPath = option('--config')
const outputPath = option('--output')
if (!sourceRoot || !configPath || !outputPath) throw new Error('usage: generate-extraction-ledger --source <git-root> --config <private-json> --output <private-json>')

const config = JSON.parse(await readFile(resolve(configPath), 'utf8'))
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' })
if (revision.status !== 0) throw new Error(`cannot resolve source revision: ${revision.stderr.trim()}`)
const inventory = spawnSync('git', ['ls-files', '-s', '--', ...config.actual_scopes], { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (inventory.status !== 0) throw new Error(`cannot inventory source: ${inventory.stderr.trim()}`)
const trackedFiles = inventory.stdout.split('\n').filter(Boolean).map((line) => {
  const match = line.match(/^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/)
  if (!match) throw new Error(`unexpected git ls-files row: ${line}`)
  return { mode: match[1], blob: match[2], stage: Number(match[3]), path: match[4] }
})
const ledger = buildExtractionLedger({
  source: config.source,
  source_revision: revision.stdout.trim(),
  requested_scopes: config.requested_scopes,
  actual_scopes: config.actual_scopes,
  scope_notes: config.scope_notes ?? [],
  tracked_files: trackedFiles,
  clusters: config.clusters,
})
const problems = extractionLedgerProblems(ledger)
await writeFile(resolve(outputPath), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
if (problems.length > 0) throw new Error(`incomplete extraction ledger:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
process.stdout.write(`extraction-ledger: PASS (${ledger.tracked_file_count} tracked files, ${ledger.clusters.length} clusters)\n`)
