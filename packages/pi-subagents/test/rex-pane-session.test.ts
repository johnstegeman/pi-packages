/**
 * rex-pane-session.test.ts — a pane child's session file, wearing the face the UIs read.
 *
 * Inside Rex a subagent is a real `pi` process in a pane, so the parent holds no
 * `AgentSession` for it — only the JSONL file the child writes. `PaneSession` is
 * the adapter between that absence and every surface that reads
 * `record.session`: messages, events and session stats come from the tail,
 * while steering and aborting arrive as injected functions because reaching the
 * pane is somebody else's job.
 *
 * These tests pin the adapter, not the tail (which has its own): every read is
 * the tail's latest snapshot, an unsubscribe stops delivery, stats are absent
 * until the file holds a usage entry, and message objects stay identical so the
 * transcript's Markdown cache keeps hitting.
 */

import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneSession, type PaneSessionDeps } from "../src/rex/pane-session.js";
import { SessionTail } from "../src/rex/session-tail.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/rex/session-child.jsonl", import.meta.url));

/** The fixture's messages in file order; the header, compaction and branch summary are not messages. */
const ROLES = ["system", "user", "assistant", "toolResult", "assistant", "toolResult", "user", "assistant"];

/** The fixture's leaf, so an appended entry continues its branch. */
const LEAF = "e0a9";

/** The fixture's three assistant turns: 1200+900+30 input, 80+40+12 output, 300+0+100 cacheWrite. */
const TOTALS = { input: 2130, output: 132, cacheWrite: 400 };

/** The tail polls every 100 ms, so an append lands on the next tick. */
const WAIT = { timeout: 5000 };

let dir: string;
let tail: SessionTail | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-pane-session-"));
});

afterEach(() => {
  tail?.stop();
  tail = undefined;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

function assistantEntry(id: string, parentId: string | null): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:11.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `answer ${id}` }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1767225611000,
    },
  };
}

/**
 * A session over `path`, with the pane-side effects stubbed unless a test
 * supplies them. The tail comes back too: the pane runner starts it, and two
 * tests watch what `dispose()` does to it.
 */
function paneSession(
  path: string,
  overrides: Partial<PaneSessionDeps> = {},
): { session: PaneSession; tail: SessionTail } {
  const t = new SessionTail(path);
  tail = t;
  const session = new PaneSession({
    tail: t,
    steer: async () => {},
    abort: async () => {},
    ...overrides,
  });
  return { session, tail: t };
}

describe("PaneSession", () => {
  it("reports the tail's latest snapshot on every read of messages", () => {
    const path = copyFixture();
    const { session } = paneSession(path);

    expect(session.messages.map(m => m.role)).toEqual(ROLES);

    appendFileSync(path, line(userEntry("f001", LEAF)) + line(assistantEntry("f002", "f001")));

    // No start(), no waiting: the tail catches up from the file on the read.
    expect(session.messages.map(m => m.role)).toEqual([...ROLES, "user", "assistant"]);
  });

  it("hands back the same message objects across reads when nothing was appended", () => {
    const { session } = paneSession(copyFixture());

    const first = session.messages;
    const second = session.messages;

    expect(second).toHaveLength(first.length);
    first.forEach((message, i) => {
      expect(second[i]).toBe(message);
    });
  });

  it("forwards the tail's events, and stops delivering to the listener that unsubscribed", async () => {
    const path = copyFixture();
    const { session, tail: t } = paneSession(path);
    const events: AgentSessionEvent[] = [];
    // Two subscriptions, because one listener cannot tell "delivered to
    // everyone" from "delivered to the only one there is": an unsubscribe that
    // cleared the whole set would look identical.
    const other: AgentSessionEvent[] = [];
    const unsubscribe = session.subscribe(event => events.push(event));
    session.subscribe(event => other.push(event));
    t.start();

    appendFileSync(path, line(userEntry("f001", LEAF)) + line(assistantEntry("f002", "f001")));
    await vi.waitFor(() => {
      expect(events.map(e => e.type)).toEqual(["message_end", "message_end", "turn_end"]);
      expect(other.map(e => e.type)).toEqual(["message_end", "message_end", "turn_end"]);
    }, WAIT);

    unsubscribe();
    appendFileSync(path, line(userEntry("f003", "f002")));
    await vi.waitFor(() => {
      expect(other.map(e => e.type)).toEqual(["message_end", "message_end", "turn_end", "message_end"]);
    }, WAIT);

    // The unsubscribed listener heard nothing after its unsubscribe; the other
    // subscription on the same tail is untouched.
    expect(events.map(e => e.type)).toEqual(["message_end", "message_end", "turn_end"]);

    // And a disposed handle is still readable — the class promises it, because
    // the tail catches up from disk on a read.
    session.dispose();
    appendFileSync(path, line(userEntry("f004", "f003")));
    expect(session.messages.map(m => m.role).slice(-1)).toEqual(["user"]);
  });

  it("reports the tail's token totals as session stats once a usage entry exists", () => {
    const { session } = paneSession(copyFixture());

    expect(session.getSessionStats()).toEqual({ tokens: TOTALS });
  });

  it("reports no session stats before the first usage entry", () => {
    const path = join(dir, "later.jsonl");
    const { session } = paneSession(path);

    // The child has not created the file yet.
    expect(session.getSessionStats()).toBeUndefined();

    // A prompt on disk spends nothing: only an assistant message carries usage.
    writeFileSync(path, line(userEntry("f000", null)));
    expect(session.getSessionStats()).toBeUndefined();

    appendFileSync(path, line(assistantEntry("f001", "f000")));
    expect(session.getSessionStats()).toEqual({ tokens: { input: 10, output: 5, cacheWrite: 0 } });
  });

  it("is the session file it was given, and steers and aborts through the injected functions", async () => {
    const steer = vi.fn(async (_message: string) => {});
    const abort = vi.fn(async () => {});
    const path = copyFixture();
    const { session } = paneSession(path, { steer, abort });

    expect(session.sessionFile).toBe(path);

    await session.steer("run the tests before you answer");
    expect(steer).toHaveBeenCalledWith("run the tests before you answer");

    await session.abort();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("stops the tail once, however many times it is disposed", () => {
    const { session, tail: t } = paneSession(copyFixture());
    const stop = vi.spyOn(t, "stop");
    t.start();

    session.dispose();
    session.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("disposes a tail that was never started", () => {
    const { session, tail: t } = paneSession(copyFixture());
    const stop = vi.spyOn(t, "stop");

    expect(() => session.dispose()).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("refuses a prompt, because a pane child is resumed by relaunching it", async () => {
    const { session } = paneSession(copyFixture());

    // Never on the pane path — the pane runner's `resume` relaunches the child
    // on the same session file — but the interface requires the member, and
    // failing loudly beats typing into a process that has already exited.
    await expect(session.prompt("more work")).rejects.toThrow(/relaunch/i);
  });
});
