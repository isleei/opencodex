import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectPiModels, removePiModels, readPiModelsStatus } from "../src/pi/models";
import { readPiSettings, writePiSettings, validatePiSettingsPatch } from "../src/pi/settings";
import { validatePiPackageSource } from "../src/pi/packages";
import { readPiExtensions } from "../src/pi/extensions";

let piHome: string;

beforeEach(() => {
  piHome = mkdtempSync(join(tmpdir(), "ocx-pi-"));
  mkdirSync(join(piHome, "agent"), { recursive: true });
});

afterEach(() => {
  rmSync(piHome, { recursive: true, force: true });
});

describe("injectPiModels", () => {
  test("upserts only providers.opencodex and preserves siblings", () => {
    const modelsPath = join(piHome, "agent", "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "llama" }] },
      },
    }, null, 2));

    const result = injectPiModels(10100, [
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000 },
    ], { hostname: "127.0.0.1", piHome });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const doc = JSON.parse(readFileSync(modelsPath, "utf8"));
    expect(doc.providers.ollama.models[0].id).toBe("llama");
    expect(doc.providers.opencodex.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(doc.providers.opencodex.models[0].id).toBe("anthropic/claude-opus-5");
    expect(readPiModelsStatus({ piHome }).present).toBe(true);
  });

  test("refuses non-loopback", () => {
    const result = injectPiModels(10100, [], { hostname: "10.0.0.5", piHome });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.skippedReason).toBe("non-loopback");
  });

  test("remove deletes only opencodex", () => {
    injectPiModels(10100, [
      { namespaced: "x", provider: "x", id: "x" },
    ], { hostname: "127.0.0.1", piHome });
    const modelsPath = join(piHome, "agent", "models.json");
    const doc = JSON.parse(readFileSync(modelsPath, "utf8"));
    doc.providers.other = { baseUrl: "http://x", api: "openai-completions", apiKey: "k", models: [] };
    writeFileSync(modelsPath, JSON.stringify(doc, null, 2));

    const result = removePiModels({ piHome });
    expect(result.changed).toBe(true);
    const next = JSON.parse(readFileSync(modelsPath, "utf8"));
    expect(next.providers.opencodex).toBeUndefined();
    expect(next.providers.other).toBeDefined();
  });

  test("remove keeps providers key so Pi schema stays valid", () => {
    injectPiModels(10100, [
      { namespaced: "only/one", provider: "only", id: "one" },
    ], { hostname: "127.0.0.1", piHome });
    const modelsPath = join(piHome, "agent", "models.json");
    const result = removePiModels({ piHome });
    expect(result.changed).toBe(true);
    const next = JSON.parse(readFileSync(modelsPath, "utf8"));
    // Bare `{}` fails Pi: "must have required properties providers".
    expect(next).toEqual({ providers: {} });
  });
});

describe("settings", () => {
  test("patch merges curated keys and preserves others", () => {
    const settingsPath = join(piHome, "agent", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark", lastChangelogVersion: "0.1" }, null, 2));
    const result = writePiSettings({ defaultProvider: "opencodex", theme: "light" }, { piHome });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(doc.defaultProvider).toBe("opencodex");
    expect(doc.theme).toBe("light");
    expect(doc.lastChangelogVersion).toBe("0.1");
    expect(readPiSettings({ piHome }).otherKeyCount).toBeGreaterThan(0);
  });

  test("rejects packages key in settings PUT", () => {
    const v = validatePiSettingsPatch({ packages: ["evil"] });
    expect(v.ok).toBe(false);
  });
});

describe("packages source validation", () => {
  test("accepts npm and git forms", () => {
    expect(validatePiPackageSource("npm:@foo/bar")).toBeNull();
    expect(validatePiPackageSource("git:github.com/user/repo")).toBeNull();
    expect(validatePiPackageSource("https://github.com/user/repo")).toBeNull();
  });
  test("rejects shell metacharacters", () => {
    expect(validatePiPackageSource("npm:foo;rm -rf /")).not.toBeNull();
    expect(validatePiPackageSource("a|b")).not.toBeNull();
  });
});

describe("extensions inventory", () => {
  test("lists auto-discovered ts files", () => {
    const dir = join(piHome, "agent", "extensions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "demo.ts"), "export default () => {}");
    writeFileSync(join(dir, "readme.md"), "# no");
    const status = readPiExtensions({ piHome });
    expect(status.entries.some(e => e.name === "demo.ts")).toBe(true);
    expect(status.entries.some(e => e.name === "readme.md")).toBe(false);
  });
});
