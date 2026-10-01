// Packaging guard (pi-packages-bckf): a published tarball must contain every module
// the package's entry points import transitively, and its entry point must load.
//
// The assertion is against npm's own packlist (`npm pack --dry-run --json`) rather than
// a hand-rolled `files`/glob matcher: a matcher would reimplement the rules it is meant
// to verify. Both halves are deliberate - the static half names the missing file and its
// importer (a fixable message), the dynamic half packs, extracts and imports the entry
// point, which is the exact failure the bug report describes and catches what the regex
// walk misses.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

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
  assert.ok(files.includes("src/index.ts"), `src/index.ts is not packed: ${files.join(", ")}`);
});

await test("every module the entry points import transitively is packed", () => {
  const closure = importClosure(entryPoints());
  assert.ok(
    closure.size >= 2,
    `import closure has ${closure.size} module(s) - the walk found nothing, so this assertion would pass vacuously`,
  );
  const packed = new Set(packList());
  const missing = [...closure.keys()]
    .filter((file) => !packed.has(relative(pkgRoot, file)))
    .map((file) => {
      const importer = closure.get(file);
      return `${relative(pkgRoot, file)} (imported by ${importer ? relative(pkgRoot, importer) : "the package manifest"})`;
    });
  assert.deepEqual(missing, [], "modules are imported but not packed");
});

await test("the packed tarball's entry point imports without a module-not-found error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-beads-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: pkgRoot, encoding: "utf8" });
    const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced no tarball");
    execFileSync("tar", ["-xzf", join(tmp, tarball), "-C", tmp]);
    const mod = await import(pathToFileURL(join(tmp, "package", "src", "index.ts")).href);
    assert.equal(typeof mod.default, "function", "the packed entry point must export the extension factory");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\npackaging: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("\npackaging: all assertions passed");
