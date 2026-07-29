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
  if (file === 'docs/provenance.md' || file.startsWith('.git/')) continue
  if (!/\.(?:md|mjs|json)$/.test(file)) continue
  const content = await readFile(join(packageRoot, file), 'utf8')
  if (/oracle[- ]streaming/i.test(content)) failures.push(`source-project name escaped provenance boundary in ${file}`)
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
