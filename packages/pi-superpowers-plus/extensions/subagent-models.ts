import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyModelOverride, mergeModelsConfig, parseModelsConfig } from "./subagent-models.mjs";

function readModelsFile(path: string): Record<string, string> {
  try {
    return parseModelsConfig(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function readConfig(cwd: string): Record<string, string> {
  const globalModels = readModelsFile(join(getAgentDir(), "subagent-models.json"));
  const projectModels = readModelsFile(join(cwd, ".pi", "subagent-models.json"));
  return mergeModelsConfig(globalModels, projectModels);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    applyModelOverride(event, readConfig(ctx.cwd));
  });
}
