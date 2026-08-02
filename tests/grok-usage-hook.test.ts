import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROK_USAGE_HOOK_MARKER,
  installGrokUsageHooks,
  stripGrokUsageHooks,
} from "../src/grok/usage-hook";
import { stripGrokConfig } from "../src/grok/inject";
import { syncGrokConfig } from "../src/grok/sync";
import { injectGrokConfig } from "../src/grok/inject";
import type { OcxConfig } from "../src/types";

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-hook-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

describe("Grok usage hook install/strip", () => {
  test("installs managed manifest + report.mjs under hooks/", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = installGrokUsageHooks({ grokHome });
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.homes).toEqual([grokHome]);

      const manifestPath = join(grokHome, "hooks", "opencodex-usage.json");
      const scriptPath = join(grokHome, "hooks", "opencodex-usage", "report.mjs");
      expect(existsSync(manifestPath)).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);

      const manifest = readFileSync(manifestPath, "utf8");
      expect(manifest).toContain(GROK_USAGE_HOOK_MARKER);
      expect(manifest).toContain("Stop");
      expect(manifest).toContain("SessionEnd");
      expect(manifest).toContain(scriptPath);

      // Idempotent.
      const again = installGrokUsageHooks({ grokHome });
      expect(again.ok).toBe(true);
      expect(again.changed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strip removes only managed hook files", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      installGrokUsageHooks({ grokHome });
      const userHook = join(grokHome, "hooks", "my-other.json");
      mkdirSync(join(grokHome, "hooks"), { recursive: true });
      writeFileSync(userHook, JSON.stringify({ hooks: {} }), "utf8");

      const stripped = stripGrokUsageHooks({ grokHome });
      expect(stripped.ok).toBe(true);
      expect(stripped.changed).toBe(true);
      expect(existsSync(join(grokHome, "hooks", "opencodex-usage.json"))).toBe(false);
      expect(existsSync(join(grokHome, "hooks", "opencodex-usage"))).toBe(false);
      expect(existsSync(userHook)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("syncGrokConfig installs the usage hook alongside the model fence", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
      const result = await syncGrokConfig(10191, config, { grokHome }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(join(grokHome, "hooks", "opencodex-usage.json"))).toBe(true);
      expect(existsSync(join(grokHome, "config.toml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stripGrokConfig also removes the usage hook", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      installGrokUsageHooks({ grokHome });
      writeFileSync(join(grokHome, "config.toml"), "# empty\n", "utf8");
      const result = stripGrokConfig({ grokHome });
      expect(result.ok).toBe(true);
      expect(existsSync(join(grokHome, "hooks", "opencodex-usage.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
