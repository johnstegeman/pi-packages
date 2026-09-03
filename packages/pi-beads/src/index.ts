/**
 * pi-beads-lean
 * -------------
 * Context-lean integration between pi and the beads (`bd`) task tracker.
 *
 * Design goals (measured on bd 1.0.3):
 *  - `bd prime` (full)      ~1065 tok  -> injected EVERY turn by other plugins = 1065 x N
 *  - `bd prime --mcp` (lean) ~141 tok  -> we inject ONCE per session segment instead
 *  - compact read tools turn `bd ... --json` (148-569 tok raw) into digests (~16-208 tok)
 *  - writes are already cheap (3-19 tok) so they pass through bd directly
 *
 * Multi-repo (hydration) aware:
 *  - READS (ready/list/show/prime) run against the umbrella aggregate (~/OpenProdent or
 *    $PI_BEADS_ROOT) so the agent sees tasks from EVERY repo at once, tagged by id prefix.
 *  - WRITES (create/update/close/dep) are ROUTED to the owning repo by the issue-id prefix
 *    (crmback-* -> crm-backend, lguard-* -> logtoorgguard, ...), then the repo's JSONL is
 *    re-exported and the umbrella re-synced so reads stay fresh. Writing into the aggregate
 *    directly would hit throwaway copies, so we never do that.
 *  - If no umbrella is found, it degrades to plain single-repo mode (original behavior).
 *
 * Pure CLI: the agent interacts with beads through in-process tools (no MCP transport).
 * beads' MCP server is deliberately NOT used — per beads' own docs it adds ~10-50k tokens
 * of tool schemas and only exists for shell-less clients (Claude Desktop, Amp).
 *
 * Typed as `any` to keep the extension dependency-free at load time; the live API is
 * injected by pi. See https://pi.dev / context7 /earendil-works/pi for the typed surface.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);

// Skill ships INSIDE this plugin (../skills relative to src/index.ts) and is
// registered via the `resources_discover` event — so it travels with the package
// and never depends on a file being hand-placed in the agent's skills folder.
const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
);

const TOOL = {
  ready: "beads_ready",
  list: "beads_list",
  show: "beads_show",
  deps: "beads_deps",
  create: "beads_create",
  update: "beads_update",
  close: "beads_close",
  dep: "beads_dep",
  undep: "beads_undep",
  comment: "beads_comment",
  reopen: "beads_reopen",
  gateCreate: "beads_gate_create",
  gateResolve: "beads_gate_resolve",
  molPour: "beads_mol_pour",
  molShow: "beads_mol_show",
  molCurrent: "beads_mol_current",
  molReady: "beads_mol_ready",
};

// Type allowlists, enforced before the value reaches bd (a typo must not
// silently persist a junk edge; bd itself accepts arbitrary --type strings).
// Verified against `bd link --help` / `bd gate create --help` on bd 1.2.2.
export const DEP_LINK_TYPES = [
  "blocks",
  "tracks",
  "related",
  "parent-child",
  "discovered-from",
];
export const GATE_TYPES = ["human", "timer", "gh:run", "gh:pr"];

export default function piBeadsLean(pi: any) {
  let activeCwd: string = process.cwd();

  // ---- multi-repo state (resolved at session_start) ----
  let umbrella: string = activeCwd; // dir whose .beads is the read aggregate (or the single repo)
  let isUmbrella = false; // true when umbrella hydrates additional repos
  const prefixToDir = new Map<string, string>(); // issue-id prefix -> owning repo dir (write routing)
  const basenameToDir = new Map<string, string>(); // repo folder name -> repo dir (create targeting)
  let defaultRepoDir: string | null = null; // repo that contains activeCwd (default create target)

  let beadsReady = false; // umbrella .beads reachable
  let needPrime = true; // inject lean prime on next turn (reset at start + after compaction)
  let needSync = true; // umbrella aggregate may be stale -> resync before next read

  // ---- bd runner (execFile = no shell injection); cwd selects which DB bd resolves ----
  async function bd(
    args: string[],
    cwd: string = umbrella,
    timeout = 15000,
  ): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      const { stdout } = await pexec("bd", args, {
        cwd: cwd || process.cwd(),
        maxBuffer: 8 * 1024 * 1024,
        timeout,
      });
      return { ok: true, out: stdout ?? "", err: "" };
    } catch (e: any) {
      return {
        ok: false,
        out: e?.stdout ?? "",
        err: (e?.stderr || e?.message || "bd failed").toString().trim(),
      };
    }
  }

  // ---- resolution helpers ----
  const firstLine = (s: string) => (s.split("\n")[0] ?? "").trim();

  async function beadsDirOf(dir: string): Promise<string> {
    const r = await bd(["where"], dir);
    if (!r.ok) return "";
    const l = firstLine(r.out);
    return l.includes(".beads") ? l : "";
  }
  async function repoRootOf(dir: string): Promise<string> {
    const b = await beadsDirOf(dir);
    return b ? path.dirname(b) : "";
  }
  async function additionalRepos(root: string): Promise<string[]> {
    const r = await bd(["repo", "list"], root);
    const dirs: string[] = [];
    for (const ln of r.out.split("\n")) {
      const m = ln.match(/^\s*-\s+(\/.+?)\s*$/);
      if (m) dirs.push(m[1]);
    }
    return dirs;
  }
  async function nativePrefixOf(dir: string): Promise<string> {
    // umbrella's own prefix from `bd where` ("  prefix: prod")
    const r = await bd(["where"], dir);
    const m = r.out.match(/^\s*prefix:\s*(\S+)/m);
    return m ? m[1] : "";
  }
  async function samplePrefixOf(repoDir: string): Promise<string> {
    // a per-repo DB only holds its own issues -> any id reveals the prefix
    const r = await bd(["list", "--all", "-n", "1", "--json"], repoDir);
    if (r.ok) {
      try {
        const a = JSON.parse(r.out);
        const id = Array.isArray(a) ? a[0]?.id : a?.id;
        if (id) return String(id).split("-")[0];
      } catch {
        /* ignore */
      }
    }
    return "";
  }

  async function resolveTopology(): Promise<void> {
    prefixToDir.clear();
    basenameToDir.clear();
    defaultRepoDir = null;

    // 1) find the umbrella root
    let root = (process.env.PI_BEADS_ROOT || "").trim();
    if (root)
      root = path.resolve(root.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
    if (!root) {
      // walk up: a hydrated umbrella is a .beads whose config lists additional repos
      let d = activeCwd;
      for (let i = 0; i < 12 && d; i++) {
        const bdir = await beadsDirOf(d);
        if (!bdir) break;
        const cand = path.dirname(bdir);
        if ((await additionalRepos(cand)).length > 0) {
          root = cand;
          break;
        }
        const parent = path.dirname(cand);
        if (parent === cand) break;
        d = parent;
      }
    }

    if (root) {
      umbrella = root;
      isUmbrella = true;
      const repos = await additionalRepos(umbrella);
      const np = await nativePrefixOf(umbrella);
      if (np) prefixToDir.set(np, umbrella);
      basenameToDir.set(path.basename(umbrella), umbrella);
      for (const dir of repos) {
        basenameToDir.set(path.basename(dir), dir);
        const pfx = await samplePrefixOf(dir);
        if (pfx) prefixToDir.set(pfx, dir);
      }
      const ar = await repoRootOf(activeCwd);
      defaultRepoDir = ar && ar !== umbrella ? ar : null;
    } else {
      // single-repo / no umbrella -> behave like the original plugin
      umbrella = (await repoRootOf(activeCwd)) || activeCwd;
      isUmbrella = false;
      basenameToDir.set(path.basename(umbrella), umbrella);
      const pfx = await samplePrefixOf(umbrella);
      if (pfx) prefixToDir.set(pfx, umbrella);
      defaultRepoDir = umbrella;
    }

    beadsReady = (await bd(["info"], umbrella)).ok;
    needSync = true;
    needPrime = true;
  }

  // refresh the aggregate before a read, at most once per "dirty" window
  async function ensureFresh(): Promise<void> {
    if (!isUmbrella || !needSync) return;
    await bd(["repo", "sync"], umbrella, 60000);
    needSync = false;
  }
  // after a routed write: re-export the repo's JSONL so the next `repo sync` sees it
  async function afterWrite(repoDir: string): Promise<void> {
    if (isUmbrella) {
      await bd(["export", "-o", ".beads/issues.jsonl"], repoDir, 30000);
      needSync = true;
    }
    pi.events.emit("beads:changed");
  }

  function dirForPrefix(id: string): string | null {
    const pfx = String(id).split("-")[0];
    return prefixToDir.get(pfx) ?? null;
  }
  function resolveRepoTarget(repoParam?: string): string | null {
    if (!repoParam) return null;
    const k = String(repoParam).trim();
    return (
      basenameToDir.get(k) ??
      prefixToDir.get(k) ??
      (basenameToDir.get(path.basename(k)) || null)
    );
  }
  function resolveCreateTarget(repoParam?: string): string | null {
    return resolveRepoTarget(repoParam) ?? defaultRepoDir;
  }
  const knownRepos = () => Array.from(basenameToDir.keys()).join(", ");

  // ---- compact formatters ----
  const trunc = (s: string, n = 70) =>
    s.length > n ? s.slice(0, n - 1) + "\u2026" : s;

  function jparse(s: string): any {
    const t = (s ?? "").trim();
    const i = t.search(/[[{]/);
    if (i < 0) return null;
    try {
      return JSON.parse(t.slice(i));
    } catch {
      return null;
    }
  }

  function fmtRows(json: string): string {
    let arr: any[];
    try {
      arr = JSON.parse(json);
      if (arr && !Array.isArray(arr) && Array.isArray(arr.issues)) arr = arr.issues;
    } catch {
      return json.trim();
    }
    if (!Array.isArray(arr) || arr.length === 0) return "(none)";
    return arr
      .map((i) => {
        const dep = i.dependency_count ? ` dep:${i.dependency_count}` : "";
        const labels =
          Array.isArray(i.labels) && i.labels.length
            ? ` labels:${i.labels.slice(0, 4).join(",")}`
            : "";
        return `${i.id} P${i.priority} [${i.status}] ${trunc(i.title ?? "")}${dep}${labels}`;
      })
      .join("\n");
  }

  function fmtMolReady(obj: any, limit?: number): string {
    const mo = Array.isArray(obj) ? obj[0] : obj;
    if (!mo || typeof mo !== "object") return "(not found)";
    const total = mo.total_steps ?? mo.steps?.length ?? 0;
    const ready = mo.ready_steps ?? 0;
    const header = `molecule: ${mo.molecule_id ?? "?"} — ${trunc(mo.molecule_title ?? "")} · ${ready}/${total} ready`;
    const rows = (Array.isArray(mo.steps) ? mo.steps : [])
      .slice(0, limit)
      .map((st: any) => {
        const i = st?.issue ?? st;
        if (!i?.id) return "";
        const dep = i.dependency_count ? ` dep:${i.dependency_count}` : "";
        return `${i.id} P${i.priority} [${i.status}] ${trunc(i.title ?? "")}${dep}`;
      })
      .filter(Boolean);
    if (ready > 0) return [header, ...rows].join("\n");
    return `${header}\nno ready steps (all blocked or completed)`;
  }

  // Parse `bd mol pour <proto> --dry-run` output: ordered (title, key) steps plus
  // a preceding-step -> gate-key map (bd generates the gate-* keys at dry-run).
  function parseDryRun(out: string): {
    steps: Array<[string, string]>;
    stepToGate: Map<string, string>;
  } {
    const steps: Array<[string, string]> = [];
    const stepToGate = new Map<string, string>();
    let lastStep: string | null = null;
    for (const ln of out.split("\n")) {
      const m = ln.match(/^\s*-\s+(.*?)\s+\(from\s+\S+\.([^)]+)\)\s*$/);
      if (!m) continue;
      const title = m[1];
      const key = m[2];
      if (key.startsWith("gate-")) {
        if (lastStep) stepToGate.set(lastStep, key);
      } else {
        steps.push([title, key]);
        lastStep = key;
      }
    }
    return { steps, stepToGate };
  }

  // Resolve formula step/gate keys -> runtime ids AFTER a pour. All reads run against the
  // owning repo `dir` (freshest data, avoids umbrella aggregation staleness). Returns null
  // whenever the map is incomplete — the caller then hard-fails WITHOUT partial labels.
  async function molKeyToId(
    proto: string,
    vars: string[],
    root: string,
    dir: string,
  ): Promise<Map<string, string> | null> {
    const dryArgs = ["mol", "pour", proto];
    for (const v of vars) dryArgs.push("--var", v);
    dryArgs.push("--dry-run");
    const dry = await bd(dryArgs, dir);
    if (!dry.ok) return null;
    const { steps, stepToGate } = parseDryRun(dry.out);
    if (steps.length === 0) return null;
    const show = await bd(["mol", "show", root, "--json"], dir);
    if (!show.ok) return null;
    const o = jparse(show.out);
    if (!o) return null;
    const issues: any[] = Array.isArray(o) ? o : o.issues ?? [];
    const deps: any[] = Array.isArray(o) ? [] : o.dependencies ?? [];
    const byId = new Map<string, any>(issues.map((i: any) => [i.id, i]));
    const result = new Map<string, string>();
    for (const [title, key] of steps) {
      const hits = issues.filter((i: any) => i.issue_type !== "gate" && i.title === title);
      if (hits.length !== 1) return null; // missing or ambiguous -> hard fail
      result.set(key, hits[0].id);
    }
    const gateIssues = issues.filter((i: any) => i.issue_type === "gate");
    if (gateIssues.length === 0) return null;
    for (const i of gateIssues) {
      const blocked = deps
        .filter((e: any) => e.type === "blocks" && e.depends_on_id === i.id)
        .map((e: any) => byId.get(e.issue_id))
        .filter(Boolean);
      const stepKey = blocked
        .map((b: any) => [...result.entries()].find(([, id]) => id === b.id)?.[0])
        .find(Boolean);
      const gateKey = stepKey ? stepToGate.get(stepKey) : undefined;
      if (!gateKey) return null;
      result.set(gateKey, i.id);
    }
    if (result.size !== steps.length + gateIssues.length) return null;
    return result;
  }

  function fmtShow(
    o: any,
    childInfo?: { done: number; total: number; openIds: string[] } | null,
    full?: boolean,
  ): string {
    if (Array.isArray(o)) o = o[0];
    if (!o) return "(not found)";
    const blockers: any[] = Array.isArray(o.dependencies) ? o.dependencies : [];
    const blocked = blockers.some((b) => b && b.status !== "closed");
    const lines = [
      `${o.id} [${o.status}]${blocked ? " BLOCKED" : ""} P${o.priority} ${o.issue_type ?? "task"}`,
      `title: ${o.title ?? ""}`,
    ];
    if (o.description) lines.push(`desc: ${full ? String(o.description) : trunc(String(o.description), 240)}`);
    if (blockers.length) {
      lines.push(
        `blocked_by: ${blockers.map((b) => `${b.id}${b.status === "closed" ? "\u2713" : `[${b.status}]`}`).join(", ")}`,
      );
    } else if (o.dependency_count) {
      lines.push(`blocked_by: ${o.dependency_count}`);
    }
    if (o.dependent_count) lines.push(`blocks: ${o.dependent_count}`);
    if (childInfo) {
      const openPart = childInfo.openIds.length
        ? ` · open: ${childInfo.openIds.slice(0, 10).join(", ")}`
        : "";
      lines.push(`children: ${childInfo.done}/${childInfo.total}${openPart}`);
    }
    if (o.assignee) lines.push(`assignee: ${o.assignee}`);
    return lines.join("\n");
  }

  // strip bd's promotional / hint lines to keep tool output lean
  function clean(s: string): string {
    return s
      .split("\n")
      .filter((l) => !/^\s*(\u{1F4A1}|Tip:|\u{1F4A1} Tip:)/u.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const textResult = (text: string) => ({
    content: [{ type: "text", text: clean(text) }],
    details: {},
  });

  // ---- lean prime block (injected once per segment) ----
  async function buildPrimeBlock(): Promise<string | null> {
    await ensureFresh();
    const prime = await bd(["prime", "--mcp"], umbrella);
    if (!prime.ok) return null;
    let focus = "none";
    const inProgress = await bd(
      ["list", "--status", "in_progress", "--json"],
      umbrella,
    );
    if (inProgress.ok) {
      try {
        const a = JSON.parse(inProgress.out);
        if (Array.isArray(a) && a[0])
          focus = `${a[0].id} ${trunc(a[0].title ?? "")}`;
      } catch {
        /* ignore */
      }
    }
    const routes = Array.from(prefixToDir.entries())
      .map(([p, d]) => `${p}-=${path.basename(d)}`)
      .join(", ");
    const guide = isUmbrella
      ? [
          `Beads here is a MULTI-REPO umbrella at ${umbrella}: each repo has its own DB + this aggregate read view. For the full workflow, USE THE \`beads\` SKILL.`,
          `Essentials: reads (beads_ready/list/show) span ALL repos; an id prefix names its project (${routes}). Create with beads_create repo=<folder-or-prefix> (never into the aggregate). beads_update/beads_close auto-route by id prefix. Deps stay within one repo. Do NOT reorganize tasks across repos.`,
        ].join("\n")
      : `Beads scope: single repo at ${umbrella}.`;
    return [
      prime.out.trim(),
      guide,
      `Current focus: ${focus}`,
      "Prefer the compact beads_* tools (ready/show/create/update/close) over raw `bd` dumps to keep context small.",
    ].join("\n\n");
  }

  function setStatusLine(ctx: any) {
    try {
      ctx?.ui?.setStatus?.("beads", beadsReady ? "bd\u2713" : "bd\u2717");
    } catch {
      /* ignore */
    }
  }

  // ============ lifecycle ============
  // ship our beads skill with the plugin (no hand-placed file in ~/.pi/agent/skills)
  pi.on("resources_discover", async () => ({ skillPaths: [SKILLS_DIR] }));

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      activeCwd = ctx?.cwd ?? process.cwd();
      await resolveTopology();
      setStatusLine(ctx);
    } catch (e: any) {
      ctx?.ui?.notify?.(
        `pi-beads-lean init failed: ${e?.message ?? e}`,
        "error",
      );
    }
  });

  // re-prime after compaction (matches beads' PreCompact refresh behavior)
  pi.on("session_compact", () => {
    needPrime = true;
    needSync = true;
  });

  // inject the lean prime exactly once per segment, into the system prompt for that turn
  pi.on("before_agent_start", async (event: any) => {
    if (!beadsReady || !needPrime) return;
    needPrime = false;
    const block = await buildPrimeBlock();
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  // ============ tools (read) — always against the umbrella aggregate ============
  pi.registerTool({
    name: TOOL.ready,
    label: "Beads ready",
    description:
      "List beads issues that are ready to work (open, unblocked) across ALL repos, newest-priority first. Compact output; id prefix shows the owning project.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max issues (default 15)" },
        repo: {
          type: "string",
          description: "Optional repo filter (folder name or id prefix)",
        },
        label: {
          type: "string",
          description:
            "Require ALL of these labels (comma-separated, bd --label semantics)",
        },
        labelAny: {
          type: "string",
          description:
            "Require AT LEAST ONE of these labels (comma-separated, bd --label-any semantics)",
        },
      },
    },
    async execute(_id: string, params: any) {
      const scope = resolveRepoTarget(params?.repo) ?? umbrella;
      if (params?.repo && !resolveRepoTarget(params.repo))
        return textResult(
          `unknown repo '${params.repo}' (known: ${knownRepos()})`,
        );
      await ensureFresh();
      const rargs = ["ready", "--json", "--include-ephemeral", "-n", String(params?.limit ?? 15)];
      if (params?.label) rargs.push("--label", String(params.label));
      if (params?.labelAny) rargs.push("--label-any", String(params.labelAny));
      const r = await bd(rargs, scope);
      if (!r.ok) return textResult(`bd ready failed: ${r.err}`);
      return textResult(fmtRows(r.out));
    },
  });

  pi.registerTool({
    name: TOOL.list,
    label: "Beads list",
    description:
      "List beads issues across ALL repos, optionally filtered by status (open,in_progress,blocked,deferred,closed). Compact output; id prefix shows the owning project.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Comma-separated status filter, e.g. 'open,in_progress'",
        },
        limit: { type: "number", description: "Max issues (default 30)" },
        repo: {
          type: "string",
          description: "Optional repo filter (folder name or id prefix)",
        },
        label: {
          type: "string",
          description:
            "Require ALL of these labels (comma-separated, bd --label semantics)",
        },
        labelAny: {
          type: "string",
          description:
            "Require AT LEAST ONE of these labels (comma-separated, bd --label-any semantics)",
        },
        mol: {
          type: "string",
          description:
            "Optional molecule root id — scope results to that molecule's steps/gates, including closed (bd list --all --parent + --include-gates)",
        },
      },
    },
    async execute(_id: string, params: any) {
      const scoped = params?.repo ? resolveRepoTarget(params.repo) : null;
      if (params?.repo && !scoped)
        return textResult(
          `unknown repo '${params.repo}' (known: ${knownRepos()})`,
        );
      await ensureFresh();
      const args = ["list", "--json", "-n", String(params?.limit ?? 30)];
      if (params?.status) args.push("--status", String(params.status));
      if (params?.label) args.push("--label", String(params.label));
      if (params?.labelAny) args.push("--label-any", String(params.labelAny));
      if (params?.mol)
        args.push("--all", "--parent", String(params.mol), "--include-gates");
      const r = await bd(args, scoped ?? umbrella);
      if (!r.ok) return textResult(`bd list failed: ${r.err}`);
      return textResult(fmtRows(r.out));
    },
  });

  pi.registerTool({
    name: TOOL.show,
    label: "Beads show",
    description:
      "Show essential details of one beads issue (status, priority, type, description, dependency counts). Works for any repo by id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue id, e.g. 'crmback-1a2'" },
        full: { type: "boolean", description: "Include the full description body (compact mode truncates to 240 chars)" },
      },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id) return textResult("id is required");
      const full = params.full === true || params.full === "true";
      await ensureFresh();
      const r = await bd(["show", String(params.id), "--json"], umbrella);
      if (!r.ok) return textResult(`bd show failed: ${r.err}`);
      const o = jparse(r.out);
      if (!o) return textResult(r.out.trim());
      let childInfo: { done: number; total: number; openIds: string[] } | null =
        null;
      const obj = Array.isArray(o) ? o[0] : o;
      if (obj && obj.issue_type === "epic") {
        const c = await bd(["children", String(params.id), "--json"], umbrella);
        const arr = jparse(c.out);
        if (Array.isArray(arr)) {
          childInfo = {
            total: arr.length,
            done: arr.filter((x: any) => x.status === "closed").length,
            openIds: arr
              .filter((x: any) => x.status !== "closed")
              .map((x: any) => x.id),
          };
        }
      }
      return textResult(fmtShow(obj, childInfo, full));
    },
  });

  pi.registerTool({
    name: TOOL.deps,
    label: "Beads dependencies",
    description:
      "Inspect dependencies across ALL repos: blockers (what must finish first) or dependents (what this blocks). Pass ONE id to get the blocker/dependent tree; pass SEVERAL ids to get one compact line each (ideal for triaging a set of epics). Read-only.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "string",
          description: "One or more issue ids, space or comma separated",
        },
        direction: {
          type: "string",
          description:
            "'blockers' (default, what must finish first) or 'dependents' (what this blocks)",
        },
      },
      required: ["ids"],
    },
    async execute(_id: string, params: any) {
      if (!params?.ids) return textResult("ids is required");
      const ids = String(params.ids)
        .split(/[\s,]+/)
        .filter(Boolean);
      if (ids.length === 0) return textResult("no valid ids");
      const up = /^(dependents|up|blocks)$/i.test(
        String(params?.direction ?? ""),
      );
      const dir = up ? "up" : "down";
      const label = up ? "blocks" : "blocked_by";
      await ensureFresh();
      if (ids.length === 1) {
        const r = await bd(
          ["dep", "tree", ids[0], "--direction", dir, "--json"],
          umbrella,
        );
        if (!r.ok) return textResult(`bd dep tree failed: ${r.err}`);
        const arr = jparse(r.out);
        if (!Array.isArray(arr) || arr.length <= 1)
          return textResult(`${ids[0]} ${label}: (none)`);
        const body = arr
          .map(
            (n: any) =>
              `${"  ".repeat(Math.max(0, n.depth || 0))}${(n.depth || 0) > 0 ? "\u2514 " : ""}${n.id} [${n.status}] P${n.priority} ${trunc(n.title ?? "", 56)}`,
          )
          .join("\n");
        const blocked =
          dir === "down" &&
          arr.some((n: any) => (n.depth || 0) > 0 && n.status !== "closed");
        return textResult((blocked ? "BLOCKED\n" : "") + body);
      }
      const lines: string[] = [];
      for (const id of ids) {
        const r = await bd(
          ["dep", "list", id, "--direction", dir, "--json"],
          umbrella,
        );
        const arr = jparse(r.out);
        const items = Array.isArray(arr) ? arr : [];
        lines.push(
          `${id} ${label}: ${items.length ? items.map((x: any) => `${x.id}[${x.status}]`).join(", ") : "(none)"}`,
        );
      }
      return textResult(lines.join("\n"));
    },
  });

  // ============ tools (write) — routed to the owning repo, then aggregate refreshed ============
  pi.registerTool({
    name: TOOL.create,
    label: "Beads create",
    description:
      "Create a beads issue in the OWNING repo. Pass `repo` (folder name or id prefix) to choose the project; if omitted, the repo containing the session cwd is used. Returns the new id. Use BEFORE starting non-trivial work.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short issue title" },
        repo: {
          type: "string",
          description:
            "Target repo (folder name or id prefix). Required when running from the umbrella root.",
        },
        type: {
          type: "string",
          description:
            "task|bug|feature|chore|epic|decision|spike|story (default task)",
        },
        priority: { type: "number", description: "0-4, 0=highest (default 2)" },
        description: {
          type: "string",
          description: "Optional longer description",
        },
        parent: {
          type: "string",
          description: "Optional parent/epic id in the SAME repo",
        },
        labels: {
          type: "string",
          description: "Optional labels (comma-separated)",
        },
        notes: { type: "string", description: "Optional notes" },
        design: { type: "string", description: "Optional design notes" },
        ephemeral: {
          type: "boolean",
          description:
            "Create as an ephemeral bead (wisp) by passing --ephemeral to bd create. Wisps stay out of federation sync and can be purged with `bd mol wisp gc` / `bd purge --force` once closed. Boolean true or the string \"true\" both work.",
        },
      },
      required: ["title"],
    },
    async execute(_id: string, params: any) {
      if (!params?.title) return textResult("title is required");
      const repoDir = resolveCreateTarget(params?.repo);
      if (!repoDir)
        return textResult(
          `specify repo (one of: ${knownRepos()}) — cannot create in the umbrella aggregate`,
        );
      const args = ["create", String(params.title)];
      if (params.type) args.push("-t", String(params.type));
      if (params.priority !== undefined && params.priority !== null)
        args.push("-p", String(params.priority));
      if (params.description) args.push("-d", String(params.description));
      if (params.parent) {
        if (
          dirForPrefix(String(params.parent)) &&
          dirForPrefix(String(params.parent)) !== repoDir
        )
          return textResult("parent must be in the same repo as the new issue");
        args.push("--parent", String(params.parent));
      }
      if (params.labels) args.push("-l", String(params.labels));
      if (params.notes) args.push("--notes", String(params.notes));
      if (params.design) args.push("--design", String(params.design));
      if (params.ephemeral === true || params.ephemeral === "true")
        args.push("--ephemeral");
      const r = await bd(args, repoDir);
      if (!r.ok) return textResult(`bd create failed: ${r.err}`);
      await afterWrite(repoDir);
      return textResult(`${r.out.trim()}  (repo: ${path.basename(repoDir)})`);
    },
  });

  pi.registerTool({
    name: TOOL.update,
    label: "Beads update",
    description:
      "Update a beads issue: status (open|in_progress|blocked|deferred|closed), priority (0-4), title, claim (assignee=you + status=in_progress), setMetadata, and/or description. Auto-routed to the owning repo by id prefix.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue id" },
        status: {
          type: "string",
          description: "open|in_progress|blocked|deferred|closed",
        },
        priority: { type: "number", description: "0-4, 0=highest" },
        title: { type: "string", description: "New title" },
        parent: {
          type: "string",
          description:
            "New parent issue ID (same repo). Empty string removes parent.",
        },
        notes: { type: "string", description: "Replace notes with this text" },
        appendNotes: {
          type: "string",
          description: "Append text to existing notes",
        },
        addLabels: {
          type: "string",
          description: "Comma-separated labels to add",
        },
        removeLabels: {
          type: "string",
          description: "Comma-separated labels to remove",
        },
        claim: { type: "boolean", description: "Atomically claim the issue (assignee=you, status=in_progress)" },
        setMetadata: { type: "string", description: "key=value metadata to set (comma-separated for multiple, e.g. review.verdict=done,foo=bar)" },
        description: { type: "string", description: "Replace the issue's description body" },
      },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id) return textResult("id is required");
      const repoDir = dirForPrefix(String(params.id));
      if (!repoDir)
        return textResult(
          `unknown repo for id '${params.id}' (known prefixes: ${Array.from(prefixToDir.keys()).join(", ")})`,
        );
      const args = ["update", String(params.id)];
      if (params.status) args.push("--status", String(params.status));
      if (params.priority !== undefined && params.priority !== null)
        args.push("-p", String(params.priority));
      if (params.title) args.push("--title", String(params.title));
      if (params.parent !== undefined) {
        const p = String(params.parent);
        if (p && dirForPrefix(p) && dirForPrefix(p) !== repoDir)
          return textResult("parent must be in the same repo as the issue");
        args.push("--parent", p);
      }
      if (params.notes) args.push("--notes", String(params.notes));
      if (params.appendNotes)
        args.push("--append-notes", String(params.appendNotes));
      if (params.addLabels) args.push("--add-label", String(params.addLabels));
      if (params.removeLabels)
        args.push("--remove-label", String(params.removeLabels));
      if (params.claim === true || params.claim === "true") args.push("--claim");
      if (params.setMetadata) {
        for (const pair of String(params.setMetadata).split(",").map((s: string) => s.trim()).filter(Boolean)) {
          args.push("--set-metadata", pair);
        }
      }
      if (params.description !== undefined) args.push("--description", String(params.description));
      if (args.length === 2)
        return textResult(
          "nothing to update (pass status, priority, title, parent, notes, label changes, claim, setMetadata, or description)",
        );
      const r = await bd(args, repoDir);
      if (!r.ok) return textResult(`bd update failed: ${r.err}`);
      await afterWrite(repoDir);
      return textResult(r.out.trim() || "updated");
    },
  });

  pi.registerTool({
    name: TOOL.close,
    label: "Beads close",
    description:
      "Close one or more beads issues by id (any repos). Run this when work is done before reporting completion. Auto-routed to owning repos by id prefix.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "string",
          description: "One or more issue ids, space or comma separated",
        },
        reason: { type: "string", description: "Optional closing reason" },
      },
      required: ["ids"],
    },
    async execute(_id: string, params: any) {
      if (!params?.ids) return textResult("ids is required");
      const ids = String(params.ids)
        .split(/[\s,]+/)
        .filter(Boolean);
      if (ids.length === 0) return textResult("no valid ids");
      const byRepo = new Map<string, string[]>();
      for (const id of ids) {
        const dir = dirForPrefix(id);
        if (!dir)
          return textResult(
            `unknown repo for id '${id}' (known prefixes: ${Array.from(prefixToDir.keys()).join(", ")})`,
          );
        (byRepo.get(dir) ?? byRepo.set(dir, []).get(dir)!).push(id);
      }
      const closedIds: string[] = [];
      let failure: string | null = null;
      for (const [dir, rids] of byRepo) {
        const args = ["close", ...rids];
        if (params.reason) args.push("-r", String(params.reason));
        const r = await bd(args, dir);
        if (!r.ok) {
          failure = `bd close failed for ${rids.join(", ")}: ${r.err}`;
          break;
        }
        await afterWrite(dir);
        closedIds.push(...rids);
      }
      if (failure) return textResult(failure);
      return textResult(`closed ${closedIds.join(", ")}`);
    },
  });

  pi.registerTool({
    name: TOOL.reopen,
    label: "Beads reopen",
    description:
      "Reopen one or more closed beads issues by id. Auto-routed to owning repos by id prefix.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "string", description: "One or more issue ids, space or comma separated" },
        reason: { type: "string", description: "Optional reason for reopening" },
      },
      required: ["ids"],
    },
    async execute(_id: string, params: any) {
      if (!params?.ids) return textResult("ids is required");
      const ids = String(params.ids).split(/[\s,]+/).filter(Boolean);
      if (ids.length === 0) return textResult("no valid ids");
      const byRepo = new Map<string, string[]>();
      for (const id of ids) {
        const dir = dirForPrefix(id);
        if (!dir)
          return textResult(
            `unknown repo for id '${id}' (known prefixes: ${Array.from(prefixToDir.keys()).join(", ")})`,
          );
        (byRepo.get(dir) ?? byRepo.set(dir, []).get(dir)!).push(id);
      }
      const reopenedIds: string[] = [];
      let failure: string | null = null;
      for (const [dir, rids] of byRepo) {
        const args = ["reopen", ...rids];
        if (params.reason) args.push("-r", String(params.reason));
        const r = await bd(args, dir);
        if (!r.ok) {
          failure = `bd reopen failed for ${rids.join(", ")}: ${r.err}`;
          break;
        }
        await afterWrite(dir);
        reopenedIds.push(...rids);
      }
      if (failure) return textResult(failure);
      return textResult(`reopened ${reopenedIds.join(", ")}`);
    },
  });

  pi.registerTool({
    name: TOOL.gateCreate,
    label: "Beads gate create",
    description:
      "Create an async gate that blocks an issue until resolved (bd gate resolve/beads_gate_resolve). Routed to the owning repo by the blocked issue's id prefix.",
    parameters: {
      type: "object",
      properties: {
        blocks: { type: "string", description: "Issue id the gate blocks" },
        type: { type: "string", description: "human|timer|gh:run|gh:pr (default human)" },
        reason: { type: "string", description: "Reason for the gate" },
        timeout: { type: "string", description: "Timeout duration for timer gates, e.g. 2h, 30m" },
        awaitId: { type: "string", description: "Condition identifier for gh:run/gh:pr gates" },
      },
      required: ["blocks"],
    },
    async execute(_id: string, params: any) {
      if (!params?.blocks) return textResult("blocks is required");
      const dir = dirForPrefix(String(params.blocks));
      if (!dir) return textResult(`unknown repo for id '${params.blocks}'`);
      const args = ["gate", "create", "--blocks", String(params.blocks)];
      if (params.type) {
        const t = String(params.type);
        if (!GATE_TYPES.includes(t))
          return textResult(`invalid gate type '${t}' (allowed: ${GATE_TYPES.join("|")})`);
        args.push("--type", t);
      }
      if (params.reason) args.push("--reason", String(params.reason));
      if (params.timeout) args.push("--timeout", String(params.timeout));
      if (params.awaitId) args.push("--await-id", String(params.awaitId));
      const r = await bd(args, dir);
      if (!r.ok) return textResult(`bd gate create failed: ${r.err}`);
      await afterWrite(dir);
      return textResult(r.out.trim() || "gate created");
    },
  });

  pi.registerTool({
    name: TOOL.gateResolve,
    label: "Beads gate resolve",
    description:
      "Resolve a human gate (unblocks dependents) and close the gated step(s) it was blocking in one call, so dependents' later beads_close never fails with 'blocked by open issues'.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Gate issue id" } },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id) return textResult("id is required");
      const id = String(params.id);
      const dir = dirForPrefix(id);
      if (!dir) return textResult(`unknown repo for id '${id}'`);
      const rr = await bd(["gate", "resolve", id], dir);
      if (!rr.ok) return textResult(`bd gate resolve failed: ${rr.err}`);
      await afterWrite(dir);
      // bd 1.2.2: `gate resolve` already closes the gate. Don't double-close.
      // Instead close the step(s) this gate was gating (its open non-gate dependents),
      // so nothing resolved-but-left-open blocks later beads_close calls.
      const dep = await bd(["dep", "list", id, "--direction", "up", "--json"], dir);
      const dependentList = Array.isArray(jparse(dep.out)) ? (jparse(dep.out) as any[]) : [];
      const gated = dependentList.filter(
        (x: any) => x && x.id != null && x.issue_type !== "gate" && x.status !== "closed",
      );
      const closed: string[] = [];
      const stillBlocked: string[] = [];
      for (const g of gated) {
        const rc = await bd(["close", String(g.id)], dir);
        if (rc.ok) {
          closed.push(String(g.id));
          await afterWrite(dir);
        } else {
          stillBlocked.push(String(g.id));
        }
      }
      if (closed.length === 0) {
        return textResult(
          stillBlocked.length
            ? `gate ${id} resolved; gated step(s) still blocked: ${stillBlocked.join(", ")}`
            : `gate ${id} resolved`,
        );
      }
      return textResult(`gate ${id} resolved and gated step ${closed.join(", ")} closed`);
    },
  });

  pi.registerTool({
    name: TOOL.molPour,
    label: "Beads molecule pour",
    description:
      "Instantiate a proto formula as a persistent molecule (bd mol pour). Prints the root issue id from bd's output. Repo-scoped like beads_create.",
    parameters: {
      type: "object",
      properties: {
        proto: { type: "string", description: "Proto/formula id, e.g. superpowers-workflow" },
        vars: { type: "string", description: "Comma-separated key=value pairs, e.g. topic=foo,owner=bar" },
        repo: { type: "string", description: "Target repo (folder name or id prefix); defaults to the session cwd's repo" },
      },
      required: ["proto"],
    },
    async execute(_id: string, params: any) {
      if (!params?.proto) return textResult("proto is required");
      const repoDir = resolveCreateTarget(params?.repo);
      if (!repoDir)
        return textResult(`specify repo (one of: ${knownRepos()}) — cannot pour in the umbrella aggregate`);
      const varPairs = String(params.vars ?? "")
        .split(",").map((s: string) => s.trim()).filter(Boolean);
      const args = ["mol", "pour", String(params.proto)];
      for (const pair of varPairs) args.push("--var", pair);
      const r = await bd(args, repoDir);
      if (!r.ok) return textResult(`bd mol pour failed: ${r.err}`);
      await afterWrite(repoDir);
      const rootMatch = r.out.match(/Root issue:\s*(\S+)/);
      if (!rootMatch)
        return textResult(
          `bd mol pour created ${String(params.proto)} but could not determine the molecule root — pour is UNLABELED; do not use`,
        );
      const root = rootMatch[1];
      const map = await molKeyToId(String(params.proto), varPairs, root, repoDir);
      if (!map)
        return textResult(
          `bd mol pour created ${String(params.proto)} but could not stamp step labels (dry-run/map incomplete) — root ${root} is UNLABELED; do not use`,
        );
      for (const [key, id] of map) {
        const u = await bd(["update", id, "--add-label", `step:${key}`], repoDir);
        if (!u.ok)
          return textResult(`bd mol pour failed: step:${key} on ${id}: ${u.err}`);
      }
      await afterWrite(repoDir);
      return textResult(r.out.trim() || "poured");
    },
  });

  pi.registerTool({
    name: TOOL.molShow,
    label: "Beads molecule show",
    description: "Show a molecule/proto's structure (bd mol show <id> --json). Read-only.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Molecule or step id" } },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id) return textResult("id is required");
      await ensureFresh();
      const r = await bd(["mol", "show", String(params.id), "--json"], umbrella);
      if (!r.ok) return textResult(`bd mol show failed: ${r.err}`);
      return textResult(r.out.trim());
    },
  });

  pi.registerTool({
    name: TOOL.molCurrent,
    label: "Beads molecule current",
    description: "Show the current position in a molecule's workflow (bd mol current <id> --json). Read-only.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Molecule root id" } },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id) return textResult("id is required");
      await ensureFresh();
      const r = await bd(["mol", "current", String(params.id), "--json"], umbrella);
      if (!r.ok) return textResult(`bd mol current failed: ${r.err}`);
      return textResult(r.out.trim());
    },
  });

  pi.registerTool({
    name: TOOL.molReady,
    label: "Beads molecule ready",
    description:
      "Show the ready frontier of one molecule's steps (bd ready --mol <id>): which steps/tasks are unblocked right now. Accepts a molecule id or a step id (e.g. the implement step with task children). Read-only; aggregate-aware; id prefix shows the owning project.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Molecule or step id, e.g. the implement step id" },
        limit: { type: "number", description: "Max steps shown (optional)" },
      },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id) return textResult("id is required");
      await ensureFresh();
      // Unlike beads_ready, beads_mol_ready intentionally omits --include-ephemeral (durable molecule steps; matches molShow/molCurrent).
      const args = ["ready", "--mol", String(params.id), "--json"];
      if (params?.limit) args.push("-n", String(params.limit));
      const r = await bd(args, umbrella);
      if (!r.ok) return textResult(`bd ready --mol failed: ${r.err}`);
      const o = jparse(r.out);
      return textResult(o ? fmtMolReady(o, params?.limit) : r.out.trim());
    },
  });

  pi.registerTool({
    name: TOOL.dep,
    label: "Beads dependency",
    description:
      "Add a dependency: 'blocker' blocks 'issue' (issue depends on blocker). Both must live in the same repo; routed by the issue's id prefix.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "string", description: "The dependent issue id" },
        blocker: {
          type: "string",
          description: "The issue that must be done first",
        },
        type: { type: "string", description: "Dependency type: blocks|tracks|related|parent-child|discovered-from (default blocks)" },
      },
      required: ["issue", "blocker"],
    },
    async execute(_id: string, params: any) {
      if (!params?.issue || !params?.blocker)
        return textResult("issue and blocker are required");
      const dir = dirForPrefix(String(params.issue));
      if (!dir) return textResult(`unknown repo for id '${params.issue}'`);
      if (
        dirForPrefix(String(params.blocker)) &&
        dirForPrefix(String(params.blocker)) !== dir
      )
        return textResult(
          "cross-repo dependencies are not supported by beads; both ids must be in the same repo",
        );
      const linkArgs = ["link", String(params.issue), String(params.blocker)];
      if (params.type) {
        const t = String(params.type);
        if (!DEP_LINK_TYPES.includes(t))
          return textResult(
            `invalid dependency type '${t}' (allowed: ${DEP_LINK_TYPES.join("|")})`,
          );
        linkArgs.push("--type", t);
      }
      const r = await bd(linkArgs, dir);
      if (!r.ok) return textResult(`bd link failed: ${r.err}`);
      await afterWrite(dir);
      return textResult(r.out.trim() || "linked");
    },
  });

  pi.registerTool({
    name: TOOL.undep,
    label: "Beads unlink dependency",
    description:
      "Remove a dependency: the issue will no longer depend on blocker. Both ids must be in the same repo; routed by the issue id prefix.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "string", description: "The dependent issue id" },
        blocker: {
          type: "string",
          description: "The blocker/dependency to remove",
        },
      },
      required: ["issue", "blocker"],
    },
    async execute(_id: string, params: any) {
      if (!params?.issue || !params?.blocker)
        return textResult("issue and blocker are required");
      const dir = dirForPrefix(String(params.issue));
      if (!dir) return textResult(`unknown repo for id '${params.issue}'`);
      if (
        dirForPrefix(String(params.blocker)) &&
        dirForPrefix(String(params.blocker)) !== dir
      )
        return textResult(
          "cross-repo dependencies are not supported by beads; both ids must be in the same repo",
        );
      // bd dep remove has no --type flag (confirmed via `bd dep remove --help`); it removes
      // whatever dependency edge exists between the two ids regardless of type.
      const r = await bd(
        ["dep", "remove", String(params.issue), String(params.blocker)],
        dir,
      );
      if (!r.ok) return textResult(`bd dep remove failed: ${r.err}`);
      await afterWrite(dir);
      return textResult(r.out.trim() || "dependency removed");
    },
  });

  pi.registerTool({
    name: TOOL.comment,
    label: "Beads comment",
    description: "Add a progress note/comment to an issue in its owning repo.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue id" },
        text: { type: "string", description: "Comment text" },
      },
      required: ["id", "text"],
    },
    async execute(_id: string, params: any) {
      if (!params?.id || !params?.text)
        return textResult("id and text are required");
      const dir = dirForPrefix(String(params.id));
      if (!dir) return textResult(`unknown repo for id '${params.id}'`);
      const r = await bd(
        ["comment", String(params.id), String(params.text)],
        dir,
      );
      if (!r.ok) return textResult(`bd comment failed: ${r.err}`);
      await afterWrite(dir);
      return textResult(r.out.trim() || "comment added");
    },
  });

  // ============ slash commands (human, no LLM-context cost) ============
  pi.registerCommand("beads", {
    description:
      "Show a compact beads board across all repos (ready + in-progress)",
    async handler(_args: string, ctx: any) {
      if (!beadsReady) {
        ctx?.ui?.notify?.(
          "beads not initialized here. Run /beads-init.",
          "warning",
        );
        return;
      }
      await ensureFresh();
      const ready = await bd(["ready", "--json", "--include-ephemeral", "-n", "10"], umbrella);
      const inProgress = await bd(
        ["list", "--status", "in_progress", "--json"],
        umbrella,
      );
      const out = [
        "In progress:",
        inProgress.ok ? fmtRows(inProgress.out) : "(error)",
        "",
        "Ready:",
        ready.ok ? fmtRows(ready.out) : "(error)",
      ].join("\n");
      ctx?.ui?.notify?.(out, "info");
    },
  });

  pi.registerCommand("beads-sync", {
    description: "Re-hydrate the umbrella aggregate from all repos now",
    async handler(_args: string, ctx: any) {
      if (!isUmbrella) {
        ctx?.ui?.notify?.("single-repo mode — nothing to hydrate.", "info");
        return;
      }
      const r = await bd(["repo", "sync"], umbrella, 60000);
      needSync = false;
      ctx?.ui?.notify?.(
        r.ok ? "umbrella re-synced." : `repo sync: ${r.err || r.out}`,
        r.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("beads-init", {
    description: "Initialize beads (bd init) in the current project",
    async handler(_args: string, ctx: any) {
      // --skip-agents/--skip-hooks: bd must not write AGENTS.md/CLAUDE.md/.claude/.codex
      // /.agents or install git hooks (core.hooksPath) into the user's project.
      const r = await bd(["init", "--skip-agents", "--skip-hooks"], activeCwd);
      await resolveTopology();
      setStatusLine(ctx);
      ctx?.ui?.notify?.(
        r.ok ? "beads initialized." : `bd init: ${r.err || r.out}`,
        r.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("beads-mode", {
    description: "Show current beads mode and context economics",
    async handler(_args: string, ctx: any) {
      const mode = beadsReady
        ? isUmbrella
          ? "UMBRELLA LEAN \u2713 (reads span all repos; writes auto-route by id prefix)"
          : "CLI LEAN \u2713 (single repo; prime ~141 tok once/segment; digests ~16-208 tok)"
        : "NOT INITIALIZED \u2014 run /beads-init";
      const lines = [
        `pi-beads-lean mode: ${mode}`,
        `umbrella: ${umbrella}${isUmbrella ? "" : " (no aggregate)"}`,
        `session cwd: ${activeCwd}`,
        `default create repo: ${defaultRepoDir ? path.basename(defaultRepoDir) : "(must pass repo)"}`,
        isUmbrella ? `repos: ${knownRepos()}` : "",
        isUmbrella
          ? `prefix routes: ${Array.from(prefixToDir.entries())
              .map(([p, d]) => `${p}->${path.basename(d)}`)
              .join(", ")}`
          : "",
        `Tools: ${Object.values(TOOL).join(", ")}`,
      ].filter(Boolean);
      ctx?.ui?.notify?.(lines.join("\n"), "info");
    },
  });
}
