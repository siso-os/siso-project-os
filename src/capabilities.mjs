import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { schemasRoot, pathExists } from './shared.mjs'
import { validateSchema } from './schema.mjs'

export const CAPABILITY_OWNERSHIP = ['INSTALL', 'DEPEND', 'PROJECT_LOCAL', 'ADAPTER', 'OMIT']

export const DEFAULT_DISCOVERY_ROUTES = Object.freeze([
  { kind: 'skill', engine: 'neutral', root: '.agents/skills', file: 'SKILL.md' },
  { kind: 'skill', engine: 'claude', root: '.claude/skills', file: 'SKILL.md' },
  { kind: 'skill', engine: 'codex', root: '.codex/skills', file: 'SKILL.md' },
  { kind: 'agent', engine: 'neutral', root: '.agents/agents', extensions: ['.json', '.md'] },
  { kind: 'agent', engine: 'claude', root: '.claude/agents', extensions: ['.json', '.md'] },
  { kind: 'agent', engine: 'codex', root: '.codex/agents', extensions: ['.json', '.md'] },
  { kind: 'command', engine: 'neutral', root: '.agents/commands', extensions: ['.json', '.md'] },
  { kind: 'command', engine: 'claude', root: '.claude/commands', extensions: ['.json', '.md'] },
  { kind: 'command', engine: 'codex', root: '.codex/commands', extensions: ['.json', '.md'] },
  { kind: 'command', engine: 'codex', root: '.codex/prompts', extensions: ['.json', '.md'] },
  { kind: 'recipe', engine: 'neutral', root: 'docs/proven-recipes', extensions: ['.html', '.md'] },
  { kind: 'adapter', engine: 'neutral', root: '.agents/adapters', extensions: ['.json', '.md'] },
  { kind: 'adapter', engine: 'project-os', root: '.project-os/adapters', extensions: ['.json', '.md'] },
  { kind: 'adapter', engine: 'claude', root: '.claude/adapters', extensions: ['.json', '.md'] },
  { kind: 'adapter', engine: 'codex', root: '.codex/adapters', extensions: ['.json', '.md'] },
  { kind: 'adapter', engine: 'ui', root: '.uihub/adapters', extensions: ['.json', '.md'] },
])

const DEFAULT_LIMITS = Object.freeze({
  maxFilesPerRoot: 200,
  maxTotalFiles: 1000,
  maxFileBytes: 262144,
  maxDepth: 5,
})

const SKIPPED_MARKDOWN = new Set(['INDEX.md', 'README.md'])

function posixPath(value) {
  return value.split(sep).join('/')
}

async function regularFileExists(path) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

function withinRoot(root, pointer) {
  const absolute = resolve(root, pointer)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`capability route escapes project root: ${pointer}`)
  return absolute
}

function boundedInteger(value, fallback, maximum) {
  if (!Number.isInteger(value) || value < 1) return fallback
  return Math.min(value, maximum)
}

function discoveryLimits(options = {}) {
  return {
    maxFilesPerRoot: boundedInteger(options.maxFilesPerRoot, DEFAULT_LIMITS.maxFilesPerRoot, 2000),
    maxTotalFiles: boundedInteger(options.maxTotalFiles, DEFAULT_LIMITS.maxTotalFiles, 10000),
    maxFileBytes: boundedInteger(options.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 1048576),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_LIMITS.maxDepth, 12),
  }
}

function routeMatches(route, name) {
  if (route.file) return name === route.file
  if (SKIPPED_MARKDOWN.has(name)) return false
  return route.extensions.includes(extname(name).toLowerCase())
}

async function scanRoute(projectRoot, route, limits, budget) {
  const routeRoot = withinRoot(projectRoot, route.root)
  if (!(await pathExists(routeRoot))) return { files: [], truncated: false, warnings: [] }

  const routeStat = await lstat(routeRoot)
  if (!routeStat.isDirectory()) {
    return {
      files: [],
      truncated: false,
      warnings: [{ code: 'discovery_root_not_directory', path: route.root, message: `${route.root} is not a directory` }],
    }
  }

  const files = []
  const warnings = []
  const queue = [{ absolute: routeRoot, depth: 0 }]
  let truncated = false
  while (queue.length > 0 && !truncated) {
    const current = queue.shift()
    const entries = (await readdir(current.absolute, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(current.absolute, entry.name)
      const path = posixPath(relative(projectRoot, absolute))
      if (entry.isSymbolicLink()) {
        warnings.push({ code: 'discovery_symlink_ignored', path, message: 'symbolic links are not followed during bounded discovery' })
        continue
      }
      if (entry.isDirectory()) {
        if (current.depth < limits.maxDepth) queue.push({ absolute, depth: current.depth + 1 })
        else warnings.push({ code: 'discovery_depth_reached', path, message: `discovery depth limit ${limits.maxDepth} reached` })
        continue
      }
      if (!entry.isFile() || !routeMatches(route, entry.name)) continue
      if (files.length >= limits.maxFilesPerRoot || budget.count >= limits.maxTotalFiles) {
        truncated = true
        warnings.push({
          code: 'discovery_file_limit_reached',
          path: route.root,
          message: `discovery stopped at its bounded file limit for ${route.root}`,
        })
        break
      }
      files.push(path)
      budget.count += 1
    }
  }
  return { files: files.sort(), truncated, warnings }
}

function unquote(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed.slice(1, -1).replaceAll("''", "'")
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function markdownMetadata(content) {
  const metadata = {}
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const end = content.indexOf('\n---', 4)
    if (end !== -1) {
      for (const line of content.slice(4, end).split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
        if (match) metadata[match[1]] = unquote(match[2])
      }
    }
  }
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null
  return { metadata, heading }
}

function fallbackId(kind, path) {
  if (kind === 'skill') return basename(resolve(path, '..'))
  const base = basename(path, extname(path))
  if (kind === 'recipe') return path
    .replace(/^docs\/proven-recipes\//, '')
    .replace(/\.md$/i, '')
    .split('/')
    .join('.')
  return base
}

function jsonIdentity(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const ids = {
    skill: ['skill_id', 'id', 'name'],
    agent: ['role_id', 'profile_id', 'agent_id', 'id', 'name'],
    command: ['command_id', 'id', 'name'],
    recipe: ['recipe_id', 'id', 'name'],
    adapter: ['adapter_id', 'capability_id', 'id', 'name'],
  }
  const id = ids[kind].map((key) => value[key]).find((candidate) => typeof candidate === 'string' && candidate.trim())
  const title = [value.title, value.name].find((candidate) => typeof candidate === 'string' && candidate.trim())
  const description = typeof value.description === 'string' && value.description.trim() ? value.description.trim() : null
  const ownership = CAPABILITY_OWNERSHIP.includes(value.ownership) ? value.ownership : 'PROJECT_LOCAL'
  return { id: id?.trim(), title: title?.trim(), description, ownership }
}

async function describeFile(projectRoot, route, path, limits) {
  const absolute = withinRoot(projectRoot, path)
  const fileStat = await lstat(absolute)
  const fallback = fallbackId(route.kind, path)
  if (fileStat.size > limits.maxFileBytes) {
    return {
      item: {
        kind: route.kind,
        id: fallback,
        title: fallback,
        description: null,
        engine: route.engine,
        ownership: 'PROJECT_LOCAL',
        path,
        format: extname(path).toLowerCase() === '.json' ? 'json' : 'markdown',
        status: 'oversize',
      },
      error: { code: 'capability_file_oversize', path, message: `file exceeds discovery byte limit ${limits.maxFileBytes}` },
    }
  }

  const content = await readFile(absolute, 'utf8')
  if (extname(path).toLowerCase() === '.json') {
    try {
      const value = JSON.parse(content)
      const identity = jsonIdentity(route.kind, value)
      return {
        item: {
          kind: route.kind,
          id: identity.id ?? fallback,
          title: identity.title ?? identity.id ?? fallback,
          description: identity.description,
          engine: route.engine,
          ownership: identity.ownership,
          path,
          format: 'json',
          status: 'valid',
        },
        error: null,
      }
    } catch (error) {
      return {
        item: {
          kind: route.kind,
          id: fallback,
          title: fallback,
          description: null,
          engine: route.engine,
          ownership: 'PROJECT_LOCAL',
          path,
          format: 'json',
          status: 'invalid',
        },
        error: { code: 'capability_json_invalid', path, message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  const { metadata, heading } = markdownMetadata(content)
  const ownership = CAPABILITY_OWNERSHIP.includes(metadata.ownership) ? metadata.ownership : 'PROJECT_LOCAL'
  return {
    item: {
      kind: route.kind,
      id: metadata.name || metadata.id || fallback,
      title: metadata.title || heading || metadata.name || fallback,
      description: metadata.description || null,
      engine: route.engine,
      ownership,
      path,
      format: 'markdown',
      status: 'valid',
    },
    error: null,
  }
}

function capabilityConflicts(items) {
  const groups = new Map()
  for (const item of items) {
    const key = `${item.kind}:${item.id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return [...groups.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([identity, matches]) => ({
      identity,
      paths: matches.map((item) => item.path).sort(),
      engines: [...new Set(matches.map((item) => item.engine))].sort(),
      message: `${identity} has multiple project-local definitions`,
    }))
    .sort((left, right) => left.identity.localeCompare(right.identity))
}

export async function discoverProjectCapabilities(projectRoot, options = {}) {
  const root = resolve(projectRoot)
  const limits = discoveryLimits(options)
  const routes = options.routes ?? DEFAULT_DISCOVERY_ROUTES
  const budget = { count: 0 }
  const items = []
  const errors = []
  const routeReports = []

  for (const route of routes) {
    let scanned
    try {
      scanned = await scanRoute(root, route, limits, budget)
    } catch (error) {
      scanned = {
        files: [],
        truncated: false,
        warnings: [{
          code: 'discovery_root_unreadable',
          path: route.root,
          message: error instanceof Error ? error.message : String(error),
        }],
      }
    }
    errors.push(...scanned.warnings)
    routeReports.push({ kind: route.kind, engine: route.engine, root: route.root, count: scanned.files.length, truncated: scanned.truncated })
    for (const path of scanned.files) {
      try {
        const described = await describeFile(root, route, path, limits)
        items.push(described.item)
        if (described.error) errors.push(described.error)
      } catch (error) {
        errors.push({ code: 'capability_file_unreadable', path, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  items.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id) || left.path.localeCompare(right.path))
  errors.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code))
  const kinds = ['skill', 'agent', 'command', 'recipe', 'adapter']
  const counts = Object.fromEntries(kinds.map((kind) => [kind, items.filter((item) => item.kind === kind).length]))

  return {
    schema_version: 1,
    limits: {
      max_files_per_root: limits.maxFilesPerRoot,
      max_total_files: limits.maxTotalFiles,
      max_file_bytes: limits.maxFileBytes,
      max_depth: limits.maxDepth,
    },
    counts,
    routes: routeReports,
    items,
    conflicts: capabilityConflicts(items),
    errors,
  }
}

async function packageSchema(name) {
  return JSON.parse(await readFile(join(schemasRoot, `${name}.schema.json`), 'utf8'))
}

function check(checks, id, status, message, options = {}) {
  checks.push({
    id,
    status,
    required: options.required ?? true,
    kind: options.kind ?? 'route',
    path: options.path ?? null,
    message,
    remediation: options.remediation ?? null,
  })
}

async function validateJsonRoute(root, pointer, schemaName, checks, id, required = true) {
  let value
  try {
    value = JSON.parse(await readFile(withinRoot(root, pointer), 'utf8'))
  } catch (error) {
    check(checks, id, required ? 'fail' : 'warn', `cannot read ${pointer}: ${error instanceof Error ? error.message : String(error)}`, {
      required,
      kind: 'schema',
      path: pointer,
      remediation: `restore a valid ${pointer}`,
    })
    return null
  }
  const schema = await packageSchema(schemaName)
  const violations = validateSchema(value, schema)
  if (violations.length > 0) {
    check(checks, id, required ? 'fail' : 'warn', `${pointer} violates ${schemaName}.schema.json: ${violations.map((entry) => `${entry.path} ${entry.message}`).join('; ')}`, {
      required,
      kind: 'schema',
      path: pointer,
      remediation: `repair ${pointer} against .project-os/schemas/${schemaName}.schema.json`,
    })
    return null
  }
  check(checks, id, 'pass', `${pointer} is valid`, { required, kind: 'schema', path: pointer })
  return value
}

function declaredProviderCapability(options, provider, capability) {
  const declared = options.providerCapabilities?.[provider]
  if (Array.isArray(declared)) return declared.includes(capability)
  if (declared instanceof Set) return declared.has(capability)
  return false
}

async function resolveDependency(root, capability, options) {
  const resolution = capability.resolution ?? {}
  if (resolution.type === 'node') {
    const version = options.runtime?.node_version ?? process.versions.node
    const major = Number(String(version).split('.')[0])
    return {
      ok: Number.isInteger(major) && major >= resolution.minimum_major,
      message: `Node.js ${version} ${major >= resolution.minimum_major ? 'satisfies' : 'does not satisfy'} >=${resolution.minimum_major}`,
      remediation: `install Node.js ${resolution.minimum_major} or newer`,
    }
  }

  if (declaredProviderCapability(options, capability.provider, capability.capability)) {
    return { ok: true, message: `${capability.provider} declares ${capability.capability}`, remediation: null }
  }

  const environment = options.env ?? process.env
  const providerRoot = options.providerRoots?.[capability.provider]
    ?? (resolution.root_env ? environment[resolution.root_env] : undefined)
  if (!providerRoot) {
    return {
      ok: false,
      message: `${capability.provider} route for ${capability.capability} is unresolved`,
      remediation: `declare providerRoots.${capability.provider} or set ${resolution.root_env ?? 'the provider root'}; no secret is required`,
    }
  }

  const relativePath = resolution.relative_path
  if (typeof relativePath !== 'string' || !relativePath) {
    return { ok: false, message: `${capability.id} has no provider-relative route`, remediation: 'add resolution.relative_path to its DEPEND declaration' }
  }
  const providerAbsolute = resolve(providerRoot)
  const target = resolve(providerAbsolute, relativePath)
  const rel = relative(providerAbsolute, target)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    return { ok: false, message: `${capability.id} provider route escapes its provider root`, remediation: 'use a provider-relative capability path' }
  }
  const exists = await regularFileExists(target)
  return {
    ok: exists,
    message: exists ? `${capability.provider} provides ${capability.capability}` : `${capability.provider} is present but ${capability.capability} is missing`,
    remediation: exists ? null : `install or expose ${relativePath} from ${capability.provider}`,
  }
}

export async function doctorProjectCapabilities(projectRoot, options = {}) {
  const root = resolve(projectRoot)
  const profilePath = options.profilePath ?? '.agents/project-profile.json'
  const checks = []
  const profile = await validateJsonRoute(root, profilePath, 'project-profile', checks, 'profile.schema')
  const declaredLimits = profile?.discovery
    ? {
        maxFilesPerRoot: profile.discovery.max_files_per_root,
        maxTotalFiles: profile.discovery.max_total_files,
        maxFileBytes: profile.discovery.max_file_bytes,
        maxDepth: profile.discovery.max_depth,
      }
    : {}
  const discovery = await discoverProjectCapabilities(root, { ...declaredLimits, ...options.discovery })
  if (!profile) {
    return {
      schema_version: 1,
      ok: false,
      profile_id: null,
      summary: { passed: 0, warned: 0, failed: checks.filter((entry) => entry.status === 'fail').length },
      checks,
      discovery,
    }
  }

  const operatorShimPath = withinRoot(root, profile.canonical_operator)
  const operatorAuthorityPath = withinRoot(root, profile.operator_authority)
  const operatorShimExists = await regularFileExists(operatorShimPath)
  const operatorAuthorityExists = await regularFileExists(operatorAuthorityPath)
  const operatorShim = operatorShimExists ? await readFile(operatorShimPath, 'utf8') : ''
  const operatorRoutesAuthority = operatorShimExists && operatorAuthorityExists && operatorShim.includes(profile.operator_authority.split('/').at(-1))
  check(checks, 'operator.authority-route', operatorRoutesAuthority ? 'pass' : 'fail', operatorRoutesAuthority
    ? `${profile.canonical_operator} resolves to ${profile.operator_authority}`
    : `${profile.canonical_operator} does not resolve to its HTML authority ${profile.operator_authority}`, {
    kind: 'bridge',
    path: profile.canonical_operator,
    remediation: `keep ${profile.canonical_operator} as a thin discovery shim that points to ${profile.operator_authority}`,
  })

  const manifests = []
  for (const pointer of profile.capability_manifests) {
    const manifest = await validateJsonRoute(root, pointer, 'capability-manifest', checks, `manifest.${pointer}`)
    if (manifest) {
      const ids = new Set()
      const duplicates = []
      for (const capability of manifest.capabilities) {
        if (ids.has(capability.id)) duplicates.push(capability.id)
        ids.add(capability.id)
      }
      if (duplicates.length > 0) {
        check(checks, `manifest.${pointer}.unique-ids`, 'fail', `${pointer} repeats capability IDs: ${[...new Set(duplicates)].sort().join(', ')}`, {
          kind: 'schema',
          path: pointer,
          remediation: 'keep exactly one declaration for each capability ID',
        })
      } else {
        check(checks, `manifest.${pointer}.unique-ids`, 'pass', `${pointer} has unique capability IDs`, { kind: 'schema', path: pointer })
      }
      manifests.push(manifest)
    }
  }
  for (const pointer of profile.agent_profiles) await validateJsonRoute(root, pointer, 'agent-profile', checks, `agent-profile.${pointer}`)
  for (const pointer of profile.commands) await validateJsonRoute(root, pointer, 'command', checks, `command.${pointer}`)
  for (const pointer of profile.verification_adapters) await validateJsonRoute(root, pointer, 'verification-adapter', checks, `adapter.${pointer}`)

  for (const manifest of manifests) {
    for (const capability of manifest.capabilities) {
      const required = capability.required
      if (capability.ownership === 'OMIT') {
        check(checks, `capability.${capability.id}`, 'pass', `${capability.id} is intentionally omitted`, { required: false, kind: 'capability' })
        continue
      }
      if (capability.ownership === 'DEPEND') {
        const result = await resolveDependency(root, capability, options)
        check(checks, `capability.${capability.id}`, result.ok ? 'pass' : (required ? 'fail' : 'warn'), result.message, {
          required,
          kind: 'dependency',
          remediation: result.remediation,
        })
        continue
      }
      const exists = typeof capability.path === 'string' && await regularFileExists(withinRoot(root, capability.path))
      check(checks, `capability.${capability.id}`, exists ? 'pass' : (required ? 'fail' : 'warn'), exists ? `${capability.id} is routed at ${capability.path}` : `${capability.id} is missing its declared route ${capability.path ?? '(none)'}`, {
        required,
        kind: 'capability',
        path: capability.path ?? null,
        remediation: exists ? null : `install or migrate ${capability.path ?? capability.id}`,
      })
    }
  }

  for (const bridge of profile.bridges) {
    const bridgePath = withinRoot(root, bridge.path)
    const exists = await regularFileExists(bridgePath)
    const content = exists ? await readFile(bridgePath, 'utf8') : ''
    const routed = exists && content.includes(bridge.canonical)
    check(checks, `bridge.${bridge.engine}`, routed ? 'pass' : 'fail', routed ? `${bridge.engine} bridge routes to ${bridge.canonical}` : (exists ? `${bridge.engine} bridge does not point to ${bridge.canonical}` : `${bridge.engine} bridge is missing at ${bridge.path}`), {
      kind: 'bridge',
      path: bridge.path,
      remediation: routed ? null : `restore one pointer to ${bridge.canonical} in ${bridge.path} without copying the canonical skill body`,
    })
  }

  const agentRules = join(root, 'AGENTS.md')
  if (await pathExists(agentRules)) {
    const content = await readFile(agentRules, 'utf8')
    const routed = content.includes(profile.canonical_operator)
    check(checks, 'bridge.root-agent-rules', routed ? 'pass' : 'warn', routed ? `AGENTS.md routes to ${profile.canonical_operator}` : `AGENTS.md does not yet route to ${profile.canonical_operator}`, {
      required: false,
      kind: 'bridge',
      path: 'AGENTS.md',
      remediation: `merge one pointer to ${profile.canonical_operator} into the existing root rules; do not duplicate the skill body`,
    })
  } else {
    check(checks, 'bridge.root-agent-rules', 'warn', 'root AGENTS.md is absent', {
      required: false,
      kind: 'bridge',
      path: 'AGENTS.md',
      remediation: 'install or author one root agent router before relying on cold pickup',
    })
  }

  for (const error of discovery.errors) {
    check(checks, `discovery.${error.code}.${error.path}`, error.code === 'capability_json_invalid' ? 'fail' : 'warn', error.message, {
      required: error.code === 'capability_json_invalid',
      kind: 'discovery',
      path: error.path,
      remediation: error.code === 'capability_json_invalid' ? `repair or remove the invalid capability record at ${error.path}` : null,
    })
  }
  for (const conflict of discovery.conflicts) {
    const canonicalConflict = conflict.identity === 'skill:project-operator'
    check(checks, `discovery.conflict.${conflict.identity}`, canonicalConflict ? 'fail' : 'warn', `${conflict.message}: ${conflict.paths.join(', ')}`, {
      required: canonicalConflict,
      kind: 'discovery',
      remediation: 'select one canonical project-local definition and make engine-specific files pointer-only bridges',
    })
  }

  checks.sort((left, right) => left.id.localeCompare(right.id))
  const summary = {
    passed: checks.filter((entry) => entry.status === 'pass').length,
    warned: checks.filter((entry) => entry.status === 'warn').length,
    failed: checks.filter((entry) => entry.status === 'fail').length,
  }
  return {
    schema_version: 1,
    ok: summary.failed === 0,
    profile_id: profile.profile_id,
    canonical_operator: profile.canonical_operator,
    operator_authority: profile.operator_authority,
    summary,
    checks,
    discovery,
  }
}
