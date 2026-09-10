// run-workflow.mjs — execute a SubagentWorkflow script source in a vm so CI
// tests can exercise its LOGIC (envelope construction, dedupe, degraded,
// short-circuits) without a live pi session. Mirrors the loader's compile:
// the `export ` keyword is stripped before the body is wrapped in an async
// IIFE, where the canonical top-level `return` envelope is legal.
//
// Usage:
//   import { readFile } from "node:fs/promises";
//   import { runWorkflow } from "./run-workflow.mjs";
//   const result = await runWorkflow(await readFile("final-review.js", "utf8"), {
//     args: {...}, agent: async (prompt, opts) => {...},
//     parallel: async (thunks) => ..., pipeline: async (items, s1, s2) => ...,
//   });
import vm from "node:vm";

export async function runWorkflow(source, sandbox = {}) {
  const metaAt = source.indexOf("export const meta");
  if (metaAt === -1) throw new Error("no export const meta found");
  const body = source.slice(0, metaAt) + "      " + source.slice(metaAt + 6);
  const code = "(async () => {\n" + body + "\n})()";
  const context = vm.createContext({
    args: sandbox.args ?? {},
    agent: sandbox.agent ?? (async () => null),
    parallel: sandbox.parallel ?? (async (thunks) => Promise.all(thunks.map((t) => t()))),
    pipeline: sandbox.pipeline ?? (async (items, s1, s2) => {
      const out = [];
      for (const item of items) {
        let prev;
        try { prev = await s1(item); } catch { out.push(null); continue; }
        if (prev === null) { out.push(null); continue; }
        if (s2) { try { prev = await s2(prev, item); } catch { out.push(null); continue; } }
        out.push(prev);
      }
      return out;
    }),
    phase: () => {},
    log: () => {},
    console,
  });
  const compiled = new vm.Script(code, { filename: "workflow" });
  const runner = compiled.runInContext(context, { timeout: 30_000 });
  // The IIFE's completion value is the cross-realm promise it produced —
  // await it directly (it is not callable from this realm).
  return await runner;
}
