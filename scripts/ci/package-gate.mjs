// scripts/ci/package-gate.mjs
// Package gate: run each package's strongest available gate with its installed
// dependencies, so a pull request cannot merge with an unrun lint/typecheck/test suite.
//
// Exit codes (CLI, added in Task 2):
//   0 = every runnable package passed
//   1 = at least one package failed
//   2 = usage or configuration error
//
// Runs only through `npm ci` / `npm run` / `npm test`. Never `npx`: `npx biome`
// resolves a stale cached binary from ~/.npm/_npx instead of the package's pinned
// one and reports a false green.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return new RegExp(`\\bnpm\\s+(?:run\\s+)?${target}(?![\\w:-])`).test(scriptText);
}

// The strongest gate a package offers:
//   `check` (when it covers test, and typecheck whenever a typecheck script exists)
//   > `typecheck && test` > `test`.
// The coverage clause is load-bearing: pi-superpowers-plus's `check` is `biome check .`
// (lint only), so using it would silently stop running its 16 suites.
export function selectGate(scripts) {
  if (!isGated(scripts)) return null;
  const check = scripts.check;
  if (check && covers(check, 'test') && (!scripts.typecheck || covers(check, 'typecheck'))) return 'npm run check';
  if (scripts.typecheck) return 'npm run typecheck && npm test';
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
