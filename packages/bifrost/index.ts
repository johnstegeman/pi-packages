/**
 * pi-bifrost
 *
 * Registers a "bifrost" provider backed by a Bifrost AI gateway
 * (https://docs.getbifrost.ai). Models are discovered dynamically at startup
 * from the gateway's /v1/models endpoint.
 *
 * Configuration (two supported paths, env vars take priority):
 *
 *   1. Environment variables
 *        BIFROST_GATEWAY_URL   https://your-gateway.example.com
 *        BIFROST_VIRTUAL_KEY   sk-bf-...
 *
 *   2. Interactive login (stores to ~/.pi/agent/bifrost-config.json)
 *        /login bifrost
 *        → prompts for gateway URL and virtual key
 *
 * After setup, use /model (or Ctrl+P) to choose any model the gateway exposes.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/** Persisted alongside pi's own global agent config. */
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "bifrost-config.json");

interface BifrostConfig {
  gatewayUrl?: string;
  virtualKey?: string;
}

function loadConfig(): BifrostConfig {
  const envUrl = process.env.BIFROST_GATEWAY_URL?.trim();
  const envKey = process.env.BIFROST_VIRTUAL_KEY?.trim();

  let file: BifrostConfig = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as BifrostConfig;
  } catch {
    // File not yet created – fine.
  }

  return {
    // Env vars win; fall back to whatever was saved by /login.
    gatewayUrl: envUrl || file.gatewayUrl,
    virtualKey: envKey || file.virtualKey,
  };
}

function saveConfig(updates: BifrostConfig): void {
  let existing: BifrostConfig = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as BifrostConfig;
  } catch {
    // No existing file – start fresh.
  }

  try {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ...existing, ...updates }, null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("[pi-bifrost] Failed to save config:", err);
  }
}

// ---------------------------------------------------------------------------
// Bifrost models API
// ---------------------------------------------------------------------------

interface BifrostModel {
  id: string;
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
  architecture?: {
    input_modalities?: string[];
  };
  pricing?: {
    prompt?: string;           // per-token USD
    completion?: string;       // per-token USD
    input_cache_read?: string; // per-token USD
    input_cache_write?: string;// per-token USD
    internal_reasoning?: string;
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
}

interface BifrostModelsResponse {
  data: BifrostModel[];
  next_page_token?: string;
}

/**
 * Prices from the Bifrost API are per-token USD strings.
 * Pi expects per-million-token USD numbers.
 */
function parsePrice(raw?: string): number {
  if (!raw) return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

/**
 * Heuristically decide if a model supports extended thinking / reasoning.
 * Bifrost's /v1/models doesn't expose a dedicated flag or supported_parameters
 * list, so we rely on two proxies:
 *   1. Non-zero internal_reasoning pricing (strong, provider-reported signal)
 *   2. Known model-family naming patterns (covers OpenAI o1/o3/o4/gpt-5,
 *      Claude 4.x+/3.7, Gemini 2.5+/3.x, GLM, Kimi K2.5+, DeepSeek V3+/R1,
 *      MiniMax M2+, Grok 3+, Qwen3.5+, Magistral, etc.)
 *
 * A small set of non-chat modalities (audio, image, embeddings, moderation,
 * frozen "-chat-latest" snapshots, ...) are excluded up front since name
 * patterns like "gpt-5" would otherwise false-positive on them.
 */
const REASONING_EXCLUDE_PATTERNS = [
  "embed",
  "embedding",
  "whisper",
  "tts",
  "transcribe",
  "audio",
  "image",
  "imagen",
  "moderation",
  "davinci",
  "babbage",
  "aqa",
  "veo",
  "lyria",
  "sora",
  "chat-latest",
  "instruct",
];

const REASONING_INCLUDE_PATTERNS: RegExp[] = [
  /(^|[^a-z])o[1-9](-|$)/, // OpenAI o1/o3/o4 series
  /gpt-5/, // GPT-5 family (reasoning by default; chat-latest excluded above)
  /claude-(opus|sonnet|haiku|fable)-[4-9]/, // Claude 4.x+ (extended thinking)
  /claude-3-7/, // Claude 3.7 (extended thinking)
  /gemini-(2\.5|3(\.\d+)?)/, // Gemini 2.5+/3.x (thinking by default)
  /gemini-(flash|pro)(-lite)?-latest/,
  /deep-research/,
  /computer-use/,
  /robotics-er/,
  /gemma-[3-9]/,
  /\bglm-/, // Zhipu GLM (native reasoning)
  /kimi-k(2\.[5-9]|[3-9])/, // Kimi K2.5+ / K3+
  /kimi.*thinking/,
  /deepseek-v[3-9]/, // DeepSeek V3.1+
  /deepseek-r[1-9]/,
  /\breasoner\b/,
  /minimax-m[2-9]/, // MiniMax M2+
  /grok-[3-9]/, // Grok 3+
  /qwen3[p.]([5-9]|[1-9][0-9])/, // Qwen3.5+ thinking-capable
  /magistral/, // Mistral reasoning line
  /mistral-(medium|small)-3\.[2-9]/,
  /\bthinking\b/,
  /\breasoning\b/,
];

function fallbackContextWindow(id: string): number {
  // Bifrost omits `context_length` for some Fireworks `accounts/.../models/...`
  // ids (DeepSeek V4, Kimi K3) and assorted non-chat OpenAI models. Mirror pi's
  // built-in model catalog so a 1M-context model isn't understated to 128k —
  // understatement forces aggressive compaction and collapses the output budget
  // (contextWindow - input - safety) in large sessions.
  const modelId = id.toLowerCase();
  const base = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  if (/deepseek-v[3-9]|deepseek-r[1-9]/.test(base)) return 1_000_000;
  if (/kimi-k3/.test(base)) return 1_048_576;
  if (/kimi-k2/.test(base)) return 262_144;
  return 128_000;
}

function detectReasoning(m: BifrostModel): boolean {
  if (m.pricing?.internal_reasoning && parseFloat(m.pricing.internal_reasoning) > 0) {
    return true;
  }

  const id = m.id.toLowerCase();
  const modelId = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;

  if (REASONING_EXCLUDE_PATTERNS.some((p) => modelId.includes(p))) {
    return false;
  }
  return REASONING_INCLUDE_PATTERNS.some((re) => re.test(modelId));
}

type PiModelInput = ("text" | "image")[];

/**
 * Bifrost exposes Anthropic models under the `anthropic/<model>` id
 * namespace (e.g. `anthropic/claude-opus-4-6`). For these, use the native
 * Anthropic Messages API (`/anthropic/v1/messages`) with full `cache_control`
 * prompt caching support — mirroring the automatic prompt-caching behavior
 * of pi's native Anthropic provider.
 */
function isBifrostAnthropicModel(id: string): boolean {
  return id.startsWith("anthropic/");
}

export function toProviderModel(m: BifrostModel, gatewayUrl: string) {
  const inputModalities = m.architecture?.input_modalities ?? [];
  const input: PiModelInput = inputModalities.includes("image")
    ? ["text", "image"]
    : ["text"];

  const isAnthropic = isBifrostAnthropicModel(m.id);
  const reasoning = detectReasoning(m);

  // Some gateway-served models (e.g. Fireworks' `accounts/.../models/...`
  // ids) omit `max_output_tokens` / `top_provider.max_completion_tokens`.
  // For reasoning models a small default (4096) lets thinking alone exhaust
  // the output budget, which surfaces as "run hit the output token limit
  // before producing any text" or "Response was truncated before completion".
  // Use a generous default so thinking + text both fit; pi clamps it further
  // to the remaining context window.
  const maxTokens =
    m.max_output_tokens ??
    m.top_provider?.max_completion_tokens ??
    (reasoning ? 32_768 : 4_096);

  return {
    id: m.id,
    name: m.name ?? m.id,
    api: isAnthropic ? "anthropic-messages" : "openai-responses",
    baseUrl: isAnthropic
      ? `${gatewayUrl}/anthropic`
      : `${gatewayUrl}/v1`,
    reasoning,
    input,
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length ?? fallbackContextWindow(m.id),
    maxTokens,
  };
}

async function fetchModels(
  gatewayUrl: string,
  virtualKey?: string,
): Promise<ReturnType<typeof toProviderModel>[]> {
  const base = gatewayUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (virtualKey) {
    headers["Authorization"] = `Bearer ${virtualKey}`;
  }

  const res = await fetch(`${base}/v1/models`, { headers });
  if (!res.ok) {
    throw new Error(`GET /v1/models → HTTP ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as BifrostModelsResponse;
  return (body.data ?? []).map((m) => toProviderModel(m, base));
}

// ---------------------------------------------------------------------------
// Superpowers phase tracking
// ---------------------------------------------------------------------------

/**
 * Reduce a `superpowers:phase` event payload into the retained phase value.
 *
 * Returns the incoming value verbatim when it is a non-empty string (trimmed
 * only to test emptiness, so the exact payload value is preserved), and
 * `null` when the incoming value is null/undefined/empty — which clears any
 * previously retained phase.
 */
export function applyPhaseUpdate(
  _current: string | null,
  incoming: string | null | undefined,
): string | null {
  return incoming && incoming.trim() !== "" ? incoming : null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // ---- Initial config resolution ------------------------------------------

  const config = loadConfig();

  let currentUrl = config.gatewayUrl ?? "";
  let currentModels: ReturnType<typeof toProviderModel>[] = [];

  if (currentUrl) {
    try {
      currentModels = await fetchModels(currentUrl, config.virtualKey);
    } catch (err) {
      console.warn(
        `[pi-bifrost] Model discovery failed (${currentUrl}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---- Provider registration ----------------------------------------------

  /**
   * (Re-)registers the bifrost provider.
   * Called once at startup and again after /login updates the URL.
   */
  function register(): void {
    pi.registerProvider("bifrost", {
      name: "Bifrost",
      // baseUrl must be known at registration time; it is updated by re-calling
      // register() inside the login callback (via setImmediate, after pi has
      // stored the new credentials).
      baseUrl: currentUrl ? `${currentUrl}/v1` : "https://localhost/v1",
      // Env-var path: used when no /login credentials are stored.
      apiKey: "$BIFROST_VIRTUAL_KEY",
      // Sends: Authorization: Bearer <key>  (one of Bifrost's accepted headers)
      authHeader: true,
      api: "openai-responses",
      models: currentModels,

      oauth: {
        name: "Bifrost Gateway",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const url = (
            await callbacks.onPrompt({
              message: "Bifrost gateway URL (e.g. https://gateway.example.com):",
            })
          ).trim();

          const key = (
            await callbacks.onPrompt({ message: "Virtual key (sk-bf-...):" })
          ).trim();

          // Persist to disk so the factory can read it on next startup.
          saveConfig({ gatewayUrl: url, virtualKey: key });

          // Re-register the provider with the new URL on the next tick, after
          // pi has finished processing the login flow and stored the credentials.
          setImmediate(async () => {
            try {
              currentModels = await fetchModels(url, key);
            } catch (err) {
              console.warn(
                `[pi-bifrost] Model refresh after login failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              currentModels = [];
            }
            currentUrl = url;
            pi.unregisterProvider("bifrost");
            register();
          });

          return {
            // Store URL in refresh so it round-trips through pi's auth storage,
            // though we primarily rely on the config file for restoring it.
            refresh: url,
            access: key,
            // Virtual keys don't expire on a short cycle; use a long TTL.
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
          };
        },

        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          // Virtual keys don't refresh via a token exchange; just extend the TTL.
          return {
            ...credentials,
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
          };
        },

        getApiKey(credentials: OAuthCredentials): string {
          return credentials.access;
        },
      },
    });
  }

  register();

  // ---- Superpowers phase header -------------------------------------------
  //
  // The Superpowers skills emit `{ phase }` on the superpowers:phase event
  // bus. Retain the latest non-empty phase in memory and carry it on every
  // Bifrost request as `x-superpowers-phase`, so the gateway can attribute
  // usage to a workflow phase (brainstorming, development, ...).

  let superpowersPhase: string | null = null;

  pi.events.on("superpowers:phase", (data) => {
    const phase =
      typeof data === "object" && data !== null && "phase" in data
        ? (data as { phase: unknown }).phase
        : undefined;
    superpowersPhase = applyPhaseUpdate(
      superpowersPhase,
      typeof phase === "string" ? phase : null,
    );
  });

  // ---- Per-session cost attribution ---------------------------------------
  //
  // Every Bifrost request carries an `x-pi-session` header set to the
  // current session's display name, so Bifrost can attribute cost to a
  // specific pi session. The name is looked up live at request time (rather
  // than cached), since it may only become available or change after the
  // provider is registered.

  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "bifrost") return;
    // Use the workspace directory basename (e.g. the worktree name) as a
    // human-readable session identifier for Bifrost cost attribution.
    event.headers["x-pi-session"] = path.basename(ctx.cwd);
    // Tag the request with the current Superpowers workflow phase, when known.
    if (superpowersPhase) {
      event.headers["x-superpowers-phase"] = superpowersPhase;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!currentUrl) {
      ctx.ui.notify(
        "Bifrost: not configured. Run /login bifrost to set your gateway URL and virtual key.",
        "warning",
      );
    }
  });
}
