import test from "node:test";
import assert from "node:assert/strict";

import { createPayloadLimits, parseLimit, DEFAULT_LIMITS } from "../src/limits.ts";
import { shapePayload } from "../src/utils.ts";
import { redactValue } from "../src/redaction.ts";

test("createPayloadLimits returns the built-in defaults when env is empty", () => {
  assert.deepEqual(createPayloadLimits({}), DEFAULT_LIMITS);
});

test("createPayloadLimits reads every PI_LANGFUSE_MAX_* override", () => {
  const limits = createPayloadLimits({
    PI_LANGFUSE_MAX_STRING_LENGTH: "500",
    PI_LANGFUSE_MAX_TOOL_PAYLOAD_LENGTH: "1000",
    PI_LANGFUSE_MAX_DEPTH: "3",
    PI_LANGFUSE_MAX_ARRAY_ITEMS: "10",
    PI_LANGFUSE_MAX_OBJECT_KEYS: "20",
    PI_LANGFUSE_MAX_PAYLOAD_NODES: "100",
  });
  assert.deepEqual(limits, {
    maxString: 500,
    maxToolPayload: 1000,
    maxDepth: 3,
    maxArrayItems: 10,
    maxObjectKeys: 20,
    maxNodes: 100,
  });
});

test("a limit set to 0 / off / unlimited / negative is removed (Infinity)", () => {
  for (const value of ["0", "off", "none", "false", "no", "unlimited", "infinity", "-1", "-42"]) {
    assert.equal(
      createPayloadLimits({ PI_LANGFUSE_MAX_STRING_LENGTH: value }).maxString,
      Number.POSITIVE_INFINITY,
      `value ${JSON.stringify(value)} should disable the limit`,
    );
  }
});

test("blank or unparseable env falls back to the default", () => {
  assert.equal(createPayloadLimits({ PI_LANGFUSE_MAX_DEPTH: "" }).maxDepth, DEFAULT_LIMITS.maxDepth);
  assert.equal(createPayloadLimits({ PI_LANGFUSE_MAX_DEPTH: "   " }).maxDepth, DEFAULT_LIMITS.maxDepth);
  assert.equal(createPayloadLimits({ PI_LANGFUSE_MAX_DEPTH: "abc" }).maxDepth, DEFAULT_LIMITS.maxDepth);
});

test("parseLimit floors fractional positives", () => {
  assert.equal(parseLimit("12.9", 5), 12);
});

test("shapePayload keeps the default array cap, and honors an override that removes it", () => {
  const arr = Array.from({ length: 120 }, (_, index) => index);

  const capped = shapePayload(arr) as unknown[];
  assert.equal(capped.length, DEFAULT_LIMITS.maxArrayItems, "default caps arrays at 50");

  const uncapped = shapePayload(arr, { maxArrayItems: Number.POSITIVE_INFINITY }) as unknown[];
  assert.equal(uncapped.length, 120, "an unlimited maxArrayItems keeps every element");
});

test("shapePayload honors an overridden maxObjectKeys", () => {
  const obj: Record<string, number> = Object.create(null);
  for (let index = 0; index < 200; index++) {
    obj[`k${index}`] = index;
  }

  const uncapped = shapePayload(obj, { maxObjectKeys: Number.POSITIVE_INFINITY }) as Record<string, number>;
  assert.equal(Object.keys(uncapped).length, 200);
});

test("shapePayload honors an overridden maxString (no truncation when unlimited)", () => {
  const big = "x".repeat(50_000);
  const shaped = shapePayload(big, { maxString: Number.POSITIVE_INFINITY, parseJson: false }) as string;
  assert.equal(shaped.length, 50_000);
  assert.ok(!shaped.includes("[truncated]"));
});

test("redaction defaults follow the configurable maxString (system-prompt regression)", () => {
  // The capture pipeline calls redactValue() with no options for systemPrompt,
  // input, output and tool IO; its defaults must track the resolved limits, or
  // the system prompt gets clipped at the old hardcoded 12000 regardless of env.
  const big = "s".repeat(30000);
  const saved = process.env.PI_LANGFUSE_MAX_STRING_LENGTH;
  const marker = "... [truncated]".length;
  try {
    delete process.env.PI_LANGFUSE_MAX_STRING_LENGTH;
    assert.equal((redactValue(big) as string).length, DEFAULT_LIMITS.maxString + marker, "default clips at 12000");

    process.env.PI_LANGFUSE_MAX_STRING_LENGTH = "off";
    assert.equal((redactValue(big) as string).length, 30000, "off keeps the full string");
  } finally {
    if (saved === undefined) {
      delete process.env.PI_LANGFUSE_MAX_STRING_LENGTH;
    } else {
      process.env.PI_LANGFUSE_MAX_STRING_LENGTH = saved;
    }
  }
});
