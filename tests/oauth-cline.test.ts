import { describe, expect, test, mock } from "bun:test";
import { formatClineAccessToken, detectLocalClineToken, refreshClineToken, loginCline, WORKOS_AUTH_URL, WORKOS_CLIENT_ID } from "../src/oauth/cline";
import { OAUTH_PROVIDERS } from "../src/oauth";

describe("Cline OAuth integration", () => {
  test("formatClineAccessToken ensures workos: prefix", () => {
    expect(formatClineAccessToken("abc.def.ghi")).toBe("workos:abc.def.ghi");
    expect(formatClineAccessToken("workos:abc.def.ghi")).toBe("workos:abc.def.ghi");
  });

  test("OAUTH_PROVIDERS includes cline with correct config", () => {
    expect(OAUTH_PROVIDERS.cline).toBeDefined();
    expect(OAUTH_PROVIDERS.cline.providerConfig.adapter).toBe("openai-chat");
    expect(OAUTH_PROVIDERS.cline.providerConfig.baseUrl).toBe("https://api.cline.bot/api/v1");
    expect(OAUTH_PROVIDERS.cline.defaultModel).toBe("anthropic/claude-sonnet-4-6");
  });

  test("detectLocalClineToken returns valid credential structure if config exists", () => {
    const cred = detectLocalClineToken();
    if (cred) {
      expect(cred.access.startsWith("workos:")).toBe(true);
      expect(cred.refresh.length).toBeGreaterThan(0);
      expect(cred.source).toBe("local-cli");
    }
  });

  test("loginCline imports local session when available", async () => {
    const local = detectLocalClineToken();
    if (local && local.expires > Date.now() + 60_000) {
      const loggedIn = await loginCline();
      expect(loggedIn.access).toBe(local.access);
      expect(loggedIn.refresh).toBe(local.refresh);
    }
  });
});
