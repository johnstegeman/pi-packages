// Structural contract test for the Superpowers skill/prompt set
// (docs/superpowers/specs/2026-09-11-superpowers-skill-prompt-contradictions-design.md).
// Plain node, no dependencies.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const skillFiles = () => walk(join(root, "skills")).filter((f) => f.endsWith(".md") || f.endsWith(".js"));

const ALLOWED_PHASES = new Set(["brainstorming", "development", ""]);

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
async function run() {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n${e.stack ?? e}`);
    }
  }
  if (failures) {
    console.error(`\nskills-contract: ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nskills-contract: all assertions passed");
}

test("set_phase uses only the canonical vocabulary", () => {
  const re = /set_phase\(\{\s*phase:\s*["']([^"']*)["']\s*\}\)/g;
  const offenders = [];
  for (const f of skillFiles()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) {
      if (!ALLOWED_PHASES.has(m[1])) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the SDD prompt set emits one aligned phase", () => {
  const dir = join(root, "skills", "subagent-driven-development");
  const files = ["implementer-prompt.md", "re-review-prompt.md", "task-reviewer-prompt.md"];
  const phases = files.map((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    const m = [...src.matchAll(/set_phase\(\{\s*phase:\s*["']([^"']*)["']\s*\}\)/g)];
    assert.ok(m.length, `${f} must emit set_phase`);
    return m.map((x) => x[1]);
  });
  assert.deepEqual([...new Set(phases.flat())], ["development"]);
});

test("plan-approval gate placeholders are not conflated", () => {
  for (const f of skillFiles()) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("<plan-approved-gate-id>"), `${f} still uses <plan-approved-gate-id>`);
    for (const m of src.matchAll(/beads_gate_resolve\(\{\s*id:\s*["']([^"']*)["']/g)) {
      assert.ok(!m[1].includes("gate-bead-id"), `${f} passes a gate task bead to beads_gate_resolve: ${m[1]}`);
    }
  }
});

test("no HEAD~1 review base in shipped skills", () => {
  for (const f of skillFiles()) {
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      if (line.includes("HEAD~1") && !/\bnever\b/.test(line)) {
        assert.fail(`${f}:${i + 1} uses HEAD~1 as a review base (only "never HEAD~1" warnings are allowed)`);
      }
    }
  }
});

test("no shipped skill restates the code-reviewer identity", () => {
  for (const f of skillFiles()) {
    assert.ok(
      !readFileSync(f, "utf8").includes("You are a Senior Code Reviewer"),
      `${f} restates the code-reviewer identity (canonical source is agent-templates/code-reviewer.md)`,
    );
  }
});

// --- reference-material contract ---
const skillsRoot = join(root, "skills");
function skillDirs() {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(skillsRoot, e.name));
}
function readRefFiles(dir) {
  try {
    return readdirSync(join(dir, "reference"));
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

test("every reference file is linked from its SKILL.md", () => {
  const offenders = [];
  for (const dir of skillDirs()) {
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
    for (const f of readRefFiles(dir)) {
      if (!skill.includes(`reference/${f}`)) offenders.push(`${dir}: reference/${f} unlinked`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every relative markdown link in a SKILL.md or reference file resolves", () => {
  const offenders = [];
  for (const dir of skillDirs()) {
    const files = [join(dir, "SKILL.md")];
    try {
      for (const f of readdirSync(join(dir, "reference"))) {
        if (f.endsWith(".md")) files.push(join(dir, "reference", f));
      }
    } catch {
      // no reference/ directory for this skill
    }
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const t = m[1];
        if (/^[a-z][a-z0-9+.-]*:/.test(t) || t.startsWith("#")) continue;
        if (!existsSync(join(dirname(file), t))) offenders.push(`${file} -> ${t}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("read-gate lines match the marker and target real files", () => {
  const offenders = [];
  for (const dir of skillDirs()) {
    const src = readFileSync(join(dir, "SKILL.md"), "utf8");
    for (const line of src.split("\n")) {
      if (!/^>\s*\*\*Read now:\*\*/.test(line)) continue;
      const m = line.match(/^>\s*\*\*Read now:\*\*\s*\[[^\]]*\]\(([^)\s]+)\)\s+—\s+\S/);
      if (!m) {
        offenders.push(`${dir}: read-gate malformed (missing em-dash description): ${line.trim()}`);
        continue;
      }
      if (!existsSync(join(dir, m[1]))) offenders.push(`${dir}: read-gate -> ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no set_phase call lives in reference material", () => {
  const offenders = [];
  for (const dir of skillDirs()) {
    for (const f of readRefFiles(dir)) {
      const src = readFileSync(join(dir, "reference", f), "utf8");
      if (/set_phase\(\{/.test(src)) offenders.push(`${dir}/reference/${f}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ----- beads guardrail (docs/superpowers/specs/2026-10-05-workflow-child-bead-guardrail-design.md) -----
// Every prompt a child receives must forbid beads writes; the controller alone owns bead state.
// CORE is byte-identical everywhere, followed by an audience tail. Each copy must sit on ONE
// unbroken line — a hard-wrap makes it invisible to a human reader scanning for the rule.

const CORE =
  "Do NOT create, update, or close any beads issues (beads_* tools / bd commands) — task tracking belongs to the orchestrator";
const TAIL_IMPL =
  ", who closes this task's bead only after the review passes. Report DONE; the controller handles the bead.";
const TAIL_REVIEW =
  ". Your beads access is READ-ONLY — reading the task/gate bead is fine; never write. Report your verdict; the controller records it.";
const GUARDRAIL_IMPL = `**${CORE}${TAIL_IMPL}**`;
const GUARDRAIL_REVIEW = `**${CORE}${TAIL_REVIEW}**`;
const IMPL = "IMPL";
const REVIEW = "REVIEW";
const rendering = (variant) => (variant === IMPL ? GUARDRAIL_IMPL : GUARDRAIL_REVIEW);

test("beads guardrail: implementer-prompt.md stays the canonical IMPL copy", () => {
  const p = join(root, "skills", "subagent-driven-development", "implementer-prompt.md");
  assert.ok(
    readFileSync(p, "utf8").includes(GUARDRAIL_IMPL),
    "implementer-prompt.md:48 must keep CORE + TAIL_IMPL verbatim on one line",
  );
});

test("beads guardrail: every prompt source carries the audience-correct variant", () => {
  const guarded = [
    ["skills/subagent-driven-development/implementer-prompt.md", [IMPL]],
    ["skills/subagent-driven-development/re-review-prompt.md", [REVIEW]],
    ["skills/subagent-driven-development/task-reviewer-prompt.md", [REVIEW]],
    ["skills/subagent-driven-development/scripts/fix-loop.js", [IMPL, REVIEW]],
    ["skills/subagent-driven-development/scripts/wave-parallel.js", [IMPL, REVIEW]],
    ["skills/subagent-driven-development/scripts/final-review.js", [REVIEW]],
    ["agent-templates/implementer.md", [IMPL]],
    ["agent-templates/worker.md", [IMPL]],
    ["agent-templates/task-reviewer.md", [REVIEW]],
    ["agent-templates/code-reviewer.md", [REVIEW]],
    ["agent-templates/verifier.md", [REVIEW]],
  ];
  const offenders = [];
  for (const [rel, variants] of guarded) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const v of variants) {
      if (!src.includes(rendering(v))) offenders.push(`${rel} (missing ${v})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("beads guardrail: no prompt source is left unguarded", () => {
  const offenders = [];
  // 1. every prompt template the skill ships
  for (const f of skillFiles()) {
    if (f.endsWith("-prompt.md") && !readFileSync(f, "utf8").includes(CORE)) offenders.push(f);
  }
  // 2. every SDD workflow script that emits a prompt
  const scriptsDir = join(root, "skills", "subagent-driven-development", "scripts");
  for (const e of readdirSync(scriptsDir)) {
    if (!e.endsWith(".js")) continue;
    const src = readFileSync(join(scriptsDir, e), "utf8");
    if (src.includes("agent(") && !src.includes(CORE)) offenders.push(join(scriptsDir, e));
  }
  // 3. every agent template except the read-only research agent
  const templatesDir = join(root, "agent-templates");
  for (const e of readdirSync(templatesDir)) {
    if (!e.endsWith(".md") || e === "explore.md") continue;
    if (!readFileSync(join(templatesDir, e), "utf8").includes(CORE)) offenders.push(join(templatesDir, e));
  }
  assert.deepEqual(offenders, [], "every prompt source must carry CORE — see the spec's inventory");
});

run();
