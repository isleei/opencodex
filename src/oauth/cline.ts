/**
 * Cline OAuth — automatic session import from local Cline CLI / VS Code extension
 * and background WorkOS token refresh.
 *
 * Security: tokens are read securely from local config files and refreshed directly
 * against WorkOS API (api.workos.com). Tokens and credentials are never logged.
 */
import { existsSync, readFileSync } from "node:fs";
import { clineConfigPath } from "../clients/config-export";
import type { OAuthController, OAuthCredentials } from "./types";

export const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
export const WORKOS_AUTH_URL = "https://api.workos.com/user_management/authenticate";
const WORKOS_TOKEN_PREFIX = "workos:";

export interface ClineLoginOptions {
  importLocal?: "fallback" | "off";
  forceLogin?: boolean;
}

interface ClineProvidersJson {
  providers?: {
    cline?: {
      settings?: {
        provider?: string;
        auth?: {
          accessToken?: unknown;
          refreshToken?: unknown;
          expiresAt?: unknown;
          accountId?: unknown;
          metadata?: {
            userInfo?: {
              email?: unknown;
              name?: unknown;
              subject?: unknown;
              clineUserId?: unknown;
            };
          };
        };
      };
    };
  };
}

interface WorkOSAuthResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  user?: {
    id?: unknown;
    external_id?: unknown;
    email?: unknown;
    first_name?: unknown;
    last_name?: unknown;
  };
  error?: unknown;
  error_description?: unknown;
}

function decodeJwtExpiry(token: string): number {
  try {
    const rawJwt = token.startsWith(WORKOS_TOKEN_PREFIX) ? token.slice(WORKOS_TOKEN_PREFIX.length) : token;
    const parts = rawJwt.split(".");
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: unknown };
      if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
        return payload.exp * 1000;
      }
    }
  } catch {
    // fallback below
  }
  return Date.now() + 3600_000;
}

export function formatClineAccessToken(token: string): string {
  return token.startsWith(WORKOS_TOKEN_PREFIX) ? token : `${WORKOS_TOKEN_PREFIX}${token}`;
}

export function detectLocalClineToken(): OAuthCredentials | null {
  const configPath = clineConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as ClineProvidersJson;
    const auth = raw.providers?.cline?.settings?.auth;
    if (!auth || typeof auth.accessToken !== "string" || typeof auth.refreshToken !== "string") {
      return null;
    }

    const accessToken = auth.accessToken.trim();
    const refreshToken = auth.refreshToken.trim();
    if (!accessToken || !refreshToken) return null;

    const expiresAt = typeof auth.expiresAt === "number" && Number.isFinite(auth.expiresAt)
      ? auth.expiresAt
      : decodeJwtExpiry(accessToken);

    const userInfo = auth.metadata?.userInfo;
    const accountId = typeof auth.accountId === "string" && auth.accountId.length > 0
      ? auth.accountId
      : typeof userInfo?.clineUserId === "string" && userInfo.clineUserId.length > 0
        ? userInfo.clineUserId
        : typeof userInfo?.subject === "string" && userInfo.subject.length > 0
          ? userInfo.subject
          : undefined;

    const email = typeof userInfo?.email === "string" && userInfo.email.length > 0
      ? userInfo.email
      : undefined;

    return {
      access: formatClineAccessToken(accessToken),
      refresh: refreshToken,
      expires: expiresAt,
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
      source: "local-cli",
    };
  } catch {
    return null;
  }
}

export async function refreshClineToken(
  refreshToken: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Cline token refresh aborted", "AbortError");
  }

  const response = await fetch(WORKOS_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: WORKOS_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Cline WorkOS token refresh failed (HTTP ${response.status}): ${body || response.statusText}`);
  }

  const data = (await response.json()) as WorkOSAuthResponse;
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error(`Cline token refresh returned no access_token: ${JSON.stringify(data)}`);
  }

  const nextRefreshToken = typeof data.refresh_token === "string" && data.refresh_token
    ? data.refresh_token
    : refreshToken;

  const access = formatClineAccessToken(data.access_token);
  const expires = decodeJwtExpiry(data.access_token);

  const accountId = typeof data.user?.external_id === "string" && data.user.external_id
    ? data.user.external_id
    : typeof data.user?.id === "string" && data.user.id
      ? data.user.id
      : credential?.accountId;

  const email = typeof data.user?.email === "string" && data.user.email
    ? data.user.email
    : credential?.email;

  return {
    access,
    refresh: nextRefreshToken,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

export async function loginCline(
  ctrl?: OAuthController,
  options: ClineLoginOptions = {},
): Promise<OAuthCredentials> {
  if (options.importLocal !== "off") {
    ctrl?.onProgress?.("Checking local Cline CLI and VS Code installation for active session...");
    const local = detectLocalClineToken();
    if (local) {
      if (local.expires <= Date.now() + 60_000) {
        ctrl?.onProgress?.("Local Cline session token expired; refreshing via WorkOS...");
        return await refreshClineToken(local.refresh, ctrl?.signal, local);
      }
      ctrl?.onProgress?.("Imported active Cline session successfully.");
      return local;
    }
  }

  throw new Error(
    "No local Cline session found. Please log in to Cline via the VS Code extension or Cline CLI (`cline`), then re-run `ocx login cline` to import your account.",
  );
}
