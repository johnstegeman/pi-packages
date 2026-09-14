/**
 * Per-agent-type subagent model selection (M28).
 * Pure, dependency-free logic — the pi wiring lives in subagent-models.ts.
 * Config: global ~/.pi/agent/subagent-models.json + project .pi/subagent-models.json,
 * shape { "models": { "<type>": "<model>" } }; project wins per key.
 */

/** Agent types the config may set a model for. */
export const SUPPORTED_TYPES = ["implementer", "task-reviewer", "code-reviewer", "verifier", "worker", "explore"];

/** Parse a subagent-models.json body; malformed JSON/maps yield {}. Never throws. */
export function parseModelsConfig(rawText) {
  if (typeof rawText !== "string" || rawText.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {};
  }
  const models = parsed && typeof parsed === "object" ? parsed.models : undefined;
  if (!models || typeof models !== "object" || Array.isArray(models)) return {};
  const out = {};
  for (const [type, model] of Object.entries(models)) {
    if (SUPPORTED_TYPES.includes(type) && typeof model === "string" && model.trim() !== "") {
      out[type] = model.trim();
    }
  }
  return out;
}

/** Merge global then project models maps; project wins per key. */
export function mergeModelsConfig(globalModels, projectModels) {
  return { ...(globalModels ?? {}), ...(projectModels ?? {}) };
}

/** The model to inject for one Agent call, or undefined to leave it alone. */
export function modelForCall({ config, subagentType, currentModel }) {
  if (currentModel != null && currentModel !== "") return undefined;
  const type = typeof subagentType === "string" ? subagentType.trim().toLowerCase() : "";
  if (!SUPPORTED_TYPES.includes(type)) return undefined;
  const model = config?.[type];
  return typeof model === "string" && model !== "" ? model : undefined;
}

/** Apply the configured model to an `Agent` tool_call event in place. */
export function applyModelOverride(event, config) {
  if (event?.toolName !== "Agent") return;
  const input = event.input;
  if (!input || typeof input !== "object") return;
  const model = modelForCall({
    config,
    subagentType: input.subagent_type,
    currentModel: input.model,
  });
  if (model) input.model = model;
}
