import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const item = {
  name: "openrouter",
  adapter: "openai-chat",
  baseUrl: "https://openrouter.ai/api/v1",
  models: ["old-model"],
  liveModels: true,
} as WorkspaceItem;

async function mount(
  providerItem = item,
  onRefreshModels?: (result?: { models: string[]; liveModelCount?: number; persisted?: boolean }) => void | Promise<void>,
): Promise<{
  root: Root;
  container: HTMLElement;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderModels
          item={providerItem}
          availableModels={providerItem.models ?? []}
          hasLiveModels
          selectedModels={[]}
          apiBase="http://localhost:10100"
          onRefreshModels={onRefreshModels}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { root, container };
}

test("Fetch models button posts refresh-models and reloads the workspace list", async () => {
  const posts: string[] = [];
  let lastResult: { models: string[]; persisted?: boolean } | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!init?.method || init.method === "GET") {
      if (url.includes("/api/custom-models")) return Response.json([]);
      return Response.json({});
    }
    posts.push(url);
    return Response.json({
      ok: true,
      provider: "openrouter",
      models: ["fresh-a", "fresh-b"],
      count: 2,
      source: "live",
      persisted: true,
      liveModelCount: 2,
      latencyMs: 12,
    });
  }) as typeof fetch;

  const { root, container } = await mount(item, async (result) => { lastResult = result; });
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Fetch models"]');
  expect(button).toBeTruthy();

  await act(async () => {
    button!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(posts).toEqual([
    "http://localhost:10100/api/providers/refresh-models?name=openrouter",
  ]);
  expect(lastResult).toEqual({ models: ["fresh-a", "fresh-b"], liveModelCount: 2, persisted: true });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Fetched and saved 2 models");

  await act(async () => { root.unmount(); });
});

test("Fetch models is hidden for static-catalog providers", async () => {
  globalThis.fetch = (async () => Response.json([])) as typeof fetch;
  const { root, container } = await mount({
    ...item,
    liveModels: false,
  } as WorkspaceItem);
  expect(container.querySelector('button[aria-label="Fetch models"]')).toBeNull();
  await act(async () => { root.unmount(); });
});
