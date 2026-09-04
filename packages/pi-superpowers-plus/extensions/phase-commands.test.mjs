import assert from "node:assert/strict";

// ---------- fake pi capturing the "input" transform handler ----------
const handlers = [];
let lastEditorText = "";
const fakePi = {
  on(ev, h) {
    if (ev === "input") handlers.push(h);
  },
  events: { emit() {}, on() {} },
};
const setup = (await import("./phase-commands.mjs")).default;
setup(fakePi);

assert.equal(handlers.length, 1, "setup must register exactly one input handler");
const input = handlers[0];

const ctx = { hasUI: true, ui: { setEditorText: (t) => (lastEditorText = t), notify() {} } };

// ---------- command table: phase commands transform to /skill:<name> ----------
const CASES = [
  ["/brainstorming", "/skill:brainstorming"],
  ["/brainstorm", "/skill:brainstorming"],
  ["/plan", "/skill:writing-plans"],
  ["/verify", "/skill:verification-before-completion"],
  ["/review", "/skill:requesting-code-review"],
  ["/finish", "/skill:finishing-a-development-branch"],
];
for (const [typed, target] of CASES) {
  const out = await input({ source: "interactive", text: typed }, ctx);
  assert.deepEqual(out, { action: "transform", text: target }, `transform: ${typed}`);
}

// ---------- args preserved (/brainstorm build a chat app) ----------
assert.deepEqual(await input({ source: "interactive", text: "/brainstorm build a chat app" }, ctx), {
  action: "transform",
  text: "/skill:brainstorming build a chat app",
});

// ---------- /execute: handled, presents both execution options in the editor ----------
lastEditorText = "";
const execOut = await input({ source: "interactive", text: "/execute" }, ctx);
assert.equal(execOut.action, "handled");
assert.ok(
  lastEditorText.includes("/skill:subagent-driven-development"),
  "/execute editor text must mention subagent-driven-development",
);
assert.ok(lastEditorText.includes("/skill:executing-plans"), "/execute editor text must mention executing-plans");

// ---------- /execute without UI still handled (never crashes) ----------
assert.equal((await input({ source: "interactive", text: "/execute" }, { hasUI: false })).action, "handled");

// ---------- non-command input passes through ----------
assert.deepEqual(await input({ source: "interactive", text: "hello" }, ctx), { action: "continue" });
assert.deepEqual(await input({ source: "interactive", text: "" }, ctx), { action: "continue" });

// ---------- extension-sourced input is skipped entirely ----------
assert.deepEqual(await input({ source: "extension", text: "/plan" }, ctx), { action: "continue" });

console.log("phase-commands.test.mjs: all assertions passed");
