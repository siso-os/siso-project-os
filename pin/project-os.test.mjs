import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bootstrapEngine, engineId, readEngineLock, resolveEngine, runProjectOs } from './project-os.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'actionmodel-project-os-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const source = join(scratch, 'source'); mkdirSync(join(source, 'bin'), { recursive: true });
const cliBytes = Buffer.from('console.log(JSON.stringify({fixture: true, argv: process.argv.slice(2)}));\n');
writeFileSync(join(source, 'bin/siso-project-os.mjs'), cliBytes);
const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic verifier', '-c', 'user.email=fixture@example.invalid', '-C', source, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
}).trim();
git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'Synthetic engine']);
const pin = git(['rev-parse', 'HEAD']);
const files = { 'bin/siso-project-os.mjs': createHash('sha256').update(cliBytes).digest('hex') };
let count = 0;
function fixture() {
  const root = join(scratch, `project-${++count}`);
  mkdirSync(join(root, 'architecture/project-os'), { recursive: true });
  const lock = { schema_version: 1, upstream_revision: pin, engine_id: engineId(files), files, patches: [] };
  writeFileSync(join(root, 'architecture/project-os/engine.json'), JSON.stringify(lock));
  return { root, lock };
}
const writeLock = (root, lock) => writeFileSync(join(root, 'architecture/project-os/engine.json'), JSON.stringify(lock));

test('offline bootstrap uses pinned committed bytes and then preserves the cache', () => {
  const { root, lock } = fixture();
  writeFileSync(join(source, 'bin/siso-project-os.mjs'), 'uncommitted source change');
  const installed = bootstrapEngine(source, root);
  assert.equal(installed.status, 'INSTALLED'); assert.equal(installed.source_fetch, false);
  const engine = resolveEngine(root);
  assert.deepEqual(readFileSync(engine.cli), cliBytes);
  assert.equal(engine.lock.engine_id, lock.engine_id);
  assert.equal(bootstrapEngine(source, root).status, 'RETAINED');
  assert.equal(runProjectOs(['help'], root).status, 0);
});

test('missing or modified cache is refused without repair', () => {
  const { root } = fixture();
  assert.throws(() => resolveEngine(root), /absent/);
  bootstrapEngine(source, root);
  const { cli } = resolveEngine(root);
  writeFileSync(cli, 'tampered');
  assert.throws(() => resolveEngine(root), /integrity mismatch/);
  assert.throws(() => bootstrapEngine(source, root), /integrity mismatch/);
  assert.equal(readFileSync(cli, 'utf8'), 'tampered');
});

test('unsafe paths and inconsistent engine IDs are refused', () => {
  for (const path of ['../escape', '/absolute', '.git/config', 'a//b', 'a/../b', 'a\\b']) {
    const { root, lock } = fixture();
    lock.files = { ...files, [path]: files['bin/siso-project-os.mjs'] }; lock.engine_id = engineId(lock.files);
    writeLock(root, lock); assert.throws(() => readEngineLock(root), /binding/);
  }
  const { root, lock } = fixture(); lock.engine_id = '0'.repeat(64); writeLock(root, lock);
  assert.throws(() => readEngineLock(root), /identity/);
});

test('cache parent symlinks are refused before any target-directory write', () => {
  const { root } = fixture(); const outside = join(scratch, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(root, 'runtime'));
  assert.throws(() => bootstrapEngine(source, root), /symlinked/);
  assert.deepEqual(readdirSync(outside), []);
});

test('symlinked engine files and wrong effective bytes are refused', () => {
  const { root } = fixture(); bootstrapEngine(source, root); const { cli } = resolveEngine(root);
  rmSync(cli); symlinkSync(join(source, 'bin/siso-project-os.mjs'), cli);
  assert.throws(() => resolveEngine(root), /integrity mismatch/);
  const other = fixture(); other.lock.files = { 'bin/siso-project-os.mjs': '0'.repeat(64) }; other.lock.engine_id = engineId(other.lock.files); writeLock(other.root, other.lock);
  assert.throws(() => bootstrapEngine(source, other.root), /integrity mismatch/);
  assert.deepEqual(readdirSync(join(other.root, 'runtime/project-os')), []);
});

test('patch hash mismatch and unavailable local source do not fetch or install', () => {
  const { root, lock } = fixture();
  lock.patches = [{ path: 'architecture/project-os/bad.patch', sha256: '0'.repeat(64) }];
  writeFileSync(join(root, lock.patches[0].path), 'bad patch'); writeLock(root, lock);
  assert.throws(() => bootstrapEngine(source, root), /patch hash mismatch/);
  const other = fixture(); other.lock.upstream_revision = 'a'.repeat(40); writeLock(other.root, other.lock);
  assert.throws(() => bootstrapEngine(source, other.root));
  assert.deepEqual(readdirSync(join(other.root, 'runtime/project-os')), []);
});

test('launcher rejects cross-project and contract-replacement commands', () => {
  const { root } = fixture(); bootstrapEngine(source, root);
  for (const args of [['check', '/elsewhere'], ['task', 'create', '--root', '/elsewhere'], ['build', '../elsewhere'], ['init'], ['adopt', 'apply'], ['upgrade', 'apply']]) {
    assert.throws(() => runProjectOs(args, root));
  }
});
