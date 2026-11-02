// A pane child's session file, wearing the interface every surface already reads.
//
// Inside Rex a subagent is a real `pi` process in a floating pane, so the parent
// holds no `AgentSession` for it: what exists is the child's JSONL session file
// (`session-tail.ts`) and whatever Rex needs to reach the pane. This class is
// the seam between those and `RunHandle` — a thin adapter, with no cache beyond
// the tail's own and no event reshaping beyond forwarding.
//
// Read this as a *file-backed* run, not as a live one, and do not compare the
// two:
//
//   - `messages` is the tail's snapshot, so it keeps pre-compaction history. A
//     live session's `messages` is the compacted working set; the viewer renders
//     either, but only one of them is what the child would send next.
//   - `getSessionStats()` is derived from the tail's usage totals, not from a
//     session window pi computes, and carries no `contextUsage`: a context
//     percentage needs the model's context window, which the file does not name.
//   - `model`/`thinkingLevel` are absent. `record.invocation` already carries
//     the spawn-time snapshot, and the result file refines it; the tail does not
//     parse `model_change`/`thinking_level_change` entries.
//   - `extensionRunner` is absent. A child's extensions live in the child
//     process, so `shutdownChildSession()` has nothing to emit `session_shutdown`
//     into and degrades to a plain dispose.
//
// The two things a file cannot do — steer, abort — arrive as injected functions,
// so this class never learns how the pane is reached and stays testable without
// Rex. It injects no close: a pane run's layer is closed by the runner that
// created it, and `dispose()` here only stops the tail.

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../types.js";
import type { SessionStatsLike } from "../usage.js";
import type { SessionTail } from "./session-tail.js";

/** What the pane side supplies: the file to read, and the two ways to reach the child. */
export interface PaneSessionDeps {
  /** The child's session file, already tailed by the caller (`start()` decides when it watches). */
  tail: SessionTail;
  /** Type into the child's pane. The pane runner refuses when its program is not accepting input. */
  steer: (message: string) => Promise<void>;
  /** Close the child's pane, which ends the child. */
  abort: () => Promise<void>;
}

/**
 * A `RunHandle` over a pane child's session file.
 *
 * Every read goes to the tail, which catches up from disk even when its poll
 * timer is off — so a handle works before the child has created the file, after
 * the child exited, and after `dispose()`.
 */
export class PaneSession implements RunHandle {
  private readonly tail: SessionTail;
  private readonly steerChild: (message: string) => Promise<void>;
  private readonly abortChild: () => Promise<void>;
  /** `dispose()` is called once per settled record, but callers retry; the tail stops once. */
  private disposed = false;

  constructor(deps: PaneSessionDeps) {
    this.tail = deps.tail;
    this.steerChild = deps.steer;
    this.abortChild = deps.abort;
  }

  /**
   * The child's transcript, as the tail currently knows it.
   *
   * Read through the tail rather than stored: `pi` writes its session file
   * lazily, so the path a run announces can be a prediction for a moment, and the
   * tail is what gets re-pointed when the real file appears (see the pane
   * runner's `followSessionFile()`). A stored string would keep naming a file
   * that never existed.
   */
  get sessionFile(): string {
    return this.tail.file;
  }

  /** The active branch as the file currently describes it — pre-compaction history included. */
  get messages(): AgentSession["messages"] {
    return this.tail.read().messages;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    return this.tail.subscribe(listener);
  }

  /**
   * The tail's token totals, or `undefined` until the file holds a usage entry.
   *
   * Absent and zero are different answers — "nothing spent yet" vs "spent
   * nothing" — and the usage readers treat absent as 0 anyway, so a run that
   * has not answered yet reports nothing rather than a false zero.
   */
  getSessionStats(): SessionStatsLike | undefined {
    const snapshot = this.tail.read();
    // A user or tool-result entry spends no tokens; usage rides on the assistant
    // messages, and a file that lost one (the tail tolerates that) is not a
    // usage entry either.
    const hasUsage = snapshot.messages.some(message => message.role === "assistant" && message.usage !== undefined);
    return hasUsage ? { tokens: snapshot.usage } : undefined;
  }

  /**
   * Not available on this path: a pane child is a one-shot process, and a resume
   * relaunches it on the same session file rather than typing into a run that
   * has already exited.
   */
  async prompt(_message: string): Promise<unknown> {
    throw new Error("A pane-backed run cannot be prompted: resuming it relaunches the child on its session file.");
  }

  steer(message: string): Promise<unknown> {
    return this.steerChild(message);
  }

  abort(): Promise<void> {
    return this.abortChild();
  }

  /** Stop watching the file. State stays readable: `messages` still catches up from disk. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tail.stop();
  }
}
