import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { discoverProjectCapabilities } from './capabilities.mjs'
import { validateSchema } from './schema.mjs'
import { pathExists, schemasRoot, templateRoot, walkFiles, writeJsonAtomic } from './shared.mjs'
import { runtimeTemplateReplacements, writeInstallManifest } from './upgrade.mjs'

export const FULL_PROFILE_FILES = Object.freeze([
  '.agents/project-profile.json',
  '.agents/capabilities/project-os.json',
  '.agents/skills/project-operator/SKILL.md',
  '.agents/skills/project-operator/OPERATOR.html',
  '.agents/agents/project-operator.json',
  '.agents/commands/project-os-onboard.json',
  '.agents/commands/project-os-check.json',
  '.agents/adapters/project-os-check.json',
  'CLAUDE.md',
  'docs/project-os/CAPABILITIES.html',
])

const RUNTIME_SHIMS = new Set(['AGENTS.md', 'CLAUDE.md'])
const RUNTIME_MARKER = 'siso-project-os:runtime-route-v1'

async function rootMode(root) {
  if (!(await pathExists(root))) return 'greenfield'
  const entries = await readdir(root)
  return entries.length === 0 ? 'greenfield' : 'existing'
}

async function compareAsset(root, path) {
  const source = await readFile(join(templateRoot, path), 'utf8')
  const target = join(root, path)
  if (!(await pathExists(target))) return { action: 'create', path, source: `template/${path}`, content: source }
  try {
    const existing = await readFile(target, 'utf8')
    if (existing === source) return { action: 'retain', path, source: `template/${path}`, content: source }
    return { action: 'preserve', path, source: `template/${path}`, content: source, reason: 'target content differs' }
  } catch (error) {
    return { action: 'preserve', path, source: `template/${path}`, content: source, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function agentRulesRoute(root) {
  const path = join(root, 'AGENTS.md')
  if (!(await pathExists(path))) return { present: false, routed: false }
  try {
    const content = await readFile(path, 'utf8')
    return { present: true, routed: content.includes('.agents/skills/project-operator/SKILL.md') }
  } catch {
    return { present: true, routed: false }
  }
}

function migrationPlan(mode, operations, discovery, rules) {
  const steps = []
  let step = 1
  const preserved = operations.filter((entry) => entry.action === 'preserve')
  if (preserved.length > 0) {
    steps.push({ step: step++, action: 'review-collisions', status: 'required', paths: preserved.map((entry) => entry.path), description: 'Choose the current authority for every differing target; no file will be overwritten.' })
  }
  if (discovery.conflicts.length > 0) {
    steps.push({ step: step++, action: 'consolidate-capability-definitions', status: 'required', identities: discovery.conflicts.map((entry) => entry.identity), description: 'Move reusable project behavior to one .agents canonical source and replace engine copies with pointers.' })
  }
  steps.push({ step: step++, action: 'install-full-profile', status: preserved.length > 0 ? 'blocked' : 'ready', paths: operations.filter((entry) => entry.action === 'create').map((entry) => entry.path), description: `${mode === 'greenfield' ? 'Create' : 'Add'} only missing full-profile files.` })
  if (!rules.routed) {
    steps.push({ step: step++, action: 'merge-root-route', status: 'manual', paths: ['AGENTS.md'], description: 'Add one pointer to .agents/skills/project-operator/SKILL.md in the canonical root rules; do not copy its contents.' })
  }
  steps.push({ step: step++, action: 'detect-runtime', status: 'ready-after-install', runtimes: ['codex-cli', 'claude-code'], description: 'Use the current agent CLI directly; declare Agent Base only when optional fleet orchestration is wanted.' })
  steps.push({ step, action: 'doctor', status: 'ready-after-install', description: 'Run doctorProjectCapabilities and resolve every required failure before calling the full profile operational.' })
  return steps
}

export async function planFullProfileAdoption(projectRoot, options = {}) {
  const root = resolve(projectRoot)
  const mode = await rootMode(root)
  const operations = []
  for (const path of FULL_PROFILE_FILES) operations.push(await compareAsset(root, path))
  const discovery = await discoverProjectCapabilities(root, options.discovery)
  const rules = await agentRulesRoute(root)
  const targetCollisions = operations
    .filter((entry) => entry.action === 'preserve')
    .map((entry) => ({ code: 'target_collision', path: entry.path, message: entry.reason }))
  const capabilityCollisions = discovery.conflicts.map((entry) => ({
    code: 'capability_identity_collision',
    identity: entry.identity,
    paths: entry.paths,
    message: entry.message,
  }))
  const migration = migrationPlan(mode, operations, discovery, rules)

  return {
    schema_version: 1,
    profile: 'full',
    mode,
    non_destructive: true,
    can_apply: targetCollisions.length === 0,
    idempotent: operations.every((entry) => entry.action === 'retain'),
    summary: {
      create: operations.filter((entry) => entry.action === 'create').length,
      retain: operations.filter((entry) => entry.action === 'retain').length,
      preserve: targetCollisions.length,
      discovered_capabilities: discovery.items.length,
      capability_conflicts: capabilityCollisions.length,
    },
    operations: operations.map(({ content, ...entry }) => entry),
    collisions: [...targetCollisions, ...capabilityCollisions],
    existing_capabilities: discovery,
    migration,
  }
}

export async function applyFullProfileAdoption(projectRoot, options = {}) {
  const root = resolve(projectRoot)
  const plan = await planFullProfileAdoption(root, options)
  const blockers = plan.collisions.filter((entry) => entry.code === 'target_collision')
  if (blockers.length > 0) {
    const error = new Error(`full-profile adoption would overwrite existing files:\n${blockers.map((entry) => `- ${entry.path}`).join('\n')}`)
    error.exitCode = 2
    error.plan = plan
    throw error
  }
  if (options.dryRun) return { ok: true, dry_run: true, created: [], retained: plan.operations.filter((entry) => entry.action === 'retain').map((entry) => entry.path), plan }

  const created = []
  try {
    await mkdir(root, { recursive: true })
    for (const operation of plan.operations) {
      if (operation.action !== 'create') continue
      const target = join(root, operation.path)
      const source = await readFile(join(templateRoot, operation.path), 'utf8')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, source, { encoding: 'utf8', flag: 'wx' })
      created.push(target)
    }
  } catch (error) {
    for (const path of created.reverse()) await unlink(path).catch(() => {})
    throw error
  }
  return {
    ok: true,
    dry_run: false,
    created: created.map((path) => path.slice(root.length + 1)),
    retained: plan.operations.filter((entry) => entry.action === 'retain').map((entry) => entry.path),
    plan,
  }
}

async function projectReplacements(root, options = {}) {
  let existing = {}
  const configPath = join(root, '.project-os', 'project.json')
  if (await pathExists(configPath)) {
    try {
      existing = JSON.parse(await readFile(configPath, 'utf8'))
    } catch {}
  }
  const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : (existing.project_name ?? basename(root))
  return {
    '{{PROJECT_NAME}}': name,
    '{{PROJECT_NAME_JSON}}': JSON.stringify(name),
    '{{PROJECT_NAME_HTML}}': htmlEscape(name),
    '{{PROJECT_SUMMARY_JSON}}': JSON.stringify(typeof options.summary === 'string' ? options.summary.trim() : (existing.project_summary ?? '')),
    '{{DESIRED_OUTCOME_JSON}}': JSON.stringify(typeof options.outcome === 'string' ? options.outcome.trim() : (existing.desired_outcome ?? '')),
    ...runtimeTemplateReplacements(options.runtimeSource),
  }
}

function renderTemplate(content, replacements) {
  let rendered = content
  for (const [token, value] of Object.entries(replacements)) rendered = rendered.split(token).join(value)
  return rendered
}

function runtimeRoute(path) {
  const engine = path === 'CLAUDE.md' ? 'Claude' : 'Agent'
  return `\n<!-- ${RUNTIME_MARKER}:begin -->\n## SISO Project OS runtime route\n\n${engine} runtime: load \`.agents/skills/project-operator/SKILL.md\`, then follow its canonical HTML authority.\n<!-- ${RUNTIME_MARKER}:end -->\n`
}

async function projectAdoptionOperations(root, options = {}) {
  const replacements = await projectReplacements(root, options)
  const operations = []
  for (const path of await walkFiles(templateRoot)) {
    const content = renderTemplate(await readFile(join(templateRoot, path), 'utf8'), replacements)
    const target = join(root, path)
    if (!(await pathExists(target))) {
      operations.push({ action: 'create', path, source: `template/${path}`, content })
      continue
    }
    try {
      const existing = await readFile(target, 'utf8')
      if (existing === content) operations.push({ action: 'retain', path, source: `template/${path}`, content })
      else if (RUNTIME_SHIMS.has(path) && !existing.includes(RUNTIME_MARKER) && !existing.includes('.agents/skills/project-operator/SKILL.md')) {
        operations.push({ action: 'merge-route', path, source: `template/${path}`, content: `${existing.replace(/\s*$/, '')}${runtimeRoute(path)}`, reason: 'preserve existing rules and append one runtime pointer' })
      } else if (RUNTIME_SHIMS.has(path) && (existing.includes(RUNTIME_MARKER) || existing.includes('.agents/skills/project-operator/SKILL.md'))) {
        operations.push({ action: 'retain', path, source: `template/${path}`, content: existing, reason: 'existing runtime route is already present' })
      } else {
        operations.push({ action: 'preserve', path, source: `template/${path}`, content, reason: 'target content differs; manual authority decision required' })
      }
    } catch (error) {
      operations.push({ action: 'preserve', path, source: `template/${path}`, content, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const file of await walkFiles(schemasRoot)) {
    const path = `.project-os/schemas/${file}`
    const content = await readFile(join(schemasRoot, file), 'utf8')
    const target = join(root, path)
    if (!(await pathExists(target))) operations.push({ action: 'create', path, source: `schemas/${file}`, content })
    else {
      try {
        const existing = await readFile(target, 'utf8')
        operations.push(existing === content
          ? { action: 'retain', path, source: `schemas/${file}`, content }
          : { action: 'preserve', path, source: `schemas/${file}`, content, reason: 'installed schema differs; explicit upgrade required' })
      } catch (error) {
        operations.push({ action: 'preserve', path, source: `schemas/${file}`, content, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return operations.sort((left, right) => left.path.localeCompare(right.path))
}

async function legacyMarkdown(root) {
  const allowed = (path) => path === 'AGENTS.md' || path === 'CLAUDE.md' || path.endsWith('/SKILL.md')
  const files = []
  for (const directory of ['.agents', '.uihub', 'docs']) {
    for (const path of await walkFiles(join(root, directory))) files.push(`${directory}/${path}`)
  }
  for (const path of ['README.md', 'SPEC.md']) if (await pathExists(join(root, path))) files.push(path)
  return files.filter((path) => path.endsWith('.md') && !allowed(path)).sort()
}

function publicAdoptionPlan(root, mode, operations, legacy) {
  const counts = Object.fromEntries(['create', 'retain', 'merge-route', 'preserve'].map((action) => [action.replace('-', '_'), operations.filter((entry) => entry.action === action).length]))
  const preserved = operations.filter((entry) => entry.action === 'preserve')
  return {
    schema_version: 1,
    profile: 'complete-siso-project-kit',
    mode,
    non_destructive: true,
    can_apply: true,
    operational_after_apply: preserved.length === 0 && legacy.length === 0,
    summary: { ...counts, legacy_markdown: legacy.length },
    operations: operations.map(({ content, ...entry }) => entry),
    preserved_collisions: preserved.map(({ content, ...entry }) => entry),
    legacy_markdown: legacy,
    next_actions: [
      ...(preserved.length > 0 ? [{ action: 'resolve-preserved-authorities', status: 'required', paths: preserved.map((entry) => entry.path) }] : []),
      ...(legacy.length > 0 ? [{ action: 'migrate-project-os-markdown-to-html', status: 'required', paths: legacy }] : []),
      { action: 'doctor', status: 'required', command: 'project-os doctor --json', optional_provider_command: 'project-os doctor --agent-base-root /path/to/SISO_Agent_Base --json' },
      { action: 'check', status: 'required', command: 'project-os check --json' },
    ],
  }
}

export async function planProjectAdoption(projectRoot, options = {}) {
  const root = resolve(projectRoot)
  return publicAdoptionPlan(root, await rootMode(root), await projectAdoptionOperations(root, options), await legacyMarkdown(root))
}

function renderMigrationHtml(plan) {
  const rows = plan.operations.map((entry) => `<tr><td>${htmlEscape(entry.action)}</td><td><code>${htmlEscape(entry.path)}</code></td><td>${htmlEscape(entry.reason ?? '')}</td></tr>`).join('')
  const state = embeddedJson(plan)
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SISO Project Kit migration</title><style>body{font:15px/1.5 system-ui;max-width:76rem;margin:auto;padding:2rem}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #ccd4df;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}@media(max-width:42rem){body{padding:.5rem}table,tbody,tr,th,td{display:block}th,td{border:0;padding:.15rem 0}tr{padding:.7rem 0}}</style></head><body><main data-contract="project-kit-migration"><h1>SISO Project Kit migration</h1><p>${plan.operational_after_apply ? 'No unresolved Project OS authority conflicts remain.' : 'Review the preserved authorities and legacy surfaces below before declaring the migration complete.'}</p><table><thead><tr><th>Action</th><th>Path</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></main><script id="project-kit-migration-state" type="application/json">${state}</script></body></html>\n`
}

export async function applyProjectAdoption(projectRoot, options = {}) {
  const root = resolve(projectRoot)
  const operations = await projectAdoptionOperations(root, options)
  const legacy = await legacyMarkdown(root)
  const plan = publicAdoptionPlan(root, await rootMode(root), operations, legacy)
  if (options.dryRun) return { ok: true, dry_run: true, plan, created: [], merged_routes: [] }
  const created = []
  const modified = []
  let reportPlan = plan
  try {
    await mkdir(root, { recursive: true })
    for (const operation of operations) {
      const target = join(root, operation.path)
      if (operation.action === 'create') {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, operation.content, { encoding: 'utf8', flag: 'wx' })
        created.push(target)
      } else if (operation.action === 'merge-route') {
        modified.push({ target, content: await readFile(target, 'utf8') })
        await writeFile(target, operation.content, 'utf8')
      }
    }
    reportPlan = publicAdoptionPlan(root, await rootMode(root), await projectAdoptionOperations(root, options), await legacyMarkdown(root))
    const reportRoot = join(root, '.project-os', 'migration')
    await mkdir(reportRoot, { recursive: true })
    await writeJsonAtomic(join(reportRoot, 'project-kit-migration.json'), reportPlan)
    await writeFile(join(reportRoot, 'project-kit-migration.html'), renderMigrationHtml(reportPlan), 'utf8')
  } catch (error) {
    for (const path of created.reverse()) await unlink(path).catch(() => {})
    for (const entry of modified.reverse()) await writeFile(entry.target, entry.content, 'utf8').catch(() => {})
    throw error
  }
  let installManifest = null
  let installManifestError = null
  try {
    installManifest = await writeInstallManifest(root, {
      by: 'project-os:adopt',
      paths: operations.filter((entry) => entry.action !== 'preserve').map((entry) => entry.path),
      preservedPaths: operations.filter((entry) => entry.action === 'preserve').map((entry) => entry.path),
    })
  } catch (error) {
    installManifestError = error instanceof Error ? error.message : String(error)
    if (plan.operational_after_apply) throw error
  }
  return {
    ok: true,
    dry_run: false,
    created: created.map((path) => path.slice(root.length + 1)),
    merged_routes: operations.filter((entry) => entry.action === 'merge-route').map((entry) => entry.path),
    preserved: operations.filter((entry) => entry.action === 'preserve').map((entry) => entry.path),
    report: '.project-os/migration/project-kit-migration.html',
    install_manifest: installManifest ? '.project-os/install-manifest.json' : null,
    install_manifest_error: installManifestError,
    plan,
    report_plan: reportPlan,
  }
}

function capabilityId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error('capability id must match ^[a-z][a-z0-9-]{1,63}$')
  return id
}

function requiredText(value, name, maximum = 500) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${name} is required`)
  if (text.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`)
  return text
}

async function writeScaffold(root, path, content, options = {}) {
  const target = join(resolve(root), path)
  if (await pathExists(target)) {
    let existing
    try {
      existing = await readFile(target, 'utf8')
    } catch (error) {
      const collision = new Error(`scaffold collision at ${path}: ${error instanceof Error ? error.message : String(error)}`)
      collision.exitCode = 2
      throw collision
    }
    if (existing === content) return { ok: true, action: 'retain', path }
    const collision = new Error(`scaffold would overwrite existing capability: ${path}`)
    collision.exitCode = 2
    throw collision
  }
  if (options.dryRun) return { ok: true, action: 'create', path, dry_run: true }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  return { ok: true, action: 'create', path, dry_run: false }
}

async function writeScaffoldSet(root, artifacts, options = {}) {
  const projectRoot = resolve(root)
  const planned = []
  for (const artifact of artifacts) {
    const target = join(projectRoot, artifact.path)
    if (!(await pathExists(target))) {
      planned.push({ ...artifact, target, action: 'create' })
      continue
    }
    let existing
    try {
      existing = await readFile(target, 'utf8')
    } catch (error) {
      const collision = new Error(`scaffold collision at ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`)
      collision.exitCode = 2
      throw collision
    }
    if (existing !== artifact.content) {
      const collision = new Error(`scaffold would overwrite existing capability: ${artifact.path}`)
      collision.exitCode = 2
      throw collision
    }
    planned.push({ ...artifact, target, action: 'retain' })
  }
  if (options.dryRun) {
    return { ok: true, action: planned.some((entry) => entry.action === 'create') ? 'create' : 'retain', dry_run: true, artifacts: planned.map(({ target, content, ...entry }) => entry) }
  }
  const created = []
  try {
    for (const artifact of planned) {
      if (artifact.action !== 'create') continue
      await mkdir(dirname(artifact.target), { recursive: true })
      await writeFile(artifact.target, artifact.content, { encoding: 'utf8', flag: 'wx' })
      created.push(artifact.target)
    }
  } catch (error) {
    for (const path of created.reverse()) await unlink(path).catch(() => {})
    throw error
  }
  return {
    ok: true,
    action: planned.some((entry) => entry.action === 'create') ? 'create' : 'retain',
    dry_run: false,
    path: planned[0].path,
    authority_path: planned[1].path,
    artifacts: planned.map(({ target, content, ...entry }) => entry),
  }
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function embeddedJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

async function assertScaffoldRecord(schemaName, value) {
  const schema = JSON.parse(await readFile(join(schemasRoot, `${schemaName}.schema.json`), 'utf8'))
  const violations = validateSchema(value, schema)
  if (violations.length === 0) return
  throw new Error(`${schemaName} scaffold is invalid:\n${violations.map((entry) => `- ${entry.path}: ${entry.message}`).join('\n')}`)
}

export async function scaffoldProjectSkill(projectRoot, specification, options = {}) {
  const id = capabilityId(specification?.id)
  const description = requiredText(specification?.description, 'skill description')
  const title = typeof specification.title === 'string' && specification.title.trim() ? specification.title.trim() : id
  const shimPath = `.agents/skills/${id}/SKILL.md`
  const authorityPath = `.agents/skills/${id}/CAPABILITY.html`
  const shim = `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\nstatus: active\nownership: PROJECT_LOCAL\n---\n\n# ${title}\n\nCanonical instructions: [CAPABILITY.html](./CAPABILITY.html). Load that HTML authority before using this skill.\n`
  const contract = {
    schema_version: 1,
    contract: 'project-os-skill-capability.v1',
    skill_id: id,
    discovery_shim: shimPath,
    canonical_authority: authorityPath,
    ownership: 'PROJECT_LOCAL',
  }
  const authority = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${htmlEscape(title)}</title>\n  <style>:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}body{max-width:64rem;margin:auto;padding:2rem}code{overflow-wrap:anywhere}h1,h2{line-height:1.2}</style>\n</head>\n<body data-contract="project-os-skill-capability.v1">\n  <main>\n    <h1>${htmlEscape(title)}</h1>\n    <p>${htmlEscape(description)}</p>\n    <section><h2>Contract</h2><ul><li>Keep project-specific repeatable knowledge in this authority.</li><li>Route shared runtime behavior to its declared provider instead of copying it.</li><li>Name the canonical records and verification evidence this capability reads or writes.</li></ul></section>\n  </main>\n  <script id="skill-capability-contract" type="application/json">${embeddedJson(contract)}</script>\n</body>\n</html>\n`
  return writeScaffoldSet(projectRoot, [
    { path: shimPath, content: shim },
    { path: authorityPath, content: authority },
  ], options)
}

export async function scaffoldProjectAgent(projectRoot, specification, options = {}) {
  const id = capabilityId(specification?.id)
  const description = requiredText(specification?.description, 'agent description')
  const title = typeof specification.title === 'string' && specification.title.trim() ? specification.title.trim() : id
  const profile = {
    schema_version: 1,
    role_id: id,
    title,
    description,
    ownership: 'PROJECT_LOCAL',
    instruction_routes: Array.isArray(specification.instruction_routes) && specification.instruction_routes.length > 0
      ? [...specification.instruction_routes]
      : ['AGENTS.md'],
    capabilities: Array.isArray(specification.capabilities) && specification.capabilities.length > 0
      ? [...specification.capabilities]
      : ['project.operator'],
    write_scope: Array.isArray(specification.write_scope) ? [...specification.write_scope] : [],
    verification: Array.isArray(specification.verification) && specification.verification.length > 0
      ? [...specification.verification]
      : ['project.check'],
  }
  await assertScaffoldRecord('agent-profile', profile)
  return writeScaffold(projectRoot, `.agents/agents/${id}.json`, `${JSON.stringify(profile, null, 2)}\n`, options)
}

export async function scaffoldProjectCommand(projectRoot, specification, options = {}) {
  const id = capabilityId(specification?.id)
  const description = requiredText(specification?.description, 'command description')
  const title = typeof specification.title === 'string' && specification.title.trim() ? specification.title.trim() : id
  const program = requiredText(specification?.program, 'command program', 200)
  const command = {
    schema_version: 1,
    command_id: id,
    title,
    description,
    ownership: 'PROJECT_LOCAL',
    mode: specification.mode === 'mutating' ? 'mutating' : 'read-only',
    program,
    arguments: Array.isArray(specification.arguments) ? [...specification.arguments] : [],
    cwd: '.',
    required_capabilities: Array.isArray(specification.required_capabilities) ? [...specification.required_capabilities] : [],
    success: {
      exit_codes: Array.isArray(specification.success_exit_codes) ? [...specification.success_exit_codes] : [0],
      output: specification.output === 'json' ? 'json' : 'text',
    },
  }
  await assertScaffoldRecord('command', command)
  return writeScaffold(projectRoot, `.agents/commands/${id}.json`, `${JSON.stringify(command, null, 2)}\n`, options)
}
