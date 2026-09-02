// scripts/ci/check-deps-mirror.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The script resolves the repo root from its own file location, so each case copies the
// real script into a scratch repo skeleton and runs it with cwd = scratch.
const SCRIPT_SRC = new URL('./check-deps-mirror.mjs', import.meta.url);

function runInScratch({ rootDeps, subDeps }) {
  const dir = mkdtempSync(join(tmpdir(), 'depmirror-'));
  mkdirSync(join(dir, 'packages/pi-subagents'), { recursive: true });
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', dependencies: rootDeps }));
  writeFileSync(join(dir, 'packages/pi-subagents/package.json'), JSON.stringify({ name: 'sub', dependencies: subDeps }));
  cpSync(SCRIPT_SRC, join(dir, 'scripts/ci/check-deps-mirror.mjs'));
  let out = '', code = 0;
  try {
    out = execFileSync('node', ['scripts/ci/check-deps-mirror.mjs'], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    code = e.status ?? 1;
    out = e.stdout ? `${e.stdout}\n${e.stderr ?? ''}` : String(e.stderr ?? e);
  }
  rmSync(dir, { recursive: true, force: true });
  return { code, out };
}

const MIRRORED = { croner: '^10.0.1', nanoid: '^5.1.16', '@sinclair/typebox': '^0.34.49', typebox: '^1.3.7' };

test('all mirrored deps pass', () => {
  const { code } = runInScratch({ rootDeps: MIRRORED, subDeps: MIRRORED });
  assert.equal(code, 0);
});

test('missing dep fails with MISSING message', () => {
  const { code, out } = runInScratch({ rootDeps: { croner: '^10.0.1' }, subDeps: MIRRORED });
  assert.equal(code, 1);
  assert.match(out, /MISSING nanoid/);
});

test('incompatible range fails with INCOMPATIBLE message', () => {
  const { code, out } = runInScratch({
    rootDeps: { ...MIRRORED, croner: '^9.0.0' },
    subDeps: { ...MIRRORED, croner: '^10.0.1' },
  });
  assert.equal(code, 1);
  assert.match(out, /INCOMPATIBLE croner/);
});

test('extra root deps are ignored', () => {
  const { code } = runInScratch({
    rootDeps: { ...MIRRORED, '@langfuse/client': '^5.3.0', '@opentelemetry/api': '^1.9.0' },
    subDeps: MIRRORED,
  });
  assert.equal(code, 0);
});

test('empty subtree deps pass', () => {
  const { code } = runInScratch({ rootDeps: MIRRORED, subDeps: {} });
  assert.equal(code, 0);
});
