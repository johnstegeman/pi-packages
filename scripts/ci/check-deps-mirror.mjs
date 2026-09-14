// scripts/ci/check-deps-mirror.mjs
// Dep-mirror gate: every runtime dependency of packages/pi-subagents must be present in the
// root package.json dependencies with a version range that intersects the subtree's range.
// Exit 0 = pass, 1 = gate failure, 2 = semver not resolvable.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let semver;
try {
  semver = require('semver');
} catch {
  const nodePath = process.env.NODE_PATH || '(unset)';
  console.error(
    `ERROR: \`semver\` not resolvable (NODE_PATH=${nodePath}). ` +
      'Run `npm install --no-save semver@^7 --prefix /tmp/depsmirror` and set NODE_PATH=/tmp/depsmirror/node_modules.',
  );
  process.exit(2);
}

const repoRoot = new URL('../..', import.meta.url); // repo root dir (from scripts/ci/)
const root = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
const sub = JSON.parse(readFileSync(new URL('packages/pi-subagents/package.json', repoRoot), 'utf8'));

const rootDeps = root.dependencies ?? {};
const subDeps = sub.dependencies ?? {};

let failed = false;
for (const [name, subRange] of Object.entries(subDeps)) {
  const rootRange = rootDeps[name];
  if (rootRange === undefined) {
    console.error(`MISSING ${name}: subtree declares "${subRange}" but root dependencies has no entry.`);
    failed = true;
    continue;
  }
  let compatible;
  try {
    compatible = semver.intersects(rootRange, subRange);
  } catch {
    console.error(
      `INVALID RANGE ${name}: root declares "${rootRange}", subtree declares "${subRange}" — not valid semver ranges.`,
    );
    failed = true;
    continue;
  }
  if (!compatible) {
    console.error(`INCOMPATIBLE ${name}: root declares "${rootRange}", subtree declares "${subRange}" — ranges do not intersect.`);
    failed = true;
  }
}

if (failed) {
  console.error('\nDep-mirror gate FAILED. Mirror the subtree dependencies into root package.json `dependencies` (same or newer-compatible range) and re-run.');
  process.exit(1);
}
console.log('OK: every subtree dependency is mirrored in root with a compatible range.');
