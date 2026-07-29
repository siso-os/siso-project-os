import { createHash } from 'node:crypto'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function buildExtractionLedger({ source, source_revision, requested_scopes, actual_scopes, scope_notes = [], tracked_files, clusters }) {
  const compiled = clusters.map((cluster) => ({ ...cluster, matcher: new RegExp(cluster.pattern) }))
  const assignments = new Map(compiled.map((cluster) => [cluster.id, []]))
  const unmatched = []
  const multiplyMatched = []

  for (const file of [...tracked_files].sort((left, right) => left.path.localeCompare(right.path))) {
    const matches = compiled.filter((cluster) => cluster.matcher.test(file.path))
    if (matches.length === 0) unmatched.push(file.path)
    else if (matches.length > 1) multiplyMatched.push({ path: file.path, cluster_ids: matches.map((match) => match.id) })
    else assignments.get(matches[0].id).push(file)
  }

  const clusterRows = compiled.map(({ matcher, ...cluster }) => {
    const files = assignments.get(cluster.id)
    return {
      ...cluster,
      file_count: files.length,
      tracked_blob_digest: sha256(JSON.stringify(files.map((file) => [file.path, file.blob]))),
      files,
    }
  })
  const payload = {
    schema_version: 1,
    kind: 'private-extraction-disposition-ledger',
    source,
    source_revision,
    requested_scopes,
    actual_scopes,
    scope_notes,
    inventory_policy: 'tracked-files-only; ignored dependencies, logs, caches, and machine state excluded',
    tracked_file_count: tracked_files.length,
    tracked_manifest_digest: sha256(JSON.stringify([...tracked_files].sort((left, right) => left.path.localeCompare(right.path)))),
    clusters: clusterRows,
    uncategorized: unmatched,
    multiply_categorized: multiplyMatched,
  }
  return { ...payload, complete: unmatched.length === 0 && multiplyMatched.length === 0, ledger_digest: sha256(JSON.stringify(payload)) }
}

export function extractionLedgerProblems(ledger) {
  const problems = []
  if (!ledger?.complete) problems.push('ledger is not complete')
  if ((ledger?.uncategorized ?? []).length > 0) problems.push(`${ledger.uncategorized.length} files are uncategorized`)
  if ((ledger?.multiply_categorized ?? []).length > 0) problems.push(`${ledger.multiply_categorized.length} files are multiply categorized`)
  const counted = (ledger?.clusters ?? []).reduce((sum, cluster) => sum + (cluster.file_count ?? 0), 0)
  if (counted !== ledger?.tracked_file_count) problems.push(`cluster count ${counted} does not equal tracked file count ${ledger?.tracked_file_count}`)
  for (const cluster of ledger?.clusters ?? []) {
    if (!['install', 'depend', 'project_local', 'adapter', 'omit'].includes(cluster.disposition)) problems.push(`${cluster.id} has invalid disposition ${cluster.disposition}`)
    if (cluster.file_count === 0) problems.push(`${cluster.id} matched no files`)
  }
  return problems
}
