// Packaging guard (pi-packages-bckf): a published tarball must contain every module
// the package's entry points import transitively, and every declared entry point must load.
//
// The assertion is against npm's own packlist (`npm pack --dry-run --json`) rather than
// a hand-rolled `files`/glob matcher: a matcher would reimplement the rules it is meant
// to verify. Both halves are deliberate - the static half names the missing file and its
// importer (a fixable message), the dynamic half packs, extracts and imports every entry
// point the manifest declares, which is the exact failure the bug report describes and
// catches what the regex walk misses. Both halves derive their inputs from the manifest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

/** npm's packlist paths are always posix-separated; `relative` yields platform separators. */
const posix = (p) => p.split(sep).join("/");
const posixRelative = (file) => posix(relative(pkgRoot, file));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}\n${e.stack ?? e}`);
  }
}

/** Manifest-declared entry points, as absolute paths. */
function entryPoints() {
  const exportsField = typeof pkg.exports === "string" ? [pkg.exports] : Object.values(pkg.exports ?? {});
  return [...new Set([...(pkg.pi?.extensions ?? []), pkg.main, ...exportsField])]
    .filter((p) => typeof p === "string" && p.startsWith("./"))
    .map((p) => resolve(pkgRoot, p));
}

const FROM_RE = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Relative specifiers only: `node:` builtins and bare specifiers are not packaged files. */
function relativeSpecifiers(source) {
  const out = [];
  for (const re of [FROM_RE, BARE_RE, DYNAMIC_RE])
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../")) out.push(spec);
    }
  return out;
}

/** Transitive relative-import closure: Map<absolute path, importer absolute path | null>. */
function importClosure(entries) {
  const seen = new Map();
  const queue = entries.map((file) => ({ file, importedBy: null }));
  while (queue.length > 0) {
    const { file, importedBy } = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, importedBy);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // an unreadable module is reported as missing by the assertion below
    }
    for (const spec of relativeSpecifiers(source)) {
      const next = resolve(dirname(file), spec);
      if (!seen.has(next)) queue.push({ file: next, importedBy: file });
    }
  }
  return seen;
}

let packListCache;
function packList() {
  if (packListCache === undefined) {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgRoot, encoding: "utf8" });
    packListCache = JSON.parse(raw)[0].files.map((f) => f.path);
  }
  return packListCache;
}

await test("npm's packlist is readable and non-vacuous", () => {
  const files = packList();
  assert.ok(files.length > 0, "npm pack --dry-run --json returned no files");
  // Derived from the manifest, so a renamed entry point cannot make this a stale literal.
  const packedEntry = entryPoints().map(posixRelative).find((p) => files.includes(p));
  assert.ok(packedEntry, `no manifest-declared entry point is packed: ${files.join(", ")}`);
});

await test("every module the entry points import transitively is packed", () => {
  const entries = entryPoints();
  const closure = importClosure(entries);
  // Non-vacuity on the *walk*, not on the seed: `seen` is pre-populated with the entry
  // points, so `closure.size >= 2` is true even when all three import regexes match
  // nothing. Require at least one module that is not an entry point.
  const roots = new Set(entries);
  const discovered = [...closure.keys()].filter((file) => !roots.has(file));
  assert.ok(
    discovered.length > 0,
    `the import walk found no module beyond the entry points (closure: ${[...closure.keys()]
      .map(posixRelative)
      .join(", ")}) - the regex walk matched nothing, so this assertion would pass vacuously`
  );
  const packed = new Set(packList());
  const missing = [...closure.keys()]
    .filter((file) => !packed.has(posixRelative(file)))
    .map((file) => {
      const importer = closure.get(file);
      return `${posixRelative(file)} (imported by ${importer ? posixRelative(importer) : "the package manifest"})`;
    });
  assert.deepEqual(missing, [], "modules are imported but not packed");
});

await test("every packed entry point imports without a module-not-found error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-beads-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: pkgRoot, encoding: "utf8" });
    const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced no tarball");
    execFileSync("tar", ["-xzf", join(tmp, tarball), "-C", tmp]);
    // Manifest-derived, like the static half: a renamed entry point must not surface here as
    // a misleading ERR_MODULE_NOT_FOUND, and every declared one must load - cost-tracking.ts
    // is the second entry point and imports ./index.ts, not the reverse, so importing index
    // alone would never evaluate it.
    const entries = entryPoints().map(posixRelative);
    assert.ok(entries.length > 0, "the manifest declares no entry point to load");
    for (const entry of entries) {
      const mod = await import(pathToFileURL(join(tmp, "package", entry)).href);
      assert.equal(
        typeof mod.default,
        "function",
        `the packed entry point ${entry} must export the extension factory`
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\npackaging: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("\npackaging: all assertions passed");
