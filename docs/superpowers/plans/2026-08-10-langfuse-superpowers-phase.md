# Langfuse Superpowers Phase Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/skill:subagent-driven-development` (recommended) or `/skill:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor `pi-langfuse` as `packages/langfuse/` under the identity `pi-langfuse-plus`, and attach the current Superpowers workflow phase to Langfuse root agent and generation observations.

**Architecture:** Copy the upstream extension from the pinned commit `c79c527a7294e1d4b8153525d5218e87354cbcb1` into a trimmed monorepo package. Add a small module-global phase tracker modeled on bifrost, register a `superpowers:phase` event listener, and spread a `superpowers_phase` metadata fragment into root-agent and generation observation metadata at creation/update time.

**Tech Stack:** TypeScript ESM, Node.js >=22, `tsx`, `node:test`, Langfuse SDK, OpenTelemetry, TypeScript `NodeNext` module resolution.

## Global Constraints

- Package directory: `packages/langfuse/`.
- NPM package name: `pi-langfuse-plus`, version `0.1.0`.
- Upstream source commit: `c79c527a7294e1d4b8153525d5218e87354cbcb1` (tag `v1.5.12`).
- Preserve upstream runtime dependencies; do not move Langfuse/OpenTelemetry dependencies to devDependencies.
- Do not vendor upstream CN docs, `.agents/skills/langfuse/`, publish workflow, deployment/development docs, image, or `skills-lock.json`.
- Metadata key is exactly `superpowers_phase`.
- Attach phase metadata to the root agent observation at both start and finish, and to every generation observation at generation start.
- Empty, whitespace-only, `null`, or `undefined` phase values clear the retained value; cleared metadata is omitted rather than sent as an empty string.
- Keep the retained phase in module memory only; do not persist it or add a session-id requirement.
- Do not commit `node_modules/` or `package-lock.json`.

---

### Task 1: Vendor the pinned upstream extension

**Files:**

- Create: `packages/langfuse/index.ts`
- Create: `packages/langfuse/src/**`
- Create: `packages/langfuse/types/**`
- Create: `packages/langfuse/test/**`, including `test/fixtures/stalled-shutdown-child.ts`
- Create: `packages/langfuse/package.json`
- Create: `packages/langfuse/tsconfig.json`

**Interfaces:**

- Consumes: upstream repository `https://github.com/gooyoung/pi-langfuse` at commit `c79c527a7294e1d4b8153525d5218e87354cbcb1`.
- Produces: a complete trimmed upstream extension with the original behavior intact and 13 upstream test files.

- [ ] **Step 1: Fetch the exact upstream commit**

```bash
rm -rf /tmp/pi-langfuse-upstream
 git clone --no-checkout https://github.com/gooyoung/pi-langfuse.git /tmp/pi-langfuse-upstream
 git -C /tmp/pi-langfuse-upstream checkout c79c527a7294e1d4b8153525d5218e87354cbcb1
```

Expected: `git -C /tmp/pi-langfuse-upstream rev-parse HEAD` prints exactly `c79c527a7294e1d4b8153525d5218e87354cbcb1`.

- [ ] **Step 2: Copy only the approved vendored file set**

```bash
mkdir -p packages/langfuse
cp /tmp/pi-langfuse-upstream/index.ts packages/langfuse/
cp -R /tmp/pi-langfuse-upstream/src packages/langfuse/
cp -R /tmp/pi-langfuse-upstream/types packages/langfuse/
cp -R /tmp/pi-langfuse-upstream/test packages/langfuse/
cp /tmp/pi-langfuse-upstream/package.json packages/langfuse/
cp /tmp/pi-langfuse-upstream/tsconfig.json packages/langfuse/
```

The resulting package must contain the upstream `src/` handlers and utilities, all 13 `test/*.test.ts` files, the fixture directory, the three type shims, `index.ts`, `package.json`, and `tsconfig.json`. It must not contain `README_CN.md`, `DEPLOY.md`, `DEVELOPMENT*.md`, `.agents/`, `.github/`, `image.png`, or `skills-lock.json`.

- [ ] **Step 3: Establish the untouched upstream test baseline**

Run:

```bash
cd packages/langfuse
npm install --no-audit --no-fund
npm test
```

Expected: 71 tests pass, 0 fail. The generated `node_modules/` and `package-lock.json` remain ignored and uncommitted.

- [ ] **Step 4: Commit the vendored baseline**

```bash
git add packages/langfuse
git commit -m "vendor: add pi-langfuse v1.5.12"
```

---

### Task 2: Give the package its monorepo identity and registration

**Files:**

- Modify: `packages/langfuse/package.json`
- Modify: `package.json:11-18`

**Interfaces:**

- Consumes: the vendored upstream package from Task 1.
- Produces: package name `pi-langfuse-plus`, local `pi` manifest, test/typecheck scripts, and root extension registration.

- [ ] **Step 1: Replace the upstream package manifest with the monorepo manifest**

Write `packages/langfuse/package.json` with this content:

```json
{
  "name": "pi-langfuse-plus",
  "version": "0.1.0",
  "description": "Langfuse extension for Pi coding agent with Superpowers phase metadata",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/johnstegeman/pi-packages.git"
  },
  "type": "module",
  "main": "index.ts",
  "files": [
    "index.ts",
    "src/",
    "types/",
    "tsconfig.json",
    "README.md"
  ],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "keywords": [
    "pi-package",
    "langfuse",
    "observability",
    "tracing",
    "monitoring",
    "pi-coding-agent",
    "extension"
  ],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "@langfuse/client": "^5.3.0",
    "@langfuse/otel": "^5.3.0",
    "@langfuse/tracing": "^5.3.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/context-async-hooks": "^2.7.1",
    "@opentelemetry/sdk-node": "^0.218.0",
    "@opentelemetry/sdk-trace-base": "^2.0.1"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "license": "MIT",
  "engines": {
    "node": ">=22"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^6.0.3"
  }
}
```

This removes upstream-only `bugs`, `homepage`, `packageManager`, image manifest data, and publish configuration while retaining all Langfuse/OpenTelemetry runtime dependencies.

- [ ] **Step 2: Register the extension in the root manifest**

Add the following final entry to the root `pi.extensions` array in `package.json`:

```json
"./packages/langfuse/index.ts"
```

The resulting array contains bifrost, statusline, hashline-edit, and langfuse entries; do not alter the theme registration.

- [ ] **Step 3: Reinstall and verify the package identity changes**

```bash
cd packages/langfuse
npm install --no-audit --no-fund
npm run typecheck
npm test
```

Expected: typecheck succeeds and all 71 upstream tests pass.

- [ ] **Step 4: Commit package registration**

```bash
git add package.json packages/langfuse/package.json
git commit -m "chore: align pi-langfuse-plus with monorepo"
```

---

### Task 3: Add the phase tracker with tests first

**Files:**

- Create: `packages/langfuse/test/phase-tracker.test.ts`
- Create: `packages/langfuse/src/phase.ts`

**Interfaces:**

- Produces `applyPhaseUpdate(_current: string | null, incoming: string | null | undefined): string | null`.
- Produces `setPhase(incoming: string | null | undefined): void`.
- Produces `buildPhaseMetadata(): Record<string, string>`.
- Relative imports use `.js` suffixes because the package uses TypeScript `NodeNext` resolution.

- [ ] **Step 1: Write the failing phase-tracker test**

Create `packages/langfuse/test/phase-tracker.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { applyPhaseUpdate, buildPhaseMetadata, setPhase } from "../src/phase.js";

test("non-empty string is retained", () => {
  assert.equal(applyPhaseUpdate(null, "brainstorming"), "brainstorming");
});

test("empty string clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", ""), null);
});

test("null clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", null), null);
});

test("undefined clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", undefined), null);
});

test("whitespace-only string clears the retained phase", () => {
  assert.equal(applyPhaseUpdate("brainstorming", "  "), null);
});

test("retained value is replaced by a new non-empty phase", () => {
  assert.equal(applyPhaseUpdate("old", "new"), "new");
});

test("buildPhaseMetadata returns the phase fragment when retained", () => {
  setPhase("development");
  assert.deepEqual(buildPhaseMetadata(), { superpowers_phase: "development" });
});

test("buildPhaseMetadata returns {} when cleared", () => {
  setPhase(null);
  assert.deepEqual(buildPhaseMetadata(), {});
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd packages/langfuse
node --import tsx --test test/phase-tracker.test.ts
```

Expected: FAIL because `../src/phase.js` does not resolve before `src/phase.ts` exists.

- [ ] **Step 3: Implement the minimal phase module**

Create `packages/langfuse/src/phase.ts`:

```ts
/**
 * Reduce a Superpowers phase update using the same semantics as bifrost.
 * Whitespace is checked only for emptiness; a non-empty value is retained
 * verbatim.
 */
export function applyPhaseUpdate(
  _current: string | null,
  incoming: string | null | undefined,
): string | null {
  return incoming && incoming.trim() !== "" ? incoming : null;
}

let retainedPhase: string | null = null;

export function setPhase(incoming: string | null | undefined): void {
  retainedPhase = applyPhaseUpdate(retainedPhase, incoming);
}

/** Return the metadata fragment to spread into Langfuse observations. */
export function buildPhaseMetadata(): Record<string, string> {
  return retainedPhase ? { superpowers_phase: retainedPhase } : {};
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

```bash
cd packages/langfuse
node --import tsx --test test/phase-tracker.test.ts
```

Expected: all 8 phase tests pass.

- [ ] **Step 5: Commit the phase tracker**

```bash
git add packages/langfuse/src/phase.ts packages/langfuse/test/phase-tracker.test.ts
git commit -m "feat: track superpowers phase for langfuse"
```

---

### Task 4: Wire phase events and observation metadata

**Files:**

- Modify: `packages/langfuse/types/pi-coding-agent.d.ts`
- Modify: `packages/langfuse/index.ts`
- Modify: `packages/langfuse/src/handlers/agent.ts:1-8,63-73,165-177`
- Modify: `packages/langfuse/src/handlers/generation.ts:1-16,46-51`

**Interfaces:**

- Consumes `setPhase()` and `buildPhaseMetadata()` from `src/phase.ts`.
- Produces event-driven phase retention and `superpowers_phase` on root and generation metadata.

- [ ] **Step 1: Extend the local pi API shim for the event bus**

The upstream shim does not declare `ExtensionAPI.events`, so add this interface and property to `types/pi-coding-agent.d.ts`:

```ts
export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
```

Add this property to `ExtensionAPI`:

```ts
events: EventBus;
```

Keep the existing `on`, `registerCommand`, and `ExtensionContext` declarations unchanged.

- [ ] **Step 2: Register the Superpowers phase listener**

In `index.ts`, add:

```ts
import { setPhase } from "./src/phase.js";
```

After the existing command registrations and before the lifecycle `pi.on("session_start", ...)` registrations, add:

```ts
  // ---- Superpowers phase tracking -----------------------------------------
  // Superpowers emits { phase } on this shared event bus. Retain the latest
  // non-empty value for live metadata attachment on Langfuse observations.
  pi.events.on("superpowers:phase", (data) => {
    const phase =
      typeof data === "object" && data !== null && "phase" in data
        ? (data as { phase: unknown }).phase
        : undefined;
    setPhase(typeof phase === "string" ? phase : null);
  });
```

Malformed payloads therefore clear the phase rather than passing an unknown value into metadata.

- [ ] **Step 3: Attach phase metadata to root agent observations**

In `src/handlers/agent.ts`, add:

```ts
import { buildPhaseMetadata } from "../phase.js";
```

alongside the existing imports. In `startAgentRun`, change the metadata object to:

```ts
        metadata: {
          cwd,
          ...sourceMetadata,
          ...buildPhaseMetadata(),
          ...(state.currentModel ? { model: state.currentModel } : {}),
          ...(state.currentProvider ? { provider: state.currentProvider } : {}),
          sessionId: state.currentSessionId || undefined,
        },
```

In `finishAgentRun`, change the metadata object to:

```ts
      metadata: {
        cwd: state.agentState.cwd,
        ...(state.agentState.sourceMetadata ?? {}),
        ...buildPhaseMetadata(),
        completed: true,
        model: state.currentModel || undefined,
        provider: state.currentProvider || undefined,
        totalTools: state.toolCallCount,
        ...computeEvaluationScores(),
      },
```

Both values remain inside the existing `applyCapturePolicy` path, just like git source metadata.

- [ ] **Step 4: Attach phase metadata to each generation**

In `src/handlers/generation.ts`, add:

```ts
import { buildPhaseMetadata } from "../phase.js";
```

with the existing imports. In `startGeneration`, add the live phase fragment to the metadata payload:

```ts
    const metadata = shapePayload({
      provider,
      ...buildPhaseMetadata(),
      requestId: key,
      url: event.url,
      method: event.method,
    }) as Record<string, unknown>;
```

Do not add phase metadata to tool or turn observations, and do not update a generation's phase at response time; the generation records the phase active when its provider request starts.

- [ ] **Step 5: Run typecheck and the complete package suite**

```bash
cd packages/langfuse
npm run typecheck
npm test
```

Expected: typecheck succeeds; the 71 upstream tests and all phase-tracker tests pass. Verify that clearing the phase produces `{}` through the focused test and that no existing upstream test behavior changes.

- [ ] **Step 6: Commit the integration**

```bash
git add packages/langfuse/types/pi-coding-agent.d.ts packages/langfuse/index.ts packages/langfuse/src/handlers/agent.ts packages/langfuse/src/handlers/generation.ts
git commit -m "feat: add superpowers phase to langfuse observations"
```

---

### Task 5: Add package and repository documentation, then verify all packages

**Files:**

- Create: `packages/langfuse/README.md`
- Modify: `README.md` package list and local-install examples
- Modify: `AGENTS.md` repo layout and runtime-dependency test note

**Interfaces:**

- Documents package setup, privacy behavior, phase metadata, provenance, and test commands.
- Does not alter extension runtime behavior.

- [ ] **Step 1: Write the package README**

Create `packages/langfuse/README.md` with these sections and concrete information:

````markdown
# pi-langfuse-plus

Langfuse observability for Pi coding agent, vendored from `gooyoung/pi-langfuse`
and extended with Superpowers workflow phase metadata.

## Install

From this monorepo:

```bash
pi install ./packages/langfuse
```

This package has runtime Langfuse/OpenTelemetry dependencies. For local tests:

```bash
cd packages/langfuse
npm install
npm test
npm run typecheck
```

## Configure

Run `/langfuse-setup` inside Pi, or set the required credentials in the environment:

- `LANGFUSE_PUBLIC_KEY` — required public key.
- `LANGFUSE_SECRET_KEY` — required secret key.
- `LANGFUSE_BASE_URL` or `LANGFUSE_HOST` — optional host, defaulting to `https://cloud.langfuse.com`.

Optional environment controls include `LANGFUSE_PRIVACY_PRESET`, `LANGFUSE_CAPTURE_INPUTS`, `LANGFUSE_CAPTURE_OUTPUTS`, `LANGFUSE_CAPTURE_TOOL_IO`, `LANGFUSE_CAPTURE_SYSTEM_PROMPT`, and `LANGFUSE_CAPTURE_CWD`. Use `/langfuse-status` to inspect configuration and `/langfuse-privacy` to view or change the capture preset.

## Superpowers phase metadata

The extension listens for `superpowers:phase` events and retains the latest
non-empty phase in memory. It writes that phase under the `superpowers_phase`
metadata key on the root agent observation at start and finish, and on every
LLM generation observation at request start. Clearing the phase omits the key;
no phase is persisted. The value follows the same capture-policy path as the
extension's git source metadata.

## Upstream provenance

This is a trimmed monorepo vendoring of `gooyoung/pi-langfuse` at commit
`c79c527a7294e1d4b8153525d5218e87354cbcb1` (v1.5.12, 2026-08-10).
To re-sync upstream behavior, compare the package against that commit before
preserving the local phase-tracking changes.
````


- [ ] **Step 2: Update the root README package list**

Add a `langfuse/` entry to the root package tree, describing it as Langfuse observability with Superpowers phase metadata. Add a matching example beside the existing `ayu` and `bifrost` local-install examples:

```bash
pi install /path/to/pi-packages/packages/langfuse
```

- [ ] **Step 3: Update AGENTS.md**

Add `langfuse/` to the documented package layout. Add a short note under test guidance that `packages/langfuse` has runtime dependencies and must run `npm install` inside the package before `npm test`; do not claim the root workspace installs those dependencies.

- [ ] **Step 4: Run final verification**

Run the new package checks:

```bash
cd packages/langfuse
npm run typecheck
npm test
```

Then run the existing package suites from their package directories:

```bash
cd ../bifrost && npm test
cd ../hashline-edit && npm test
cd ../statusline && npm test
```

Expected: all existing suites remain green, the langfuse typecheck succeeds, and the langfuse suite reports all upstream plus phase-tracker tests passing. Check `git status --short` and ensure only intended source/docs changes are present; do not stage ignored install artifacts or the pre-existing untracked `.pi/` directory.

- [ ] **Step 5: Commit documentation and final verification**

```bash
git add README.md AGENTS.md packages/langfuse/README.md
git commit -m "docs: document pi-langfuse-plus setup and provenance"
```

---

## Verification Summary

After all tasks, the following must be true:

- `packages/langfuse/` contains only the approved trimmed upstream files plus `src/phase.ts`, `test/phase-tracker.test.ts`, and the local README/manifest changes.
- The root `pi.extensions` manifest includes `./packages/langfuse/index.ts`.
- `npm run typecheck` and `npm test` pass in `packages/langfuse/`.
- Root package tests remain green.
- `superpowers_phase` appears only when a non-empty phase is retained, and appears on root agent start/finish metadata and generation-start metadata.
- Upstream provenance remains documented with commit `c79c527a7294e1d4b8153525d5218e87354cbcb1`.
