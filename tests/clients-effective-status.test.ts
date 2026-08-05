/**
 * Unit tests for Clients effective-status probes + verdict aggregation.
 * Fixtures never contain real API keys.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  buildProxyTarget,
  readClientsEffectiveStatus,
  urlPointsAtProxy,
  verdictFromBaseUrl,
} from "../src/clients/effective-status";
import { probeClaude } from "../src/clients/probes/claude";
import { listModelProviderNames, probeCodex } from "../src/clients/probes/codex";
import { probeOpencode } from "../src/clients/probes/opencode";
import { readCcSwitchCurrentProfiles } from "../src/clients/probes/cc-switch";
import { readPaseoProviderCommands } from "../src/clients/probes/paseo";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ocx-clients-"));
}

const PROXY = buildProxyTarget({ port: 10100, hostname: "127.0.0.1" });

describe("urlPointsAtProxy / verdictFromBaseUrl", () => {
  test("loopback :10100/v1 is ocx", () => {
    expect(urlPointsAtProxy("http://127.0.0.1:10100/v1", PROXY)).toBe(true);
    expect(verdictFromBaseUrl("http://127.0.0.1:10100/v1", PROXY).verdict).toBe("ocx");
  });

  test("Claude bare loopback base (no /v1) is still ocx", () => {
    expect(urlPointsAtProxy("http://127.0.0.1:10100", PROXY)).toBe(true);
    expect(verdictFromBaseUrl("http://127.0.0.1:10100", PROXY).verdict).toBe("ocx");
  });

  test("anyrouter is direct", () => {
    expect(urlPointsAtProxy("https://anyrouter.top", PROXY)).toBe(false);
    expect(verdictFromBaseUrl("https://anyrouter.top", PROXY).verdict).toBe("direct");
  });

  test("missing file → missing", () => {
    expect(verdictFromBaseUrl(null, PROXY, { present: false }).verdict).toBe("missing");
  });

  test("mixed flag wins", () => {
    expect(verdictFromBaseUrl("http://127.0.0.1:10100/v1", PROXY, { mixed: true }).verdict).toBe("mixed");
  });

  test("wrong port is direct", () => {
    expect(urlPointsAtProxy("http://127.0.0.1:9999/v1", PROXY)).toBe(false);
  });
});

describe("probeClaude", () => {
  test("reads BASE_URL and MODEL only; ignores AUTH_TOKEN", () => {
    const home = tempHome();
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-SHOULD-NEVER-APPEAR",
        ANTHROPIC_BASE_URL: "https://anyrouter.top",
        ANTHROPIC_MODEL: "claude-fable-5[1M]",
      },
    }));
    const result = probeClaude({ home });
    expect(result.present).toBe(true);
    expect(result.baseUrl).toBe("https://anyrouter.top");
    expect(result.model).toBe("claude-fable-5[1M]");
    const json = JSON.stringify(result);
    expect(json).not.toContain("sk-SHOULD");
    expect(json).not.toContain("AUTH_TOKEN");
  });

  test("missing settings → present false", () => {
    const home = tempHome();
    const result = probeClaude({ home });
    expect(result.present).toBe(false);
    expect(result.baseUrl).toBeNull();
  });
});

describe("probeCodex", () => {
  test("marker-owned openai_base_url → base + mixed when foreign providers exist", () => {
    const home = tempHome();
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), `
model = "gpt-5.6"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"
[model_providers.custom]
name = "My Codex"
base_url = "https://example.invalid/v1"
`);
    const result = probeCodex({ home });
    expect(result.present).toBe(true);
    expect(result.injected).toBe(true);
    expect(result.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(result.model).toBe("gpt-5.6");
    expect(result.mixed).toBe(true);
    expect(listModelProviderNames(readFileSync(join(dir, "config.toml"), "utf8"))).toContain("custom");
    expect(JSON.stringify(result)).not.toContain("bearer");
  });

  test("no file → missing", () => {
    const home = tempHome();
    expect(probeCodex({ home }).present).toBe(false);
  });
});

describe("probeOpencode", () => {
  test("reads baseURL and omits apiKey", () => {
    const home = tempHome();
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "opencode.json");
    writeFileSync(path, JSON.stringify({
      provider: {
        default: {
          options: {
            apiKey: "sk-SECRET-KEY-VALUE",
            baseURL: "http://sub.proxy.example/v1",
          },
          models: { "gpt-5.4": { name: "gpt-5.4" } },
        },
      },
    }));
    const result = probeOpencode({ home, configPath: path });
    expect(result.present).toBe(true);
    expect(result.baseUrl).toBe("http://sub.proxy.example/v1");
    expect(result.model).toBe("gpt-5.4");
    const json = JSON.stringify(result);
    expect(json).not.toContain("sk-SECRET");
    expect(json).not.toContain("apiKey");
  });
});

describe("cc-switch + paseo probes", () => {
  test("cc-switch returns name only from is_current rows", () => {
    const home = tempHome();
    const dir = join(home, ".cc-switch");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "cc-switch.db");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      app_type TEXT,
      name TEXT,
      settings_config TEXT,
      is_current INTEGER
    )`);
    db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, is_current)
       VALUES (?, ?, ?, ?, 1)`,
      ["p1", "claude", "anyroute-MEI", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-SECRET" } })],
    );
    db.close();

    const profiles = readCcSwitchCurrentProfiles({ home, dbPath });
    expect(profiles).toEqual([{ appType: "claude", name: "anyroute-MEI", id: "p1" }]);
    expect(JSON.stringify(profiles)).not.toContain("sk-SECRET");
    expect(JSON.stringify(profiles)).not.toContain("settings_config");
  });

  test("paseo reads command arrays only", () => {
    const home = tempHome();
    const dir = join(home, ".paseo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      providers: {
        pi: {
          command: ["/Users/test/.local/bin/ocx-pi"],
          env: { OPENCODEX_API_KEY: "sk-SHOULD-NOT-LEAK" },
        },
      },
    }));
    const cmds = readPaseoProviderCommands({ home });
    expect(cmds).toEqual([{ provider: "pi", command: ["/Users/test/.local/bin/ocx-pi"] }]);
    expect(JSON.stringify(cmds)).not.toContain("sk-SHOULD");
    expect(JSON.stringify(cmds)).not.toContain("OPENCODEX_API_KEY");
  });
});

describe("GET /api/clients/status", () => {
  test("returns 200 with clients array and no secret fields", async () => {
    const { handleManagementAPI } = await import("../src/server/management-api");
    const config = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
      // Deliberately include a real-looking key so absence assertions mean something.
      apiKeys: [{ id: "k1", name: "default", key: "ocx_live_secret_should_not_appear", createdAt: "2020-01-01T00:00:00.000Z" }],
    } as import("../src/types").OcxConfig;

    const url = new URL("http://127.0.0.1:10100/api/clients/status");
    const response = await handleManagementAPI(
      new Request(url, { headers: { Host: url.host } }),
      url,
      config,
      { saveConfigPreservingClaudeCode: () => {}, refreshCodexCatalog: async () => {} },
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      generatedAt: number;
      proxy: { baseUrl: string; port: number };
      clients: Array<{ id: string; verdict: string }>;
    };
    expect(typeof body.generatedAt).toBe("number");
    expect(body.proxy.port).toBe(10100);
    expect(Array.isArray(body.clients)).toBe(true);
    expect(body.clients.map(c => c.id).sort()).toEqual(
      ["agy", "claude", "codex", "grok", "opencode", "pi"].sort(),
    );
    const blob = JSON.stringify(body);
    expect(blob).not.toContain("ocx_live_secret");
    expect(blob).not.toContain("apiKey");
    expect(blob).not.toContain("settings_config");
  });
});

describe("readClientsEffectiveStatus aggregator", () => {
  test("builds rows with injected probes; no secret fields", async () => {
    const snapshot = await readClientsEffectiveStatus(
      { port: 10100, hostname: "127.0.0.1" },
      {
        running: true,
        probes: {
          claude: () => ({
            present: true,
            baseUrl: "https://anyrouter.top",
            model: "claude-fable-5",
            configPaths: ["/tmp/claude/settings.json"],
            notes: [],
          }),
          codex: () => ({
            present: true,
            baseUrl: "http://127.0.0.1:10100/v1",
            model: "gpt-5.6",
            configPaths: ["/tmp/codex/config.toml"],
            notes: ["Extra model_providers on disk: custom"],
            mixed: true,
            injected: true,
          }),
          pi: () => ({
            present: true,
            baseUrl: "http://127.0.0.1:10100/v1",
            model: "volcengine/ark",
            configPaths: ["/tmp/pi/models.json"],
            notes: [],
            binary: "/usr/bin/pi",
          }),
          grok: () => ({
            present: true,
            baseUrl: "http://127.0.0.1:10100/v1",
            model: "grok-4",
            configPaths: ["/tmp/grok/config.toml"],
            notes: [],
          }),
          opencode: () => ({
            present: true,
            baseUrl: "http://sub.proxy.example/v1",
            model: "gpt-5.4",
            configPaths: ["/tmp/opencode.json"],
            notes: [],
          }),
          agy: () => ({
            present: false,
            baseUrl: null,
            model: null,
            configPaths: [],
            notes: ["agy binary not on PATH"],
            binary: null,
          }),
          ccSwitch: () => [{ appType: "claude", name: "anyroute-MEI", id: "p1" }],
          paseo: () => [{ provider: "pi", command: ["ocx-pi"] }],
        },
      },
    );

    expect(snapshot.proxy.running).toBe(true);
    expect(snapshot.proxy.port).toBe(10100);
    expect(snapshot.clients).toHaveLength(6);

    const byId = Object.fromEntries(snapshot.clients.map(c => [c.id, c]));
    expect(byId.claude?.verdict).toBe("direct");
    expect(byId.claude?.switcher?.name).toBe("anyroute-MEI");
    expect(byId.codex?.verdict).toBe("mixed");
    expect(byId.pi?.verdict).toBe("ocx");
    expect(byId.pi?.launcher).toBe("paseo: ocx-pi");
    expect(byId.grok?.verdict).toBe("ocx");
    expect(byId.opencode?.verdict).toBe("direct");
    expect(byId.agy?.verdict).toBe("missing");

    const blob = JSON.stringify(snapshot);
    for (const forbidden of ["apiKey", "api_key", "AUTH_TOKEN", "sk-", "settings_config", "experimental_bearer"]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});
