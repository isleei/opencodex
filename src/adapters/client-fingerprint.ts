/**
 * First-party client fingerprints.
 *
 * Routed OAuth providers reject — or quietly flag — requests whose header signature doesn't match
 * the real first-party client that minted the token. Sending a valid OAuth token with an empty
 * header set (or a giveaway literal UA like "antigravity") is a non-first-party signature. These
 * constants mirror the headers the real Claude Code CLI and Antigravity CLI send, so the proxy's
 * request fingerprint matches the credential.
 *
 * Pinned versions live HERE (single source) so they're trivial to bump. Values that need a live
 * manifest fetch (Antigravity auto-updater) or a cryptographic billing signature (Claude cch) are
 * intentionally NOT modeled — those are brittle and a wrong guess does more harm than the gap.
 */
import { createHash } from "node:crypto";

// ── Claude Code CLI (matches Claude Code 2.1.63 / @anthropic-ai/sdk 0.74.0) ──
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
  "X-Stainless-Arch": process.arch,
  "X-Stainless-OS": process.platform,
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Runtime-Version": process.version.slice(1),
};

/**
 * Stable per-credential session id, matching Claude Code's `X-Claude-Code-Session-Id`. Real Claude
 * Code keeps one session id per CLI session; we derive a deterministic UUIDv4-shaped id from the
 * OAuth token so it stays stable across a conversation's turns without persisting state. The token
 * itself never leaves this function (only its hash drives the id).
 */
export function claudeCodeSessionId(token: string | undefined): string {
  const seed = token && token.length > 0 ? token : "opencodex-anon";
  const h = createHash("sha256").update(`claude-code-session:${seed}`, "utf8").digest("hex");
  // Shape the hash into a v4-looking UUID (version nibble 4, variant nibble 8-b).
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── Antigravity IDE ──
/** Pinned fallback Antigravity IDE language-server version (matches the bundled LS 2.5.5). */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";
const ANTIGRAVITY_IDE_CLIENT_NAME = "aidev_client";
const ANTIGRAVITY_IDE_PLATFORM = "windows/amd64";

/**
 * Real Antigravity IDE User-Agent format, decompiled from 2.5.5 Go LS (`setHeaders` @ `0x1018fbe00`):
 * `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`
 *
 * Token ordering from decompiled binary: `os_type` -> `arch` -> `aidev_client` -> `auth_method=oauth`.
 *
 * Must be the IDE client family (`antigravity/ide/...`): Cloud Code Assist backend gates
 * newer agent models (e.g. `gemini-3.7-flash`) by User-Agent and answers 404 NOT_FOUND to
 * CLI-shaped UAs even with a valid OAuth token. Only `antigravity/ide/<ver>` unlocks them.
 * A `GOOGLE_ANTIGRAVITY_USER_AGENT` override (set by the caller) takes precedence upstream.
 */
export function antigravityUserAgent(version = ANTIGRAVITY_IDE_VERSION, authMethod = "oauth"): string {
  const ov = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (ov) return ov;
  const [osType, arch] = ANTIGRAVITY_IDE_PLATFORM.split("/");
  return `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; ${ANTIGRAVITY_IDE_CLIENT_NAME}; auth_method=${authMethod})`;
}

// ── Standard First-Party Client Fingerprints ──

export const CLAUDE_CODE_FINGERPRINT: Record<string, string> = {
  "User-Agent": "claude-code/2.1.63 (@anthropic-ai/sdk/0.74.0)",
  ...CLAUDE_CODE_HEADERS,
};

export const CODEX_CLI_FINGERPRINT: Record<string, string> = {
  "User-Agent": "codex_cli_rs/0.1.0",
  "originator": "codex_cli_rs",
};

export const GROK_BUILD_FINGERPRINT: Record<string, string> = {
  "User-Agent": "grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)",
};

export const AGY_CLI_FINGERPRINT: Record<string, string> = {
  "User-Agent": antigravityUserAgent(),
};

/** Classify a model id into its primary vendor family for auto fingerprinting. */
export function classifyModelFamily(modelId?: string): "claude" | "gpt" | "grok" | "agy" | "unknown" {
  if (!modelId || typeof modelId !== "string") return "unknown";
  const m = modelId.toLowerCase();
  if (m.includes("claude") || m.startsWith("anthropic/")) return "claude";
  if (m.includes("grok") || m.startsWith("xai/")) return "grok";
  if (m.includes("gemini") || m.includes("antigravity") || m.startsWith("google/")) return "agy";
  if (
    m.includes("gpt") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.includes("chatgpt") ||
    m.startsWith("openai/")
  ) {
    return "gpt";
  }
  return "unknown";
}

const PASSTHROUGH_ALLOWLIST = new Set([
  "user-agent",
  "originator",
  "x-app",
  "x-client-request-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-window-id",
  "x-claude-code-session-id",
  "session-id",
  "session_id",
  "thread-id",
  "openai-beta",
  "anthropic-beta",
]);

/** Extract genuine caller client identity headers safely (stripping hop-by-hop & credentials). */
export function extractPassthroughHeaders(
  incomingHeaders?: Headers | Record<string, unknown>,
): Record<string, string> {
  if (!incomingHeaders) return {};
  const extracted: Record<string, string> = {};
  const entries: Iterable<[string, unknown]> =
    typeof (incomingHeaders as Headers).entries === "function"
      ? (incomingHeaders as Headers).entries()
      : Object.entries(incomingHeaders);

  for (const [key, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    const lower = key.toLowerCase();
    if (PASSTHROUGH_ALLOWLIST.has(lower) || lower.startsWith("x-stainless-")) {
      extracted[key] = value;
    }
  }
  return extracted;
}

/**
 * Resolve client identity headers for an outbound provider request.
 *
 * Honors provider.clientIdentity:
 * - "auto": dynamically inject first-party fingerprint matching the requested model
 * - "passthrough": forward genuine caller headers (e.g. real Codex / Claude Code caller)
 * - "codex" | "claude-code" | "grok" | "agy": statically enforce the given fingerprint
 * - "none": send clean requests (default)
 *
 * Any headers explicitly defined in provider.headers win over generated identity headers.
 */
export function resolveClientIdentityHeaders(
  provider: import("../types").OcxProviderConfig,
  modelId?: string,
  incomingHeaders?: Headers | Record<string, unknown>,
): Record<string, string> {
  const mode = provider.clientIdentity ?? "none";
  let fingerprint: Record<string, string> = {};

  if (mode === "none") {
    return {};
  } else if (mode === "passthrough") {
    fingerprint = extractPassthroughHeaders(incomingHeaders);
  } else if (mode === "codex") {
    fingerprint = { ...CODEX_CLI_FINGERPRINT };
  } else if (mode === "claude-code") {
    fingerprint = { ...CLAUDE_CODE_FINGERPRINT };
  } else if (mode === "grok") {
    fingerprint = { ...GROK_BUILD_FINGERPRINT };
  } else if (mode === "agy") {
    fingerprint = { ...AGY_CLI_FINGERPRINT };
  } else if (mode === "auto") {
    const family = classifyModelFamily(modelId);
    if (family === "claude") fingerprint = { ...CLAUDE_CODE_FINGERPRINT };
    else if (family === "gpt") fingerprint = { ...CODEX_CLI_FINGERPRINT };
    else if (family === "grok") fingerprint = { ...GROK_BUILD_FINGERPRINT };
    else if (family === "agy") fingerprint = { ...AGY_CLI_FINGERPRINT };
  }

  if (provider.headers) {
    const configuredKeys = new Set(Object.keys(provider.headers).map(k => k.toLowerCase()));
    for (const key of Object.keys(fingerprint)) {
      if (configuredKeys.has(key.toLowerCase())) {
        delete fingerprint[key];
      }
    }
  }

  return fingerprint;
}

