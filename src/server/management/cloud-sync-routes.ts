/**
 * /api/cloud-sync/* — OneDrive backup/restore for ~/.opencodex (management auth).
 */
import {
  azureRedirectUri,
  cancelBrowserLogin,
  clearOneDriveToken,
  fetchOneDriveAccountEmail,
  getBrowserLoginStatus,
  pollDeviceCodeTokenOnce,
  readOneDriveToken,
  resolveLoopbackPort,
  resolveMsAuthority,
  startBrowserLoopbackLogin,
  startDeviceCodeLogin,
  writeOneDriveToken,
} from "../../cloud/onedrive-auth";
import type { MsAuthority } from "../../cloud/types";
import { remoteSyncRootDescription } from "../../cloud/onedrive-graph";
import { pullFromOneDrive, pushToOneDrive, readRemoteManifest } from "../../cloud/sync";
import {
  getDeviceName,
  getOrCreateDeviceId,
  readCloudSyncSettings,
  resolveClientId,
  writeCloudSyncSettings,
} from "../../cloud/settings";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

interface PendingDeviceLogin {
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresAt: number;
  authority: MsAuthority;
}

let pendingLogin: PendingDeviceLogin | null = null;

function statusPayload() {
  const settings = readCloudSyncSettings();
  const token = readOneDriveToken();
  return {
    clientId: settings.clientId ?? process.env.OPENCODEX_MS_CLIENT_ID ?? process.env.OPENCODEX_ONEDRIVE_CLIENT_ID ?? null,
    hasClientSecret: Boolean(settings.clientSecret?.trim() || process.env.OPENCODEX_MS_CLIENT_SECRET?.trim()),
    loggedIn: Boolean(token),
    account: token?.account ?? null,
    msAuthority: resolveMsAuthority(),
    deviceId: getOrCreateDeviceId(),
    deviceName: getDeviceName(),
    lastSyncAt: settings.lastSyncAt ?? null,
    lastSyncDirection: settings.lastSyncDirection ?? null,
    remoteRoot: remoteSyncRootDescription(),
    includeUsage: settings.includeUsage === true,
    includeVault: settings.includeVault !== false,
    loopbackPort: resolveLoopbackPort(),
    /** Exact value to paste into Azure → Mobile and desktop → Redirect URIs */
    azureRedirectUri: azureRedirectUri(),
  };
}

export async function handleCloudSyncRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/cloud-sync/status" && req.method === "GET") {
    const base = statusPayload();
    let remoteManifest: unknown = null;
    let remoteError: string | null = null;
    if (base.loggedIn) {
      try {
        remoteManifest = await readRemoteManifest();
      } catch (e) {
        remoteError = e instanceof Error ? e.message : String(e);
      }
    }
    return jsonResponse({ ...base, remoteManifest, remoteError });
  }

  if (url.pathname === "/api/cloud-sync/client-id" && req.method === "POST") {
    let body: { clientId?: unknown; clientSecret?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId || clientId.length < 8) return jsonResponse({ error: "clientId is required" }, 400);
    const settings = readCloudSyncSettings();
    const next = { ...settings, clientId };
    // Only update secret when the field is present (empty string clears it).
    if ("clientSecret" in body) {
      const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
      if (secret) next.clientSecret = secret;
      else delete next.clientSecret;
    }
    writeCloudSyncSettings(next);
    return jsonResponse({
      ok: true,
      clientId,
      hasClientSecret: Boolean(next.clientSecret),
    });
  }

  if (url.pathname === "/api/cloud-sync/login/start" && req.method === "POST") {
    let body: { clientId?: unknown; msAuthority?: unknown; mode?: unknown } = {};
    try { body = await req.json(); } catch { /* empty ok */ }
    let clientId: string;
    try {
      clientId = resolveClientId(typeof body.clientId === "string" ? body.clientId : undefined);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const authorityHint = typeof body.msAuthority === "string" ? body.msAuthority : undefined;
    const authority =
      authorityHint === "common" || authorityHint === "consumers" || authorityHint === "organizations"
        ? authorityHint
        : undefined;
    const settings = readCloudSyncSettings();
    writeCloudSyncSettings({
      ...settings,
      clientId,
      ...(authority ? { msAuthority: authority } : {}),
    });
    // Default: browser loopback PKCE (works with Mobile+desktop + http://localhost).
    // mode=device forces classic device-code (needs Allow public client flows / "mobile").
    const mode = body.mode === "device" ? "device" : "browser";
    try {
      if (mode === "browser") {
        cancelBrowserLogin();
        pendingLogin = null;
        const start = await startBrowserLoopbackLogin(clientId, authority);
        return jsonResponse({
          ok: true,
          mode: "browser",
          authUrl: start.authUrl,
          redirectUri: start.redirectUri,
          azureRedirectUri: start.azureRedirectUri,
          verificationUri: start.authUrl,
          verificationUriComplete: start.authUrl,
          message:
            `Complete sign-in in the browser. Azure must list redirect URI exactly: ${start.azureRedirectUri}`,
          expiresIn: start.expiresIn,
          interval: 2,
          msAuthority: start.authority,
        });
      }
      cancelBrowserLogin();
      const start = await startDeviceCodeLogin(clientId, authority);
      pendingLogin = {
        clientId,
        deviceCode: start.deviceCode,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        interval: start.interval,
        expiresAt: Date.now() + start.expiresIn * 1000,
        authority: start.authority,
      };
      return jsonResponse({
        ok: true,
        mode: "device",
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete ?? null,
        message: start.message,
        expiresIn: start.expiresIn,
        interval: start.interval,
        msAuthority: start.authority,
      });
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (url.pathname === "/api/cloud-sync/login/poll" && req.method === "POST") {
    // Browser loopback session takes precedence when active.
    const browser = getBrowserLoginStatus();
    if (browser.status === "pending") {
      return jsonResponse({ ok: true, pending: true, mode: "browser" });
    }
    if (browser.status === "ok") {
      const account = browser.account ?? browser.store.account ?? null;
      cancelBrowserLogin();
      return jsonResponse({ ok: true, pending: false, mode: "browser", account, msAuthority: browser.store.authority });
    }
    if (browser.status === "error") {
      const err = browser.error;
      cancelBrowserLogin();
      return jsonResponse({ pending: false, mode: "browser", error: err }, 400);
    }

    if (!pendingLogin) return jsonResponse({ pending: false, error: "no login in progress" }, 400);
    if (Date.now() > pendingLogin.expiresAt) {
      pendingLogin = null;
      return jsonResponse({ pending: false, error: "device code expired" }, 400);
    }
    try {
      const result = await pollDeviceCodeTokenOnce(
        pendingLogin.clientId,
        pendingLogin.deviceCode,
        pendingLogin.authority,
      );
      if (result.status === "pending") {
        return jsonResponse({ ok: true, pending: true, mode: "device", error: result.error });
      }
      if (result.status === "error") {
        pendingLogin = null;
        return jsonResponse({ pending: false, mode: "device", error: result.error }, 400);
      }
      const store = result.store;
      const email = await fetchOneDriveAccountEmail(store.accessToken);
      if (email) {
        store.account = email;
        writeOneDriveToken(store);
      }
      pendingLogin = null;
      return jsonResponse({ ok: true, pending: false, mode: "device", account: email ?? null, msAuthority: store.authority });
    } catch (e) {
      return jsonResponse({ pending: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (url.pathname === "/api/cloud-sync/logout" && req.method === "POST") {
    pendingLogin = null;
    cancelBrowserLogin();
    clearOneDriveToken();
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/cloud-sync/push" && req.method === "POST") {
    let body: { passphrase?: unknown; includeUsage?: unknown; noVault?: unknown } = {};
    try { body = await req.json(); } catch { /* empty ok */ }
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : undefined;
    const includeUsage = body.includeUsage === true;
    const noVault = body.noVault === true;
    try {
      resolveClientId();
      const result = await pushToOneDrive({
        passphrase: noVault ? undefined : passphrase,
        includeUsage,
        includeVault: !noVault && Boolean(passphrase),
      });
      return jsonResponse({ ok: true, ...result });
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  if (url.pathname === "/api/cloud-sync/pull" && req.method === "POST") {
    let body: { passphrase?: unknown; includeUsage?: unknown; yes?: unknown } = {};
    try { body = await req.json(); } catch { /* empty ok */ }
    if (body.yes !== true) return jsonResponse({ error: "pull requires yes: true (overwrites local state)" }, 400);
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : undefined;
    const includeUsage = body.includeUsage === true;
    try {
      resolveClientId();
      const result = await pullFromOneDrive({ yes: true, passphrase, includeUsage });
      return jsonResponse({ ok: true, ...result });
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  void config;
  return null;
}
