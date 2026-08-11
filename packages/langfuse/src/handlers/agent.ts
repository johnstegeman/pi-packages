import { state, resetRunState, computeEvaluationScores } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import { ensureConfig } from "../config.js";
import { shapePayload, truncate, extractFinalAssistant, extractAssistantOutput, getCapturePolicy, getLimits } from "../utils.js";
import { closeDanglingObservations } from "./tool.js";
import { applyCapturePolicy } from "../capture-policy.js";
import { collectSourceMetadata } from "../source-metadata.js";
import { buildPhaseMetadata, buildPhaseTags, replacePhaseTags } from "../phase.js";

function stringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      output[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      output[key] = String(value);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

// Tag sync is serialized per-session so concurrent sessions can never
// interleave: each session gets its own promise chain, and the trace id /
// desired tags for a given update are captured synchronously here (before
// the update is queued) rather than re-read from `state` when the queued
// callback eventually runs. Without this, a single shared chain plus a
// deferred read of `state.agentState` could apply one session's phase
// tags to a different session's trace if their async work interleaves.
const tagSyncChains = new Map<string, Promise<void>>();
const lastSentTagsBySession = new Map<string, string>();
const DEFAULT_TAG_SYNC_SESSION_KEY = "__pi_langfuse_default_session__";

function formatPhaseTagSyncError(error: unknown): string {
  if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: unknown }).statusCode === 404) {
    return "trace is not visible yet or is outside the configured Langfuse project";
  }
  // Generic SDK errors can contain request headers, credentials, response bodies, or stacks.
  // Use a stable classification rather than copying arbitrary Error.message content.
  return "unexpected error while synchronizing trace tags";
}

export async function syncActiveTracePhaseTags(): Promise<void> {
  const sessionKey = state.currentSessionId || DEFAULT_TAG_SYNC_SESSION_KEY;
  const root = state.agentState?.root;
  const traceId = state.agentState?.traceId;
  if (!root || !traceId) {
    return;
  }

  const desiredTags = buildPhaseTags();
  const desiredTagsKey = `${traceId}\u0000${JSON.stringify(desiredTags)}`;
  if (lastSentTagsBySession.get(sessionKey) === desiredTagsKey) {
    // Identical tag set already sent (or in flight) for this trace; skip the
    // redundant ingestion request.
    return tagSyncChains.get(sessionKey) ?? Promise.resolve();
  }
  lastSentTagsBySession.set(sessionKey, desiredTagsKey);

  const previous = tagSyncChains.get(sessionKey) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const rt = await getRuntime();
      const currentTags = await rt.getTraceTags(traceId);
      const replacementTags = replacePhaseTags(currentTags, desiredTags);
      await rt.updateTraceTags(traceId, replacementTags);
    } catch (e) {
      if (lastSentTagsBySession.get(sessionKey) === desiredTagsKey) {
        lastSentTagsBySession.delete(sessionKey);
      }
      console.warn(`📊 Langfuse: Phase tag sync unavailable (${formatPhaseTagSyncError(e)}); tracing continues.`);
    }
  });
  tagSyncChains.set(sessionKey, next);
  return next;
}

export function updateTraceIO(input?: unknown, output?: unknown) {
  const root = state.agentState?.root;
  if (!root?.setTraceIO) {
    return;
  }

  try {
    root.setTraceIO({ input, output });
  } catch {
    // Older SDKs may omit setTraceIO; root IO still mirrors trace IO in current Langfuse.
  }
}

export async function startAgentRun(event: Record<string, unknown>, ctx: any) {
  if (!(await ensureConfig(ctx))) {
    state.isTracingDisabled = true;
    return;
  }

  try {
    const rt = await getRuntime();
    const cwd = String(
      (event.systemPromptOptions && typeof event.systemPromptOptions === "object"
        ? (event.systemPromptOptions as Record<string, unknown>).cwd
        : undefined) ?? process.cwd(),
    );

    if (!state.currentModel && ctx.model) {
      state.currentModel = ctx.model.id || "";
      state.currentProvider = ctx.model.provider || "";
    }

    const rawPromptInput = shapePayload({
      prompt: event.prompt,
      images: event.images,
      context: event.context ?? event.attachments,
    });
    const sourceMetadata = collectSourceMetadata(cwd);
    const captured = applyCapturePolicy(
      {
        input: rawPromptInput,
        metadata: {
          cwd,
          ...sourceMetadata,
          ...buildPhaseMetadata(),
          ...(state.currentModel ? { model: state.currentModel } : {}),
          ...(state.currentProvider ? { provider: state.currentProvider } : {}),
          sessionId: state.currentSessionId || undefined,
        },
      },
      getCapturePolicy(),
    );

    state.agentState = {
      cwd,
      promptInput: captured.input,
      generationSeq: 0,
      activeGenerations: new Map(),
      generationOrder: [],
      activeTools: new Map(),
      sourceMetadata,
      providerMetadataByRequest: new Map(),
    };

    const phaseTags = buildPhaseTags();
    const root = rt.propagateAttributes(
      {
        sessionId: state.currentSessionId ? truncate(state.currentSessionId, 200) : undefined,
        traceName: "pi-agent",
        metadata: stringMetadata(captured.metadata),
        ...(phaseTags.length > 0 ? { tags: phaseTags } : {}),
      },
      () =>
        rt.startObservation(
          "pi-agent",
            {
              input: captured.input,
              metadata: captured.metadata ?? {},
            },
          { asType: "agent" },
        ),
    );

    state.agentState.root = root;
    state.agentState.traceId = root.traceId;
    updateTraceIO(captured.input, undefined);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create agent observation", e);
    state.isTracingDisabled = true;
  }
}

/**
 * Records the effective system prompt on the root agent observation.
 *
 * Deliberately called from `agent_start` rather than `before_agent_start`:
 * during `before_agent_start` the extension runner hands each handler the
 * prompt as it stands mid-chain, so extensions registered after this one
 * (e.g. inline factories that rewrite the system prompt) are not reflected
 * yet. By `agent_start` the session has applied the final override, and
 * `ctx.getSystemPrompt()` returns the prompt actually sent to the model.
 */
export async function recordSystemPrompt(ctx: any) {
  const root = state.agentState?.root;
  if (state.isTracingDisabled || !root) {
    return;
  }

  let systemPrompt = undefined;
  try {
    if (ctx.getSystemPrompt) {
      systemPrompt = await ctx.getSystemPrompt();
    }
  } catch {
    // Ignore if getSystemPrompt is not available or fails
  }
  if (!systemPrompt) {
    return;
  }

  const captured = applyCapturePolicy(
    { systemPrompt: truncate(String(systemPrompt), getLimits().maxString) },
    getCapturePolicy(),
  );
  if (!captured.systemPrompt) {
    return;
  }

  try {
    root.update({ metadata: { systemPrompt: captured.systemPrompt } });
  } catch (e) {
    console.warn("\u{1F4CA} Langfuse: Failed to record system prompt", e);
  }
}

export async function finishAgentRun(event: Record<string, unknown> = {}) {
  if (!state.agentState?.root) {
    resetRunState();
    return;
  }

  const lastAssistant = extractFinalAssistant(event.messages);
  const rawOutput = lastAssistant ? extractAssistantOutput(lastAssistant) : state.agentState.latestAssistantOutput;
  const captured = applyCapturePolicy(
    {
      output: rawOutput,
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
    },
    getCapturePolicy(),
  );
  const scores = computeEvaluationScores();

  closeDanglingObservations("Agent run ended before observation finalized");

  try {
    state.agentState.root
      .update({
        output: captured.output,
        metadata: captured.metadata,
      })
      .end();
    updateTraceIO(state.agentState.promptInput, captured.output);

    await sendScore("tool_call_count", scores.tool_call_count, { traceId: state.agentState.traceId });
    await sendScore("turn_count", scores.turn_count, { traceId: state.agentState.traceId });
    await sendScore("total_tool_errors", scores.total_tool_errors, { traceId: state.agentState.traceId });
    await sendScore("tool_success_rate", scores.tool_success_rate, { traceId: state.agentState.traceId });
    await sendScore("session_had_errors", scores.session_had_errors, { traceId: state.agentState.traceId });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish agent observation", e);
  } finally {
    resetRunState();
  }
}
