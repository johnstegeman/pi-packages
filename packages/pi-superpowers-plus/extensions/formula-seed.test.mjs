import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedFormula } from "./formula-seed.mjs";

const FORMULA = "superpowers-workflow.formula.toml";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fseed-"));
  const sourceDir = join(dir, "pkg", "formulas");
  const targetDir = join(dir, "home", ".beads", "formulas");
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, FORMULA);
  writeFileSync(source, "[formula]\nid = \"superpowers-workflow\"\n");
  return { dir, source, targetDir, target: join(targetDir, FORMULA) };
}
function cleanup(s) { rmSync(s.dir, { recursive: true, force: true }); }

test("absent target -> linked (symlink to source)", async () => {
  const s = scratch();
  try {
    const r = await seedFormula(s.source, s.targetDir);
    assert.equal(r.action, "linked");
    assert.ok(existsSync(s.target));
    assert.equal(readlinkSync(s.target), s.source);
  } finally { cleanup(s); }
});

test("our good symlink -> already-linked (no change)", async () => {
  const s = scratch();
  try {
    mkdirSync(s.targetDir, { recursive: true });
    symlinkSync(s.source, s.target);
    const r = await seedFormula(s.source, s.targetDir);
    assert.equal(r.action, "already-linked");
    assert.equal(readlinkSync(s.target), s.source);
  } finally { cleanup(s); }
});

test("symlinked package dir -> linked", async () => {
  const s = scratch();
  try {
    const pkgDir = join(s.dir, "pkg"); // real package dir
    symlinkSync(pkgDir, join(s.dir, "alias")); // simulate a pi-install-style symlinked package dir
    const source = join(s.dir, "alias", "formulas", FORMULA);
    const r = await seedFormula(source, s.targetDir);
    assert.equal(r.action, "linked");
    assert.ok(existsSync(s.target));
  } finally { cleanup(s); }
});

test("symlinked package dir, re-seed -> already-linked (realpath identity)", async () => {
  const s = scratch();
  try {
    const pkgDir = join(s.dir, "pkg");
    symlinkSync(pkgDir, join(s.dir, "alias"));
    const source = join(s.dir, "alias", "formulas", FORMULA);
    const r1 = await seedFormula(source, s.targetDir);
    assert.equal(r1.action, "linked");
    const r2 = await seedFormula(source, s.targetDir);
    assert.equal(r2.action, "already-linked");
  } finally { cleanup(s); }
});

test("already-linked despite differing source path form (real vs symlinked)", async () => {
  const s = scratch();
  try {
    const pkgDir = join(s.dir, "pkg");
    symlinkSync(pkgDir, join(s.dir, "alias"));
    const symlinkSource = join(s.dir, "alias", "formulas", FORMULA);
    const realSource = join(pkgDir, "formulas", FORMULA);
    assert.equal((await seedFormula(symlinkSource, s.targetDir)).action, "linked");
    // re-seed through the sibling real path; only realpath-based identity sees this as already-linked
    const r = await seedFormula(realSource, s.targetDir);
    assert.equal(r.action, "already-linked");
  } finally { cleanup(s); }
});

test("dangling symlink -> relinked", async () => {
  const s = scratch();
  try {
    mkdirSync(s.targetDir, { recursive: true });
    symlinkSync(join(s.targetDir, "gone.formula.toml"), s.target); // point at a nonexistent file
    const r = await seedFormula(s.source, s.targetDir);
    assert.equal(r.action, "relinked");
    assert.equal(readlinkSync(s.target), s.source);
  } finally { cleanup(s); }
});

test("foreign symlink -> skipped-foreign (untouched)", async () => {
  const s = scratch();
  try {
    mkdirSync(s.targetDir, { recursive: true });
    const other = join(s.dir, "other.formula.toml");
    writeFileSync(other, "other");
    symlinkSync(other, s.target);
    const r = await seedFormula(s.source, s.targetDir);
    assert.equal(r.action, "skipped-foreign");
    assert.equal(readlinkSync(s.target), other);
  } finally { cleanup(s); }
});

test("regular file at target -> skipped-user-file (untouched)", async () => {
  const s = scratch();
  try {
    mkdirSync(s.targetDir, { recursive: true });
    writeFileSync(s.target, "user customized");
    const r = await seedFormula(s.source, s.targetDir);
    assert.equal(r.action, "skipped-user-file");
    assert.equal(existsSync(s.target), true);
    assert.equal(readFileSync(join(s.targetDir, FORMULA), "utf8"), "user customized");
  } finally { cleanup(s); }
});

test("unwritable/ENOTDIR target -> skipped-unwritable (no throw)", async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "not-a-dir"), "x"); // a regular FILE as the parent of targetDir
    const r = await seedFormula(s.source, join(join(s.dir, "not-a-dir"), ".beads", "formulas"));
    assert.equal(r.action, "skipped-unwritable");
  } finally { cleanup(s); }
});

test("missing source -> skipped-error (no throw)", async () => {
  const s = scratch();
  try {
    const r = await seedFormula(join(s.dir, "pkg", "formulas", "nope.formula.toml"), s.targetDir);
    assert.equal(r.action, "skipped-error");
    assert.equal(existsSync(join(s.targetDir, FORMULA)), false);
  } finally { cleanup(s); }
});
