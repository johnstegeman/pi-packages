// The one place in this package that runs `rex`.
//
// Two jobs. `execRex` is the process layer: spawn the CLI, capture both
// streams, bound it, and — the part everything else depends on — never reject.
// A subagent spawn is not allowed to fail because a CLI was missing, slow, or
// unhappy; the caller gets a status and decides.
//
// The rest are the reads a running pane needs: whether its program has exited,
// what the program says it is doing, and the last lines on its screen. Each of
// them treats "the pane is already gone" as an ordinary answer, because with
// `exit.on_completion` a pane closes itself the moment its child ends — the
// block call failing is the normal end of a run, not an error.
//
// Pane lifecycle (`launchPane`, `minimizePane`, `closePane`) lives in
// `launcher.ts` beside the builders, because those calls must be serialized
// and that queue is the launcher's.

import { spawn } from "node:child_process";

/**
 * How long one `rex` call gets before it is killed. Every call here is a
 * round trip to a local server: tens of milliseconds when it answers at all.
 * Ten seconds is the point past which the server is not answering and a hung
 * spawn would outlive the run that asked for it.
 */
export const DEFAULT_REX_EXEC_TIMEOUT_MS = 10_000;

/**
 * How many screen lines `captureTail()` keeps when the caller does not say.
 * A terminal keeps up to 64 MiB of scrollback, so an unbounded tail could put
 * a hundred thousand lines into an error report; a report wants the tail.
 */
export const DEFAULT_CAPTURE_TAIL_LINES = 40;

/** What one `rex` invocation left behind. Never a rejection — see `execRex`. */
export interface RexExecResult {
  /** The CLI's exit status, or -1 when it could not be started or was killed. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The seam the pane verbs take instead of calling `execRex` directly, so a test
 * can drive them without a `rex` on PATH. The contract is `execRex`'s: it
 * resolves, always.
 *
 * `signal` is how a caller that has stopped caring ends the process: a watching
 * run whose result file landed does not need a `rex wait` finishing its 30 s
 * window, and a killed call reads as `code: -1` like any other unanswered call.
 */
export type RexExec = (
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<RexExecResult>;

/**
 * How long a killed `rex` gets to report its own death before the promise
 * settles anyway. `'close'` fires only once the child's stdio closes, and a
 * grandchild that inherited those pipes keeps them open after the CLI itself
 * is gone — long enough that settlement cannot wait for it: this promise sits
 * inside the pane queue, so one call that never settles would wedge every
 * later `launchPane`/`minimizePane` in the process.
 */
const SETTLE_BACKSTOP_MS = 250;

/**
 * Run `rex` with `args` and settle, whatever happens.
 *
 * `shell: false` and argv the caller built: nothing here is interpolated into a
 * shell, and a pane label with a space or a quote in it stays one argument.
 * stdin is closed so a CLI that would prompt cannot wait on a terminal that is
 * not there; stderr is captured because that is where `rex` explains a
 * `bad_request`. A child killed by the timeout has no exit status, so it is -1,
 * the same "no status" the Rex API itself uses — and a call that timed out is
 * -1 whatever status the child happened to exit with, because a clean exit that
 * races the kill is still a call that never answered.
 */
export function execRex(
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RexExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REX_EXEC_TIMEOUT_MS;
  const signal = options.signal;
  return new Promise<RexExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const child = spawn("rex", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    timer = setTimeout(() => {
      timedOut = true;
      stderr += `${stderr === "" ? "" : "\n"}rex ${args[0] ?? ""} timed out after ${timeoutMs} ms`;
      // SIGKILL, not SIGTERM: a CLI stuck in a syscall still has to go, and a
      // child left behind a settled promise would keep the process open.
      child.kill("SIGKILL");
      // Settlement must not depend on `'close'`: if the child, or anything it
      // started, still holds the pipes, the stream may not close at all.
      setTimeout(() => finish(-1), SETTLE_BACKSTOP_MS).unref();
    }, timeoutMs);
    timer.unref();

    // Decoded by the stream, not per chunk: a capture is full of unicode, and
    // a chunk boundary can fall inside a multi-byte character.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // A missing `rex` is an error event with no exit status; a call that could
    // not be made is -1 for the same reason a killed one is.
    child.on("error", (error: Error) => {
      stderr += `${stderr === "" ? "" : "\n"}${error.message}`;
      finish(-1);
    });
    // A caller that stopped caring kills the call, the same way the timeout does
    // and for the same reason: a CLI left behind a settled promise keeps the
    // process open. Not marked `timedOut` — this is not a failure to report, and
    // the caller already knows why it asked.
    const cancel = () => {
      child.kill("SIGKILL");
      setTimeout(() => finish(-1), SETTLE_BACKSTOP_MS).unref();
    };
    if (signal?.aborted === true) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    // 'close', not 'exit': stdout may still be draining when the process ends.
    // A child that exits 0 just as the timer fires is still a timeout, not a
    // successful call.
    child.on("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      finish(timedOut ? -1 : (code ?? -1));
    });
  });
}

/** The pane the calls in this module act on: which session, which window. */
export interface PaneDeps {
  exec: RexExec;
  /** The parent's own session. A pane is never created in anyone else's. */
  sessionId: string;
  /** The parent block's window, so the pane floats above the user's own tab. */
  windowId: string;
}

/**
 * What a pane's program has done and what it says it is doing.
 *
 * `lastExit` is null both while the program runs and when the pane is already
 * gone — Rex cannot tell you about a block that no longer exists — so a caller
 * that needs to distinguish those two reads the result file as well.
 * `status` is the program's own report (`working`, `blocked`, `idle`, `done`,
 * `error`), null when it has not reported one.
 */
export interface ProcessState {
  lastExit: number | null;
  status: string | null;
}

/**
 * Read how the pane's program ended and what it says it is doing.
 *
 * Two calls, in this order, because they answer different questions: `process`
 * carries `last_exit`, `program_status` carries the OSC 7501 state pi emits, and
 * that state is how a blocked child ("waiting for the user") is told from a
 * working one. The second is skipped when the first fails: a block that cannot
 * be read is a block that is not there, and asking twice changes nothing.
 */
export async function readProcessState(deps: PaneDeps, blockId: string): Promise<ProcessState> {
  const processReply = await blockCall(deps, blockId, "process");
  if (!processReply) return { lastExit: null, status: null };
  const statusReply = await blockCall(deps, blockId, "program_status");
  return { lastExit: exitCodeOf(processReply), status: reportedState(statusReply) };
}

/**
 * The pane's last lines, trimmed.
 *
 * A pane whose program has exited may have closed itself, so a failed capture
 * is an expected outcome and reads as "": the caller has an exit status and no
 * screen, which is what it reports.
 */
export async function captureTail(deps: PaneDeps, blockId: string, lines?: number): Promise<string> {
  const result = await deps.exec(["capture", "-s", deps.sessionId, "-b", blockId, "--trim"]);
  if (result.code !== 0) return "";
  // `--trim` drops trailing blank lines but the CLI still ends its output with
  // a newline, and an empty screen is not one empty line.
  const text = result.stdout.replace(/\n+$/, "");
  if (text === "") return "";
  // At least one line: `lines: 0` is a caller that made a mistake, and an empty
  // report would hide the screen it asked to see.
  const limit =
    lines !== undefined && Number.isFinite(lines) ? Math.max(1, Math.trunc(lines)) : DEFAULT_CAPTURE_TAIL_LINES;
  return text.split("\n").slice(-limit).join("\n");
}

/**
 * One `rex block call`, as an object.
 *
 * Undefined covers all three ways there is no answer: the call failed (a closed
 * block, a stopped server), it printed something that is not JSON, or it printed
 * JSON that is not an object. Callers report "nothing known" for all three.
 */
async function blockCall(
  deps: PaneDeps,
  blockId: string,
  method: string,
): Promise<Record<string, unknown> | undefined> {
  return rexReply(await deps.exec(["block", "call", "-s", deps.sessionId, "-b", blockId, method]));
}

/** A reply body as an object, or undefined when there is no reply body to read. */
export function rexReply(result: RexExecResult): Record<string, unknown> | undefined {
  if (result.code !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    // An array is JSON but never a reply body: every method in this API answers
    // with an object, so an array is some other CLI answering to the same name.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Why a `rex` call failed, as it should be shown to a user.
 *
 * The CLI prefixes its diagnostics with `Error: `, which is its own
 * decoration rather than the message; after it is what went wrong
 * (`bad_request: a window must keep a visible pane`, a missing binary, a
 * timeout). A failure that said nothing gets the caller's `fallback`: an empty
 * diagnostic is no evidence of any particular cause, and naming one would be a
 * guess dressed as an answer.
 */
export function failureReason(text: string, fallback: string): string {
  const detail = text.trim().replace(/^Error:\s*/i, "").trim();
  return detail === "" ? fallback : detail;
}

/** `last_exit.exit_code`, or null while the program runs or when it never started one. */
function exitCodeOf(reply: Record<string, unknown> | undefined): number | null {
  const lastExit = reply?.last_exit;
  if (typeof lastExit !== "object" || lastExit === null) return null;
  const code = (lastExit as { exit_code?: unknown }).exit_code;
  return typeof code === "number" ? code : null;
}

/**
 * The state the program reported for itself.
 *
 * Only the root record counts: `program_status` also carries records a program
 * reports for its children under slash-separated ids (`build/test`), and the
 * question here is about the pane's own program. A report from a child is not
 * its parent's state.
 */
function reportedState(reply: Record<string, unknown> | undefined): string | null {
  const records = reply?.records;
  if (!Array.isArray(records)) return null;
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const { id, state } = record as { id?: unknown; state?: unknown };
    if (id !== undefined) continue;
    return typeof state === "string" && state !== "" ? state : null;
  }
  return null;
}

/**
 * The window the parent block sits in, which is where its panes float.
 *
 * `session.new_layer` wants a window id, and a layer created without one lands
 * wherever the server decides — measured to be the parent block's window, but
 * only because nothing else asked. `rex block inspect` reports the block's own
 * `window_id`, so the answer is the parent's window by construction rather than
 * by luck.
 *
 * Undefined when there is no answer to read: Rex missing, a server that is not
 * there, or a block that has since closed. A caller that cannot name the window
 * has no business creating a pane.
 */
export async function resolveWindowId(
  deps: Pick<PaneDeps, "exec" | "sessionId">,
  blockId: string,
): Promise<string | undefined> {
  const reply = rexReply(await deps.exec(["block", "inspect", "-s", deps.sessionId, blockId, "--json"]));
  const block = reply?.block;
  if (typeof block !== "object" || block === null) return undefined;
  const windowId = (block as { window_id?: unknown }).window_id;
  return typeof windowId === "string" && windowId !== "" ? windowId : undefined;
}
