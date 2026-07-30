/**
 * ocx sync-cloud — OneDrive cloud backup/restore for OpenCodex local state.
 */
import { openUrl } from "../lib/open-url";
import {
  clearOneDriveToken,
  fetchOneDriveAccountEmail,
  loginWithBrowserLoopback,
  pollDeviceCodeToken,
  readOneDriveToken,
  startDeviceCodeLogin,
  writeOneDriveToken,
} from "../cloud/onedrive-auth";
import { remoteSyncRootDescription } from "../cloud/onedrive-graph";
import { pullFromOneDrive, pushToOneDrive, readRemoteManifest } from "../cloud/sync";
import {
  getDeviceName,
  getOrCreateDeviceId,
  readCloudSyncSettings,
  resolveClientId,
  writeCloudSyncSettings,
} from "../cloud/settings";
import { CliUsageError, printData, rejectArgs, runCliAction, takeFlag, takeOption } from "./runtime-api";

const USAGE = `Usage:
  ocx sync-cloud login [--client-id <id>] [--device] [--json]
  ocx sync-cloud logout [--json]
  ocx sync-cloud status [--json]
  ocx sync-cloud set-client-id <id> [--secret <secret>] [--json]
  ocx sync-cloud push [--passphrase <p>] [--include-usage] [--no-vault] [--json]
  ocx sync-cloud pull --yes [--passphrase <p>] [--include-usage] [--json]

Microsoft OneDrive sync for ~/.opencodex (config + optional encrypted auth vault).
Default login is browser loopback PKCE.
If Azure requires client_secret (AADSTS70002), pass --secret or set OPENCODEX_MS_CLIENT_SECRET.

Environment:
  OPENCODEX_MS_CLIENT_ID       Microsoft application (client) ID
  OPENCODEX_MS_CLIENT_SECRET   Optional client secret (confidential/Web apps)
  OPENCODEX_MS_AUTHORITY       common | consumers | organizations (default consumers)
  OPENCODEX_MS_LOOPBACK_PORT   Default 18765 — register http://localhost:<port> in Azure`;

function readPassphrase(args: string[]): string | undefined {
  const fromFlag = takeOption(args, "--passphrase");
  if (fromFlag) return fromFlag;
  return process.env.OPENCODEX_SYNC_PASSPHRASE?.trim() || undefined;
}

async function handleLogin(argv: string[]): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const useDevice = takeFlag(args, "--device");
  const clientIdFlag = takeOption(args, "--client-id");
  rejectArgs(args, USAGE);
  const clientId = resolveClientId(clientIdFlag ?? undefined);

  // Persist client id for later refresh/login
  const settings = readCloudSyncSettings();
  writeCloudSyncSettings({ ...settings, clientId });

  let store;
  if (useDevice) {
    const start = await startDeviceCodeLogin(clientId);
    if (wantsJson) {
      console.log(JSON.stringify({
        mode: "device",
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        message: start.message,
        expiresIn: start.expiresIn,
        msAuthority: start.authority,
      }, null, 2));
    } else {
      console.log("\n☁️  OneDrive login (Microsoft device code)\n");
      console.log(`  1. Open: ${start.verificationUri}`);
      console.log(`  2. Enter code: ${start.userCode}`);
      if (start.verificationUriComplete) {
        console.log(`  Or open: ${start.verificationUriComplete}`);
      }
      console.log(`\n  ${start.message}\n`);
    }
    try {
      openUrl(start.verificationUriComplete || start.verificationUri);
    } catch { /* optional */ }
    store = await pollDeviceCodeToken(
      clientId,
      start.deviceCode,
      start.interval,
      start.expiresIn,
      msg => { if (!wantsJson) console.log(`   ${msg}`); },
      start.authority,
    );
  } else {
    if (!wantsJson) {
      console.log("\n☁️  OneDrive login (browser loopback PKCE)\n");
      console.log("  Azure app needs: Mobile and desktop platform + redirect http://localhost");
      console.log("  Opening browser…\n");
    }
    store = await loginWithBrowserLoopback(clientId, undefined, info => {
      if (wantsJson) {
        console.log(JSON.stringify({ mode: "browser", authUrl: info.authUrl, redirectUri: info.redirectUri }, null, 2));
      } else {
        console.log(`  Auth URL: ${info.authUrl}`);
        console.log(`  Redirect: ${info.redirectUri}\n`);
      }
      try { openUrl(info.authUrl); } catch { /* optional */ }
    });
  }

  const email = await fetchOneDriveAccountEmail(store.accessToken);
  if (email) {
    store.account = email;
    writeOneDriveToken(store);
  }

  if (wantsJson) {
    console.log(JSON.stringify({ ok: true, account: email ?? null, remoteRoot: remoteSyncRootDescription() }, null, 2));
  } else {
    console.log(`\n✅ Logged in to OneDrive${email ? ` as ${email}` : ""}.`);
    console.log(`   Remote folder: ${remoteSyncRootDescription()}`);
    console.log(`   Next: ocx sync-cloud push --passphrase 'your-secret-passphrase'`);
  }
}

async function handleLogout(argv: string[]): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  clearOneDriveToken();
  printData({ ok: true }, wantsJson, ["Logged out of OneDrive (local token removed)."]);
}

async function handleStatus(argv: string[]): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const settings = readCloudSyncSettings();
  const token = readOneDriveToken();
  let remote: Awaited<ReturnType<typeof readRemoteManifest>> | null = null;
  let remoteError: string | undefined;
  if (token) {
    try {
      remote = await readRemoteManifest();
    } catch (e) {
      remoteError = e instanceof Error ? e.message : String(e);
    }
  }
  const payload = {
    clientId: settings.clientId ?? process.env.OPENCODEX_MS_CLIENT_ID ?? null,
    loggedIn: Boolean(token),
    account: token?.account ?? null,
    deviceId: getOrCreateDeviceId(),
    deviceName: getDeviceName(),
    lastSyncAt: settings.lastSyncAt ?? null,
    lastSyncDirection: settings.lastSyncDirection ?? null,
    remoteRoot: remoteSyncRootDescription(),
    remoteManifest: remote,
    remoteError: remoteError ?? null,
  };
  if (wantsJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("\n☁️  Cloud sync (OneDrive)\n");
  console.log(`  Client ID:   ${payload.clientId ?? "(not set — ocx sync-cloud set-client-id …)"}`);
  console.log(`  Logged in:   ${payload.loggedIn ? "yes" : "no"}`);
  if (payload.account) console.log(`  Account:     ${payload.account}`);
  console.log(`  Device:      ${payload.deviceName} (${payload.deviceId})`);
  console.log(`  Remote:      ${payload.remoteRoot}`);
  console.log(`  Last sync:   ${payload.lastSyncAt ?? "never"} ${payload.lastSyncDirection ? `(${payload.lastSyncDirection})` : ""}`);
  if (remote) {
    console.log(`  Remote at:   ${remote.updatedAt} from ${remote.deviceName}`);
    console.log(`  Remote files:${remote.files.join(", ")}`);
    console.log(`  Has vault:   ${remote.hasVault ? "yes" : "no"}`);
  } else if (remoteError) {
    console.log(`  Remote:      error — ${remoteError}`);
  } else if (payload.loggedIn) {
    console.log("  Remote:      (no manifest yet — push first)");
  }
  console.log();
}

async function handleSetClientId(argv: string[]): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const secret = takeOption(args, "--secret");
  const id = args.shift()?.trim();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("client id is required", USAGE);
  const settings = readCloudSyncSettings();
  const next = { ...settings, clientId: id };
  if (secret !== undefined) {
    const s = secret.trim();
    if (s) next.clientSecret = s;
    else delete next.clientSecret;
  }
  writeCloudSyncSettings(next);
  printData(
    { ok: true, clientId: id, hasClientSecret: Boolean(next.clientSecret) },
    wantsJson,
    [
      `Saved Microsoft client_id (${id.slice(0, 8)}…)`
      + (next.clientSecret ? " + client secret." : "."),
    ],
  );
}

async function handlePush(argv: string[]): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const includeUsage = takeFlag(args, "--include-usage");
  const noVault = takeFlag(args, "--no-vault");
  const passphrase = readPassphrase(args);
  rejectArgs(args, USAGE);
  // Ensure client id exists for refresh path
  resolveClientId();
  const result = await pushToOneDrive({
    passphrase: noVault ? undefined : passphrase,
    includeUsage,
    includeVault: !noVault && Boolean(passphrase),
  });
  if (wantsJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  console.log("\n✅ Pushed to OneDrive");
  console.log(`   ${result.remoteRoot}`);
  console.log(`   Files: ${result.files.join(", ")}`);
  console.log(`   Vault: ${result.hasVault ? "yes (encrypted)" : "no"}`);
  console.log(`   At:    ${result.updatedAt}\n`);
}

async function handlePull(argv: string[]): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const yes = takeFlag(args, "--yes");
  const includeUsage = takeFlag(args, "--include-usage");
  const passphrase = readPassphrase(args);
  rejectArgs(args, USAGE);
  resolveClientId();
  const result = await pullFromOneDrive({ yes, passphrase, includeUsage });
  if (wantsJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  console.log("\n✅ Pulled from OneDrive");
  console.log(`   ${result.remoteRoot}`);
  console.log(`   Applied: ${result.files.join(", ")}`);
  console.log(`   Vault restored: ${result.hasVault ? "yes" : "no"}`);
  console.log(`   Remote timestamp: ${result.updatedAt}\n`);
  console.log("   Tip: run `ocx sync` to refresh Codex catalog after config pull.\n");
}

export async function handleSyncCloudCommand(argv: string[]): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const sub = (args.shift() ?? "").toLowerCase();
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(USAGE);
      console.log(`
Azure app registration (once):
  1. https://portal.azure.com → Microsoft Entra ID → App registrations → New
  2. Name: OpenCodex Sync (any)
  3. Supported account types: personal + work/school
  4. Authentication → Advanced → Allow public client flows = Yes
  5. API permissions → Microsoft Graph delegated:
       User.Read, Files.ReadWrite, offline_access
  6. Copy Application (client) ID → ocx sync-cloud set-client-id <id>
`);
      return;
    }
    if (sub === "login") return handleLogin(args);
    if (sub === "logout") return handleLogout(args);
    if (sub === "status") return handleStatus(args);
    if (sub === "set-client-id") return handleSetClientId(args);
    if (sub === "push") return handlePush(args);
    if (sub === "pull") return handlePull(args);
    throw new CliUsageError(`unknown sync-cloud subcommand: ${sub}`, USAGE);
  });
}

export const SYNC_CLOUD_USAGE = USAGE;
