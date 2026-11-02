/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.js";

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run,
 * `agent-manager.ts` snapshots the same labels at spawn and refines them from
 * whatever the run reports afterwards — all three must agree, or the label
 * would visibly change the moment the run starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry);
    if (typeof bare !== "string") return bare;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/**
 * The two registry members model resolution needs — nothing else is read, so
 * a caller can hand over whatever shape its context happens to have.
 */
export type ModelLookup = {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAvailable?(): Model<any>[];
};

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 *
 * Lives here rather than in `agent-runner.ts` because the manager resolves it
 * too: `record.invocation` is snapshotted at spawn, for every modality,
 * instead of read back off a live session.
 */
export function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: ModelLookup,
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/**
 * The model and thinking level one run will actually use.
 *
 * One precedence rule, one implementation: the caller's explicit option, else
 * the agent type's config, else the parent's own model (and, for thinking,
 * nothing at all — inherit).
 *
 * It lives here because two entry points resolve it for different reasons and
 * must never disagree: `runAgent()` needs it to open its session, and the
 * manager needs it at spawn to write `record.invocation`, which for a
 * pane-backed run is the ONLY source of the labels — the parent never holds the
 * child's session to read them off afterwards. Two copies of this precedence
 * held together by a comment drift silently.
 */
export function resolveRunInvocation(input: {
  /** What the caller asked for explicitly; each wins over the agent file. */
  options: { model?: Model<any>; thinkingLevel?: ThinkingLevel };
  /** The agent type's own config, when the type has one. */
  config: { model?: string; thinking?: ThinkingLevel } | undefined;
  /**
   * The parent session: its model is the last resort, and its registry is what
   * turns a `provider/model` name from the agent file into a model.
   *
   * The registry is optional because a context is not obliged to have one — a
   * stub in a test, or a partial SDK context. Without it the config's model
   * cannot be resolved, so the run gets the caller's model or the parent's:
   * the same fallback, one source short. What it must never do is throw, since
   * these are display labels and the manager resolves them in the middle of a
   * spawn, where a throw fails the tool call rather than the record.
   */
  ctx: { model?: Model<any>; modelRegistry?: ModelLookup };
}): { model: Model<any> | undefined; thinkingLevel: ThinkingLevel | undefined } {
  const registry = input.ctx.modelRegistry;
  const model = input.options.model
    ?? (registry === undefined
      // No registry to resolve a name against; the parent's own model is the
      // most specific answer left, and exactly what the last resort below
      // would have returned for a config that names nothing.
      ? input.ctx.model
      : resolveDefaultModel(input.ctx.model, registry, input.config?.model));
  return {
    model,
    thinkingLevel: input.options.thinkingLevel ?? input.config?.thinking,
  };
}
