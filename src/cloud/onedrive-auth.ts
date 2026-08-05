/**
 * Microsoft identity platform — OAuth for OneDrive (public client, no secret).
 *
 * Preferred: authorization-code + PKCE via loopback http://127.0.0.1:<port>/callback
 * Fallback: device-code (requires Azure “Allow public client flows” / mobile platform)
 *
 * Authority:
 *  - "consumers" — personal Microsoft accounts only (AADSTS9002346 if you used /common)
 *  - "common"    — work/school + personal (app must allow both)
 *  - "organizations" — work/school only
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import type { MsAuthority, OneDriveTokenStore } from "./types";
import { readCloudSyncSettings, writeCloudSyncSettings } from "./settings";

const SCOPES = ["offline_access", "User.Read", "Files.ReadWrite"].join(" ");
/** Default fixed loopback port — register this exact URI in Azure (Mobile and desktop). */
export const DEFAULT_LOOPBACK_PORT = 18765;

const VALID_AUTHORITIES = new Set<MsAuthority>(["common", "consumers", "organizations"]);

export function normalizeMsAuthority(raw?: string | null): MsAuthority | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "common" || v === "consumers" || v === "organizations") return v;
  return undefined;
}

/** Prefer token store → settings → env → consumers (personal OneDrive default). */
export function resolveMsAuthority(explicit?: string): MsAuthority {
  const fromFlag = normalizeMsAuthority(explicit);
  if (fromFlag) return fromFlag;
  const fromEnv = normalizeMsAuthority(process.env.OPENCODEX_MS_AUTHORITY);
  if (fromEnv) return fromEnv;
  const token = readOneDriveToken();
  if (token?.authority && VALID_AUTHORITIES.has(token.authority)) return token.authority;
  const fromSettings = normalizeMsAuthority(readCloudSyncSettings().msAuthority);
  if (fromSettings) return fromSettings;
  // Personal MSA apps are common; /consumers avoids AADSTS9002346.
  return "consumers";
}

export function deviceCodeUrl(authority: MsAuthority): string {
  return `https://login.microsoftonline.com/${authority}/oauth2/v2.0/devicecode`;
}

export function tokenUrl(authority: MsAuthority): string {
  return `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
}

/** Fixed loopback port from settings / env / default. */
export function resolveLoopbackPort(): number {
  const fromEnv = Number(process.env.OPENCODEX_MS_LOOPBACK_PORT || "");
  if (Number.isInteger(fromEnv) && fromEnv >= 1024 && fromEnv <= 65535) return fromEnv;
  const fromSettings = readCloudSyncSettings().loopbackPort;
  if (typeof fromSettings === "number" && Number.isInteger(fromSettings) && fromSettings >= 1024 && fromSettings <= 65535) {
    return fromSettings;
  }
  return DEFAULT_LOOPBACK_PORT;
}

/** Exact redirect URI that must be registered on the Azure app (Mobile and desktop). */
export function azureRedirectUri(port = resolveLoopbackPort()): string {
  return `http://localhost:${port}`;
}

export function onedriveAuthPath(): string {
  return join(getConfigDir(), "onedrive-auth.json");
}

export function readOneDriveToken(): OneDriveTokenStore | null {
  const path = onedriveAuthPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as OneDriveTokenStore;
    if (!raw.accessToken || !raw.refreshToken || !raw.clientId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeOneDriveToken(store: OneDriveTokenStore): void {
  const path = onedriveAuthPath();
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  hardenSecretPath(path, { required: true });
}

export function clearOneDriveToken(): void {
  const path = onedriveAuthPath();
  try { unlinkSync(path); } catch { /* missing ok */ }
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  message: string;
  authority: MsAuthority;
}

function isConsumersOnlyError(status: number, json: Record<string, unknown>): boolean {
  if (status !== 400) return false;
  const codes = Array.isArray(json.error_codes) ? json.error_codes : [];
  if (codes.includes(9002346)) return true;
  const desc = String(json.error_description ?? "");
  return desc.includes("AADSTS9002346") || desc.includes("/consumers endpoint");
}

async function requestDeviceCode(clientId: string, authority: MsAuthority): Promise<{
  ok: true; start: DeviceCodeStart;
} | {
  ok: false; status: number; json: Record<string, unknown>;
}> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
  });
  const res = await fetch(deviceCodeUrl(authority), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) return { ok: false, status: res.status, json };
  return {
    ok: true,
    start: {
      deviceCode: String(json.device_code ?? ""),
      userCode: String(json.user_code ?? ""),
      verificationUri: String(json.verification_uri ?? "https://microsoft.com/devicelogin"),
      verificationUriComplete: typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined,
      expiresIn: Number(json.expires_in) || 900,
      interval: Number(json.interval) || 5,
      message: String(json.message ?? "Sign in with the user code shown above."),
      authority,
    },
  };
}

function rememberAuthority(authority: MsAuthority): void {
  const settings = readCloudSyncSettings();
  if (settings.msAuthority === authority) return;
  writeCloudSyncSettings({ ...settings, msAuthority: authority });
}

/**
 * Start device-code login. If the app is personal-MSA-only and authority is
 * common (or unset), automatically retries with /consumers (AADSTS9002346).
 */
export async function startDeviceCodeLogin(
  clientId: string,
  authority?: MsAuthority,
): Promise<DeviceCodeStart> {
  const preferred = authority ?? resolveMsAuthority();
  const first = await requestDeviceCode(clientId, preferred);
  if (first.ok) {
    rememberAuthority(first.start.authority);
    return first.start;
  }

  // MSA-only apps must use /consumers, not /common.
  if (preferred === "common" && isConsumersOnlyError(first.status, first.json)) {
    const second = await requestDeviceCode(clientId, "consumers");
    if (second.ok) {
      rememberAuthority("consumers");
      return second.start;
    }
    throw new Error(`device code start failed (${second.status}): ${JSON.stringify(second.json)}`);
  }

  // Org-only apps may need /organizations or /common — give a clear hint.
  if (preferred === "consumers") {
    const desc = String(first.json.error_description ?? "");
    if (desc.includes("AADSTS") || first.status === 400) {
      // try common as secondary for multi-tenant apps mis-defaulted to consumers
      const second = await requestDeviceCode(clientId, "common");
      if (second.ok) {
        rememberAuthority("common");
        return second.start;
      }
    }
  }

  const hint = formatAzureClientHint(first.status, first.json);
  throw new Error(
    `device code start failed (${first.status}): ${JSON.stringify(first.json)}`
    + (hint ? `\n\n${hint}` : ""),
  );
}

function formatAzureClientHint(status: number, json: Record<string, unknown>): string {
  const codes = Array.isArray(json.error_codes) ? json.error_codes : [];
  const desc = String(json.error_description ?? "");
  if (desc.includes("client_secret") || desc.includes("client secret")) {
    return [
      "Azure treats this app as a confidential (Web) client and requires client_secret.",
      "Pick ONE fix:",
      "  A) Preferred — make it a public client (no secret):",
      "     Authentication → Advanced → Allow public client flows = Yes → Save",
      "     Manifest → \"allowPublicClient\": true",
      "     Then login again (do not send a secret).",
      "  B) Or keep Web app — create a client secret under Certificates & secrets,",
      "     paste it in OpenCodex cloud sync (or OPENCODEX_MS_CLIENT_SECRET), then login again.",
      `  Redirect URI must still be exactly: ${azureRedirectUri()}`,
    ].join("\n");
  }
  if (status === 401 || codes.includes(70002) || desc.includes("AADSTS70002") || desc.includes("marked as 'mobile'")) {
    return [
      "Azure app is not a public/mobile client (AADSTS70002).",
      "Fix in Azure portal → your app:",
      "  1) Authentication → Advanced → Allow public client flows = Yes  (save)",
      "  2) Authentication → Add a platform → Mobile and desktop applications",
      `  3) Redirect URI exactly: ${azureRedirectUri()}`,
      "  4) Manifest: \"allowPublicClient\": true",
      "Then wait ~1 minute and try again.",
    ].join("\n");
  }
  return "";
}

/** Optional confidential-client secret (settings / env). Empty = public client. */
export function resolveClientSecret(): string | undefined {
  const fromEnv = process.env.OPENCODEX_MS_CLIENT_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const fromSettings = readCloudSyncSettings().clientSecret?.trim();
  return fromSettings || undefined;
}

// ─── Browser loopback + PKCE (preferred) ─────────────────────────────────────

interface BrowserLoginSession {
  clientId: string;
  authority: MsAuthority;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  authUrl: string;
  server: Server;
  expiresAt: number;
  result:
    | { status: "pending" }
    | { status: "ok"; store: OneDriveTokenStore; account?: string }
    | { status: "error"; error: string };
}

let browserLogin: BrowserLoginSession | null = null;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl(opts: {
  clientId: string;
  authority: MsAuthority;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(`https://login.microsoftonline.com/${opts.authority}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Force account picker when re-auth
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
.ok{color:#0a7} .err{color:#c22}</style></head><body>${body}</body></html>`;
}

export function cancelBrowserLogin(): void {
  if (!browserLogin) return;
  try { browserLogin.server.close(); } catch { /* ignore */ }
  browserLogin = null;
}

export function getBrowserLoginStatus(): BrowserLoginSession["result"] | { status: "idle" } {
  if (!browserLogin) return { status: "idle" };
  if (Date.now() > browserLogin.expiresAt && browserLogin.result.status === "pending") {
    cancelBrowserLogin();
    return { status: "error", error: "browser login timed out" };
  }
  return browserLogin.result;
}

export async function startBrowserLoopbackLogin(
  clientId: string,
  authority?: MsAuthority,
): Promise<{ authUrl: string; redirectUri: string; authority: MsAuthority; expiresIn: number; azureRedirectUri: string }> {
  cancelBrowserLogin();
  const auth = authority ?? resolveMsAuthority();
  const { verifier, challenge } = pkcePair();
  const state = base64Url(randomBytes(16));
  const port = resolveLoopbackPort();
  // Exact match required on many personal-MSA apps — register this in Azure as-is.
  const redirectUri = azureRedirectUri(port);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          `loopback port ${port} is in use. Free it, or set OPENCODEX_MS_LOOPBACK_PORT / cloud-sync loopbackPort `
          + `and register the matching http://localhost:<port> in Azure.`,
        ));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const authUrl = authorizeUrl({
    clientId,
    authority: auth,
    redirectUri,
    state,
    codeChallenge: challenge,
  });

  const session: BrowserLoginSession = {
    clientId,
    authority: auth,
    codeVerifier: verifier,
    state,
    redirectUri,
    authUrl,
    server,
    expiresAt: Date.now() + 10 * 60 * 1000,
    result: { status: "pending" },
  };
  browserLogin = session;

  server.on("request", (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", redirectUri);
        // Root only — redirect_uri has no path (must match Azure registration exactly).
        if (url.pathname !== "/" && url.pathname !== "") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Not found — OAuth callback is ${redirectUri}`);
          return;
        }
        const err = url.searchParams.get("error");
        const errDesc = url.searchParams.get("error_description");
        const code = url.searchParams.get("code");
        const st = url.searchParams.get("state");
        if (err) {
          session.result = { status: "error", error: errDesc || err };
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage("OpenCodex", `<p class="err">Login failed: ${escapeHtml(errDesc || err)}</p><p>You can close this tab.</p>`));
          setTimeout(() => { try { server.close(); } catch { /* */ } }, 500);
          return;
        }
        if (!code || st !== session.state) {
          session.result = { status: "error", error: "invalid OAuth callback (state/code)" };
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage("OpenCodex", `<p class="err">Invalid callback.</p>`));
          setTimeout(() => { try { server.close(); } catch { /* */ } }, 500);
          return;
        }
        try {
          const store = await exchangeAuthCode({
            clientId: session.clientId,
            authority: session.authority,
            code,
            redirectUri: session.redirectUri,
            codeVerifier: session.codeVerifier,
          });
          writeOneDriveToken(store);
          rememberAuthority(session.authority);
          const account = await fetchOneDriveAccountEmail(store.accessToken);
          if (account) {
            store.account = account;
            writeOneDriveToken(store);
          }
          session.result = { status: "ok", store, account };
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage(
            "OpenCodex",
            `<p class="ok">Signed in to OneDrive${account ? ` as <b>${escapeHtml(account)}</b>` : ""}.</p><p>You can close this tab and return to OpenCodex.</p>`,
          ));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          session.result = { status: "error", error: msg };
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage("OpenCodex", `<p class="err">Token exchange failed: ${escapeHtml(msg)}</p>`));
        }
        setTimeout(() => { try { server.close(); } catch { /* */ } }, 500);
      } catch (e) {
        session.result = { status: "error", error: e instanceof Error ? e.message : String(e) };
        try {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("error");
        } catch { /* */ }
      }
    })();
  });

  return {
    authUrl,
    redirectUri,
    azureRedirectUri: redirectUri,
    authority: auth,
    expiresIn: 600,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function exchangeAuthCode(opts: {
  clientId: string;
  authority: MsAuthority;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OneDriveTokenStore> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    scope: SCOPES,
  });
  // Confidential (Web) apps require client_secret; public clients must omit it.
  const secret = resolveClientSecret();
  if (secret) body.set("client_secret", secret);

  const res = await fetch(tokenUrl(opts.authority), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    const hint = formatAzureClientHint(res.status, json);
    throw new Error(
      `token exchange failed (${res.status}): ${JSON.stringify(json)}`
      + (hint ? `\n\n${hint}` : ""),
    );
  }
  const store: OneDriveTokenStore = {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token ?? ""),
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: typeof json.scope === "string" ? json.scope : undefined,
    clientId: opts.clientId,
    authority: opts.authority,
  };
  if (!store.refreshToken) {
    throw new Error("token response missing refresh_token — ensure offline_access scope on the Azure app");
  }
  return store;
}

/**
 * Blocking browser login for CLI: open URL, wait until loopback callback finishes.
 */
export async function loginWithBrowserLoopback(
  clientId: string,
  authority?: MsAuthority,
  onReady?: (info: { authUrl: string; redirectUri: string }) => void,
): Promise<OneDriveTokenStore> {
  const start = await startBrowserLoopbackLogin(clientId, authority);
  onReady?.({ authUrl: start.authUrl, redirectUri: start.redirectUri });
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    const st = getBrowserLoginStatus();
    if (st.status === "ok") {
      cancelBrowserLogin();
      return st.store;
    }
    if (st.status === "error") {
      cancelBrowserLogin();
      throw new Error(st.error);
    }
    await Bun.sleep(400);
  }
  cancelBrowserLogin();
  throw new Error("browser login timed out");
}

export async function pollDeviceCodeToken(
  clientId: string,
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
  onProgress?: (msg: string) => void,
  authority?: MsAuthority,
): Promise<OneDriveTokenStore> {
  const auth = authority ?? resolveMsAuthority();
  const deadline = Date.now() + expiresInSec * 1000;
  let interval = Math.max(3, intervalSec) * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(interval);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceCode,
    });
    const res = await fetch(tokenUrl(auth), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && json.access_token) {
      const store: OneDriveTokenStore = {
        accessToken: String(json.access_token),
        refreshToken: String(json.refresh_token ?? ""),
        expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
        scope: typeof json.scope === "string" ? json.scope : undefined,
        clientId,
        authority: auth,
      };
      if (!store.refreshToken) throw new Error("token response missing refresh_token — ensure offline_access scope");
      writeOneDriveToken(store);
      rememberAuthority(auth);
      return store;
    }
    const err = String(json.error ?? "");
    if (err === "authorization_pending") {
      onProgress?.("waiting for browser authorization…");
      continue;
    }
    if (err === "slow_down") {
      interval += 2000;
      onProgress?.("slowing poll rate…");
      continue;
    }
    if (err === "expired_token") throw new Error("device code expired — run login again");
    if (err === "authorization_declined") throw new Error("authorization declined in browser");
    throw new Error(`token poll failed: ${err || res.status} ${JSON.stringify(json)}`);
  }
  throw new Error("device code timed out — run login again");
}

/** One-shot token poll for GUI (no sleep loop). */
export async function pollDeviceCodeTokenOnce(
  clientId: string,
  deviceCode: string,
  authority: MsAuthority,
): Promise<
  | { status: "ok"; store: OneDriveTokenStore }
  | { status: "pending"; error: string }
  | { status: "error"; error: string }
> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clientId,
    device_code: deviceCode,
  });
  const res = await fetch(tokenUrl(authority), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.ok && json.access_token) {
    const store: OneDriveTokenStore = {
      accessToken: String(json.access_token),
      refreshToken: String(json.refresh_token ?? ""),
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      clientId,
      authority,
    };
    if (!store.refreshToken) {
      return { status: "error", error: "missing refresh_token — ensure offline_access" };
    }
    writeOneDriveToken(store);
    rememberAuthority(authority);
    return { status: "ok", store };
  }
  const err = String(json.error ?? "");
  if (err === "authorization_pending" || err === "slow_down") {
    return { status: "pending", error: err };
  }
  return { status: "error", error: err || `token poll failed (${res.status})` };
}

export async function refreshOneDriveToken(store: OneDriveTokenStore): Promise<OneDriveTokenStore> {
  const auth = store.authority ?? resolveMsAuthority();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: store.clientId,
    refresh_token: store.refreshToken,
    scope: SCOPES,
  });
  const secret = resolveClientSecret();
  if (secret) body.set("client_secret", secret);
  const res = await fetch(tokenUrl(auth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    throw new Error(`OneDrive token refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  const next: OneDriveTokenStore = {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token ?? store.refreshToken),
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: typeof json.scope === "string" ? json.scope : store.scope,
    account: store.account,
    clientId: store.clientId,
    authority: auth,
  };
  writeOneDriveToken(next);
  return next;
}

/** Return a valid access token, refreshing if within 2 minutes of expiry. */
export async function getValidOneDriveAccessToken(): Promise<{ token: string; store: OneDriveTokenStore }> {
  let store = readOneDriveToken();
  if (!store) throw new Error("not logged in to OneDrive — run: ocx sync-cloud login");
  if (store.expiresAt <= Date.now() + 120_000) {
    store = await refreshOneDriveToken(store);
  }
  return { token: store.accessToken, store };
}

export async function fetchOneDriveAccountEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName,userPrincipalName,mail", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const json = await res.json() as Record<string, unknown>;
    return String(json.mail || json.userPrincipalName || json.displayName || "") || undefined;
  } catch {
    return undefined;
  }
}
