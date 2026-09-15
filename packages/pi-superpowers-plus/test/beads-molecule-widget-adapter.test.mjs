// Adapter wiring test for the pi-facing seam in beads-molecule-widget.ts.
// Node strips the TS types; the adapter's only pi import is `import type`, erased.
import assert from "node:assert/strict";
import widget from "../extensions/beads-molecule-widget.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const RAW = JSON.stringify([
  {
    molecule_id: "bd-mol-A",
    molecule_title: "superpowers-workflow",
    current_step: { id: "bd-mol-A.1", title: "Ask clarifying questions", status: "in_progress", issue_type: "task" },
    next_step: null,
    steps: [
      {
        issue: { id: "bd-mol-A.1", title: "Ask clarifying questions", issue_type: "task", status: "in_progress" },
        status: "current",
        is_current: true,
      },
    ],
  },
]);

function makeFakePi() {
  const handlers = {};
  const subs = {};
  const offCounts = {};
  const execCalls = [];
  const pi = {
    on: (ev, fn) => {
      if (!handlers[ev]) handlers[ev] = [];
      handlers[ev].push(fn);
    },
    events: {
      on: (name, cb) => {
        if (!subs[name]) subs[name] = [];
        subs[name].push(cb);
        return () => {
          offCounts[name] = (offCounts[name] ?? 0) + 1;
        };
      },
    },
    exec: async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      if (cmd === "git") return { code: 0, stdout: "/repo\n", stderr: "" };
      return { code: 0, stdout: RAW, stderr: "" };
    },
  };
  return { pi, handlers, subs, offCounts, execCalls };
}

const bdCalls = (execCalls) => execCalls.filter((c) => c[0] === "bd");

// ---------- subscribes to both change sources ----------
{
  const { pi, handlers, subs } = makeFakePi();
  widget(pi);
  // Subscriptions are installed when a session is bound (the controller's
  // subscribeChanges is only invoked from bindSession).
  await handlers.session_start[0]({}, { cwd: "/repo", ui: { setWidget() {} } });
  assert.equal(subs["beads:changed"]?.length, 1, "subscribes to beads:changed");
  assert.equal(subs["superpowers:phase"]?.length, 1, "subscribes to superpowers:phase");
}

// ---------- non-empty phase refreshes ----------
{
  // A fresh controller is used for each phase case: the coalescer fires the
  // first change immediately, so a shared instance would mask a later event.
  const { pi, handlers, subs, execCalls } = makeFakePi();
  widget(pi);
  await handlers.session_start[0]({}, { cwd: "/repo", ui: { setWidget() {} } });
  await tick();
  execCalls.length = 0; // drop the session_start git probe

  subs["superpowers:phase"][0]({ phase: "development" });
  await tick();
  await tick();
  assert.ok(bdCalls(execCalls).length >= 1, `non-empty phase triggers a refresh; got ${JSON.stringify(execCalls)}`);
}

// ---------- empty phase does not refresh ----------
{
  const { pi, handlers, subs, execCalls } = makeFakePi();
  widget(pi);
  await handlers.session_start[0]({}, { cwd: "/repo", ui: { setWidget() {} } });
  await tick();
  execCalls.length = 0; // drop the session_start git probe

  subs["superpowers:phase"][0]({ phase: "" });
  await tick();
  await tick();
  assert.equal(bdCalls(execCalls).length, 0, "empty phase must not trigger a refresh");
}

// ---------- session_shutdown unsubscribes both listeners ----------
{
  const { pi, handlers, offCounts } = makeFakePi();
  widget(pi);
  await handlers.session_start[0]({}, { cwd: "/repo", ui: { setWidget() {} } });
  handlers.session_shutdown[0]();
  assert.equal(offCounts["beads:changed"], 1, "beads:changed unsubscribed on shutdown");
  assert.equal(offCounts["superpowers:phase"], 1, "superpowers:phase unsubscribed on shutdown");
}

console.log("\nbeads-molecule-widget-adapter: all assertions passed");
