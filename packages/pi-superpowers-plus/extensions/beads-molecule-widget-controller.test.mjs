import assert from "node:assert/strict";
import { createMoleculeWidgetController } from "./beads-molecule-widget-controller.mjs";

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
  assert.ok(lines && lines.some((l) => l.includes("Ask clarifying questions")), `rendered frame: ${lines}`);
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
  const controller = createMoleculeWidgetController({
    exec: async () => ({ code: 1, stdout: "", stderr: "connection refused" }),
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo" });
  await tick();
  assert.equal(warns.length, 1, "transient failure warns and is non-fatal");
}
{
  const warns = [];
  const ui = makeFakeUi();
  const controller = createMoleculeWidgetController({
    exec: async () => ({ code: 1, stdout: "no active molecule", stderr: "" }),
    subscribeChanges: () => () => {},
    warn: (...a) => warns.push(a),
  });
  controller.bindSession({ ui, cwd: "/repo" });
  await tick();
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

console.log("beads-molecule-widget-controller: all assertions passed");
