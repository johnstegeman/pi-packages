// Extension-entry wiring test for the repo-local shadow warning in formula-seed.ts.
// Node strips the TS types; the entry's only pi import is `import type`, erased.
// The warning is the one thing that must be visible when a repo-local formula silently
// shadows the seeded user-level symlink (bd search path #2 wins over path #3).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { warnOnRepoLocalShadow } from "../extensions/formula-seed.ts";

const FORMULA = "superpowers-workflow.formula.toml";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fshadow-"));
  const sourceDir = join(dir, "pkg", "formulas");
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, FORMULA);
  writeFileSync(source, '[formula]\nid = "superpowers-workflow"\n');
  return { dir, source, repoPath: join(dir, ".beads", "formulas", FORMULA) };
}

/** A fake pi.exec that answers one `git rev-parse --git-common-dir` probe. */
function fakeExec(commonDir) {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args, opts) => {
      calls.push([cmd, ...args, opts?.cwd]);
      if (cmd !== "git") return { code: 0, stdout: "", stderr: "" };
      if (commonDir === null) return { code: 128, stdout: "", stderr: "not a git repository" };
      return { code: 0, stdout: `${commonDir}\n`, stderr: "" };
    },
  };
}

const captureWarn = () => {
  const warnings = [];
  return { warnings, warn: (msg) => warnings.push(msg) };
};

// ---------- differing repo-local file -> one warning naming both paths ----------
{
  const s = scratch();
  try {
    mkdirSync(dirname(s.repoPath), { recursive: true });
    writeFileSync(s.repoPath, "stale copy with no wrap-up step\n");
    const { warnings, warn } = captureWarn();
    const { exec, calls } = fakeExec(join(s.dir, ".git"));
    await warnOnRepoLocalShadow({ exec, cwd: s.dir, sourcePath: s.source, warn });
    assert.equal(warnings.length, 1, `warns exactly once; got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /repo-local formula shadows the packaged one/);
    assert.ok(warnings[0].includes(s.repoPath), "names the repo-local path");
    assert.ok(warnings[0].includes(s.source), "names the packaged path");
    assert.match(warnings[0], /bd reads the repo-local copy/);
    assert.equal(calls.filter((c) => c[0] === "git").length, 1, "one git call at most");
    assert.equal(
      readFileSync(s.repoPath, "utf8"),
      "stale copy with no wrap-up step\n",
      "no writes to the repo-local path",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

// ---------- no repo-local file -> silent ----------
{
  const s = scratch();
  try {
    const { warnings, warn } = captureWarn();
    const { exec } = fakeExec(join(s.dir, ".git"));
    await warnOnRepoLocalShadow({ exec, cwd: s.dir, sourcePath: s.source, warn });
    assert.equal(warnings.length, 0, "silent when no repo-local file exists");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

// ---------- byte-identical repo-local file -> silent ----------
{
  const s = scratch();
  try {
    mkdirSync(dirname(s.repoPath), { recursive: true });
    writeFileSync(s.repoPath, readFileSync(s.source));
    const { warnings, warn } = captureWarn();
    const { exec } = fakeExec(join(s.dir, ".git"));
    await warnOnRepoLocalShadow({ exec, cwd: s.dir, sourcePath: s.source, warn });
    assert.equal(warnings.length, 0, "silent when the repo-local copy matches the package");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

// ---------- not a git repo -> silent, no throw ----------
{
  const s = scratch();
  try {
    mkdirSync(dirname(s.repoPath), { recursive: true });
    writeFileSync(s.repoPath, "stale\n");
    const { warnings, warn } = captureWarn();
    const { exec } = fakeExec(null);
    await warnOnRepoLocalShadow({ exec, cwd: s.dir, sourcePath: s.source, warn });
    assert.equal(warnings.length, 0, "silent when the checkout root cannot be resolved");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

// ---------- exec throwing -> silent, no throw ----------
{
  const s = scratch();
  try {
    const { warnings, warn } = captureWarn();
    const exec = async () => {
      throw new Error("no git on PATH");
    };
    await warnOnRepoLocalShadow({ exec, cwd: s.dir, sourcePath: s.source, warn });
    assert.equal(warnings.length, 0, "a git failure never throws or warns");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

// ---------- no exec available (pi-less load) -> silent, no throw ----------
{
  const s = scratch();
  try {
    const { warnings, warn } = captureWarn();
    await warnOnRepoLocalShadow({ exec: undefined, cwd: s.dir, sourcePath: s.source, warn });
    assert.equal(warnings.length, 0, "missing exec is a silent no-op");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

console.log("\nformula-seed-shadow: all assertions passed");
