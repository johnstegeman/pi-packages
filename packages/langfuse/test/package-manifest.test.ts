import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootManifest = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };

test("monorepo root installs Langfuse runtime dependencies for its registered extension", () => {
  for (const dependency of [
    "@langfuse/client",
    "@langfuse/otel",
    "@langfuse/tracing",
    "@opentelemetry/api",
    "@opentelemetry/context-async-hooks",
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace-base",
  ]) {
    assert.ok(rootManifest.dependencies?.[dependency], `${dependency} must be a root dependency`);
  }
});
