// scripts/ci/package-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PACKAGES_DIR, covers, discoverGated, isGated, planRun, selectGate, summarize } from './package-gate.mjs';

// ---------- isGated ----------
test('isGated: only a non-empty test script counts', () => {
  assert.equal(isGated({ test: 'node --test' }), true);
  assert.equal(isGated({ test: '' }), false);
  assert.equal(isGated({ test: '   ' }), false);
  assert.equal(isGated({ build: 'tsc' }), false);
  assert.equal(isGated(undefined), false);
});

// ---------- covers ----------
test('covers: matches npm invocations, not other words or extended script names', () => {
  assert.equal(covers('npm test', 'test'), true);
  assert.equal(covers('npm run test', 'test'), true);
  assert.equal(covers('npm run typecheck && npm test', 'typecheck'), true);
  assert.equal(covers('npm run typecheck && npm test', 'test'), true);
  assert.equal(covers('biome check .', 'test'), false);
  assert.equal(covers('npm run test:coverage', 'test'), false);
  assert.equal(covers(undefined, 'test'), false);
});

// ---------- selectGate: the recorded shapes of the seven real packages ----------
const SHAPES = [
  ['pi-superpowers-plus', { check: 'biome check .', test: 'biome check . && node test/a.test.mjs' }, 'npm test'],
  ['hashline-edit', { check: 'biome check . && npm run typecheck && npm test', typecheck: 'tsc --noEmit', test: 'node --import tsx --test test/*.test.ts' }, 'npm run check'],
  ['statusline', { check: 'biome check . && npm run typecheck && npm test', typecheck: 'tsc --noEmit', test: 'node --import tsx --test test/statusline.test.ts' }, 'npm run check'],
  ['pi-subagents', { check: 'npm run lint && npm run typecheck && npm run test', lint: 'biome check src/ test/', typecheck: 'tsc --noEmit', test: 'vitest run' }, 'npm run check'],
  ['langfuse', { typecheck: 'tsc --noEmit', test: 'node --import tsx --test test/*.test.ts' }, 'npm run typecheck && npm test'],
  ['bifrost', { test: 'node --import tsx --test test/*.test.ts' }, 'npm test'],
  ['pi-beads', { test: 'node test/a.test.mjs && node test/b.test.mjs' }, 'npm test'],
];

for (const [name, scripts, expected] of SHAPES) {
  test(`selectGate: ${name} -> ${expected}`, () => {
    assert.equal(selectGate(scripts), expected);
  });
}

test('selectGate: check that skips the typecheck is not used when typecheck exists', () => {
  assert.equal(selectGate({ check: 'npm test', typecheck: 'tsc --noEmit', test: 'x' }), 'npm run typecheck && npm test');
});

test('selectGate: check that covers test with no typecheck script is used as-is', () => {
  assert.equal(selectGate({ check: 'npm test', test: 'x' }), 'npm run check');
});

test('selectGate: not gated -> null', () => {
  assert.equal(selectGate({ build: 'tsc' }), null);
});

// ---------- discoverGated ----------
function scratchPackages(pkgs) {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-gate-'));
  for (const [name, manifest] of Object.entries(pkgs)) {
    mkdirSync(join(dir, name), { recursive: true });
    if (manifest !== null) writeFileSync(join(dir, name, 'package.json'), JSON.stringify(manifest));
  }
  return dir;
}

test('discoverGated: sorted, skips non-gated dirs and dirs without a manifest', () => {
  const dir = scratchPackages({
    zeta: { scripts: { test: 'npm test' } },
    ayu: { scripts: { build: 'tsc' } },
    empty: null,
    alpha: { scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } },
  });
  try {
    assert.deepEqual(
      discoverGated(dir).map((p) => p.name),
      ['alpha', 'zeta'],
    );
    assert.equal(discoverGated(dir)[0].gate, 'npm run typecheck && npm test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverGated: the real repo includes the gated packages, excludes ayu, stays sorted', () => {
  const names = discoverGated(PACKAGES_DIR).map((p) => p.name);
  assert.ok(names.includes('pi-superpowers-plus'));
  assert.ok(names.includes('pi-beads'));
  assert.ok(!names.includes('ayu'), 'ayu declares no test script');
  assert.deepEqual(names, [...names].sort());
});

// ---------- planRun ----------
const GATED = [
  { name: 'alpha', dir: '/x/alpha', gate: 'npm test' },
  { name: 'beta', dir: '/x/beta', gate: 'npm test' },
];

test('planRun: splits runnable from skipped and flags quarantine rot', () => {
  const plan = planRun(GATED, { beta: 'known red - bead: pi-packages-zzz', ghost: 'stale - bead: pi-packages-yyy' });
  assert.deepEqual(plan.runnable, ['alpha']);
  assert.deepEqual(plan.skipped, [{ name: 'beta', reason: 'known red - bead: pi-packages-zzz' }]);
  assert.equal(plan.rotWarnings.length, 1);
  assert.match(plan.rotWarnings[0], /ghost/);
});

test('planRun: an empty quarantine map runs everything', () => {
  const plan = planRun(GATED, {});
  assert.deepEqual(plan.runnable, ['alpha', 'beta']);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.rotWarnings, []);
});

// ---------- summarize ----------
test('summarize: renders every status and counts only FAIL as failed', () => {
  const { lines, failed } = summarize([
    { name: 'alpha', status: 'PASS', gate: 'npm test', ms: 1234 },
    { name: 'beta', status: 'FAIL', gate: 'npm run check', ms: 99 },
    { name: 'gamma', status: 'SKIPPED', reason: 'known red - bead: pi-packages-zzz' },
  ]);
  assert.equal(failed, 1);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^PASS\s+alpha/);
  assert.match(lines[1], /^FAIL\s+beta/);
  assert.match(lines[2], /^SKIPPED\s+gamma/);
  assert.match(lines[2], /bead: pi-packages-zzz/);
});

test('summarize: a clean run is all-pass with failed = 0', () => {
  const { failed } = summarize([{ name: 'alpha', status: 'PASS', gate: 'npm test', ms: 1 }]);
  assert.equal(failed, 0);
});
