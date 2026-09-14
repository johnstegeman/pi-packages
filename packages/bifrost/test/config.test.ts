import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveConfig } from "../index.ts";

test("saveConfig writes a new config file with 0600 permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bifrost-config-"));
  const configPath = join(dir, "nested", "bifrost-config.json");

  saveConfig({ gatewayUrl: "https://gw.example.com", virtualKey: "sk-bf-test" }, configPath);

  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o077, 0);
});

test("saveConfig corrects the mode of an existing world-readable config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bifrost-config-"));
  const configPath = join(dir, "bifrost-config.json");
  writeFileSync(configPath, JSON.stringify({ gatewayUrl: "https://old.example.com" }), { mode: 0o644 });

  saveConfig({ virtualKey: "sk-bf-test" }, configPath);

  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
    gatewayUrl?: string;
    virtualKey?: string;
  };
  assert.equal(saved.gatewayUrl, "https://old.example.com");
  assert.equal(saved.virtualKey, "sk-bf-test");
});

test("saveConfig leaves an existing directory's mode unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bifrost-config-"));
  const parent = join(dir, "shared");
  mkdirSync(parent, { mode: 0o755 });
  chmodSync(parent, 0o755); // umask can only tighten; force the loose mode we assert against
  const configPath = join(parent, "bifrost-config.json");

  saveConfig({ virtualKey: "sk-bf-test" }, configPath);

  assert.equal(statSync(parent).mode & 0o777, 0o755);
});
