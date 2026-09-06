/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subscriptions from "../src/pages/Subscriptions";
import { LanguageProvider } from "../src/i18n/provider";

// AGY switch honesty: a failed sync must surface the failing target with a
// retry affordance — never a success message — and retrying the current
// account must re-run the sync.

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const ACCOUNT_A = { id: "agy-account-a", email: "a***a@example.com" };
const ACCOUNT_B = { id: "agy-account-b", email: "b***b@example.com" };

let putCalls: Array<{ accountId: string }>;
let putMode: "fail-cli" | "ok";
let snapshotCliMatch = true;
// A failed switch leaves the native files behind the new proxy account, so
// the snapshot must report mismatch until a later write heals it. An
// explicit override models an out-of-band fix (no new PUT involved).
let lastPutFailed = false;
let snapshotOverride: boolean | null = null;

function agyList(activeId: string) {
  const match = snapshotOverride ?? (lastPutFailed ? false : snapshotCliMatch);
  return {
    activeAccountId: activeId,
    accounts: [
      { ...ACCOUNT_A, active: activeId === ACCOUNT_A.id },
      { ...ACCOUNT_B, active: activeId === ACCOUNT_B.id },
    ],
    agySync: {
      cli: { filePresent: true, matchesActive: match, keyringPresent: true, keyringMatchesActive: match },
      ide: { installed: false },
      nativeKeyring: "unsupported",
    },
  };
}

function installFetch(activeIdRef: { current: string }) {
  putCalls = [];
  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("/api/oauth/accounts/active") && (init?.method === "PUT" || url instanceof Request)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { accountId?: string };
      putCalls.push({ accountId: body.accountId ?? "" });
      if (putMode === "fail-cli") {
        lastPutFailed = true;
        activeIdRef.current = body.accountId ?? activeIdRef.current;
        return new Response(
          JSON.stringify({
            ok: false,
            provider: "google-antigravity",
            activeAccountId: activeIdRef.current,
            requestedTargets: ["cli", "ide"],
            code: "AGY_SWITCH_CLI_FAILED",
            message: "Proxy account switched, but CLI sync failed (AGY_CLI_WRITE_FAILED).",
            cli: {
              target: "cli",
              status: "failed",
              code: "AGY_CLI_WRITE_FAILED",
              message: "CLI credential write failed (disk full); previous credentials were restored.",
              retryable: true,
            },
            ide: { target: "ide", status: "not_installed", code: "AGY_IDE_NOT_INSTALLED", retryable: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      activeIdRef.current = body.accountId ?? activeIdRef.current;
      lastPutFailed = false;
      return new Response(
        JSON.stringify({
          ok: true,
          provider: "google-antigravity",
          activeAccountId: activeIdRef.current,
          requestedTargets: ["cli", "ide"],
          code: "AGY_SWITCH_CLI_ONLY_NO_IDE",
          message: "Proxy account switched and CLI credentials verified.",
          cli: { target: "cli", status: "synced", code: "AGY_CLI_SYNCED", retryable: false },
          ide: { target: "ide", status: "not_installed", code: "AGY_IDE_NOT_INSTALLED", retryable: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("provider=google-antigravity")) {
      return new Response(JSON.stringify(agyList(activeIdRef.current)), {
        status: 200,
        headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("/api/codex-auth/accounts")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ accounts: [], activeAccountId: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" } },
    );
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  putMode = "fail-cli";
  snapshotCliMatch = true;
  lastPutFailed = false;
  snapshotOverride = null;
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

function switchButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button[title="设为当前活跃账号"]')) as HTMLButtonElement[];
}

function retryButton(): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
  return buttons.find(b => (b.textContent ?? "").includes("Retry sync for current account")) ?? null;
}

function refreshButton(): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
  return buttons.find(b => (b.textContent ?? "").includes("Refresh all quotas")) ?? null;
}

test("sync panel shows proxy, CLI, and IDE states without claiming success", async () => {
  const activeIdRef = { current: ACCOUNT_A.id };
  installFetch(activeIdRef);
  await mountSubscriptions();
  const body = text();
  expect(body.includes("Proxy active account")).toBe(true);
  expect(body.includes("CLI credentials")).toBe(true);
  expect(body.includes("IDE sync")).toBe(true);
  // Snapshot: CLI verified, IDE absent — neither may read as a failure or a false full success.
  expect(body.includes("synced")).toBe(true);
  expect(body.includes("not installed")).toBe(true);
});

test("failed CLI sync reports the failing target and offers retry; retry succeeds", async () => {
  const activeIdRef = { current: ACCOUNT_A.id };
  installFetch(activeIdRef);
  await mountSubscriptions();

  const buttons = switchButtons();
  expect(buttons.length).toBe(1);
  await act(async () => {
    buttons[0]!.click();
    await new Promise(r => setTimeout(r, 50));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 50));
  });

  expect(putCalls.length).toBe(1);
  expect(putCalls[0]!.accountId).toBe(ACCOUNT_B.id);
  // No success message after a failed sync.
  expect(text().includes("Switched active account to")).toBe(false);
  expect(text().includes("CLI sync needs attention")).toBe(true);

  const retry = retryButton();
  expect(retry).not.toBeNull();
  expect(retry!.disabled).toBe(false);

  putMode = "ok";
  await act(async () => {
    retry!.click();
    await new Promise(r => setTimeout(r, 50));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 50));
  });

  expect(putCalls.length).toBe(2);
  expect(putCalls[1]!.accountId).toBe(ACCOUNT_B.id);
  expect(text().includes("Switched to")).toBe(true);
});

test("same-account drift supersedes a recorded success instead of freezing synced", async () => {
  // Finding 5: PUT reports cli synced, but the fresh GET shows the native
  // store drifted. The panel must follow the snapshot (failed + retry),
  // not the stale historical result.
  const activeIdRef = { current: ACCOUNT_A.id };
  installFetch(activeIdRef);
  putMode = "ok";
  snapshotCliMatch = false;
  await mountSubscriptions();

  const buttons = switchButtons();
  expect(buttons.length).toBe(1);
  await act(async () => {
    buttons[0]!.click();
    await new Promise(r => setTimeout(r, 50));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 100));
  });

  expect(putCalls.length).toBe(1);
  const body = text();
  expect(body.includes("CLI credentials: failed")).toBe(true);
  expect(body.includes("CLI credentials: synced")).toBe(false);
  expect(body.includes("needs attention")).toBe(true);
  const retry = retryButton();
  expect(retry).not.toBeNull();
  expect(retry!.disabled).toBe(false);
});

test("external healing supersedes a recorded failure on refresh", async () => {
  // Finding 5: PUT failed, then the native store was fixed outside this
  // panel. A fresh GET reporting a match must clear the stale failure and
  // show the true synced state.
  const activeIdRef = { current: ACCOUNT_A.id };
  installFetch(activeIdRef);
  await mountSubscriptions();

  const buttons = switchButtons();
  expect(buttons.length).toBe(1);
  await act(async () => {
    buttons[0]!.click();
    await new Promise(r => setTimeout(r, 50));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 100));
  });
  expect(text().includes("CLI sync needs attention")).toBe(true);

  // Healed outside the panel; the next authoritative read wins.
  snapshotOverride = true;
  const refresh = refreshButton();
  expect(refresh).not.toBeNull();
  await act(async () => {
    refresh!.click();
    await new Promise(r => setTimeout(r, 50));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 100));
  });

  const body = text();
  expect(body.includes("CLI credentials: synced")).toBe(true);
  expect(body.includes("CLI sync needs attention")).toBe(false);
});
