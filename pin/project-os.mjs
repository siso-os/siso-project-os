#!/usr/bin/env node
// Pinned Project OS launcher for any project root (first user: Action Model); Project OS remains the task/lifecycle writer.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The project root: --root <dir>, else PROJECT_OS_ROOT, else the current directory.
// The launcher is engine code; the project's data (lock, cache) lives under the root.
function rootFromArgs(argv) {
  const at = argv.indexOf('--root');
  if (at === -1) return { root: resolve(process.env.PROJECT_OS_ROOT || process.cwd()), args: argv };
  if (!argv[at + 1]) throw new Error('--root needs a directory');
  return { root: resolve(argv[at + 1]), args: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}
const ROOT = resolve(process.env.PROJECT_OS_ROOT || process.cwd());
const LOCK = 'architecture/project-os/engine.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path)
  && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git');

export function engineId(files) {
  return hash(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
}

export function readEngineLock(root = ROOT) {
  let lock;
  try { lock = JSON.parse(readFileSync(join(root, LOCK), 'utf8')); }
  catch { throw new Error('Engine lock is missing or invalid; do not infer an upstream version.'); }
  if (lock.schema_version !== 1 || !/^[a-f0-9]{40}$/.test(lock.upstream_revision ?? '') ||
      !lock.files || Array.isArray(lock.files) || typeof lock.files !== 'object' ||
      !Array.isArray(lock.patches) || Object.keys(lock.files).length < 1 || Object.keys(lock.files).length > 512 ||
      !lock.files['bin/siso-project-os.mjs'] || engineId(lock.files) !== lock.engine_id) throw new Error('Engine lock identity is invalid.');
  for (const [path, sha] of Object.entries(lock.files)) {
    if (!safePath(path) || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('Engine file binding is invalid.');
  }
  for (const patch of lock.patches) {
    if (!safePath(patch.path) || !/^[a-f0-9]{64}$/.test(patch.sha256)) throw new Error('Engine patch binding is invalid.');
  }
  return lock;
}

function verifyFiles(directory, lock) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Engine cache is absent or symlinked; run the explicit bootstrap.');
  for (const [path, sha] of Object.entries(lock.files)) {
    const file = join(directory, path);
    if (!existsSync(file) || !lstatSync(file).isFile() || realpathSync(file) !== file || hash(readFileSync(file)) !== sha) {
      throw new Error(`Engine integrity mismatch: ${path}; existing cache was not changed.`);
    }
  }
}

export function resolveEngine(root = ROOT) {
  root = realpathSync(root);
  const lock = readEngineLock(root);
  const directory = join(root, 'runtime', 'project-os', lock.engine_id);
  verifyFiles(directory, lock);
  return { lock, directory, cli: join(directory, 'bin/siso-project-os.mjs') };
}

export function bootstrapEngine(source, root = ROOT) {
  root = realpathSync(root);
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('bootstrap requires --source /absolute/local/project-os-checkout; no fetch is performed.');
  const lock = readEngineLock(root);
  const parent = join(root, 'runtime', 'project-os');
  for (const directory of [join(root, 'runtime'), parent]) {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Engine cache parent must not be symlinked.');
    if (!stat) mkdirSync(directory);
  }
  const destination = join(parent, lock.engine_id);
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    verifyFiles(destination, lock);
    return { status: 'RETAINED', engine_id: lock.engine_id, source_fetch: false };
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd, args, options = {}) => execFileSync('git', ['--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env, timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (git(source, ['cat-file', '-t', lock.upstream_revision]).toString().trim() !== 'commit') throw new Error('The pinned local source is not a commit.');
  for (const entry of git(source, ['ls-tree', '-rz', '--full-tree', lock.upstream_revision]).toString().split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
    if (!match || !safePath(match[2])) throw new Error('Source tree contains an unsafe path or unsupported object.');
  }
  const patches = lock.patches.map(patch => {
    const path = join(root, patch.path);
    if (realpathSync(path) !== path || !lstatSync(path).isFile() || hash(readFileSync(path)) !== patch.sha256) throw new Error('Adaptation patch hash mismatch.');
    return path;
  });
  const stage = mkdtempSync(join(parent, '.stage-'));
  try {
    const archive = git(source, ['archive', '--format=tar', lock.upstream_revision]);
    execFileSync('tar', ['-xf', '-', '-C', stage], { input: archive, timeout: 15000 });
    // An isolated empty Git directory prevents discovery of the parent worktree.
    git(stage, ['init', '-q']);
    for (const patch of patches) {
      git(stage, ['apply', '--check', patch]);
      git(stage, ['apply', patch]);
    }
    verifyFiles(stage, lock);
    rmSync(join(stage, '.git'), { recursive: true, force: true });
    renameSync(stage, destination);
    return { status: 'INSTALLED', engine_id: lock.engine_id, source_fetch: false, files_verified: Object.keys(lock.files).length };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function runProjectOs(args, root = ROOT) {
  root = realpathSync(root);
  if (args[0] === 'init' || args[0] === 'adopt' || (args[0] === 'upgrade' && args[1] !== 'plan')) {
    throw new Error('Changing the installed operating contract requires an owner-reviewed adaptation; this launcher will not replace it.');
  }
  const forwarded = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root') {
      if (!args[i + 1] || resolve(root, args[++i]) !== root) throw new Error('This launcher only operates the Action Model root.');
    } else forwarded.push(args[i]);
  }
  const position = ['onboard', 'check', 'build', 'doctor'].includes(forwarded[0]) ? 1
    : ['architecture', 'upgrade'].includes(forwarded[0]) ? 2 : null;
  if (position !== null && forwarded[position] && !forwarded[position].startsWith('--') && resolve(root, forwarded[position]) !== root) {
    throw new Error('Cross-project command target refused.');
  }
  const engine = resolveEngine(root);
  const result = spawnSync(process.execPath, [engine.cli, ...(forwarded.length ? forwarded : ['help']), '--root', root], { cwd: root, stdio: 'inherit', timeout: 30000 });
  if ((result.error || result.status !== 0) && ['task', 'run', 'claim', 'mission', 'resume', 'sprint', 'delivery', 'ui'].includes(forwarded[0])) {
    console.error(JSON.stringify({ canonical_state: 'RECHECK_REQUIRED', next_action: 'Read the existing task/run before retrying. A mutation may have committed before its projection failed; do not blindly repeat it.' }));
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { root, args } = rootFromArgs(process.argv.slice(2));
    if (args[0] === 'bootstrap') {
      if (args.length !== 3 || args[1] !== '--source') throw new Error('Usage: node project-os.mjs [--root <project>] bootstrap --source /absolute/local/project-os-checkout');
      console.log(JSON.stringify(bootstrapEngine(args[2], root)));
    } else {
      const result = runProjectOs(args, root);
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', code: 'PROJECT_OS_LOCAL', message: error.message }));
    process.exitCode = 2;
  }
}
