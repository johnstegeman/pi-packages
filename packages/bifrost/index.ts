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
 * Bifrost doesn't expose a dedicated flag, so we use two proxies:
 *   1. Non-zero internal_reasoning pricing
 *   2. Known naming patterns (o1, o3, r1, thinking, reasoner)
 */
function detectReasoning(m: BifrostModel): boolean {
  if (m.pricing?.internal_reasoning && parseFloat(m.pricing.internal_reasoning) > 0) {
    return true;
  }
  const id = m.id.toLowerCase();
  return (
    id.includes("thinking") ||
    id.includes("-o1") ||
    id.includes("-o3") ||
    id.includes("r1") ||
    id.includes("reasoner")
  );
}

type PiModelInput = ("text" | "image")[];

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
  };
}

async function fetchModels(gatewayUrl: string, virtualKey?: string): Promise<ReturnType<typeof toProviderModel>[]> {
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

  // ---- Startup warning if not yet configured ------------------------------

  pi.on("session_start", async (_event, ctx) => {
    if (!currentUrl) {
      ctx.ui.notify(
        "Bifrost: not configured. Run /login bifrost to set your gateway URL and virtual key.",
        "warning",
      );
    }
  });
}
