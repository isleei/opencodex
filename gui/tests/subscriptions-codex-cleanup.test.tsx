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

const CODEX_MAIN = {
  id: "codex-main-account",
  email: "real_user@example.com",
  plan: "team",
  isMain: true,
  quota: {
    shortPercent: 20,
    shortResetAt: Math.floor(Date.now() / 1000) + 1800,
    weeklyPercent: 60,
    weeklyResetAt: Math.floor(Date.now() / 1000) + 86400 * 3,
    resetCredits: 1,
    updatedAt: Date.now() - 60000,
  },
};

const CODEX_POOL = {
  id: "codex-pool-1",
  email: "pool_user@example.com",
  plan: "team",
  isMain: false,
  quota: {
    shortPercent: 10,
    shortResetAt: Math.floor(Date.now() / 1000) + 3600,
    weeklyPercent: 30,
    weeklyResetAt: Math.floor(Date.now() / 1000) + 86400 * 5,
    resetCredits: 0,
    updatedAt: Date.now() - 120000,
  },
};

// Mirrors the backend agyQuotaGroups shape: percents are USED%.
const AGY_ACCOUNT = {
  id: "agy-test-account",
  email: "agy_user@example.com",
  quota: {
    updatedAt: Date.now() - 60000,
    agyQuotaGroups: [
      {
        id: "gemini",
        windows: [
          { window: "weekly", percent: 24.46, resetAt: Date.now() + 86400 * 1000 },
          { window: "5h", percent: 37.03, resetAt: Date.now() + 3600 * 1000 },
        ],
      },
      {
        id: "claude-gpt",
        windows: [
          { window: "weekly", percent: 0, resetAt: Date.now() + 86400 * 1000 },
          { window: "5h", percent: 0, resetAt: Date.now() + 3600 * 1000 },
        ],
      },
    ],
  },
};

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

  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL | Request) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("/api/codex-auth/accounts")) {
      return new Response(JSON.stringify({ accounts: [CODEX_MAIN, CODEX_POOL] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("/api/oauth/accounts")) {
      if (urlStr.includes("google-antigravity")) {
        return new Response(JSON.stringify({ accounts: [AGY_ACCOUNT] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ accounts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
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
  globalThis.fetch = originalFetch;
});

async function mountSubscriptions() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Subscriptions apiBase="http://127.0.0.1:10100" />
      </LanguageProvider>
    );
  });
  // Flush microtasks
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });
  }
}

test("Codex subscriptions: does not render fake API service card, mock team name, or mock expiry", async () => {
  await mountSubscriptions();
  const text = host.textContent || "";

  // 1. Fake API service card must be completely absent
  expect(text).not.toContain("API 服务");
  expect(text).not.toContain("服务端点");
  expect(text).not.toContain("agt_codex_7921bf38a209");
  expect(text).not.toContain("本地代理服务在线");

  // 2. Fake team name and passkey strings must be absent
  expect(text).not.toContain("MyTeam");
  expect(text).not.toContain("使用 passkey 登录");
  expect(text).not.toContain("102***88c");

  // 3. Fake subscription expiry banner must be absent
  expect(text).not.toContain("订阅有效期 6天");
  expect(text).not.toContain("2026-09-10 15:17");

  // 4. Real account data must be present
  expect(text).toContain("real_user@example.com");
  expect(text).toContain("pool_user@example.com");
  expect(text).toContain("5h 滚动限额");
  expect(text).toContain("Weekly 每周限额");
  expect(text).toContain("重置 1");

  // 5. Codex cards show used% like the Providers page (fixture: 5h used 20%,
  // weekly used 60%), not remaining% (80%/40%).
  expect(text).toContain("20%");
  expect(text).toContain("60%");
  expect(text).not.toContain("80%");
  expect(text).not.toContain("40%");
});

test("AGY subscriptions: shows used% matching the Providers page, not remaining%", async () => {
  await mountSubscriptions();
  const text = host.textContent || "";

  // Fixture: gemini 5h used 37.03%, weekly used 24.46% — Providers shows "37%"/"24%".
  expect(text).toContain("agy_user@example.com");
  expect(text).toContain("37%");
  expect(text).toContain("24%");
  // Remaining-portrait values must be gone: 100-37.03=62.97, 100-24.46=75.54.
  expect(text).not.toContain("62.97");
  expect(text).not.toContain("75.54");
});
