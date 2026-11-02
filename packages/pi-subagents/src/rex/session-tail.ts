// The child's session file, read as a live agent session.
//
// A Rex pane child is a real `pi` process, so the parent holds no `AgentSession`
// for it: the only live view of what the child did and is doing is the JSONL
// file pi appends to under the `--session-dir` the parent chose. This module is
// that view, and it is the only place in this extension that knows pi's on-disk
// session format — the proxy session and the pane runner downstream read
// `read()` and `subscribe()` and never a file.
//
// Three properties shape it:
//
//   - Incremental. The file is tailed from a byte offset, complete lines only,
//     with a trailing partial line kept as bytes until its newline arrives. A
//     failing child can be killed mid-write, so a truncated last line is normal
//     input, not corruption: it is buffered, not parsed, and never throws.
//   - Stable objects. `read()` hands out the same message object for an entry
//     it has already seen, because the transcript UI caches rendered Markdown in
//     a `WeakMap` keyed on object identity (`ui/conversation-viewer.ts`). Only
//     appended entries produce new objects.
//   - The active branch. Entries carry `id`/`parentId`, so an abandoned branch is
//     in the file but not in the conversation: `read()` walks from the leaf back
//     through parents and keeps only what the session itself would send, in file
//     order.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { AgentSession, AgentSessionEvent, CompactionResult } from "@earendil-works/pi-coding-agent";

/** Everything downstream needs from the file, and nothing it would have to parse. */
export interface SessionTailSnapshot {
  /** The active branch's messages, in file order — pi's own `AgentSession["messages"]`. */
  messages: AgentSession["messages"];
  /** Completed assistant turns; one per assistant message on the active branch. */
  turns: number;
  /** Lifetime token components, summed over the active branch's assistant messages. */
  usage: { input: number; output: number; cacheWrite: number };
}

type TailMessage = AgentSession["messages"][number];
type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * The events a session *file* can witness.
 *
 * Deliberately not `AgentSessionEvent`: there is no live agent behind a file, so
 * none of pi's streaming or lifecycle events can be synthesized from it — no
 * `agent_start`/`agent_end`/`agent_settled` (the parent watches the process for
 * those), no `message_start`/`message_update` (a message reaches the disk only
 * once it is complete), no tool-execution lifecycle (a call is a content block of
 * an assistant message here and its result is a later entry), no queue, retry or
 * boundary events. `turn_end` carries the turn index pi's own event leaves for
 * its consumers to count.
 */
type TailEvent =
  | { type: "message_end"; message: TailMessage }
  | { type: "turn_end"; turnIndex: number; message: TailMessage; toolResults: TailMessage[] }
  | { type: "compaction_start"; reason: CompactionReason }
  | { type: "compaction_end"; reason: CompactionReason; result: CompactionResult; aborted: boolean; willRetry: boolean };

/**
 * A compaction in a file is one that finished, and the file does not record why
 * pi ran it. An unattended child compacts on its own threshold, so that is the
 * reason reported; nothing downstream reads it for anything but display.
 */
const COMPACTION_REASON: CompactionReason = "threshold";

/**
 * How often the file is re-stated while the child works: one `stat` per tick,
 * and an open only when the file has grown.
 *
 * A timer rather than `fs.watchFile`, deliberately. `watchFile` spends a libuv
 * threadpool slot on every poll, so a parent whose pool is busy — every agent
 * tool that touches a file competes for the same four slots — can leave the
 * tail's tick queued for seconds while a child finishes (measured: a poll of a
 * file appended immediately before was still unseen five seconds later under
 * the full test suite). `statSync` never leaves this thread, so the worst case
 * is one delayed timer callback, and the read that follows is bounded by what
 * the child appended.
 */
const POLL_INTERVAL_MS = 100;

/** Bytes per `read` call; a session line is far smaller, and a big one spills over ticks. */
const READ_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Read one agent's session file, incrementally, as it is being written.
 *
 * `start()` watches; `read()` is correct with or without it (it catches up from
 * disk itself), which is what lets a caller drop the watcher and still render.
 */
export class SessionTail {
  private filePath: string;
  /** Bytes consumed so far; the next read starts here. */
  private offset = 0;
  /** Bytes read past the last newline: a line the child is still writing. */
  private buffered: Buffer = Buffer.alloc(0);
  /**
   * The one read buffer, reused for every pass. `buffered` is always built with
   * `Buffer.concat`, so it never aliases this — a 64 KiB allocation per poll
   * tick per running agent would be the tail's whole cost.
   */
  private readonly chunk = Buffer.alloc(READ_CHUNK_BYTES);
  /** Message entries in file order, each with the id that places it on a branch. */
  private readonly bearers: Array<{ id: string | undefined; message: TailMessage }> = [];
  /** Every entry's parent, by id — the tree `read()` walks from the leaf. */
  private readonly parents = new Map<string, string | null>();
  /** The last entry written: the leaf of the active branch. */
  private leafId: string | undefined;
  private messages: AgentSession["messages"] = [];
  private turns = 0;
  private usage = { input: 0, output: 0, cacheWrite: 0 };
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  /** Events produced by the drain in progress, published in order once it ends. */
  private outbox: TailEvent[] = [];
  /** The poll timer while `start()` is in effect. */
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** The file this tail is reading, as it currently knows it. */
  get file(): string {
    return this.filePath;
  }

  /**
   * Follow a different file.
   *
   * Only ever from a path that held nothing — a name predicted for a child that
   * had not written it yet — to the file the child actually wrote. Byte offsets
   * are per-file, so the offset is reset; the caller that re-points is the one
   * that knows nothing was read, and a false return says it was too late to be
   * true.
   */
  retarget(filePath: string): boolean {
    if (filePath === this.filePath) return false;
    if (this.offset !== 0) return false;
    this.filePath = filePath;
    return true;
  }

  /**
   * Begin watching the file.
   *
   * What is already in it is read here, so the first `read()` is complete — but
   * it is not replayed as events. A subscriber is told what happens next;
   * history is the snapshot's job, and a usage accumulator fed by replayed
   * events would count every token already on disk twice.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.drain(false);
    const timer = setInterval(() => {
      this.drain(true);
    }, POLL_INTERVAL_MS);
    // The tail must never be the reason the parent process stays alive.
    timer.unref();
    this.timer = timer;
  }

  /** Stop watching. State stays readable: `read()` still catches up from disk. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The session as the file currently describes it. */
  read(): SessionTailSnapshot {
    this.drain(true);
    return {
      messages: [...this.messages],
      turns: this.turns,
      usage: { ...this.usage },
    };
  }

  /** Fan out synthesized events. Returns the unsubscribe. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Read whatever has been appended since the last pass and place it.
   *
   * `emit` is false only for the backlog `start()` absorbs.
   */
  private drain(emit: boolean): void {
    this.outbox = [];
    try {
      // Nothing appended since the last pass, which is every poll of an idle
      // child: skip the open. `statSync` is on this thread, so a busy libuv
      // threadpool cannot hold the tail up.
      if (statSync(this.filePath).size === this.offset) return;
    } catch {
      // Not created yet — the child writes it on its first turn.
      return;
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.filePath, "r");
    } catch {
      // Absent (not written yet) or unreadable for a moment: the next tick tries
      // again, and neither is an error worth surfacing.
      return;
    }
    try {
      for (;;) {
        const read = readSync(fd, this.chunk, 0, this.chunk.length, this.offset);
        if (read === 0) break;
        this.offset += read;
        this.buffered = Buffer.concat([this.buffered, this.chunk.subarray(0, read)]);
        this.takeLines();
      }
    } catch {
      // Truncated or replaced under us, or the volume refused the read: keep
      // what is already placed and let the next tick retry.
    } finally {
      closeSync(fd);
    }
    const events = this.outbox;
    this.outbox = [];
    if (!emit) return;
    for (const event of events) this.publish(event);
  }

  /** Split the buffer into complete lines, keeping a line still being written. */
  private takeLines(): void {
    for (;;) {
      const newline = this.buffered.indexOf(NEWLINE);
      if (newline === -1) return;
      const text = this.buffered.subarray(0, newline).toString("utf-8");
      this.buffered = this.buffered.subarray(newline + 1);
      this.place(text);
    }
  }

  /**
   * Place one entry: its tree position always, its message or compaction only
   * when it has one. Every other entry type — `session` header, `branch_summary`,
   * `custom`, `custom_message`, `context_edit`, `label`, `model_change`,
   * `session_info`, `thinking_level_change`, `usage` — is bookkeeping the
   * transcript does not show.
   */
  private place(text: string): void {
    if (text.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // Junk in the middle of the file (a hand edit, a partially flushed write
      // that later got a newline): one unreadable entry, not a dead tail.
      return;
    }
    if (!isRecord(raw) || typeof raw.type !== "string") return;

    const id = typeof raw.id === "string" ? raw.id : undefined;
    const parentId = typeof raw.parentId === "string" ? raw.parentId : null;
    if (id !== undefined) {
      this.parents.set(id, parentId);
      this.leafId = id;
    }
    if (raw.type === "message") this.placeMessage(raw, id);
    else if (raw.type === "compaction") this.placeCompaction(raw);
  }

  private placeMessage(raw: JsonRecord, id: string | undefined): void {
    if (!isRecord(raw.message)) return;
    // pi serialized one of its own `AgentMessage`s; which one is a question the
    // consumers answer by role, and re-validating it here would duplicate pi's
    // every message variant. This is the JSON boundary, not a conversion — the
    // object handed on is the one pi wrote, unchanged and unparsed again.
    const message = raw.message as TailMessage;
    this.bearers.push({ id, message });
    this.rebuild();

    this.outbox.push({ type: "message_end", message });
    if (message.role === "assistant") {
      // `toolResults` is empty by construction: a turn's tool results are the
      // entries that follow the assistant entry, and none of them are on disk
      // yet when it lands. Consumers read those from the snapshot's messages.
      this.outbox.push({ type: "turn_end", turnIndex: this.turns, message, toolResults: [] });
    }
  }

  private placeCompaction(raw: JsonRecord): void {
    const { summary, firstKeptEntryId, tokensBefore } = raw;
    if (typeof summary !== "string" || typeof firstKeptEntryId !== "string" || typeof tokensBefore !== "number") return;
    // Back to back: pi's live events bracket the summarization call, which a
    // file cannot witness — a compaction entry exists only once it succeeded.
    const result: CompactionResult = { summary, firstKeptEntryId, tokensBefore };
    this.outbox.push({ type: "compaction_start", reason: COMPACTION_REASON });
    this.outbox.push({
      type: "compaction_end",
      reason: COMPACTION_REASON,
      result,
      aborted: false,
      willRetry: false,
    });
  }

  /**
   * Recompute the active branch, its turn count and its spend.
   *
   * Derived on every placement rather than accumulated: a branch that switches
   * mid-file (an entry whose parent is not the current leaf) invalidates every
   * running total, and the active branch is short enough that walking it costs
   * nothing worth optimizing.
   */
  private rebuild(): void {
    const active = new Set<string>();
    let id = this.leafId;
    while (id !== undefined && !active.has(id)) {
      active.add(id);
      id = this.parents.get(id) ?? undefined;
    }

    const messages: AgentSession["messages"] = [];
    for (const bearer of this.bearers) {
      // An entry with no id cannot be pointed at, so it cannot be branched away
      // from; pi always writes ids, and keeping them is friendlier than losing a
      // message to a malformed line.
      if (bearer.id !== undefined && !active.has(bearer.id)) continue;
      messages.push(bearer.message);
    }
    this.messages = messages;

    this.turns = 0;
    this.usage = { input: 0, output: 0, cacheWrite: 0 };
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      this.turns++;
      // `usage` is required on an assistant message, so the guard only catches a
      // file that lost it; `?? 0` covers a partial usage object for the same
      // reason. A turn is counted either way: the message is what the turn was.
      const usage = message.usage;
      if (!usage) continue;
      this.usage.input += usage.input ?? 0;
      this.usage.output += usage.output ?? 0;
      this.usage.cacheWrite += usage.cacheWrite ?? 0;
    }
  }

  private publish(event: TailEvent): void {
    // The one cast on the event path. A file cannot produce pi's full
    // `AgentSessionEvent` union (see `TailEvent` above: no streaming, no
    // tool-execution lifecycle, no lifecycle or boundary events), so what is
    // published is the subset a file can witness — a `turn_end` that also names
    // the turn index. Every consumer downstream reads `type`, `message` and the
    // compaction result, all of which are pi's own shapes.
    const agentEvent = event as AgentSessionEvent;
    for (const listener of this.listeners) listener(agentEvent);
  }
}
