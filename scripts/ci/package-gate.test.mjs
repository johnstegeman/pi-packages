// scripts/ci/package-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


// ---------- process-level: the real script executed in a scratch repo ----------
// House pattern (see check-deps-mirror.test.mjs): the script resolves the repo root from
// its own location, so copy it into a scratch skeleton and run it with cwd = scratch.
const SCRIPT_SRC = new URL('./package-gate.mjs', import.meta.url);

// A dependency-free fixture installs with no network. `npm ci` needs a lockfile that
// matches package.json; this minimal v3 lock does. If npm ever rejects it, replace the
// writeFileSync with:
//   execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: pkgDir })
const minimalLock = (name) =>
  JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } } });

function scratchRepo(pkgs) {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-gate-repo-'));
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  cpSync(SCRIPT_SRC, join(dir, 'scripts/ci/package-gate.mjs'));
  for (const [name, testScript] of Object.entries(pkgs)) {
    const pkgDir = join(dir, 'packages', name);
    mkdirSync(pkgDir, { recursive: true });
    if (testScript === null) {
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      continue;
    }
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: {}, scripts: { test: testScript } }),
    );
    writeFileSync(join(pkgDir, 'package-lock.json'), minimalLock(name));
  }
  return dir;
}

function runCli(dir, args) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/ci/package-gate.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
  }
  return { code, out };
}

test('cli --all: a passing package exits 0 and prints PASS', () => {
  const dir = scratchRepo({ alpha: 'node -e "process.exit(0)"' });
  try {
    const { code, out } = runCli(dir, ['--all']);
    assert.equal(code, 0);
    assert.match(out, /PASS\s+alpha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli --all: a failing package exits 1, prints FAIL and the output tail', () => {
  const dir = scratchRepo({ alpha: 'node -e "console.error(\'boom-marker\'); process.exit(3)"' });
  try {
    const { code, out } = runCli(dir, ['--all']);
    assert.equal(code, 1);
    assert.match(out, /FAIL\s+alpha/);
    assert.match(out, /boom-marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli --all: a package with no lockfile fails rather than being skipped', () => {
  const dir = scratchRepo({ alpha: 'node -e "process.exit(0)"' });
  rmSync(join(dir, 'packages/alpha/package-lock.json'));
  try {
    const { code, out } = runCli(dir, ['--all']);
    assert.equal(code, 1);
    assert.match(out, /FAIL\s+alpha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli --list --json: emits only the runnable names, as JSON', () => {
  const dir = scratchRepo({ alpha: 'node -e "process.exit(0)"', beta: 'node -e "process.exit(0)"', gamma: null });
  try {
    const { code, out } = runCli(dir, ['--list', '--json']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out.trim()), ['alpha', 'beta']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: an unknown package exits 2', () => {
  const dir = scratchRepo({ alpha: 'node -e "process.exit(0)"' });
  try {
    const { code, out } = runCli(dir, ['nope']);
    assert.equal(code, 2);
    assert.match(out, /unknown package/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: no arguments exits 2 with usage', () => {
  const dir = scratchRepo({ alpha: 'node -e "process.exit(0)"' });
  try {
    const { code, out } = runCli(dir, []);
    assert.equal(code, 2);
    assert.match(out, /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the module never invokes npx in code', () => {
  const src = readFileSync(new URL('./package-gate.mjs', import.meta.url), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/\bnpx\b/.test(code), 'package-gate.mjs must not invoke npx in code (the header comment may explain why not)');
});