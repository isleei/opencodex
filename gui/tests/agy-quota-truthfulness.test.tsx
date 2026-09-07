/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subscriptions from "../src/pages/Subscriptions";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const UPDATED_AT = 1_786_000_000_000;

function summaryQuota() {
  return { updatedAt: UPDATED_AT, agyQuotaGroups: [
    { id: "gemini", windows: [{ window: "weekly", percent: 5.25939, resetAt: UPDATED_AT + 86400000 }, { window: "5h", percent: 0 }] },
    { id: "claude-gpt", windows: [{ window: "weekly", percent: 100 }, { window: "5h", percent: 20 }] },
  ] };
}
function installFetch(quota: unknown = summaryQuota(), unavailable = false) {
  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL | Request) => {
    if (String(url).includes("provider=google-antigravity")) return Response.json({
      activeAccountId: "agy-full", accounts: [{ id: "agy-full", email: "fixture@example.com", quota, quotaUnavailable: unavailable }],
    });
    if (String(url).includes("/api/codex-auth/accounts")) return Response.json([]);
    return Response.json({ accounts: [], activeAccountId: null });
  };
}
function installStaleFetch() { installFetch(summaryQuota(), true); }

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => {
      current.unmount();
    });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function mountSubscriptions() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Subscriptions apiBase="http://127.0.0.1:10100" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 50));
  });
}

function text(): string {
  return host.textContent ?? "";
}

test("AGY shows the weekly subscription usage hidden by a full catalog", async () => {
  installFetch(); await mountSubscriptions();
  expect(text()).toContain("94.74% remaining");
  expect(text()).toContain("100% remaining");
  expect(text()).toContain("0% remaining");
  expect(text()).toContain("80% remaining");
  expect(text()).toContain("Gemini"); expect(text()).toContain("Claude / GPT");
  expect(text()).toContain("Weekly"); expect(text()).toContain("5-hour");
  expect(text()).toContain("Reset unknown"); expect(text()).toContain("Observed");
  expect(text()).not.toContain("Sampled from");
});
test("failed summary keeps a visibly stale reading and its observation time", async () => {
  installStaleFetch(); await mountSubscriptions();
  expect(text()).toContain("Cached reading — out of date");
  expect(text()).toContain("94.74% remaining");
  expect(host.querySelectorAll(".cockpit-progress-fill.stale")).toHaveLength(4);
});
test("pre-fix all-full model cache is unknown, never subscription quota", async () => {
  installFetch({ updatedAt: UPDATED_AT, agyModels: [{ modelId: "gemini-a", percent: 0 }] });
  await mountSubscriptions(); expect(text()).toContain("Quota unknown");
  expect(text()).not.toContain("100% remaining");
});

test("AGY renders while an unrelated provider request is still pending", async () => {
  installFetch();
  const fetchReady = globalThis.fetch;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL | Request) => {
    if (String(url).includes("provider=xai")) await pending;
    return fetchReady(url);
  };
  try {
    await mountSubscriptions();
    expect(text()).toContain("Gemini");
    expect(text()).toContain("100% remaining");
  } finally {
    await act(async () => { finish(); await pending; });
  }
});


test("failed AGY quota retries automatically and stops after recovery", async () => {
  installStaleFetch();
  const realSetTimeout = testWindow.setTimeout.bind(testWindow);
  let retry: (() => void) | undefined;
  let retries = 0;
  testWindow.setTimeout = ((handler: () => void, delay?: number) => {
    if (delay === 30000) { retry = handler; retries++; }
    return realSetTimeout(handler, delay);
  }) as typeof testWindow.setTimeout;
  await mountSubscriptions();
  expect(text()).toContain("Cached reading — out of date");
  expect(retry).toBeDefined();
  installFetch();
  const fetchRecovered = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL | Request) => {
    const response = await fetchRecovered(url);
    if (!String(url).includes("provider=google-antigravity")) return response;
    const body = await response.json();
    body.accounts = body.accounts.filter((a: { quota: unknown }) => a.quota);
    return new Response(JSON.stringify(body));
  };
  await act(async () => { retry!(); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(text()).toContain("100% remaining");
  expect(text()).not.toContain("Cached reading — out of date");
  expect(retries).toBe(1);
});


test("background refresh paints the cached reading first and polls only AGY", async () => {
  installFetch();
  const ready = globalThis.fetch;
  const calls: string[] = [];
  let updated = false;
  let poll: (() => void) | undefined;
  const realTimer = testWindow.setTimeout.bind(testWindow);
  testWindow.setTimeout = ((handler: () => void, delay?: number) => {
    if (delay === 2000) poll = handler;
    return realTimer(handler, delay);
  }) as typeof testWindow.setTimeout;
  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    const response = await ready(url);
    if (!String(url).includes("provider=google-antigravity")) return response;
    const body = await response.json();
    body.accounts[0].quotaStale = !updated;
    body.accounts[0].quotaRefreshing = !updated;
    if (updated) body.accounts[0].quota.agyQuotaGroups[0].windows[0].percent = 10;
    return Response.json(body);
  };
  await mountSubscriptions();
  expect(text()).toContain("94.74% remaining");
  expect(text()).toContain("Cached reading — out of date");
  expect(text()).toContain("Updating quota");
  const count = calls.length;
  updated = true;
  await act(async () => { poll!(); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(calls.slice(count)).toHaveLength(1);
  expect(calls[count]).toContain("provider=google-antigravity");
  expect(text()).toContain("90% remaining");
  expect(text()).not.toContain("Cached reading — out of date");
});
