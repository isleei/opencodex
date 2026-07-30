import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getConfigDir } from "../config";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import type { CloudSyncSettings } from "./types";

export function cloudSyncSettingsPath(): string {
  return join(getConfigDir(), "cloud-sync.json");
}

export function deviceIdPath(): string {
  return join(getConfigDir(), "device-id");
}

export function getOrCreateDeviceId(): string {
  const path = deviceIdPath();
  if (existsSync(path)) {
    try {
      const id = readFileSync(path, "utf8").trim();
      if (id) return id;
    } catch { /* recreate */ }
  }
  const id = createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 16);
  writeFileSync(path, `${id}\n`, { encoding: "utf8", mode: 0o600 });
  hardenSecretPath(path);
  return id;
}

export function getDeviceName(): string {
  try { return hostname() || "unknown-device"; } catch { return "unknown-device"; }
}

export function readCloudSyncSettings(): CloudSyncSettings {
  const path = cloudSyncSettingsPath();
  if (!existsSync(path)) return { provider: "onedrive" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CloudSyncSettings;
    return { ...raw, provider: "onedrive" };
  } catch {
    return { provider: "onedrive" };
  }
}

export function writeCloudSyncSettings(settings: CloudSyncSettings): void {
  const path = cloudSyncSettingsPath();
  const next: CloudSyncSettings = { ...settings, provider: "onedrive" };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  hardenSecretPath(path);
}

/** Resolve Microsoft public client id: flag > env > settings. */
export function resolveClientId(explicit?: string): string {
  const fromFlag = explicit?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.OPENCODEX_MS_CLIENT_ID?.trim() || process.env.OPENCODEX_ONEDRIVE_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  const fromSettings = readCloudSyncSettings().clientId?.trim();
  if (fromSettings) return fromSettings;
  throw new Error(
    "Microsoft client_id required.\n"
    + "  1) Register an app at https://portal.azure.com → App registrations\n"
    + "  2) Supported accounts: personal + organizational\n"
    + "  3) Platform: Mobile and desktop (or none). Device-code login does not need a redirect URI.\n"
    + "     Do NOT use http://localhost:10100/#cloud — Azure rejects # fragments in redirect URIs.\n"
    + "  4) Authentication → Allow public client flows = Yes\n"
    + "     (or Manifest: \"allowPublicClient\": true). Device code requires a public/mobile client.\n"
    + "  5) API permissions (delegated Microsoft Graph): User.Read, Files.ReadWrite, offline_access\n"
    + "     Personal-MSA-only apps use /consumers (set automatically).\n"
    + "  6) Then:\n"
    + "       ocx sync-cloud set-client-id <YOUR_CLIENT_ID>\n"
    + "     or export OPENCODEX_MS_CLIENT_ID=<YOUR_CLIENT_ID>",
  );
}
