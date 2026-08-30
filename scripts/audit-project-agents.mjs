#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathExists } from '../src/shared.mjs'

const root = resolve(process.argv[2] || process.cwd())
const required = [
  'AGENTS.md',
  'CLAUDE.md',
  'PROJECT-OS.html',
  'FILE-TREE.html',
  '.agents/skills/project-operator/SKILL.md',
  '.agents/skills/project-operator/OPERATOR.html',
  '.project-os/generated/onboarding.html',
]

const files = []
for (const relative of required) {
  const path = join(root, relative)
  if (!(await pathExists(path))) throw new Error(`missing cold-pickup path: ${relative}`)
  const content = await readFile(path, 'utf8')
  files.push({ path: relative, bytes: Buffer.byteLength(content), sha256: null })
}

const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
const skill = await readFile(join(root, '.agents/skills/project-operator/SKILL.md'), 'utf8')
const operator = await readFile(join(root, '.agents/skills/project-operator/OPERATOR.html'), 'utf8')

const duplicateAuthorities = [
  (operator.match(/data-contract="project-os-operator\.v1"/g) || []).length !== 1,
  !/Canonical instructions:.*OPERATOR\.html/s.test(skill),
  !/not a second rules source/i.test(claude),
].filter(Boolean).length
const competingBootSequences = [
  (agents.match(/\.agents\/skills\/project-operator\/SKILL\.md/g) || []).length !== 1,
  !/\.agents\/skills\/project-operator\/SKILL\.md/.test(claude),
].filter(Boolean).length
const boundedContextProducer = /bounded|pointer/i.test(skill + operator)

const result = {
  schema_version: 1,
  root,
  first_read: files,
  first_read_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  first_read_tokens_estimate: Math.ceil(files.reduce((sum, file) => sum + file.bytes, 0) / 4),
  duplicate_authorities: duplicateAuthorities,
  competing_boot_sequences: competingBootSequences,
  bounded_context_producer: boundedContextProducer,
  pass: duplicateAuthorities === 0 && competingBootSequences === 0 && boundedContextProducer,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.pass) process.exitCode = 1
