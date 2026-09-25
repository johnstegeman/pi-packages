// scripts/ci/package-gate.mjs
// Package gate: run each package's strongest available gate with its installed
// dependencies, so a pull request cannot merge with an unrun lint/typecheck/test suite.
//
// Exit codes:
//   0 = every runnable package passed
//   1 = at least one package failed
//   2 = usage or configuration error
//
// Runs only through `npm ci` / `npm run` / `npm test`. Never `npx`: `npx biome`
// resolves a stale cached binary from ~/.npm/_npx instead of the package's pinned
// one and reports a false green.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PACKAGES_DIR = join(REPO_ROOT, 'packages');

// Packages deliberately not run. Every entry needs a reason AND a bead id, is reported
// on every run, and an entry that no longer names a gated package produces a warning —
// so this list cannot rot and nothing can be excluded silently.
export const QUARANTINED = {
  // '<package>': '<why> - bead: <id>',
};

export function isGated(scripts) {
  return typeof scripts?.test === 'string' && scripts.test.trim() !== '';
}

// True when a script's text invokes `npm <target>` or `npm run <target>`. The negative
// lookahead keeps `npm run test:coverage` from counting as a `test` invocation.
export function covers(scriptText, target) {
  if (typeof scriptText !== 'string') return false;
  const escaped = String(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bnpm\\s+(?:run\\s+)?${escaped}(?![\\w:-])`).test(scriptText);
}

// The strongest gate a package offers:
//   `check` when it covers test (prefixed with `typecheck` if `check` itself does not
//   invoke the typecheck script) > `typecheck && test` > `test`. Nothing declared is
//   dropped: a selected gate always composes, never replaces, a declared script.
// The coverage clause is load-bearing: pi-superpowers-plus's `check` is `biome check .`
// (lint only), so using it would silently stop running its 16 suites.
export function selectGate(scripts) {
  if (!isGated(scripts)) return null;
  const { check, typecheck } = scripts;
  if (check && covers(check, 'test')) {
    // `check` runs the tests; compose rather than replace so a typecheck script that
    // `check` does not already invoke is added without dropping the rest of `check`.
    if (!typecheck || covers(check, 'typecheck')) return 'npm run check';
    return 'npm run typecheck && npm run check';
  }
  if (typecheck) return 'npm run typecheck && npm test';
  return 'npm test';
}

// Auto-discovery: a package is gated iff it declares a non-empty `test` script, so the
// list cannot drift from reality and no package can be dropped by forgetting to edit it.
export function discoverGated(packagesDir = PACKAGES_DIR) {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const dir = join(packagesDir, name);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) return [];
      const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts;
      return isGated(scripts) ? [{ name, dir, gate: selectGate(scripts) }] : [];
    });
}

// Split the inventory into what will run and what is quarantined, and flag quarantine
// entries that no longer name a gated package.
export function planRun(gated, quarantined = QUARANTINED) {
  const runnable = [];
  const skipped = [];
  for (const pkg of gated) {
    if (Object.hasOwn(quarantined, pkg.name)) skipped.push({ name: pkg.name, reason: quarantined[pkg.name] });
    else runnable.push(pkg.name);
  }
  const names = new Set(gated.map((pkg) => pkg.name));
  const rotWarnings = Object.keys(quarantined)
    .filter((name) => !names.has(name))
    .map((name) => `${name} is quarantined but is not a gated package; remove the entry.`);
  return { runnable, skipped, rotWarnings };
}

// Render the always-printed summary table. `failed` drives the process exit code.
export function summarize(results) {
  const lines = results.map((result) => {
    const status = String(result.status).padEnd(7);
    const detail = result.status === 'SKIPPED' ? (result.reason ?? '') : (result.gate ?? '');
    const ms = typeof result.ms === 'number' ? `${Math.round(result.ms)}ms` : '';
    return `${status} ${String(result.name).padEnd(20)} ${ms.padStart(8)}  ${detail}`.trimEnd();
  });
  const failed = results.filter((result) => result.status === 'FAIL').length;
  return { lines, failed };
}

const TAIL_LINES = 25;

// Split a gate string produced by selectGate into argv arrays. The vocabulary is fixed
// ('npm test', 'npm run <script>'), so splitting is sufficient and avoids a shell.
export function gateSteps(gate) {
  return String(gate)
    .split(' && ')
    .map((step) => step.trim().split(/\s+/))
    .filter((argv) => argv.length > 0 && argv[0] !== '');
}

function tail(text) {
  return String(text ?? '').trim().split('\n').slice(-TAIL_LINES).join('\n');
}

// `npm ci` from the committed lockfile, then the selected gate. Any non-zero exit is a
// failure with its output tail attached — an install failure is never a skip.
export function runGate(name, { packagesDir = PACKAGES_DIR } = {}) {
  const dir = join(packagesDir, name);
  const gated = discoverGated(packagesDir).find((pkg) => pkg.name === name);
  if (!gated) {
    return { name, status: 'FAIL', gate: null, ms: 0, output: `no gate for package: ${name}` };
  }
  const gate = gated.gate;
  const started = Date.now();
  const steps = [
    ['npm', ['ci', '--no-audit', '--no-fund']],
    ...gateSteps(gate).map((argv) => [argv[0], argv.slice(1)]),
  ];
  for (const [cmd, args] of steps) {
    try {
      execFileSync(cmd, args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      const output = tail(`${err.stdout ?? ''}\n${err.stderr ?? ''}`);
      return { name, status: 'FAIL', gate, ms: Date.now() - started, output };
    }
  }
  return { name, status: 'PASS', gate, ms: Date.now() - started };
}

export function main(argv, { out = console.log, err = console.error, packagesDir = PACKAGES_DIR, quarantined = QUARANTINED } = {}) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const names = argv.filter((arg) => !arg.startsWith('--'));
  const gated = discoverGated(packagesDir);
  const { runnable, skipped, rotWarnings } = planRun(gated, quarantined);
  const isSkipped = (name) => skipped.some((entry) => entry.name === name);

  if (flags.has('--list')) {
    if (flags.has('--json')) out(JSON.stringify(runnable));
    else
      for (const pkg of gated) {
        const skip = skipped.find((entry) => entry.name === pkg.name);
        out(skip ? `SKIPPED ${pkg.name}  ${skip.reason}` : `${pkg.name}  ${pkg.gate}`);
      }
    for (const warning of rotWarnings) err(`WARNING: ${warning}`);
    return 0;
  }

  const all = flags.has('--all');
  if (!all && names.length === 0) {
    err('usage: package-gate.mjs <package> | --all | --list [--json]');
    return 2;
  }
  for (const name of names) {
    if (gated.some((pkg) => pkg.name === name) || isSkipped(name)) continue;
    err(`unknown package: ${name}`);
    return 2;
  }

  const targets = all ? runnable : names;
  const results = targets.map((name) =>
    isSkipped(name)
      ? { name, status: 'SKIPPED', reason: skipped.find((entry) => entry.name === name).reason }
      : runGate(name, { packagesDir }),
  );
  if (all) for (const entry of skipped) results.push({ name: entry.name, status: 'SKIPPED', reason: entry.reason });

  const { lines, failed } = summarize(results);
  for (const line of lines) out(line);
  for (const result of results.filter((entry) => entry.status === 'FAIL'))
    err(`\n--- ${result.name} output tail ---\n${result.output}`);
  for (const warning of rotWarnings) err(`WARNING: ${warning}`);
  return failed > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));