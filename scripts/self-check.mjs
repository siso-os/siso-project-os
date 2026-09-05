#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schemasRoot, templateRoot, walkFiles } from '../src/shared.mjs'
import { validateSchema } from '../src/schema.mjs'

const failures = []
const schemaFiles = (await walkFiles(schemasRoot)).filter((file) => file.endsWith('.json'))
for (const file of schemaFiles) {
  try {
    JSON.parse(await readFile(join(schemasRoot, file), 'utf8'))
  } catch (error) {
    failures.push(`invalid schema ${file}: ${error.message}`)
  }
}

const banned = /(?:stripchat|camsoda|chaturbate|\/Users\/shaansisodia|\.env\.local|BIFROST_VIRTUAL_KEY)/i
const packageRoot = join(new URL('..', import.meta.url).pathname)
for (const root of [templateRoot, join(packageRoot, 'src')]) {
  for (const file of await walkFiles(root)) {
    const content = await readFile(join(root, file), 'utf8')
    if (banned.test(content)) failures.push(`banned source-specific material in ${file}`)
  }
}


for (const file of await walkFiles(packageRoot)) {
  if (file.startsWith('.git/')) continue
  if (!/\.(?:html|md|mjs|json)$/.test(file)) continue
  const content = await readFile(join(packageRoot, file), 'utf8')
  if (/oracle[- ]streaming/i.test(content)) failures.push(`source-project name escaped provenance boundary in ${file}`)
}

const markdownAllowed = (file) => file === 'AGENTS.md'
  || file === 'template/AGENTS.md'
  || file === 'template/CLAUDE.md'
  || file === 'template/.agents/PAGE.md'
  || file === 'template/.agents/HANDOFF.md'
  || /^template\/\.agents\/skills\/[^/]+\/SKILL\.md$/.test(file)
for (const file of (await walkFiles(packageRoot)).filter((path) => path.endsWith('.md') && !path.startsWith('.git/'))) {
  if (!markdownAllowed(file)) failures.push(`unauthorized Markdown authority: ${file}`)
}

for (const directory of ['docs', 'template/.agents', 'template/.uihub', 'template/docs']) {
  for (const file of (await walkFiles(join(packageRoot, directory))).filter((path) => path.endsWith('.html'))) {
    const content = await readFile(join(packageRoot, directory, file), 'utf8')
    if (!/^<!doctype html>/i.test(content)) failures.push(`HTML authority lacks doctype: ${directory}/${file}`)
    if (!/type="application\/json"/.test(content)) failures.push(`HTML authority lacks embedded JSON contract: ${directory}/${file}`)
  }
}

const documentSchema = JSON.parse(await readFile(join(schemasRoot, 'document.schema.json'), 'utf8'))
for (const file of (await walkFiles(join(templateRoot, 'docs'))).filter((path) => /\.(?:html|md)$/.test(path))) {
  const content = await readFile(join(templateRoot, 'docs', file), 'utf8')
  const match = content.match(/<!-- project-os-meta\s*\n([\s\S]*?)\n-->/)
  if (!match) failures.push(`missing project-os-meta in template/docs/${file}`)
  else {
    try {
      const violations = validateSchema(JSON.parse(match[1]), documentSchema)
      for (const violation of violations) failures.push(`invalid document metadata in ${file}: ${violation.path} ${violation.message}`)
    } catch (error) {
      failures.push(`invalid document metadata JSON in ${file}: ${error.message}`)
    }
  }
}

if (schemaFiles.length < 8) failures.push(`expected at least 8 schemas, found ${schemaFiles.length}`)
if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`self-check: PASS (${schemaFiles.length} schemas)\n`)
}
