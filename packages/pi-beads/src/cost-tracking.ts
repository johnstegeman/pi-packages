/**
 * Per-task-bead cost tracking via subagents lifecycle events.
 * See docs/superpowers/specs/2026-09-10-cost-tracking-on-task-beads-design.md.
 * Subscribes to pi.events (inter-extension bus). Top-level agents only —
 * nested/workflow children emit no events and never reach the handler.
 * Records regardless of showCost/reportUsage (those govern display and
 * per-session totals). Writes ONLY cost.* metadata; never status/parent/etc.
 */
import { getBeadsRuntime } from "./index.ts";

const BEAD_RE = /\bbead:\s*([A-Za-z0-9._-]+)\b/;
const AGENT_LINE_RE = /^cost\.agents\.([^.]+)\.total$/;
const KEY_UNSAFE = /[^A-Za-z0-9_-]/g;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// Register the subagents listeners exactly once per pi instance. The factory may
// run more than once against the same bus; re-subscribing would double-count.
const registered = new WeakSet<object>();

// Serialize the show->merge->update read-modify-write per bead. Overlapping
// subagents:completed events for the SAME bead would otherwise race and drop a
// contribution (last-write-wins). Different beads still run concurrently.
const beadQueues = new Map<string, Promise<void>>();
function enqueue(beadId: string, task: () => Promise<void>): Promise<void> {
  const prev = beadQueues.get(beadId) ?? Promise.resolve();
  const next = prev.then(task, task);
  beadQueues.set(beadId, next.catch(() => {}));
  return next.catch(() => {});
}

export default function costTracking(pi: any): void {
  async function onSettled(event: any): Promise<void> {
    try {
      const m = BEAD_RE.exec(String(event?.description ?? ""));
      if (!m) return; // not aimed at a task bead
      const usage = event?.usage;
      const total = usage?.cost?.total;
      if (total === undefined || total === null) return; // spent nothing / never ran
      if (!Number.isFinite(Number(total))) return;
      const rt = getBeadsRuntime();
      if (!rt) return; // pi-beads core not initialized -> degrade silently
      const beadId = m[1];
      const repoDir = rt.dirForPrefix(beadId);
      if (!repoDir) return; // unknown repo for this id prefix
      const agentId = String(event?.id ?? "agent").replace(KEY_UNSAFE, "_");

      // Everything above is synchronous; the RMW below is serialized per bead.
      return enqueue(beadId, async () => {
        try {
          // 1. read current metadata (merge base)
          const show = await rt.bd(["show", beadId, "--json"], repoDir, 15000);
          if (!show.ok) {
            console.error(`[pi-beads] cost: bd show failed: ${show.err}`);
            return;
          }
          let meta: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(show.out);
            const row = Array.isArray(parsed) ? parsed[0] : parsed;
            meta = (row?.metadata ?? {}) as Record<string, unknown>;
          } catch (e) {
            console.error(`[pi-beads] cost: bad bd show output: ${e}`);
            return;
          }

          // 2. per-agent line (last-write-wins)
          meta[`cost.agents.${agentId}.total`] = round6(Number(total));
          meta[`cost.agents.${agentId}.tokens.input`] = Number(usage.input ?? 0);
          meta[`cost.agents.${agentId}.tokens.output`] = Number(usage.output ?? 0);
          meta[`cost.agents.${agentId}.tokens.cacheRead`] = Number(usage.cacheRead ?? 0);
          meta[`cost.agents.${agentId}.role`] = String(event.type ?? "");
          meta[`cost.agents.${agentId}.status`] = String(event.status ?? "completed");

          // 3. rollups from the FULL current line set (incl. other agents)
          let sumTotal = 0, sumIn = 0, sumOut = 0, sumCR = 0, count = 0;
          for (const [k, v] of Object.entries(meta)) {
            const am = AGENT_LINE_RE.exec(k);
            if (!am) continue;
            sumTotal += Number(v) || 0;
            count += 1;
            const id = am[1];
            sumIn += Number(meta[`cost.agents.${id}.tokens.input`]) || 0;
            sumOut += Number(meta[`cost.agents.${id}.tokens.output`]) || 0;
            sumCR += Number(meta[`cost.agents.${id}.tokens.cacheRead`]) || 0;
          }
          meta["cost.total"] = round6(sumTotal);
          meta["cost.tokens.input"] = sumIn;
          meta["cost.tokens.output"] = sumOut;
          meta["cost.tokens.cacheRead"] = sumCR;
          meta["cost.agents.count"] = count;

          // 4. merge-write ONLY the derived cost.* keys (bd --set-metadata merges)
          const args = ["update", beadId];
          for (const [k, v] of Object.entries(meta)) {
            if (!k.startsWith("cost.")) continue;
            args.push("--set-metadata", `${k}=${String(v)}`);
          }
          const up = await rt.bd(args, repoDir, 15000);
          if (!up.ok) {
            console.error(`[pi-beads] cost: bd update failed: ${up.err}`);
            return;
          }
          await rt.afterWrite(repoDir);
        } catch (e: any) {
          console.error(`[pi-beads] cost: ${e?.message ?? e}`);
        }
      });
    } catch (e: any) {
      console.error(`[pi-beads] cost: ${e?.message ?? e}`);
    }
  }

  if (!registered.has(pi)) {
    registered.add(pi);
    pi.events.on("subagents:completed", onSettled);
    pi.events.on("subagents:failed", onSettled);
  }
}
