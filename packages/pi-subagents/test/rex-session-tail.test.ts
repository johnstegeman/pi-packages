/**
 * rex-session-tail.test.ts — a child's session file, read as a live session.
 *
 * The tail is the only reader of pi's on-disk session format, and it runs
 * against a file another process is still writing: appended lines must reach
 * subscribers, a half-written last line must not throw, and the message objects
 * `read()` hands back must stay the same objects so the transcript's Markdown
 * cache (keyed on identity) keeps hitting.
 */

import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTail } from "../src/rex/session-tail.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/rex/session-child.jsonl", import.meta.url));

/**
 * The fixture as the transcript sees it, in file order: the `session` header,
 * the `compaction` entry and the `branch_summary` are not messages, and the
 * system message pi persists is.
 */
const ROLES = ["system", "user", "assistant", "toolResult", "assistant", "toolResult", "user", "assistant"];

/** The fixture's leaf, so an appended entry continues its branch. */
const LEAF = "e0a9";

/**
 * The tail polls the file every 100 ms, so an append lands on the next tick. In
 * a full-suite run a tick can be delayed past vitest's 1 s default while other
 * workers keep the machine busy, so the waits are bounded generously: the bound
 * is on a passing test, not the timing the test asserts.
 */
const WAIT = { timeout: 5000 };

let dir: string;
let tail: SessionTail | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-session-tail-"));
});

afterEach(() => {
  tail?.stop();
  tail = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function copyFixture(): string {
  const path = join(dir, "session.jsonl");
  copyFileSync(FIXTURE, path);
  return path;
}

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function userEntry(id: string, parentId: string | null): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:10.000Z",
    message: { role: "user", content: `ask ${id}`, timestamp: 1767225610000 },
  };
}

function assistantEntry(id: string, parentId: string | null, usage = { input: 10, output: 5, cacheWrite: 0 }): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:10.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `answer ${id}` }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        ...usage,
        cacheRead: 0,
        totalTokens: usage.input + usage.output + usage.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1767225610000,
    },
  };
}

function compactionEntry(id: string, parentId: string, tokensBefore: number): unknown {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:10.000Z",
    summary: "Earlier turns summarized.",
    firstKeptEntryId: "e0a7",
    tokensBefore,
  };
}

function roles(t: SessionTail): string[] {
  return t.read().messages.map(m => m.role);
}

describe("SessionTail", () => {
  it("reads the fixture's messages in file order, dropping the header, compaction and branch summary", () => {
    const t = new SessionTail(copyFixture());
    tail = t;
    t.start();

    const snapshot = t.read();
    expect(snapshot.messages.map(m => m.role)).toEqual(ROLES);
    // One per assistant message, and only the assistant messages' usage:
    // 1200+900+30 input, 80+40+12 output, 300+0+100 cacheWrite.
    expect(snapshot.turns).toBe(3);
    expect(snapshot.usage).toEqual({ input: 2130, output: 132, cacheWrite: 400 });
  });

  it("picks up an appended line: read() grows and subscribers see message_end then turn_end", async () => {
    const path = copyFixture();
    const t = new SessionTail(path);
    tail = t;
    const events: AgentSessionEvent[] = [];
    t.subscribe(e => events.push(e));
    t.start();
    // The backlog is the snapshot's, not the subscribers': a tail reports what
    // happens next, and a usage accumulator counting replayed history would
    // double every token already in the file.
    expect(events).toHaveLength(0);

    appendFileSync(path, line(userEntry("f001", LEAF)) + line(assistantEntry("f002", "f001")));

    await vi.waitFor(() => {
      expect(events.map(e => e.type)).toEqual(["message_end", "message_end", "turn_end"]);
    }, WAIT);
    const turnEnd = events[2];
    if (turnEnd.type !== "turn_end") throw new Error("expected a turn_end");
    expect(turnEnd.message.role).toBe("assistant");

    const snapshot = t.read();
    expect(snapshot.messages.map(m => m.role)).toEqual([...ROLES, "user", "assistant"]);
    expect(snapshot.turns).toBe(4);
    expect(snapshot.usage).toEqual({ input: 2140, output: 137, cacheWrite: 400 });
  });

  it("reports a compaction entry as compaction_start then compaction_end", async () => {
    const path = copyFixture();
    const t = new SessionTail(path);
    tail = t;
    const events: AgentSessionEvent[] = [];
    t.subscribe(e => events.push(e));
    t.start();

    appendFileSync(path, line(compactionEntry("f003", LEAF, 42000)));

    await vi.waitFor(() => {
      expect(events.map(e => e.type)).toEqual(["compaction_start", "compaction_end"]);
    }, WAIT);
    const end = events[1];
    if (end.type !== "compaction_end") throw new Error("expected a compaction_end");
    expect(end.aborted).toBe(false);
    expect(end.result?.tokensBefore).toBe(42000);
    // A compaction is not a message: the history it summarized stays readable.
    expect(roles(t)).toEqual(ROLES);
  });

  it("does not throw while the file is absent and reads it once the child creates it", async () => {
    const path = join(dir, "not-yet.jsonl");
    const t = new SessionTail(path);
    tail = t;
    const events: AgentSessionEvent[] = [];
    t.subscribe(e => events.push(e));
    t.start();

    expect(t.read()).toEqual({ messages: [], turns: 0, usage: { input: 0, output: 0, cacheWrite: 0 } });

    copyFileSync(FIXTURE, path);

    await vi.waitFor(() => {
      expect(events.filter(e => e.type === "turn_end")).toHaveLength(3);
    }, WAIT);
    expect(roles(t)).toEqual(ROLES);
  });

  it("buffers a line cut off mid-write and reads it once the rest arrives", async () => {
    const path = join(dir, "cut.jsonl");
    const lines = readFileSync(FIXTURE, "utf8").trimEnd().split("\n");
    // The file ends inside the last assistant message, the way a child killed
    // mid-write leaves it: no trailing newline, no parsable JSON.
    const cut = 40;
    writeFileSync(path, `${lines.slice(0, -2).join("\n")}\n${lines[lines.length - 2].slice(0, cut)}`);

    const t = new SessionTail(path);
    tail = t;
    const events: AgentSessionEvent[] = [];
    t.subscribe(e => events.push(e));
    t.start();

    expect(roles(t)).toEqual(ROLES.slice(0, -1));
    expect(t.read().turns).toBe(2);

    appendFileSync(path, `${lines[lines.length - 2].slice(cut)}\n${lines[lines.length - 1]}\n`);

    await vi.waitFor(() => {
      expect(t.read().turns).toBe(3);
    }, WAIT);
    expect(roles(t)).toEqual(ROLES);
    expect(events.some(e => e.type === "turn_end")).toBe(true);
  });

  it("hands back the same message objects across appends, so the Markdown cache keeps its keys", () => {
    const path = copyFixture();
    const t = new SessionTail(path);
    tail = t;
    t.start();

    const before = t.read().messages;
    appendFileSync(path, line(assistantEntry("f001", LEAF)));
    const after = t.read().messages;

    expect(after).toHaveLength(before.length + 1);
    before.forEach((message, i) => {
      expect(after[i]).toBe(message);
    });
  });

  it("follows the active branch: an entry that branches off earlier history hides the abandoned tail", () => {
    const path = copyFixture();
    const t = new SessionTail(path);
    tail = t;
    t.start();

    // Parented to the first user message: everything after it is the branch the
    // child abandoned, so neither its messages, its turns nor its spend count.
    appendFileSync(path, line(assistantEntry("f001", "e0a1")));

    const snapshot = t.read();
    expect(snapshot.messages.map(m => m.role)).toEqual(["system", "user", "assistant"]);
    expect(snapshot.turns).toBe(1);
    expect(snapshot.usage).toEqual({ input: 10, output: 5, cacheWrite: 0 });
  });

  it("stops reporting appends after stop()", async () => {
    const path = copyFixture();
    const t = new SessionTail(path);
    tail = t;
    const events: AgentSessionEvent[] = [];
    t.subscribe(e => events.push(e));
    t.start();
    t.stop();

    appendFileSync(path, line(assistantEntry("f001", LEAF)));
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(events).toHaveLength(0);
  });

  it("takes a listener out of the fan-out when its unsubscribe runs", async () => {
    const path = copyFixture();
    const t = new SessionTail(path);
    tail = t;
    const events: AgentSessionEvent[] = [];
    const unsubscribe = t.subscribe(e => events.push(e));
    t.start();
    unsubscribe();

    appendFileSync(path, line(assistantEntry("f001", LEAF)));
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(events).toHaveLength(0);
  });
});

describe("re-pointing a tail", () => {
  it("follows the file the child actually wrote, and reads what is in it", () => {
    // The shape a pane run has: the parent guessed a path (the child had not
    // written anything yet) and the real file turned up afterwards.
    const guess = join(dir, "agent-1.jsonl");
    const real = copyFixture();
    tail = new SessionTail(guess);
    expect(tail.file).toBe(guess);
    expect(tail.read().messages).toHaveLength(0);

    expect(tail.retarget(real)).toBe(true);

    expect(tail.file).toBe(real);
    // Byte offsets are per-file, so the retargeted tail reads the new file from
    // its start rather than from where the guess left off.
    expect(tail.read().messages.map((message) => message.role)).toEqual(ROLES);
  });

  it("refuses to re-point a tail that already read something", () => {
    // A tail with data has counted what it read; hopping to another file would
    // keep those messages and then add another file's on top of them.
    const first = copyFixture();
    tail = new SessionTail(first);
    tail.read();

    expect(tail.retarget(join(dir, "other.jsonl"))).toBe(false);
    expect(tail.file).toBe(first);
  });
});
