/**
 * workflow-stall.e2e.test.ts — the mn4e replay, end to end.
 *
 * The design's acceptance test (2026-10-08 subagent-workflow-stall-watchdog
 * design, Testing): a final-review-shaped workflow in which one verifier child
 * never returns must NOT wedge the run. The watchdog aborts the silent child,
 * its `agent()` call resolves `null`, the script finishes and writes its
 * findings file, and the timed-out child is surfaced in the persisted run
 * snapshot.
 *
 * This is the one suite that proves the pieces fit: a real `SubagentWorkflow`
 * tool call, a real worker thread compiling the script, real child sessions
 * against the faux model backend, the runtime's per-child watchdog, and the
 * settle path that persists the terminal entry.
 *
 * The stall window comes from settings (`workflowStallTimeoutSecs`, read per
 * run); the scan cadence tracks that window (`stallTimeoutMs / 10`, capped at
 * 30s), so a 4s window is observed in ~400ms ticks. No production knob is
 * stubbed: the watchdog under test is the real one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { runPrintMode } from "../helpers/print-mode-runner.js";

/** A project directory with workflows on and a short stall window. */
function workflowProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-stall-e2e-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "subagents.json"),
    JSON.stringify({ workflowsEnabled: true, workflowStallTimeoutSecs: 4 }),
  );
  return dir;
}

/**
 * A final-review-shaped script: two finders, one finding each, then a refuter
 * per finding, then a writer that appends the machine-built lines. `args`
 * carries the findings file the writer appends to.
 *
 * Written as a template literal so the heredoc inside the writer prompt keeps
 * its real newlines. No `${}` — the test would interpolate it.
 */
const script = `export const meta = { name: "mn4e-replay", description: "final-review-shaped stall replay", phases: [{ title: "Find" }, { title: "Verify" }] };
phase("Find");
const dims = ["correctness", "plan"];
const raw = await parallel(dims.map((d) => () => agent("FINDER " + d, { label: "find:" + d, phase: "Find" })));
const rows = [];
raw.forEach((text, i) => {
  if (!text) return;
  const parsed = JSON.parse(text);
  for (const f of parsed.findings) rows.push({ file: f.file, line: f.line, dimension: dims[i] });
});
phase("Verify");
const verdicts = await parallel(rows.map((f) => () => agent("VERIFY " + f.file + ":" + f.line, { label: "verify:" + f.file, phase: "Verify" })));
const unverified = verdicts.reduce((n, v) => (v === null ? n + 1 : n), 0);
const lines = rows.map((f, i) => JSON.stringify({ kind: "verify", file: f.file, line: f.line, verdict: verdicts[i] ?? { isReal: true, reason: "unverified (verifier skipped or timed out)" } })).join("\\n");
const writerPrompt = [
  "WRITER",
  "cat >> '" + args.findingsFile + "' <<'EOF'",
  lines,
  "EOF",
  "Then reply with the number of lines written.",
].join("\\n");
const wrote = await agent(writerPrompt, { label: "writer", phase: "Verify" });
return { degraded: unverified > 0 ? unverified + " of " + rows.length + " findings unverified (verifier skipped or timed out)" : null, unverified, persisted: wrote !== null };
`;

/** The last user message's text — where a workflow child's prompt lives. */
function lastUserText(context: { messages: Array<{ role?: string; content?: unknown }> }): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return (message.content as Array<{ type?: string; text?: string }>)
        .map((block) => (block.type === "text" ? block.text ?? "" : ""))
        .join("");
    }
  }
  return "";
}

/** The `cat >> … <<'EOF' … EOF` block the writer prompt hands the child. */
function heredoc(text: string): string | undefined {
  const start = text.indexOf("cat >> '");
  if (start === -1) return undefined;
  const end = text.indexOf("\nEOF", start);
  if (end === -1) return undefined;
  return text.slice(start, end + 4);
}

const asText = (context: { messages?: unknown[] }) => JSON.stringify(context.messages ?? []);

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

const workflowEntry = (session: any): any =>
  session.sessionManager
    .getEntries()
    .find((entry: any) => entry.type === "custom" && entry.customType === "subagents:workflow");

describe("workflow stall watchdog end to end", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("finishes a final-review-shaped run when one verifier never returns", async () => {
    const cwd = workflowProject();
    dirs.push(cwd);
    const findingsFile = join(cwd, "findings.jsonl");

    const run = await runPrintMode({
      prompt: "run the review workflow",
      cwd,
      // SubagentWorkflow is `deferred` exposure; this suite scripts the direct
      // call a production model makes from a codemode script.
      activateTools: ["SubagentWorkflow"],
      maxModelCalls: 40,
      live: false,
      timeoutMs: 30_000,
      respond: (context) => {
        const text = asText(context);
        const isParent = getCurrentTools(context.messages).some((tool) => tool.name === "SubagentWorkflow");
        if (isParent) {
          return text.includes("Task ID")
            ? fauxText("workflow launched")
            : fauxToolCall("SubagentWorkflow", { script, args: { findingsFile } }, { id: "wf-stall-1" });
        }

        // --- children ---
        if (text.includes("FINDER correctness")) {
          return fauxText(JSON.stringify({ dimension: "correctness", findings: [{ file: "src/a.ts", line: 10, severity: "minor", description: "off-by-one" }] }));
        }
        if (text.includes("FINDER plan")) {
          return fauxText(JSON.stringify({ dimension: "plan", findings: [{ file: "src/b.ts", line: 3, severity: "minor", description: "spec drift" }] }));
        }
        // The verifier for src/b.ts is the incident: it prints nothing and never
        // returns, so only the watchdog can free the run.
        if (text.includes("VERIFY src/b.ts")) return new Promise(() => {});
        if (text.includes("VERIFY src/a.ts")) return fauxText(JSON.stringify({ isReal: true, reason: "holds" }));

        if (text.includes("WRITER")) {
          const ranBash = context.messages.some((m: any) => m.role === "toolResult" && m.toolName === "bash");
          if (ranBash) return fauxText("wrote 2 lines");
          const command = heredoc(lastUserText(context));
          return command ? fauxToolCall("bash", { command }) : fauxText("nothing to write");
        }
        return fauxText("child done");
      },
    });

    try {
      // The run must SETTLE — the whole point is that a silent child cannot
      // wedge it. The terminal snapshot is the observable.
      const settled = await waitFor(() => workflowEntry(run.parentSession) !== undefined, 30_000);
      expect(settled, "the stalled run never settled").toBe(true);

      const data = workflowEntry(run.parentSession).data;
      expect(data.status).toBe("completed");
      // The script's own degraded signal, persisted in the run's outcome text.
      // (`workflowResultText` pretty-prints a non-string value, so the space
      // after the colon is part of the persisted text.)
      expect(data.result).toContain('"unverified": 1');
      expect(data.result).toContain('"persisted": true');

      // The stalled child is named in the progress snapshot.
      const timedOut = data.progress.filter((entry: any) => entry.type === "workflow_agent" && entry.timedOut);
      expect(timedOut.map((entry: any) => entry.label)).toEqual(["verify:src/b.ts"]);

      // And the writer child actually appended the findings file.
      const lines = readFileSync(findingsFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const verdicts = lines.map((line) => JSON.parse(line));
      expect(verdicts.every((v) => v.kind === "verify")).toBe(true);
      expect(verdicts.find((v) => v.file === "src/b.ts").verdict.reason).toBe("unverified (verifier skipped or timed out)");
    } finally {
      await run.dispose?.();
    }
  }, 60_000);
});
