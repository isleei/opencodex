import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../src/server/management-api";
import { saveConfig } from "../src/config";
import { clearModelCache, getFreshCached, setCached } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const TEST_DIR = join(tmpdir(), `ocx-refresh-models-${process.pid}`);
const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearModelCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function baseConfig(providers: OcxConfig["providers"]): OcxConfig {
  if (globalThis.fetch !== originalFetch) {
    for (const provider of Object.values(providers)) {
      (provider as typeof provider & { fetch?: typeof fetch }).fetch = globalThis.fetch;
    }
  }
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0]!,
    providers,
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function refresh(
  config: OcxConfig,
  name: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://127.0.0.1/api/providers/refresh-models?name=${encodeURIComponent(name)}`, {
    method: "POST",
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    refreshCodexCatalog: async () => undefined,
  });
  if (!res) throw new Error("handler returned no response");
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe("POST /api/providers/refresh-models", () => {
  test("unknown provider returns 404", async () => {
    const config = baseConfig({
      live: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
      },
    });
    const { status, body } = await refresh(config, "missing");
    expect(status).toBe(404);
    expect(body.error).toBe("unknown provider");
  });

  test("static catalog returns configured models without upstream fetch", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [{ id: "should-not-load" }] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({
      staticprov: {
        adapter: "openai-chat",
        baseUrl: "https://static.example.test/v1",
        apiKey: "sk-x",
        liveModels: false,
        models: ["m-1", "m-2"],
      },
    });
    const { status, body } = await refresh(config, "staticprov");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("static");
    expect(body.models).toEqual(["m-1", "m-2"]);
    expect(body.count).toBe(2);
    expect(fetches).toBe(0);
  });

  test("clears the TTL cache and re-fetches live models", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        data: [{ id: "fresh-a" }, { id: "fresh-b" }],
      }), { status: 200 });
    }) as typeof fetch;

    const config = baseConfig({
      live: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
        allowPrivateNetwork: true,
      },
    });
    // Stale-looking cache that would otherwise win within the 5-minute TTL.
    setCached("live", [
      { id: "stale-only", provider: "live" },
    ]);
    expect(getFreshCached("live", 5 * 60 * 1000)?.map(m => m.id)).toEqual(["stale-only"]);

    const { status, body } = await refresh(config, "live");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("live");
    expect(body.persisted).toBe(true);
    expect(body.models).toEqual(["fresh-a", "fresh-b"]);
    expect(body.count).toBe(2);
    expect(fetches).toBe(1);
    expect(getFreshCached("live", 5 * 60 * 1000)?.map(m => m.id)).toEqual(["fresh-a", "fresh-b"]);
    // Discovered ids are written into the provider config so they survive restart.
    expect(config.providers.live?.models).toEqual(["fresh-a", "fresh-b"]);
  });

  test("upstream failure returns ok:false and does not overwrite configured models", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
    const config = baseConfig({
      live: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
        models: ["configured-fallback"],
        allowPrivateNetwork: true,
      },
    });
    const { status, body } = await refresh(config, "live");
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.source).toBe("fallback");
    expect(body.persisted).toBe(false);
    expect(body.models).toEqual(["configured-fallback"]);
    expect(String(body.error)).toContain("503");
    expect(config.providers.live?.models).toEqual(["configured-fallback"]);
  });

  test("prunes selectedModels that no longer exist upstream after a live fetch", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "kept" }, { id: "new-live" }],
    }), { status: 200 })) as typeof fetch;
    const config = baseConfig({
      live: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
        models: ["old"],
        selectedModels: ["kept", "gone"],
        allowPrivateNetwork: true,
      },
    });
    const { body } = await refresh(config, "live");
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(true);
    expect(config.providers.live?.models).toEqual(["kept", "new-live"]);
    expect(config.providers.live?.selectedModels).toEqual(["kept"]);
  });

  test("GET /api/selected-models includes configured media-gen ids the catalog hides", async () => {
    // Simulate a live chat catalog that already filtered imagine-* out of the gather path,
    // while providers[name].models still holds the full refresh-models persist.
    setCached("grok2api", [
      { id: "grok-4.5", provider: "grok2api" },
      { id: "grok-chat-fast", provider: "grok2api" },
    ]);
    const { markProviderDiscoveryOk } = await import("../src/codex/model-cache");
    markProviderDiscoveryOk("grok2api", 2);
    const config = baseConfig({
      grok2api: {
        adapter: "openai-chat",
        baseUrl: "https://a.2008020.xyz/v1",
        apiKey: "sk-x",
        liveModels: true,
        models: [
          "grok-4.5",
          "grok-imagine-video-1.5",
          "grok-imagine-image",
          "grok-chat-fast",
        ],
        allowPrivateNetwork: true,
      },
    });
    // Avoid re-hitting upstream — serve from the cache we just seeded.
    globalThis.fetch = (async () => {
      throw new Error("selected-models must use the cache, not re-fetch");
    }) as typeof fetch;
    const req = new Request("http://127.0.0.1/api/selected-models");
    const res = await handleManagementAPI(req, new URL(req.url), config, {});
    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      available: Record<string, string[]>;
      liveModelCounts: Record<string, number>;
      refreshing?: boolean;
    };
    expect(body.liveModelCounts.grok2api).toBe(2);
    expect(body.refreshing).toBe(false);
    expect(body.available.grok2api).toEqual([
      "grok-4.5",
      "grok-chat-fast",
      "grok-imagine-video-1.5",
      "grok-imagine-image",
    ]);
  });

  test("GET /api/selected-models returns configured seeds immediately without waiting on slow upstream", async () => {
    let fetchStarted = 0;
    globalThis.fetch = (async () => {
      fetchStarted += 1;
      // Never resolve during this test — a blocking gather would hang the request.
      await new Promise(() => {});
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({
      slow: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
        liveModels: true,
        models: ["seed-a", "seed-b", "grok-imagine-image"],
      },
    });
    const started = Date.now();
    const req = new Request("http://127.0.0.1/api/selected-models");
    const res = await handleManagementAPI(req, new URL(req.url), config, {});
    const elapsedMs = Date.now() - started;
    expect(res?.status).toBe(200);
    const body = await res!.json() as {
      available: Record<string, string[]>;
      refreshing?: boolean;
    };
    // Must not block on the hung upstream (8s timeout). Local seeds only.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(body.refreshing).toBe(true);
    expect(body.available.slow).toEqual(["seed-a", "seed-b", "grok-imagine-image"]);
    // Background kick may or may not have scheduled yet; either way the response is done.
    expect(fetchStarted).toBeGreaterThanOrEqual(0);
  });

  test("disabled provider is rejected without discovery", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({
      live: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
        disabled: true,
      },
    });
    const { status, body } = await refresh(config, "live");
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Provider is disabled");
    expect(fetches).toBe(0);
  });
});
