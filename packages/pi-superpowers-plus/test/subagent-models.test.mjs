import assert from "node:assert/strict";
import {
  applyModelOverride,
  mergeModelsConfig,
  modelForCall,
  parseModelsConfig,
  SUPPORTED_TYPES,
} from "../extensions/subagent-models.mjs";

assert.deepEqual(
  SUPPORTED_TYPES,
  ["implementer", "task-reviewer", "code-reviewer", "verifier", "worker", "explore"],
  "supported types",
);

// parseModelsConfig: malformed input never throws
assert.deepEqual(parseModelsConfig(""), {}, "empty -> {}");
assert.deepEqual(parseModelsConfig("{not json"), {}, "malformed JSON -> {}");
assert.deepEqual(parseModelsConfig(JSON.stringify({ models: ["x"] })), {}, "non-object models -> {}");
assert.deepEqual(
  parseModelsConfig(JSON.stringify({ models: { EXPLORE: "m", implementer: "s", bogus: "x", worker: "" } })),
  { implementer: "s" },
  "keeps supported non-empty string types only",
);
assert.deepEqual(
  parseModelsConfig(JSON.stringify({ models: { explore: "s" }, extra: true })),
  { explore: "s" },
  "ignores extra top-level keys",
);

// mergeModelsConfig: project wins per key
assert.deepEqual(mergeModelsConfig({ implementer: "a", worker: "b" }, { implementer: "c" }), {
  implementer: "c",
  worker: "b",
});
assert.deepEqual(mergeModelsConfig(undefined, undefined), {}, "both absent -> {}");

// modelForCall
assert.equal(modelForCall({ config: { explore: "s" }, subagentType: "Explore" }), "s", "case-insensitive type");
assert.equal(modelForCall({ config: { explore: "s" }, subagentType: " explore " }), "s", "trims type");
assert.equal(
  modelForCall({ config: { explore: "s" }, subagentType: "explore", currentModel: "x" }),
  undefined,
  "caller model wins",
);
assert.equal(modelForCall({ config: {}, subagentType: "explore" }), undefined, "unconfigured type");
assert.equal(modelForCall({ config: { explore: "s" }, subagentType: "general-purpose" }), undefined, "unknown type");

// applyModelOverride mutates only Agent calls, only when configured
const mk = () => ({ toolName: "Agent", input: { subagent_type: "explore" } });
let ev = mk();
applyModelOverride(ev, { explore: "s" });
assert.equal(ev.input.model, "s", "injects for Agent");
ev = mk();
ev.input.model = "existing";
applyModelOverride(ev, { explore: "s" });
assert.equal(ev.input.model, "existing", "preserves caller model");
ev = mk();
applyModelOverride(ev, {});
assert.equal(ev.input.model, undefined, "no-op when unconfigured");
ev = { toolName: "bash", input: { command: "ls" } };
applyModelOverride(ev, { explore: "s" });
assert.equal(ev.input.model, undefined, "ignores non-Agent tools");
console.log("subagent-models: all assertions passed");
