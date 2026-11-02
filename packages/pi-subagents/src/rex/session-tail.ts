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
//     input, not corruption: it is buffered, not parsed, and never throws. A
//     file that shrinks under the tail — an in-place rewrite — resets it, since
//     the old offset points past the new end.
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
  /**
   * Token components summed over the active branch's assistant messages: this
   * branch's spend, not the run's lifetime total. An entry a later branch
   * abandoned is in the file but is not counted here — the run's lifetime usage
   * is the manager's record, not the tail's.
   */
  usage: { input: number; output: number; cacheWrite: number };
}

type TailMessage = AgentSession["messages"][number];

/** pi's own reason union, derived so it cannot drift from the event it reports. */
type CompactionReason = Extract<AgentSessionEvent, { type: "compaction_start" }>["reason"];

/**
 * The events a session *file* can witness.
 *
 * Deliberately not `AgentSessionEvent`: there is no live agent behind a file, so
 * none of pi's streaming or lifecycle events can be synthesized from it — no
 * `agent_start`/`agent_end`/`agent_settled` (the parent watches the process for
 * those), no `message_start`/`message_update` (a message reaches the disk only
 * once it is complete), no tool-execution lifecycle (a call is a content block of
 * an assistant message here and its result is a later entry), no queue, retry or
 * boundary events. `turn_end` carries no turn index because pi's own does not
 * either — a consumer that needs one counts the branch's assistant messages
 * itself, which is what `feedActivity()` in `pane-run.ts` does.
 */
type TailEvent =
  | { type: "message_end"; message: TailMessage }
  | { type: "turn_end"; message: TailMessage; toolResults: TailMessage[] }
  | { type: "compaction_start"; reason: CompactionReason }
  | { type: "compaction_end"; reason: CompactionReason; result: CompactionResult; aborted: boolean; willRetry: boolean };

/**
 * One event and the entry that produced it.
 *
 * The entry id is kept beside the event so publication can honour the branch: a
 * line later in the same pass may branch away from an earlier one, and an entry
 * that is not in the conversation must not be announced as though it were.
 * `undefined` is an entry pi wrote without an id, which cannot be branched away
 * from (see `rebuild()`).
 */
interface StagedEvent {
  event: TailEvent;
  entryId: string | undefined;
}

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

/**
 * Bytes per `read` call; a session line is far smaller, so a big one — a tool
 * result with a payload — spills over ticks and is joined by `consume()`.
 */
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
  /**
   * Bytes of a line the child has not finished writing, as the slices of the
   * reads that produced them.
   *
   * Slices rather than one growing buffer: a multi-megabyte line arrives as many
   * chunk reads, and re-concatenating the whole buffer per chunk is quadratic in
   * the line's length. The slices are joined once, when the newline arrives.
   */
  private pending: Buffer[] = [];
  /** Bytes held in `pending`, so the join needs no extra pass to measure them. */
  private pendingBytes = 0;
  /**
   * The one read buffer, reused for every pass. `pending` holds copies, so it
   * never aliases this — a 64 KiB allocation per poll tick per running agent
   * would be the tail's whole cost.
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
  private outbox: StagedEvent[] = [];
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

  /**
   * Stop watching.
   *
   * State stays readable — `read()` still catches up from disk — but silently:
   * nothing is published once the tail is stopped, so a snapshot read after the
   * fact cannot resurrect the event stream of a run that has ended.
   */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The session as the file currently describes it. */
  read(): SessionTailSnapshot {
    // Publication is the watcher's job, so the catch-up a stopped tail performs
    // here stays silent (see `stop()`).
    this.drain(this.timer !== undefined);
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
   * `emit` is false for the backlog `start()` absorbs and for every catch-up a
   * stopped tail performs.
   */
  private drain(emit: boolean): void {
    this.outbox = [];
    let size: number;
    try {
      // Nothing appended since the last pass, which is every poll of an idle
      // child: skip the open. `statSync` is on this thread, so a busy libuv
      // threadpool cannot hold the tail up.
      size = statSync(this.filePath).size;
    } catch {
      // Not created yet — the child writes it on its first turn.
      return;
    }
    // A file shorter than what has been read was rewritten in place. The offset
    // now points past its end and `readSync` from there returns 0 for ever, so
    // the tail would stall on the old history: start over instead.
    if (size < this.offset) this.reset();
    if (size === this.offset) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.filePath, "r");
    } catch {
      // Absent (not written yet) or unreadable for a moment: the next tick tries
      // again, and neither is an error worth surfacing.
      return;
    }
    let sawLine = false;
    try {
      for (;;) {
        const read = readSync(fd, this.chunk, 0, this.chunk.length, this.offset);
        if (read === 0) break;
        this.offset += read;
        sawLine = this.consume(this.chunk.subarray(0, read)) || sawLine;
      }
    } catch {
      // Truncated or replaced under us, or the volume refused the read: keep
      // what is already placed and let the next tick retry.
    } finally {
      closeSync(fd);
    }
    if (!sawLine) return;
    // Once per pass, not once per line: the branch, its turns and its spend are
    // derived from the whole file, so rebuilding per entry would be quadratic in
    // a resumed backlog — and that work runs on the parent's thread, inside
    // `start()`.
    const active = this.rebuild();
    const batch = this.outbox;
    this.outbox = [];
    if (!emit) return;
    for (const staged of batch) {
      // An entry a later line in this same pass branched away from is in the
      // file but not in the conversation, so its events would contradict the
      // snapshot's `turns` the moment they were published.
      if (staged.entryId !== undefined && !active.has(staged.entryId)) continue;
      this.publish(staged.event);
    }
  }

  /**
   * Forget everything read so far, for a file that was rewritten in place.
   *
   * Every value this class holds is a function of the file's bytes from offset
   * 0, and a shortened file invalidates all of them at once: the offset points
   * past the new end, a buffered partial line belongs to a write that no longer
   * exists, and the placed entries are another file's history. Message objects
   * are rebuilt rather than kept — the transcript's Markdown cache is keyed on
   * identity, and there is no identity to carry between two files.
   */
  private reset(): void {
    this.offset = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.bearers.length = 0;
    this.parents.clear();
    this.leafId = undefined;
    this.messages = [];
    this.turns = 0;
    this.usage = { input: 0, output: 0, cacheWrite: 0 };
  }

  /**
   * Split one read into complete lines, keeping a line still being written.
   *
   * Returns whether the read contained a complete line — the caller's cue that
   * the snapshot has to be derived again.
   */
  private consume(read: Buffer): boolean {
    let sawLine = false;
    let start = 0;
    for (;;) {
      const newline = read.indexOf(NEWLINE, start);
      if (newline === -1) break;
      const piece = read.subarray(start, newline);
      if (this.pendingBytes === 0) {
        this.place(piece.toString("utf-8"));
      } else {
        // The line began in an earlier read: join its slices here, once, rather
        // than re-concatenating a growing buffer per chunk.
        this.pending.push(Buffer.from(piece));
        const joined = Buffer.concat(this.pending, this.pendingBytes + piece.length);
        this.pending = [];
        this.pendingBytes = 0;
        this.place(joined.toString("utf-8"));
      }
      sawLine = true;
      start = newline + 1;
    }
    if (start < read.length) {
      // A copy, because `this.chunk` is overwritten by the next read.
      const rest = Buffer.from(read.subarray(start));
      this.pending.push(rest);
      this.pendingBytes += rest.length;
    }
    return sawLine;
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
    else if (raw.type === "compaction") this.placeCompaction(raw, id);
  }

  private placeMessage(raw: JsonRecord, id: string | undefined): void {
    if (!isRecord(raw.message)) return;
    // pi serialized one of its own `AgentMessage`s; which one is a question the
    // consumers answer by role, and re-validating it here would duplicate pi's
    // every message variant. This is the JSON boundary, not a conversion — the
    // object handed on is the one pi wrote, unchanged and unparsed again.
    const message = raw.message as TailMessage;
    this.bearers.push({ id, message });

    this.outbox.push({ event: { type: "message_end", message }, entryId: id });
    if (message.role === "assistant") {
      // `toolResults` is empty by construction: a turn's tool results are the
      // entries that follow the assistant entry, and none of them are on disk
      // yet when it lands. Consumers read those from the snapshot's messages.
      this.outbox.push({ event: { type: "turn_end", message, toolResults: [] }, entryId: id });
    }
  }

  private placeCompaction(raw: JsonRecord, id: string | undefined): void {
    const { summary, firstKeptEntryId, tokensBefore } = raw;
    if (typeof summary !== "string" || typeof firstKeptEntryId !== "string" || typeof tokensBefore !== "number") return;
    // Back to back: pi's live events bracket the summarization call, which a
    // file cannot witness — a compaction entry exists only once it succeeded.
    const result: CompactionResult = { summary, firstKeptEntryId, tokensBefore };
    this.outbox.push({ event: { type: "compaction_start", reason: COMPACTION_REASON }, entryId: id });
    this.outbox.push({
      event: {
        type: "compaction_end",
        reason: COMPACTION_REASON,
        result,
        aborted: false,
        willRetry: false,
      },
      entryId: id,
    });
  }

  /**
   * Recompute the active branch, its turn count and its spend, and hand back the
   * ids that branch holds.
   *
   * Derived from the file rather than accumulated: a branch that switches
   * mid-file (an entry whose parent is not the current leaf) invalidates every
   * running total, and re-deriving is what makes the snapshot and the event
   * stream agree. Called once per drain, so the cost is linear in the file.
   */
  private rebuild(): Set<string> {
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
    return active;
  }

  private publish(event: TailEvent): void {
    // The one cast on the event path. A file cannot produce pi's full
    // `AgentSessionEvent` union (see `TailEvent` above: no streaming, no
    // tool-execution lifecycle, no lifecycle or boundary events), so what is
    // published is the subset a file can witness. Every consumer downstream
    // reads `type`, `message` and the compaction result, all of which are pi's
    // own shapes.
    const agentEvent = event as AgentSessionEvent;
    for (const listener of this.listeners) {
      try {
        listener(agentEvent);
      } catch (error) {
        // One subscriber's failure is not the tail's: without this, the rest of
        // the batch is lost and the exception escapes into the timer callback,
        // where nothing is left to catch it.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-subagents] a session-tail subscriber threw on ${agentEvent.type}: ${reason}`);
      }
    }
  }
}
