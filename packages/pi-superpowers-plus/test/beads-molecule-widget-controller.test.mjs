import assert from "node:assert/strict";
import { createMoleculeWidgetController } from "../extensions/beads-molecule-widget-controller.mjs";

const raw = (id, current, impl) =>
  JSON.stringify([
    {
      molecule_id: id,
      molecule_title: "superpowers-workflow",
      current_step: { id: `${id}.1`, title: current, status: "in_progress", issue_type: "task" },
      next_step: null,
      steps: [
        {
          issue: { id: `${id}.1`, title: current, issue_type: "task", status: "in_progress" },
          status: "current",
          is_current: true,
        },
        {
          issue: { id: `${id}.2`, title: impl, issue_type: "task", status: "open" },
          status: "pending",
          is_current: false,
        },
      ],
    },
  ]);

const RAW_A = raw("bd-mol-A", "Ask clarifying questions", "Implement A");
const RAW_B = raw("bd-mol-B", "Propose approaches", "Implement B");

function makeFakeUi() {
  const calls = [];
  const ui = {
    theme: undefined,
    setWidget(id, widget, opts) {
      calls.push({ id, widget, opts });
    },
    lastLines(width = 200) {
      const last = [...calls].reverse().find((c) => c.id === "beads-mol");
      if (!last || last.widget === undefined) return null;
      return last.widget({}, ui.theme).render(width);
    },
  };
  return ui;
}

function makeFakeSubscribe() {
  const state = { onChange: null, unsubscribed: 0 };
  return {
    state,
    subscribeChanges(onChange) {
      state.onChange = onChange;
      return () => {
        state.unsubscribed += 1;
        state.onChange = null;
      };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------- bindSession: subscribes once, refreshes and renders ----------
{
  const ui = makeFakeUi();
  const { state, subscribeChanges } = makeFakeSubscribe();
  const calls = [];
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: RAW_A, stderr: "" };
    },
    subscribeChanges,
  });
  controller.bindSession({ ui, cwd: "/repo" });
  await tick();
  assert.equal(typeof state.onChange, "function", "subscribes to changes on bind");
  assert.deepEqual(calls.at(-1), ["bd", "mol", "current", "--json"], "no-id inference on first bind");
  const lines = ui.lastLines();
  assert.ok(
    lines?.some((l) => l.includes("Ask clarifying questions")),
    `rendered frame: ${lines}`,
  );
}

// ---------- race: overlapping refreshes are last-write-wins ----------
{
  const ui = makeFakeUi();
  const resolvers = [];
  const controller = createMoleculeWidgetController({
    exec: (_cmd, args) => new Promise((resolve) => resolvers.push({ args, resolve })),
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo" }); // refresh #1
  const second = controller.refresh(); // refresh #2
  assert.equal(resolvers.length, 2, "two overlapping refreshes issued");
  resolvers[1].resolve({ code: 0, stdout: RAW_B, stderr: "" }); // newest resolves first
  await second;
  resolvers[0].resolve({ code: 0, stdout: RAW_A, stderr: "" }); // older resolves late
  await tick();
  controller.render();
  const lines = ui.lastLines();
  assert.ok(
    lines.some((l) => l.includes("Propose approaches")),
    `newest frame wins: ${lines}`,
  );
  assert.ok(!lines.some((l) => l.includes("Ask clarifying questions")), `stale frame discarded: ${lines}`);
}

// ---------- unbindSession: cancels timer, unsubscribes, resets, discards in-flight ----------
{
  let scheduled = null;
  const timers = {
    setTimeout: (cb, ms) => {
      scheduled = { cb, ms };
      return scheduled;
    },
    clearTimeout: (t) => {
      if (t === scheduled) scheduled = null;
    },
  };
  const ui = makeFakeUi();
  const { state, subscribeChanges } = makeFakeSubscribe();
  const resolvers = [];
  const controller = createMoleculeWidgetController({
    exec: () => new Promise((resolve) => resolvers.push({ resolve })),
    subscribeChanges,
    timers,
  });
  controller.bindSession({ ui, cwd: "/repo" }); // refresh #1 in flight
  state.onChange(); // open a coalescer timer (leading edge fires refresh #2)
  assert.ok(scheduled, "coalescer timer pending");

  controller.unbindSession();
  assert.equal(state.unsubscribed, 1, "unsubscribes on shutdown");
  assert.equal(scheduled, null, "cancels the coalescer timer on shutdown");

  resolvers[0].resolve({ code: 0, stdout: RAW_A, stderr: "" }); // stale resolve after teardown
  await tick();

  const ui2 = makeFakeUi();
  controller.bindSession({ ui: ui2, cwd: "/repo" }); // refresh #3 stays pending
  controller.render();
  assert.equal(ui2.lastLines(), null, "stale in-flight frame is discarded after unbind");
}

// ---------- error matrix ----------
{
  const warns = [];
  const ui = makeFakeUi();
  let call = 0;
  const controller = createMoleculeWidgetController({
    exec: async () => {
      call += 1;
      return call === 1
        ? { code: 0, stdout: RAW_A, stderr: "" }
        : { code: 1, stdout: "", stderr: "connection refused" };
    },
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo" }); // seeds a frame
  await tick();
  const seeded = ui.lastLines();
  assert.ok(
    seeded?.some((l) => l.includes("Ask clarifying questions")),
    `frame seeded before transient failure: ${seeded}`,
  );
  await controller.refresh(); // transient non-zero error
  controller.render();
  const after = ui.lastLines();
  assert.ok(
    after?.some((l) => l.includes("Ask clarifying questions")),
    `transient failure keeps the prior frame: ${after}`,
  );
  assert.equal(warns.length, 1, "transient failure warns and is non-fatal");
}
{
  const warns = [];
  const ui = makeFakeUi();
  let call = 0;
  const controller = createMoleculeWidgetController({
    exec: async () => {
      call += 1;
      return call === 1
        ? { code: 0, stdout: RAW_A, stderr: "" }
        : { code: 1, stdout: "no active molecule", stderr: "" };
    },
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo" }); // seeds a frame
  await tick();
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("Ask clarifying questions")),
    "frame seeded before clean not-found",
  );
  await controller.refresh(); // clean not-found
  controller.render();
  assert.equal(ui.lastLines(), null, "clean not-found clears the frame");
  assert.equal(warns.length, 0, "clean not-found clears silently");
}
{
  const warns = [];
  const ui = makeFakeUi();
  const controller = createMoleculeWidgetController({
    exec: async () => {
      throw new Error("boom");
    },
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo" });
  await tick();
  assert.equal(warns.length, 1, "exec throw warns and is non-fatal");
}
{
  const warns = [];
  const ui = makeFakeUi();
  ui.setWidget = () => {
    throw new Error("no ui");
  };
  const controller = createMoleculeWidgetController({
    exec: async () => ({ code: 0, stdout: RAW_A, stderr: "" }),
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo" });
  await tick();
  assert.equal(warns.length, 1, "render throw warns and is non-fatal");
}

// ---------- setCwd: agent_start per-turn refresh against the new cwd ----------
{
  const ui = makeFakeUi();
  const calls = [];
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { code: 0, stdout: RAW_A, stderr: "" };
    },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo-old" });
  await tick();
  calls.length = 0;
  controller.setCwd("/repo-new");
  await tick();
  controller.render();
  assert.equal(calls.at(-1)?.cwd, "/repo-new", "setCwd refreshes against the new cwd");
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("Ask clarifying questions")),
    "setCwd renders the refreshed frame",
  );
}

// ---------- race (non-zero-code path): stale clean not-found is discarded ----------
{
  const ui = makeFakeUi();
  const resolvers = [];
  const controller = createMoleculeWidgetController({
    exec: (_cmd, args) => new Promise((resolve) => resolvers.push({ args, resolve })),
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo" }); // refresh #1 (older)
  const second = controller.refresh(); // refresh #2 (newer)
  assert.equal(resolvers.length, 2, "two overlapping refreshes issued");
  resolvers[1].resolve({ code: 0, stdout: RAW_B, stderr: "" }); // newest resolves first
  await second;
  resolvers[0].resolve({ code: 1, stdout: "no active molecule", stderr: "" }); // stale clear resolves late
  await tick();
  controller.render();
  const lines = ui.lastLines();
  assert.ok(
    lines.some((l) => l.includes("Propose approaches")),
    `newest frame wins: ${lines}`,
  );
  assert.ok(!lines.some((l) => l.includes("Ask clarifying questions")), `stale clear discarded: ${lines}`);
}

// ---------- bindSession idempotency + triggerChange no-op ----------
{
  let subscribeCount = 0;
  let scheduled = 0;
  const timers = {
    setTimeout: () => {
      scheduled += 1;
      return {};
    },
    clearTimeout: () => {},
  };
  const ui = makeFakeUi();
  const subs = makeFakeSubscribe();
  const controller = createMoleculeWidgetController({
    exec: async () => ({ code: 0, stdout: RAW_A, stderr: "" }),
    subscribeChanges: (onChange) => {
      subscribeCount += 1;
      return subs.subscribeChanges(onChange);
    },
    timers,
  });
  controller.triggerChange(); // before bind: safe no-op
  controller.bindSession({ ui, cwd: "/repo" });
  await tick();
  assert.equal(subscribeCount, 1, "subscribes once on first bind");
  subs.state.onChange(); // leading edge opens a coalescer window
  assert.equal(scheduled, 1, "a change opens a coalescer window");
  controller.bindSession({ ui, cwd: "/repo" }); // second bind must not rebuild
  await tick();
  assert.equal(subscribeCount, 1, "second bind does not double-subscribe");
  subs.state.onChange();
  assert.equal(scheduled, 1, "second bind did not rebuild the coalescer (window still open)");

  controller.unbindSession();
  controller.triggerChange(); // after unbind: safe no-op
  controller.triggerChange();
  assert.equal(subscribeCount, 1, "trigger after unbind is a no-op");
}

// ---------- startup: bindSession/setCwd without a query; first event paints ----------
{
  const ui = makeFakeUi();
  const calls = [];
  const { state, subscribeChanges } = makeFakeSubscribe();
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { code: 0, stdout: RAW_A, stderr: "" };
    },
    subscribeChanges,
  });

  controller.bindSession({ ui, cwd: "/repo", initialRefresh: false });
  await tick();
  assert.equal(calls.length, 0, "bindSession without initialRefresh issues no bd query");
  assert.equal(ui.lastLines(), null, "nothing painted before an event");
  assert.equal(typeof state.onChange, "function", "still subscribes to changes");

  controller.setCwd("/repo-2", { refresh: false });
  await tick();
  assert.equal(calls.length, 0, "setCwd without refresh issues no bd query");

  state.onChange();
  await tick();
  assert.equal(calls.length, 1, "the first change issues exactly one bd query");
  assert.equal(calls.at(-1)?.cwd, "/repo-2", "refresh uses the latest cwd");
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("Ask clarifying questions")),
    "the first change paints the frame",
  );

  controller.unbindSession();
}

const rawFinished = (id) =>
  JSON.stringify([
    {
      molecule_id: id,
      molecule_title: "superpowers-workflow",
      current_step: null,
      next_step: null,
      steps: [
        {
          issue: { id: `${id}.1`, title: "Finish", issue_type: "task", status: "closed" },
          status: "done",
          is_current: false,
        },
      ],
    },
  ]);
const roots = (entries) => JSON.stringify(entries.map((e) => ({ issue_type: "molecule", ...e })));

// ---------- workspace: one root -> by-id query ----------
{
  const ui = makeFakeUi();
  const calls = [];
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "list")
        return { code: 0, stdout: roots([{ id: "bd-mol-A", updated_at: "2026-01-01" }]), stderr: "" };
      return { code: 0, stdout: RAW_A, stderr: "" };
    },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.deepEqual(calls[0], ["bd", "list", "--type", "molecule", "--label", "ws:k1", "--json"]);
  assert.deepEqual(calls[1], ["bd", "mol", "current", "bd-mol-A", "--json"]);
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("Ask clarifying questions")),
    `rendered: ${ui.lastLines()}`,
  );
}

// ---------- workspace: several roots -> active beats finished ----------
{
  const ui = makeFakeUi();
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      if (args[0] === "list")
        return {
          code: 0,
          stdout: roots([
            { id: "bd-mol-A", updated_at: "2026-02-01" },
            { id: "bd-mol-B", updated_at: "2026-01-01" },
          ]),
          stderr: "",
        };
      if (args[2] === "bd-mol-A") return { code: 0, stdout: rawFinished("bd-mol-A"), stderr: "" };
      return { code: 0, stdout: RAW_B, stderr: "" };
    },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("Propose approaches")),
    `active wins: ${ui.lastLines()}`,
  );
}

// ---------- workspace: no roots + one global candidate -> adopt ----------
{
  const ui = makeFakeUi();
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      if (args[0] === "list") return { code: 0, stdout: "[]", stderr: "" };
      return { code: 0, stdout: RAW_A, stderr: "" };
    },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.ok(ui.lastLines()?.some((l) => l.includes("Ask clarifying questions")));
}

// ---------- workspace: no roots + two global candidates -> clear ----------
{
  const ui = makeFakeUi();
  const two = JSON.stringify([...JSON.parse(RAW_A), ...JSON.parse(RAW_B)]);
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) =>
      args[0] === "list" ? { code: 0, stdout: "[]", stderr: "" } : { code: 0, stdout: two, stderr: "" },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.equal(ui.lastLines(), null, "ambiguous global fallback clears rather than guessing");
}

// ---------- workspace: lock held -> list skipped ----------
{
  const ui = makeFakeUi();
  const calls = [];
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "list")
        return { code: 0, stdout: roots([{ id: "bd-mol-A", updated_at: "2026-01-01" }]), stderr: "" };
      return { code: 0, stdout: RAW_A, stderr: "" };
    },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  calls.length = 0;
  await controller.refresh();
  assert.deepEqual(calls, [["bd", "mol", "current", "bd-mol-A", "--json"]], "locked refresh skips list");
}

// ---------- workspace: key change resets frame + lock ----------
{
  const ui = makeFakeUi();
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      if (args[0] === "list") {
        const isK2 = args.includes("ws:k2");
        return {
          code: 0,
          stdout: roots([{ id: isK2 ? "bd-mol-B" : "bd-mol-A", updated_at: "2026-01-01" }]),
          stderr: "",
        };
      }
      return { code: 0, stdout: args[2] === "bd-mol-B" ? RAW_B : RAW_A, stderr: "" };
    },
    subscribeChanges: () => () => {},
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.ok(ui.lastLines()?.some((l) => l.includes("Ask clarifying questions")));
  controller.setCwd("/repo2", { workspaceKey: "k2" });
  await tick();
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("Propose approaches")),
    `key change re-resolves: ${ui.lastLines()}`,
  );
}

// ---------- workspace: transient list error retains the finished frame ----------
{
  const warns = [];
  const ui = makeFakeUi();
  let listCall = 0;
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) => {
      if (args[0] === "list") {
        listCall += 1;
        if (listCall === 1)
          return { code: 0, stdout: roots([{ id: "bd-mol-A", updated_at: "2026-01-01" }]), stderr: "" };
        return { code: 1, stdout: "", stderr: "connection refused" };
      }
      return { code: 0, stdout: rawFinished("bd-mol-A"), stderr: "" };
    },
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("finished")),
    "finished frame seeded",
  );
  await controller.refresh(); // lock was dropped by the finished frame -> list runs
  controller.render();
  assert.ok(
    ui.lastLines()?.some((l) => l.includes("finished")),
    "transient list error keeps the prior frame",
  );
  assert.equal(warns.length, 1, "transient list error warns once");
}

// ---------- workspace: clean not-found list clears silently ----------
{
  const warns = [];
  const ui = makeFakeUi();
  const controller = createMoleculeWidgetController({
    exec: async (cmd, args) =>
      args[0] === "list"
        ? { code: 1, stdout: "no beads database found", stderr: "" }
        : { code: 0, stdout: RAW_A, stderr: "" },
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo", workspaceKey: "k1" });
  await tick();
  assert.equal(ui.lastLines(), null, "clean not-found clears");
  assert.equal(warns.length, 0, "clean not-found clears silently");
}

console.log("beads-molecule-widget-controller: all assertions passed");
