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
 * namespace (e.g. `anthropic/claude-opus-4-6`). For these, request Anthropic-
 * style `cache_control` markers on the system prompt, last tool definition,
 * and last user/assistant/tool-result content — mirroring the automatic
 * prompt-caching behavior of pi's native Anthropic provider.
 */
function isBifrostAnthropicModel(id: string): boolean {
  return id.startsWith("anthropic/");
}

function toProviderModel(m: BifrostModel) {
  const inputModalities = m.architecture?.input_modalities ?? [];
  const input: PiModelInput = inputModalities.includes("image")
    ? ["text", "image"]
    : ["text"];

  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: detectReasoning(m),
    input,
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length ?? 128_000,
    maxTokens: m.max_output_tokens ?? m.top_provider?.max_completion_tokens ?? 4_096,
    ...(isBifrostAnthropicModel(m.id)
      ? { compat: { cacheControlFormat: "anthropic" as const } }
      : {}),
  };
}

async function fetchModels(
  gatewayUrl: string,
  virtualKey?: string,
  sessionName?: string,
): Promise<ReturnType<typeof toProviderModel>[]> {
  const base = gatewayUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (virtualKey) {
    headers["Authorization"] = `Bearer ${virtualKey}`;
  }
  if (sessionName) {
    headers["x-module-name"] = `pi: ${sessionName}`;
  }

  const res = await fetch(`${base}/v1/models`, { headers });
  if (!res.ok) {
    throw new Error(`GET /v1/models → HTTP ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as BifrostModelsResponse;
  return (body.data ?? []).map(toProviderModel);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // ---- Initial config resolution ------------------------------------------

  const config = loadConfig();

  let currentUrl = config.gatewayUrl ?? "";
  let currentModels: ReturnType<typeof toProviderModel>[] = [];
  let currentSessionName = pi.getSessionName() ?? "";

  if (currentUrl) {
    try {
      currentModels = await fetchModels(currentUrl, config.virtualKey, currentSessionName);
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
      // Tag requests so Bifrost can attribute cost to this pi session.
      headers: { "x-module-name": `pi: ${currentSessionName}` },
      api: "openai-completions",
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
              currentModels = await fetchModels(url, key, currentSessionName);
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

  // ---- Session name tracking & re-registration ---------------------------
  //
  // The session name (e.g. "feature-add-x-module-name-header-for-bifrost")
  // is sent as `x-module-name: pi: <name>` on every bifrost request so that
  // Bifrost can attribute cost to a specific pi session. Because the name may
  // not be available when the factory runs (or may change mid-session), we
  // re-register the provider whenever it changes.

  function refreshSessionName(name: string | undefined): void {
    const next = name ?? "";
    if (next === currentSessionName) return;
    currentSessionName = next;
    pi.unregisterProvider("bifrost");
    register();
  }

  pi.on("session_start", async (_event, ctx) => {
    // The session name may only become available after session start.
    refreshSessionName(pi.getSessionName());

    if (!currentUrl) {
      ctx.ui.notify(
        "Bifrost: not configured. Run /login bifrost to set your gateway URL and virtual key.",
        "warning",
      );
    }
  });

  pi.on("session_info_changed", (event) => {
    refreshSessionName(event.name);
  });
