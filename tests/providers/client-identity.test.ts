import { describe, expect, test } from "bun:test";
import {
  classifyModelFamily,
  extractPassthroughHeaders,
  resolveClientIdentityHeaders,
  CLAUDE_CODE_FINGERPRINT,
  CODEX_CLI_FINGERPRINT,
  GROK_BUILD_FINGERPRINT,
  AGY_CLI_FINGERPRINT,
} from "../../src/adapters/client-fingerprint";
import { validateConfigCandidate } from "../../src/config";
import type { OcxProviderConfig } from "../../src/types/provider";

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

describe("classifyModelFamily", () => {
  test("identifies Claude / Anthropic models", () => {
    expect(classifyModelFamily("claude-3-7-sonnet-20250219")).toBe("claude");
    expect(classifyModelFamily("claude-3-5-haiku-20241022")).toBe("claude");
    expect(classifyModelFamily("anthropic/claude-3-opus")).toBe("claude");
    expect(classifyModelFamily("CLAUDE-4-SONNET")).toBe("claude");
  });

  test("identifies OpenAI / ChatGPT / o-series models", () => {
    expect(classifyModelFamily("gpt-4o")).toBe("gpt");
    expect(classifyModelFamily("gpt-4.5-preview")).toBe("gpt");
    expect(classifyModelFamily("gpt-5")).toBe("gpt");
    expect(classifyModelFamily("chatgpt-4o-latest")).toBe("gpt");
    expect(classifyModelFamily("o1")).toBe("gpt");
    expect(classifyModelFamily("o1-preview")).toBe("gpt");
    expect(classifyModelFamily("o3-mini")).toBe("gpt");
    expect(classifyModelFamily("o4-high")).toBe("gpt");
  });

  test("identifies Grok models", () => {
    expect(classifyModelFamily("grok-2")).toBe("grok");
    expect(classifyModelFamily("grok-beta")).toBe("grok");
    expect(classifyModelFamily("grok-3-mini")).toBe("grok");
    expect(classifyModelFamily("xai/grok-4")).toBe("grok");
  });

  test("identifies Gemini and Antigravity models", () => {
    expect(classifyModelFamily("gemini-2.0-flash")).toBe("agy");
    expect(classifyModelFamily("gemini-1.5-pro-latest")).toBe("agy");
    expect(classifyModelFamily("google/gemini-2.5-ultra")).toBe("agy");
    expect(classifyModelFamily("antigravity/gemini-3")).toBe("agy");
  });

  test("returns unknown for unclassified models or empty strings", () => {
    expect(classifyModelFamily("deepseek-chat")).toBe("unknown");
    expect(classifyModelFamily("qwen-2.5-coder")).toBe("unknown");
    expect(classifyModelFamily("llama-3.3-70b")).toBe("unknown");
    expect(classifyModelFamily("")).toBe("unknown");
    expect(classifyModelFamily(undefined)).toBe("unknown");
  });
});

describe("extractPassthroughHeaders", () => {
  test("extracts client fingerprint headers and drops sensitive credentials and hop-by-hop headers", () => {
    const rawIncoming = {
      "user-agent": "Claude-Code/0.2.29 (Darwin; arm64)",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "originator": "codex_cli_rs",
      "x-client-request-id": "req-12345",
      "authorization": "Bearer sk-secret-token",
      "cookie": "session=sensitive",
      "host": "localhost:8080",
      "connection": "keep-alive",
      "content-length": "42",
      "content-type": "application/json",
      "accept-encoding": "gzip",
    };

    const extracted = extractPassthroughHeaders(rawIncoming);
    expect(extracted).toEqual({
      "user-agent": "Claude-Code/0.2.29 (Darwin; arm64)",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "originator": "codex_cli_rs",
      "x-client-request-id": "req-12345",
    });

    expect(getHeader(extracted, "authorization")).toBeUndefined();
    expect(getHeader(extracted, "cookie")).toBeUndefined();
    expect(getHeader(extracted, "host")).toBeUndefined();
    expect(getHeader(extracted, "content-type")).toBeUndefined();
  });

  test("handles web standard Headers instances", () => {
    const headers = new Headers();
    headers.set("User-Agent", "codex_cli_rs/0.48.0");
    headers.set("originator", "codex_cli_rs");
    headers.set("Authorization", "Bearer sk-test");

    const extracted = extractPassthroughHeaders(headers);
    expect(getHeader(extracted, "user-agent")).toBe("codex_cli_rs/0.48.0");
    expect(getHeader(extracted, "originator")).toBe("codex_cli_rs");
    expect(getHeader(extracted, "authorization")).toBeUndefined();
  });

  test("returns empty record if incoming is empty or undefined", () => {
    expect(extractPassthroughHeaders(undefined)).toEqual({});
    expect(extractPassthroughHeaders({})).toEqual({});
  });
});

describe("resolveClientIdentityHeaders", () => {
  const baseProvider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
  };

  test("returns empty headers when mode is omitted or none", () => {
    expect(resolveClientIdentityHeaders(baseProvider, "claude-3-5-sonnet")).toEqual({});
    expect(resolveClientIdentityHeaders({ ...baseProvider, clientIdentity: "none" }, "gpt-4o")).toEqual({});
  });

  test("resolves auto mode based on model family", () => {
    const autoProvider: OcxProviderConfig = { ...baseProvider, clientIdentity: "auto" };

    // Claude
    const claudeHeaders = resolveClientIdentityHeaders(autoProvider, "claude-3-7-sonnet-20250219");
    expect(getHeader(claudeHeaders, "user-agent")).toContain("claude-code");
    expect(getHeader(claudeHeaders, "x-app")).toBe("cli");
    expect(getHeader(claudeHeaders, "x-stainless-lang")).toBe("js");

    // OpenAI
    const gptHeaders = resolveClientIdentityHeaders(autoProvider, "gpt-4o");
    expect(getHeader(gptHeaders, "user-agent")).toContain("codex_cli_rs");
    expect(getHeader(gptHeaders, "originator")).toBe("codex_cli_rs");

    // Grok
    const grokHeaders = resolveClientIdentityHeaders(autoProvider, "grok-2");
    expect(getHeader(grokHeaders, "user-agent")).toContain("grok-shell");

    // AGY
    const agyHeaders = resolveClientIdentityHeaders(autoProvider, "gemini-2.0-flash");
    expect(getHeader(agyHeaders, "user-agent")).toContain("antigravity");

    // Unknown model yields no spoofed headers
    expect(resolveClientIdentityHeaders(autoProvider, "deepseek-chat")).toEqual({});
  });

  test("resolves explicit preset modes regardless of model", () => {
    const codexProvider: OcxProviderConfig = { ...baseProvider, clientIdentity: "codex" };
    expect(getHeader(resolveClientIdentityHeaders(codexProvider, "claude-3-5-sonnet"), "originator")).toBe("codex_cli_rs");

    const claudeProvider: OcxProviderConfig = { ...baseProvider, clientIdentity: "claude-code" };
    const claudeHeaders = resolveClientIdentityHeaders(claudeProvider, "gpt-4o");
    expect(getHeader(claudeHeaders, "user-agent")).toContain("claude-code");

    const grokProvider: OcxProviderConfig = { ...baseProvider, clientIdentity: "grok" };
    expect(getHeader(resolveClientIdentityHeaders(grokProvider, "gpt-4o"), "user-agent")).toContain("grok-shell");

    const agyProvider: OcxProviderConfig = { ...baseProvider, clientIdentity: "agy" };
    expect(getHeader(resolveClientIdentityHeaders(agyProvider, "gpt-4o"), "user-agent")).toContain("antigravity");
  });

  test("resolves passthrough mode using caller's request headers", () => {
    const passthroughProvider: OcxProviderConfig = { ...baseProvider, clientIdentity: "passthrough" };
    const incoming = {
      "user-agent": "custom-client/1.0",
      "x-app": "test-runner",
      "authorization": "Bearer secret",
    };

    const resolved = resolveClientIdentityHeaders(passthroughProvider, "any-model", incoming);
    expect(getHeader(resolved, "user-agent")).toBe("custom-client/1.0");
    expect(getHeader(resolved, "x-app")).toBe("test-runner");
    expect(getHeader(resolved, "authorization")).toBeUndefined();
  });

  test("respects user configured provider.headers with absolute precedence", () => {
    const providerWithUserHeaders: OcxProviderConfig = {
      ...baseProvider,
      clientIdentity: "auto",
      headers: {
        "User-Agent": "my-custom-agent/2.0",
        "X-Custom-Auth": "custom-val",
      },
    };

    // Even though model is claude, user-configured User-Agent should NOT be in the generated identity headers
    const resolved = resolveClientIdentityHeaders(providerWithUserHeaders, "claude-3-5-sonnet");
    expect(getHeader(resolved, "user-agent")).toBeUndefined();
    // Non-colliding keys from fingerprint are still provided
    expect(getHeader(resolved, "x-app")).toBe("cli");
  });
});

describe("clientIdentity in config schema validation", () => {
  const baseConfig = {
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.com/v1",
      },
    },
  };

  test("accepts valid clientIdentity modes", () => {
    for (const mode of ["auto", "passthrough", "codex", "claude-code", "grok", "agy", "none"] as const) {
      const result = validateConfigCandidate({
        ...baseConfig,
        providers: {
          test: {
            ...baseConfig.providers.test,
            clientIdentity: mode,
          },
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.providers.test.clientIdentity).toBe(mode);
      }
    }
  });

  test("rejects invalid clientIdentity modes", () => {
    const result = validateConfigCandidate({
      ...baseConfig,
      providers: {
        test: {
          ...baseConfig.providers.test,
          clientIdentity: "invalid-mode",
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
