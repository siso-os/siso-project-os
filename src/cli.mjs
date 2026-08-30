import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  copyRenderedTree,
  copySchemas,
  parseArgs,
  pathExists,
  projectRoot,
  schemasRoot,
  splitList,
  templateRoot,
} from './shared.mjs'
import {
  applyProjectAdoption,
  planProjectAdoption,
  scaffoldProjectAgent,
  scaffoldProjectCommand,
  scaffoldProjectSkill,
} from './adoption.mjs'
import { architectureSnapshot, checkArchitecture, writeArchitectureBaseline } from './architecture.mjs'
import { buildProject, projectSnapshot } from './build.mjs'
import { discoverProjectCapabilities, doctorProjectCapabilities } from './capabilities.mjs'
import { checkProject } from './check.mjs'
import { formatOnboardingReport, onboardingReport } from './console.mjs'
import {
  admitFleet,
  buildFleet,
  checkFleetInstallation,
  initFleet,
  loadFleetBootstrap,
  planFleetInstall,
} from './fleet.mjs'
import * as lifecycle from './lifecycle.mjs'
import { closeRun, createRun, createSprint, createTask, updateTask } from './work.mjs'
import { advanceUiCampaign, createUiCampaign, importUiReviewDecision } from './ui.mjs'
import {
  applyUpgrade,
  planUpgrade,
  rollbackUpgrade,
  runtimeTemplateReplacements,
  verifyRuntimeSource,
  writeInstallManifest,
} from './upgrade.mjs'

const HELP = `SISO Project OS

Usage:
  project-os init [path] [--name <name>] [--summary <text>] [--outcome <text>] [runtime provenance] [--dry-run]
  project-os adopt plan [path] [runtime provenance]
  project-os adopt apply [path] [runtime provenance] [--dry-run]
  project-os upgrade plan [path] [runtime provenance]
  project-os upgrade apply [path] [runtime provenance] [--dry-run] [--by <agent>]
  project-os upgrade rollback UPGRADE-... --root <path> [--by <agent>]
  project-os onboard [path] [--json]
  project-os check [path] [--json]
  project-os build [path]
  project-os doctor [path] [--agent-base-root <path>] [--json]
  project-os capabilities list [path] [--json]
  project-os architecture assess|check [path] [--json]
  project-os architecture baseline [path] --by <agent> [--decision <ref>] [--ratchet]
  project-os fleet plan|init [path] --config <fleet.bootstrap.json> [--dry-run]
  project-os fleet check|build [path] [--json]
  project-os fleet admit [path] --file <admission.json> [--dry-run]
  project-os scaffold skill --id <id> --description <text> [--title <title>]
  project-os scaffold agent --id <id> --description <text> [options]
  project-os scaffold command --id <id> --description <text> --program <program> [options]
  project-os task create --title <title> [options]
  project-os task update TASK-NNNN --by <agent> [options]
  project-os task claim --by <agent> [filters]
  project-os task archive TASK-NNNN --by <agent> --reason <text> [--dry-run]
  project-os mission acquire|status|heartbeat|release|quarantine [MISSION-id] [options]
  project-os resume create --objective <text> --first-read <paths> --by <agent>
  project-os claim acquire --task TASK-NNNN --run RUN-... --unit <id> --paths <paths> [options]
  project-os claim release CLAIM-... --by <agent> --receipt <path>
  project-os sprint create --title <title> [--tasks TASK-0001,TASK-0002]
  project-os sprint lane-create|start|lane-update|lane-return|gate|close|archive SPRINT-... [options]
  project-os run create --title <title> --task TASK-0001
  project-os run start|unit-add|return|gate|census RUN-... [options]
  project-os run packet-create|packet-amend RUN-... --file <record.json> [--unit <id>]
  project-os run event|attempt|verify|result|fail RUN-... [unit-id] --file <record.json>
  project-os run close RUN-... --by <agent> --verdict passed|failed|cancelled --summary <text>
  project-os delivery plan --file <record.json>
  project-os delivery land DELIVERY-... --file <record.json>
  project-os ui create --title <title> --task TASK-0001
  project-os ui review-import UI-... --decision-id DEC-UI-... --paths <paths> --accept <criteria>
  project-os ui advance UI-... --stage <stage> [receipts]

Global options:
  --root <path>   Project root for state commands
  --json          Machine-readable output

Runtime provenance (required by init, adopt, and upgrade plan/apply):
  --runtime-repository https://github.com/sisodias/siso-project-os.git
  --runtime-tag vX.Y.Z --runtime-tag-object <40-hex>
  --runtime-commit <40-hex> --runtime-tree <40-hex>
`

function print(value, json = false) {
  if (json || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${value}\n`)
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

async function assertInitialized(root) {
  if (!(await pathExists(join(root, '.project-os', 'project.json')))) {
    throw new Error(`${root} is not initialized; run project-os init first`)
  }
}

async function initProject(tokens) {
  const { positional, flags } = parseArgs(tokens)
  const runtimeSource = await verifyRuntimeSource(flags)
  const root = resolve(positional[0] ?? process.cwd())
  const name = typeof flags.name === 'string' ? flags.name : basename(root)
  const summary = typeof flags.summary === 'string' ? flags.summary.trim() : ''
  const outcome = typeof flags.outcome === 'string' ? flags.outcome.trim() : ''
  const dryRun = flags['dry-run'] === true
  const existingAgentRules = await pathExists(join(root, 'AGENTS.md'))
  const replacements = {
    '{{PROJECT_NAME}}': name,
    '{{PROJECT_NAME_JSON}}': JSON.stringify(name),
    '{{PROJECT_NAME_HTML}}': htmlEscape(name),
    '{{PROJECT_SUMMARY_JSON}}': JSON.stringify(summary),
    '{{DESIRED_OUTCOME_JSON}}': JSON.stringify(outcome),
    ...runtimeTemplateReplacements(runtimeSource),
  }

  await copyRenderedTree(templateRoot, root, replacements, {
    dryRun: true,
    skipExistingAgentRules: existingAgentRules,
  })
  await copySchemas(root, { dryRun: true })
  if (existingAgentRules && await pathExists(join(root, '.project-os', 'AGENTS.project-os.html'))) {
    const error = new Error('init would overwrite .project-os/AGENTS.project-os.html')
    error.exitCode = 2
    throw error
  }
  if (dryRun) {
    print({ ok: true, dry_run: true, root, project_name: name, existing_agent_rules: existingAgentRules }, flags.json === true)
    return
  }

  await mkdir(root, { recursive: true })
  const copied = await copyRenderedTree(templateRoot, root, replacements, {
    skipExistingAgentRules: existingAgentRules,
  })
  const schemaFiles = await copySchemas(root)
  if (existingAgentRules) {
    const source = await readFile(join(templateRoot, 'AGENTS.md'), 'utf8')
    const rendered = source.split('{{PROJECT_NAME}}').join(name)
    const destination = join(root, '.project-os', 'AGENTS.project-os.html')
    await mkdir(dirname(destination), { recursive: true })
    const state = JSON.stringify({ schema_version: 1, kind: 'agent-router-merge', target: 'AGENTS.md', canonical_operator: '.agents/skills/project-operator/SKILL.md' }).replaceAll('<', '\\u003c')
    await writeFile(destination, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(name)} agent-router merge</title><style>body{font:15px/1.5 system-ui;max-width:68rem;margin:auto;padding:2rem}pre{white-space:pre-wrap;background:#eef2f7;padding:1rem;border-radius:.5rem}</style></head><body><main data-contract="agent-router-merge"><h1>Merge Project OS into AGENTS.md</h1><p>Preserve the existing rules and add the runtime route below. The complete Project OS router is shown for review.</p><pre>${htmlEscape(rendered)}</pre></main><script id="agent-router-merge-state" type="application/json">${state}</script></body></html>\n`, 'utf8')
  }
  await buildProject(root)
  await writeArchitectureBaseline(root, { by: 'project-os:init' })
  await writeInstallManifest(root, {
    by: 'project-os:init',
    paths: [
      ...copied.files.filter((path) => !copied.skipped.includes(path)),
      ...schemaFiles.map((path) => `.project-os/schemas/${path}`),
    ],
    preservedPaths: existingAgentRules ? ['AGENTS.md'] : [],
  })
  print({
    ok: true,
    root,
    project_name: name,
    files_installed: copied.files.length - copied.skipped.length,
    agent_rules: existingAgentRules ? 'staged at .project-os/AGENTS.project-os.html for manual merge' : 'installed as AGENTS.md',
  }, flags.json === true)
}

function commandRoot(positional, flags) {
  return resolve(positional[0] ?? (typeof flags.root === 'string' ? flags.root : process.cwd()))
}

function capabilityOptions(flags) {
  return typeof flags['agent-base-root'] === 'string'
    ? { providerRoots: { 'siso-agent-base': resolve(flags['agent-base-root']) } }
    : {}
}

function scaffoldSpecification(kind, flags) {
  const common = {
    id: flags.id,
    title: flags.title,
    description: flags.description,
  }
  if (kind === 'agent') {
    return {
      ...common,
      instruction_routes: splitList(flags.instructions),
      capabilities: splitList(flags.capabilities),
      write_scope: splitList(flags['write-scope']),
      verification: splitList(flags.verification),
    }
  }
  if (kind === 'command') {
    return {
      ...common,
      program: flags.program,
      arguments: splitList(flags.args),
      required_capabilities: splitList(flags.capabilities),
      mode: flags.mutating === true ? 'mutating' : 'read-only',
      output: flags.output,
    }
  }
  return common
}

async function recordFromFile(root, flags, label) {
  const pointer = typeof flags.file === 'string' ? flags.file : ''
  if (!pointer) throw new Error(`${label} requires --file <record.json>`)
  try {
    return JSON.parse(await readFile(resolve(root, pointer), 'utf8'))
  } catch (error) {
    throw new Error(`${label} could not read ${pointer}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizedLifecycleFlags(flags) {
  const normalized = { ...flags }
  if (typeof flags.attempt === 'string') normalized.attempt = Number(flags.attempt)
  if (typeof flags['exit-code'] === 'string') normalized.exit_code = Number(flags['exit-code'])
  return normalized
}

export async function main(argv) {
  const [command, subcommand, ...rest] = argv
  if (!command || ['help', '--help', '-h'].includes(command)) {
    print(HELP)
    return
  }
  if (command === '--version' || command === 'version') {
    const packageJson = JSON.parse(await readFile(join(dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8'))
    print(packageJson.version)
    return
  }
  if (command === 'init') return initProject(argv.slice(1))

  if (command === 'fleet') {
    if (!['plan', 'init', 'check', 'build', 'admit'].includes(subcommand)) throw new Error(`unknown fleet command\n\n${HELP}`)
    const { positional, flags } = parseArgs(rest)
    const root = commandRoot(positional, flags)
    await assertInitialized(root)
    let result
    if (subcommand === 'plan' || subcommand === 'init') {
      const loaded = await loadFleetBootstrap(root, flags.config)
      result = subcommand === 'plan'
        ? await planFleetInstall(root, loaded.config, { configPath: loaded.path })
        : await initFleet(root, loaded.config, { configPath: loaded.path, dryRun: flags['dry-run'] === true })
      if (subcommand === 'init' && result.ok && flags['dry-run'] !== true) {
        result.generated = Object.keys(await buildProject(root))
      }
      if (!result.ok) process.exitCode = 2
    } else if (subcommand === 'check') {
      result = await checkFleetInstallation(root)
      if (!result.ok) process.exitCode = 1
    } else if (subcommand === 'build') {
      const outputs = await buildFleet(root)
      result = { ok: true, outputs: Object.keys(outputs) }
    } else {
      const input = await recordFromFile(root, flags, 'fleet admit')
      result = await admitFleet(root, input, { dryRun: flags['dry-run'] === true })
      if (result.verdict !== 'admit') process.exitCode = 2
    }
    const printable = result && typeof result === 'object' && '_entries' in result
      ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== '_entries'))
      : result
    print(printable, flags.json === true)
    return
  }

  if (command === 'adopt') {
    if (!['plan', 'apply'].includes(subcommand)) throw new Error(`unknown adoption command\n\n${HELP}`)
    const { positional, flags } = parseArgs(rest)
    const root = commandRoot(positional, flags)
    const runtimeSource = await verifyRuntimeSource(flags)
    let result = subcommand === 'plan'
      ? await planProjectAdoption(root, { ...flags, runtimeSource })
      : await applyProjectAdoption(root, { ...flags, runtimeSource, dryRun: flags['dry-run'] === true })
    if (subcommand === 'apply' && flags['dry-run'] !== true && await pathExists(join(root, '.project-os', 'project.json'))) {
      const activation = { build: null, architecture_baseline: null }
      try {
        activation.build = Object.keys(await buildProject(root))
        const baselinePath = join(root, '.project-os', 'architecture', 'baseline.json')
        activation.architecture_baseline = await pathExists(baselinePath)
          ? 'retained'
          : await writeArchitectureBaseline(root, { by: 'project-os:adopt' })
      } catch (error) {
        activation.error = error instanceof Error ? error.message : String(error)
      }
      result = { ...result, activation }
      if (activation.error || !result.plan.operational_after_apply) process.exitCode = 2
    }
    print(result, flags.json === true)
    return
  }

  if (command === 'upgrade') {
    if (!['plan', 'apply', 'rollback'].includes(subcommand)) throw new Error(`unknown upgrade command\n\n${HELP}`)
    const { positional, flags } = parseArgs(rest)
    const root = subcommand === 'rollback'
      ? resolve(typeof flags.root === 'string' ? flags.root : (positional[1] ?? process.cwd()))
      : commandRoot(positional, flags)
    await assertInitialized(root)
    const result = subcommand === 'plan'
      ? await planUpgrade(root, flags)
      : subcommand === 'apply'
        ? await applyUpgrade(root, { ...flags, dryRun: flags['dry-run'] === true })
        : await rollbackUpgrade(root, positional[0], flags)
    print(result, flags.json === true)
    if (subcommand === 'plan' && !result.can_apply) process.exitCode = 2
    return
  }

  if (command === 'capabilities' && subcommand === 'list') {
    const { positional, flags } = parseArgs(rest)
    const result = await discoverProjectCapabilities(commandRoot(positional, flags))
    print(result, flags.json === true)
    return
  }

  if (command === 'doctor') {
    const { positional, flags } = parseArgs(argv.slice(1))
    const root = commandRoot(positional, flags)
    const result = await doctorProjectCapabilities(root, capabilityOptions(flags))
    print(result, flags.json === true)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (command === 'architecture') {
    if (!['assess', 'check', 'baseline'].includes(subcommand)) throw new Error(`unknown architecture command\n\n${HELP}`)
    const { positional, flags } = parseArgs(rest)
    const root = commandRoot(positional, flags)
    await assertInitialized(root)
    const result = subcommand === 'assess'
      ? await architectureSnapshot(root)
      : subcommand === 'check'
        ? await checkArchitecture(root)
        : await writeArchitectureBaseline(root, {
            by: flags.by,
            decision: flags.decision,
            ratchet: flags.ratchet === true,
          })
    print(result, flags.json === true)
    if (subcommand === 'check' && !result.ok) process.exitCode = 1
    return
  }

  if (command === 'scaffold') {
    if (!['skill', 'agent', 'command'].includes(subcommand)) throw new Error(`unknown scaffold command\n\n${HELP}`)
    const { flags } = parseArgs(rest)
    const root = projectRoot(flags)
    await assertInitialized(root)
    const specification = scaffoldSpecification(subcommand, flags)
    const options = { dryRun: flags['dry-run'] === true }
    const result = subcommand === 'skill'
      ? await scaffoldProjectSkill(root, specification, options)
      : subcommand === 'agent'
        ? await scaffoldProjectAgent(root, specification, options)
        : await scaffoldProjectCommand(root, specification, options)
    print(result, flags.json === true)
    return
  }

  if (command === 'onboard' || command === 'check' || command === 'build') {
    const { positional, flags } = parseArgs(argv.slice(1))
    const root = resolve(positional[0] ?? (typeof flags.root === 'string' ? flags.root : process.cwd()))
    await assertInitialized(root)
    if (command === 'onboard') {
      const checked = await checkProject(root)
      const report = onboardingReport(root, await projectSnapshot(root), checked)
      print(flags.json === true ? report : formatOnboardingReport(report), flags.json === true)
      if (!report.ok) process.exitCode = 1
      return
    }
    if (command === 'build') {
      const outputs = await buildProject(root)
      print({ ok: true, outputs: Object.keys(outputs) }, flags.json === true)
      return
    }
    const result = await checkProject(root)
    print(result, flags.json === true)
    if (!result.ok) process.exitCode = 1
    return
  }

  const { positional, flags } = parseArgs(rest)
  const root = projectRoot(flags)
  await assertInitialized(root)
  let result
  let rebuild = true
  const lifecycleFlags = normalizedLifecycleFlags(flags)
  if (command === 'task' && subcommand === 'create') result = await createTask(root, flags)
  else if (command === 'task' && subcommand === 'update') result = await updateTask(root, positional[0], flags)
  else if (command === 'task' && subcommand === 'claim') result = await lifecycle.claimNextTask(root, lifecycleFlags)
  else if (command === 'task' && subcommand === 'archive') result = await lifecycle.archiveTask(root, positional[0], lifecycleFlags)
  else if (command === 'mission' && subcommand === 'acquire') result = await lifecycle.acquireMission(root, lifecycleFlags)
  else if (command === 'mission' && subcommand === 'status') {
    result = await lifecycle.missionStatus(root, positional[0] ?? null)
    rebuild = false
  }
  else if (command === 'mission' && subcommand === 'heartbeat') result = await lifecycle.heartbeatMission(root, positional[0], lifecycleFlags)
  else if (command === 'mission' && subcommand === 'release') result = await lifecycle.releaseMission(root, positional[0], lifecycleFlags)
  else if (command === 'mission' && subcommand === 'quarantine') result = await lifecycle.quarantineMission(root, positional[0], lifecycleFlags)
  else if (command === 'resume' && subcommand === 'create') result = await lifecycle.createResumeSnapshot(root, lifecycleFlags)
  else if (command === 'claim' && subcommand === 'acquire') result = await lifecycle.acquireWorkClaim(root, lifecycleFlags)
  else if (command === 'claim' && subcommand === 'release') result = await lifecycle.releaseWorkClaim(root, positional[0], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'create') result = await createSprint(root, flags)
  else if (command === 'sprint' && subcommand === 'lane-create') result = await lifecycle.createSprintLane(root, positional[0], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'start') result = await lifecycle.startSprint(root, positional[0], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'lane-update') result = await lifecycle.updateSprintLane(root, positional[0], positional[1], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'lane-return') result = await lifecycle.recordSprintLaneReturn(root, positional[0], positional[1], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'gate') result = await lifecycle.recordSprintGate(root, positional[0], positional[1], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'close') result = await lifecycle.closeSprint(root, positional[0], lifecycleFlags)
  else if (command === 'sprint' && subcommand === 'archive') result = await lifecycle.archiveSprint(root, positional[0], lifecycleFlags)
  else if (command === 'run' && subcommand === 'create') result = await createRun(root, flags)
  else if (command === 'run' && subcommand === 'start') result = await lifecycle.startRun(root, positional[0], lifecycleFlags)
  else if (command === 'run' && subcommand === 'unit-add') result = await lifecycle.addRunUnit(root, positional[0], lifecycleFlags)
  else if (command === 'run' && ['packet-create', 'packet-amend'].includes(subcommand)) {
    const packet = await recordFromFile(root, flags, `run ${subcommand}`)
    const options = { unit_id: flags.unit ?? flags['unit-id'] }
    result = subcommand === 'packet-create'
      ? await lifecycle.createRunPacket(root, positional[0], packet, options)
      : await lifecycle.amendRunPacket(root, positional[0], packet, options)
  }
  else if (command === 'run' && subcommand === 'return') result = await lifecycle.recordRunReturn(root, positional[0], positional[1], lifecycleFlags)
  else if (command === 'run' && subcommand === 'event') result = await lifecycle.appendRunEvent(root, positional[0], await recordFromFile(root, flags, 'run event'))
  else if (command === 'run' && subcommand === 'gate') result = await lifecycle.recordRunGate(root, positional[0], positional[1], lifecycleFlags)
  else if (command === 'run' && subcommand === 'attempt') result = await lifecycle.recordAttemptReceipt(root, positional[0], positional[1], await recordFromFile(root, flags, 'run attempt'))
  else if (command === 'run' && subcommand === 'verify') result = await lifecycle.recordVerificationReceipt(root, positional[0], positional[1], await recordFromFile(root, flags, 'run verification'))
  else if (command === 'run' && subcommand === 'result') result = await lifecycle.recordUnitResult(root, positional[0], positional[1], await recordFromFile(root, flags, 'run result'))
  else if (command === 'run' && subcommand === 'fail') result = await lifecycle.recordFailureResult(root, positional[0], positional[1], await recordFromFile(root, flags, 'run failure'))
  else if (command === 'run' && subcommand === 'census') {
    const options = typeof flags.file === 'string' ? await recordFromFile(root, flags, 'run census') : lifecycleFlags
    result = await lifecycle.inspectRunCloseCensus(root, positional[0], options)
    rebuild = false
  }
  else if (command === 'run' && subcommand === 'close') result = await closeRun(root, positional[0], flags)
  else if (command === 'delivery' && subcommand === 'plan') result = await lifecycle.createDeliveryPlan(root, await recordFromFile(root, flags, 'delivery plan'))
  else if (command === 'delivery' && subcommand === 'land') result = await lifecycle.recordLandingReceipt(root, positional[0], await recordFromFile(root, flags, 'delivery landing'))
  else if (command === 'ui' && subcommand === 'create') result = await createUiCampaign(root, flags)
  else if (command === 'ui' && subcommand === 'review-import') result = await importUiReviewDecision(root, positional[0], flags)
  else if (command === 'ui' && subcommand === 'advance') result = await advanceUiCampaign(root, positional[0], flags)
  else throw new Error(`unknown command\n\n${HELP}`)
  if (rebuild) await buildProject(root)
  print(result, flags.json === true)
}
