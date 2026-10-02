// scripts/ci/package-gate.mjs
// Package gate: run each package's composed gate with its installed
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

// Select the gate that runs each declared `check` / `typecheck` / `test` script at least once.
//
// Order is typecheck -> lint/check -> tests: cheapest and most fundamental first, so a type
// error fails before the suite runs. Each of those three declared scripts is composed in, and
// running one twice is acceptable and deliberate — the gate errs toward repeating a step rather
// than skipping one. The rule only knows these three script names, and it decides coverage by
// matching script text: a standalone script that nothing references is not run, and a script that
// merely mentions an invocation can suppress a step. Both are documented limitations — see
// "Residual limitation" in
// docs/superpowers/specs/2026-09-25-package-gate-select-composition-design.md. The single
// transitive exception: `typecheck` is not added when `check` or `test` already invokes it
// (matched by script text).
//
// The coverage clause is load-bearing: pi-superpowers-plus's `check` is `biome check .` (lint
// only), so its gate is `npm run check && npm test` — the lint runs twice because that package's
// `test` also lints, which is harmless.
export function selectGate(scripts) {
  if (!isGated(scripts)) return null;
  const { check, typecheck, test } = scripts;
  const checkRunsTests = Boolean(check) && covers(check, 'test');
  const steps = [];
  if (typecheck && !(check && covers(check, 'typecheck')) && !covers(test, 'typecheck')) {
    steps.push('npm run typecheck');
  }
  if (check && !checkRunsTests) steps.push('npm run check');
  steps.push(checkRunsTests ? 'npm run check' : 'npm test');
  return steps.join(' && ');
}

// Auto-discovery: the inventory of every directory under packages/ that declares a manifest.
// A gated package contributes `{ name, dir, gate }`; a package whose manifest cannot be read,
// parsed, or shaped into a `scripts` object contributes `{ name, dir, gate: null, error }` and
// fails on its own — one unreadable manifest never aborts the scan and is never silently omitted.
// Ungated packages and directories with no manifest contribute nothing.
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

// Read and parse one manifest, or throw a normalized, single-line Error. The shape check covers
// only the two container levels: `isGated` already treats a non-string `test` as ungated, so
// `{ scripts: { test: 42 } }` is legitimately an ungated package, not an unreadable manifest.
function readManifest(dir) {
  let text;
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch (err) {
    throw new Error(`cannot read package.json: ${oneLine(err.message)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`package.json is not valid JSON: ${oneLine(err.message)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package.json is not an object');
  }
  const { scripts } = parsed;
  if (scripts !== undefined && (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))) {
    throw new Error('package.json "scripts" is not an object');
  }
  return scripts;
}

export function discoverPackages(packagesDir = PACKAGES_DIR) {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const dir = join(packagesDir, name);
      if (!existsSync(join(dir, 'package.json'))) return [];
      try {
        const scripts = readManifest(dir);
        return isGated(scripts) ? [{ name, dir, gate: selectGate(scripts) }] : [];
      } catch (err) {
        return [{ name, dir, gate: null, error: oneLine(err.message) }];
      }
    });
}

// Split the inventory into what will run, what is quarantined, and what could not be read, and
// flag quarantine entries that no longer name a gated package. An unreadable manifest is never
// quarantinable: it is always reported as a failure, and it never counts as a gated package for
// rot detection, so quarantining one warns instead of silencing it.
export function planRun(inventory, quarantined = QUARANTINED) {
  const runnable = [];
  const skipped = [];
  const errored = [];
  for (const pkg of inventory) {
    if (pkg.gate === null) errored.push({ name: pkg.name, error: pkg.error });
    else if (Object.hasOwn(quarantined, pkg.name)) skipped.push({ name: pkg.name, reason: quarantined[pkg.name] });
    else runnable.push(pkg.name);
  }
  const names = new Set(inventory.filter((pkg) => pkg.gate !== null).map((pkg) => pkg.name));
  const rotWarnings = Object.keys(quarantined)
    .filter((name) => !names.has(name))
    .map((name) => `${name} is quarantined but is not a gated package; remove the entry.`);
  return { runnable, skipped, errored, rotWarnings };
}

// Render the always-printed summary table. `failed` drives the process exit code.
export function summarize(results) {
  const lines = results.map((result) => {
    const status = String(result.status).padEnd(7);
    // A FAIL row with no gate is an unreadable manifest: show its error instead of an empty column.
    const detail = result.status === 'SKIPPED' ? (result.reason ?? '') : (result.gate ?? result.error ?? '');
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
  const found = discoverPackages(packagesDir).find((pkg) => pkg.name === name);
  if (!found) {
    return { name, status: 'FAIL', gate: null, ms: 0, output: `no gate for package: ${name}` };
  }
  if (found.gate === null) {
    // An unreadable manifest is a failure with nothing executed: never a false PASS, never a crash,
    // and never an npm invocation with a null gate.
    return { name, status: 'FAIL', gate: null, ms: 0, output: found.error };
  }
  const gate = found.gate;
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
  const inventory = discoverPackages(packagesDir);
  const { runnable, skipped, errored, rotWarnings } = planRun(inventory, quarantined);
  const isSkipped = (name) => skipped.some((entry) => entry.name === name);
  const errorOf = (name) => errored.find((entry) => entry.name === name)?.error;

  if (flags.has('--list')) {
    if (flags.has('--json')) {
      // CI's gates-list job feeds this straight to fromJSON(), so it stays a bare array; the broken
      // package is signalled on stderr and through the exit code instead.
      out(JSON.stringify(runnable));
      for (const entry of errored) err(`FAIL ${entry.name}  ${entry.error}`);
    } else {
      for (const pkg of inventory) {
        const skip = skipped.find((entry) => entry.name === pkg.name);
        if (pkg.gate === null) out(`FAIL ${pkg.name}  ${pkg.error}`);
        else out(skip ? `SKIPPED ${pkg.name}  ${skip.reason}` : `${pkg.name}  ${pkg.gate}`);
      }
    }
    for (const warning of rotWarnings) err(`WARNING: ${warning}`);
    return errored.length > 0 ? 1 : 0;
  }

  const all = flags.has('--all');
  if (!all && names.length === 0) {
    err('usage: package-gate.mjs <package> | --all | --list [--json]');
    return 2;
  }
  for (const name of names) {
    if (inventory.some((pkg) => pkg.name === name) || isSkipped(name)) continue;
    err(`unknown package: ${name}`);
    return 2;
  }

  const order = all ? inventory.map((pkg) => pkg.name) : names;
  const results = order.map((name) => {
    const error = errorOf(name);
    // `error` feeds the summary table's detail column; `output` feeds the tail block below.
    if (error !== undefined) return { name, status: 'FAIL', gate: null, ms: 0, error, output: error };
    if (isSkipped(name)) return { name, status: 'SKIPPED', reason: skipped.find((entry) => entry.name === name).reason };
    return runGate(name, { packagesDir });
  });

  const { lines, failed } = summarize(results);
  for (const line of lines) out(line);
  for (const result of results.filter((entry) => entry.status === 'FAIL'))
    err(`\n--- ${result.name} output tail ---\n${result.output}`);
  for (const warning of rotWarnings) err(`WARNING: ${warning}`);
  return failed > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));