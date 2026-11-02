// Modality detection: does a subagent run as a real `pi` process in a Rex pane,
// or as the in-process SDK session that has always run it?
//
// This sits on the spawn path, not at extension load, so the 1500 ms ceiling
// below is a cost a user can feel — and every failure has to be a cheap "no"
// rather than a throw or a wait. Three questions, cheapest first: are the
// environment markers there, is anyone watching (a terminal), and does the Rex
// server answer. The last one costs a subprocess, so it is asked last and only
// once per process (`rexPanesEnabled` memoizes).

import { spawn } from "node:child_process";
// `RexPanesSetting` is declared in settings.ts, beside the key that holds it, and
// re-exported here so callers that already import it from the detector keep
// working. `loadSettings` is the only value this module takes from there, so the
// layering runs one way: settings.ts knows nothing about Rex.
import { loadSettings, type RexPanesSetting } from "../settings.js";

export type { RexPanesSetting };

/**
 * How long `rex whoami --json` gets. One subprocess round trip to a local
 * server answers in tens of milliseconds; 1500 ms is the point past which the
 * pane path costs more than it saves and the in-process runner wins.
 */
export const DEFAULT_REX_PROBE_TIMEOUT_MS = 1500;

/**
 * How much of the probe's stdout is kept. `whoami --json` answers in a few
 * hundred bytes, so anything past this is not the answer: the body is dropped
 * and the shape check rejects whatever survived. The 1500 ms ceiling is a bound
 * on time, not on memory, and a CLI chattering for a second and a half must not
 * be able to grow this string without limit.
 */
const MAX_PROBE_STDOUT_LENGTH = 64 * 1024;

/** Everything detection reads, injected so the matrix is testable without a Rex server. */
export interface RexDetectDeps {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  setting: RexPanesSetting | undefined;
  probe: () => Promise<boolean>;
}

/**
 * Should this process run subagents in Rex panes?
 *
 * False whenever any leg of the answer is doubtful — the checks are ordered
 * cheapest-first and short-circuit before the probe, which costs a subprocess.
 */
export async function detectRexPanes(deps: RexDetectDeps): Promise<boolean> {
  if (!rexTerminalMarkers(deps.env, deps.isTTY)) return false;
  if (deps.setting === "off") return false;
  return settleWithin(deps.probe, DEFAULT_REX_PROBE_TIMEOUT_MS);
}

/**
 * The cheap half of detection: everything answerable without a subprocess.
 *
 * Exported because the spawn path can use it to skip the whole question. A
 * caller that gets `false` here knows there is no pane to be had, synchronously,
 * so a spawn outside Rex does not have to wait on a promise to learn it is
 * running in-process — which keeps the manager's timing exactly as it was for
 * every session that is not inside Rex.
 */
export function rexTerminalMarkers(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  // A child `pi` launched in a pane inherits REX_SESSION, REX_BLOCK and its own
  // TTY, so without this marker every child would try to spawn panes of its
  // own. `index.ts` sets it on the pane child and the child mode deletes it, so
  // its presence means "I am already somebody's subagent".
  if (env.PI_SUBAGENTS_CHILD_SPEC) return false;
  // Empty counts as absent: `REX_SESSION=` in a wrapper script is not a session.
  if (!env.REX_SESSION || !env.REX_BLOCK) return false;
  // A print-mode or RPC-driven parent has nobody watching capsules and may exit
  // mid-run, leaving an orphan pane behind.
  return isTTY;
}

/**
 * Run the probe, but never let it outlive the ceiling or reject. The probe
 * bounds its own child; this bounds the probe, so a future implementation that
 * forgets to cannot hang a spawn.
 */
function settleWithin(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // unref: a probe that answers instantly must not hold the process open for
    // the rest of the window.
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    let pending: Promise<boolean>;
    try {
      pending = probe();
    } catch {
      finish(false);
      return;
    }
    pending.then(finish, () => finish(false));
  });
}

/**
 * Ask the Rex server, through its CLI, whether there is one to answer.
 *
 * `rex whoami --json` exits non-zero when no server is listening, so exit status
 * carries the answer; the body is parsed only to reject a CLI that exits 0 while
 * printing something that is not whoami JSON. A missing `rex` (spawn ENOENT) and
 * a CLI that hangs are both `false`: `spawn`'s own timeout kills the child, so
 * nothing is left running behind a `false`.
 */
export function rexProbe(timeoutMs: number = DEFAULT_REX_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn("rex", ["whoami", "--json"], {
      // stdin closed so a CLI that would prompt cannot wait on it; stderr
      // ignored because "no server" is an expected answer, not a diagnostic.
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      // Past the cap the body is no longer the answer, so it is not kept — but
      // the listener stays attached: an unread pipe would fill and block the
      // child instead of letting the ceiling kill it.
      if (stdout.length >= MAX_PROBE_STDOUT_LENGTH) return;
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(false));
    // 'close', not 'exit': the whoami JSON arrives on the pipe, and a large
    // enough body can still be draining when the process exits.
    child.on("close", (code) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        // An object, not merely parseable: `whoami --json` answers with an
        // object, so `true`, a bare string or an array is some other CLI
        // answering to the same name.
        finish(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
      } catch {
        finish(false);
      }
    });
  });
}

// Memoized per process. Detection runs on the spawn path and costs a subprocess,
// and the answer cannot usefully change mid-session: a fan-out whose spawns
// disagreed on the modality would be the one genuinely confusing outcome.
let memo: Promise<boolean> | undefined;

/** The spawn path's single question. Memoized — first answer wins for the process. */
export function rexPanesEnabled(cwd: string = process.cwd()): Promise<boolean> {
  memo ??= askTheEnvironment(cwd);
  return memo;
}

/**
 * The detection itself, with the setting read where it can fail safely.
 *
 * `loadSettings` runs synchronously and can throw (an agent dir pi cannot read,
 * a settings file that vanishes between the stat and the read). A throw here
 * would escape as a rejected promise on the spawn path, where every failure is
 * supposed to be a cheap "no" — so an unreadable setting is answered with the
 * in-process runner instead.
 */
async function askTheEnvironment(cwd: string): Promise<boolean> {
  let setting: RexPanesSetting | undefined;
  try {
    setting = loadSettings(cwd).runInRexPanes;
  } catch {
    return false;
  }
  return detectRexPanes({
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    setting,
    probe: rexProbe,
  });
}

/** Test seam: drop the memoized answer so a suite can observe detection again. */
export function resetRexDetectionForTests(): void {
  memo = undefined;
}
