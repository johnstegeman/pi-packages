import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, saveConfig } from "../index.ts";

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
  chmodSync(configPath, 0o644); // umask can only tighten; force the loose mode we assert against

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

test("loadConfig repairs an existing world-readable config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bifrost-config-"));
  const configPath = join(dir, "bifrost-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ gatewayUrl: "https://gw.example.com", virtualKey: "sk-bf-file" }),
    { mode: 0o644 },
  );
  chmodSync(configPath, 0o644); // umask can only tighten; force the loose mode we assert against

  const priorUrl = process.env.BIFROST_GATEWAY_URL;
  const priorKey = process.env.BIFROST_VIRTUAL_KEY;
  delete process.env.BIFROST_GATEWAY_URL;
  delete process.env.BIFROST_VIRTUAL_KEY;
  try {
    const config = loadConfig(configPath);

    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(config.gatewayUrl, "https://gw.example.com");
    assert.equal(config.virtualKey, "sk-bf-file");
  } finally {
    if (priorUrl === undefined) delete process.env.BIFROST_GATEWAY_URL;
    else process.env.BIFROST_GATEWAY_URL = priorUrl;
    if (priorKey === undefined) delete process.env.BIFROST_VIRTUAL_KEY;
    else process.env.BIFROST_VIRTUAL_KEY = priorKey;
  }
});

test("loadConfig returns an empty config for a missing file without creating it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bifrost-config-"));
  const configPath = join(dir, "absent.json");

  const priorUrl = process.env.BIFROST_GATEWAY_URL;
  const priorKey = process.env.BIFROST_VIRTUAL_KEY;
  delete process.env.BIFROST_GATEWAY_URL;
  delete process.env.BIFROST_VIRTUAL_KEY;
  try {
    const config = loadConfig(configPath);

    assert.deepEqual(config, { gatewayUrl: undefined, virtualKey: undefined });
    assert.equal(existsSync(configPath), false);
  } finally {
    if (priorUrl === undefined) delete process.env.BIFROST_GATEWAY_URL;
    else process.env.BIFROST_GATEWAY_URL = priorUrl;
    if (priorKey === undefined) delete process.env.BIFROST_VIRTUAL_KEY;
    else process.env.BIFROST_VIRTUAL_KEY = priorKey;
  }
});

test("loadConfig lets env vars override file values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bifrost-config-"));
  const configPath = join(dir, "bifrost-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ gatewayUrl: "https://file.example.com", virtualKey: "sk-bf-file" }),
    { mode: 0o644 },
  );

  process.env.BIFROST_GATEWAY_URL = "https://env.example.com";
  process.env.BIFROST_VIRTUAL_KEY = "sk-bf-env";
  try {
    const config = loadConfig(configPath);
    assert.equal(config.gatewayUrl, "https://env.example.com");
    assert.equal(config.virtualKey, "sk-bf-env");
  } finally {
    delete process.env.BIFROST_GATEWAY_URL;
    delete process.env.BIFROST_VIRTUAL_KEY;
  }
});
