/**
 * Push / pull OpenCodex local state to OneDrive.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, loadConfig, saveConfig } from "../config";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { downloadFile, remoteSyncRootDescription, uploadTextFile } from "./onedrive-graph";
import {
  getDeviceName,
  getOrCreateDeviceId,
  readCloudSyncSettings,
  writeCloudSyncSettings,
} from "./settings";
import type { CloudSyncManifest } from "./types";
import { decryptVault, encryptVault, packVaultFiles, unpackVaultFiles } from "./vault";

const VAULT_FILES = ["auth.json", "codex-accounts.json"] as const;
const CONFIG_FILE = "config.json";
const MANIFEST_FILE = "manifest.json";
const VAULT_FILE = "vault.enc";
const USAGE_FILE = "usage.jsonl";

function localPath(name: string): string {
  return join(getConfigDir(), name);
}

function readLocalOptional(name: string): string | null {
  const path = localPath(name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function writeLocal(name: string, content: string, mode = 0o600): void {
  const path = localPath(name);
  writeFileSync(path, content, { encoding: "utf8", mode });
  hardenSecretPath(path, { required: true });
}

export interface PushOptions {
  passphrase?: string;
  includeUsage?: boolean;
  includeVault?: boolean;
}

export interface PullOptions {
  passphrase?: string;
  /** Overwrite local config/auth without interactive confirm (CLI --yes). */
  yes?: boolean;
  includeUsage?: boolean;
}

export interface SyncResult {
  direction: "push" | "pull";
  remoteRoot: string;
  files: string[];
  hasVault: boolean;
  updatedAt: string;
}

export async function pushToOneDrive(options: PushOptions = {}): Promise<SyncResult> {
  const settings = readCloudSyncSettings();
  const includeUsage = options.includeUsage ?? settings.includeUsage === true;
  const includeVault = options.includeVault ?? Boolean(options.passphrase);
  if (includeVault && !options.passphrase) {
    throw new Error("vault sync requires --passphrase (min 8 chars)");
  }

  const files: string[] = [];
  const config = loadConfig();
  const configJson = `${JSON.stringify(config, null, 2)}\n`;
  await uploadTextFile(CONFIG_FILE, configJson);
  files.push(CONFIG_FILE);

  let hasVault = false;
  if (includeVault && options.passphrase) {
    const vaultFiles: Record<string, string> = {};
    for (const name of VAULT_FILES) {
      const content = readLocalOptional(name);
      if (content != null) vaultFiles[name] = content;
    }
    if (Object.keys(vaultFiles).length === 0) {
      throw new Error("no vault files found (auth.json / codex-accounts.json)");
    }
    const packed = packVaultFiles(vaultFiles);
    const blob = encryptVault(packed, options.passphrase);
    await uploadTextFile(VAULT_FILE, blob, "application/octet-stream");
    files.push(VAULT_FILE);
    hasVault = true;
  }

  if (includeUsage) {
    const usage = readLocalOptional(USAGE_FILE);
    if (usage != null) {
      await uploadTextFile(USAGE_FILE, usage, "application/x-ndjson");
      files.push(USAGE_FILE);
    }
  }

  const updatedAt = new Date().toISOString();
  const manifest: CloudSyncManifest = {
    version: 1,
    updatedAt,
    deviceId: getOrCreateDeviceId(),
    deviceName: getDeviceName(),
    files,
    hasVault,
    includeUsage,
  };
  await uploadTextFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  files.push(MANIFEST_FILE);

  writeCloudSyncSettings({
    ...settings,
    lastSyncAt: updatedAt,
    lastSyncDirection: "push",
    lastDeviceId: manifest.deviceId,
    includeUsage,
    includeVault,
  });

  return {
    direction: "push",
    remoteRoot: remoteSyncRootDescription(),
    files,
    hasVault,
    updatedAt,
  };
}

export async function pullFromOneDrive(options: PullOptions = {}): Promise<SyncResult> {
  if (!options.yes) {
    throw new Error("pull overwrites local state — re-run with --yes to confirm");
  }

  const manifestBuf = await downloadFile(MANIFEST_FILE);
  if (!manifestBuf) {
    throw new Error(`no cloud sync found at ${remoteSyncRootDescription()} — push from another machine first`);
  }
  const manifest = JSON.parse(manifestBuf.toString("utf8")) as CloudSyncManifest;
  if (manifest.version !== 1) throw new Error(`unsupported remote manifest version ${manifest.version}`);

  const files: string[] = [MANIFEST_FILE];
  const configBuf = await downloadFile(CONFIG_FILE);
  if (configBuf) {
    // Validate by parsing + saveConfig path (structural checks)
    const raw = JSON.parse(configBuf.toString("utf8"));
    saveConfig(raw);
    files.push(CONFIG_FILE);
  }

  let hasVault = false;
  if (manifest.hasVault || manifest.files.includes(VAULT_FILE)) {
    if (!options.passphrase) {
      throw new Error("remote has encrypted vault — provide --passphrase to restore accounts");
    }
    const vaultBuf = await downloadFile(VAULT_FILE);
    if (vaultBuf) {
      const plain = decryptVault(vaultBuf, options.passphrase);
      const payload = unpackVaultFiles(plain);
      for (const [name, content] of Object.entries(payload.files)) {
        if (!VAULT_FILES.includes(name as typeof VAULT_FILES[number])) continue;
        writeLocal(name, content.endsWith("\n") ? content : `${content}\n`);
        files.push(name);
      }
      hasVault = true;
    }
  }

  const wantUsage = options.includeUsage ?? manifest.includeUsage;
  if (wantUsage) {
    const usageBuf = await downloadFile(USAGE_FILE);
    if (usageBuf) {
      // Merge: append remote lines not already present (simple content-hash set of last 50k lines)
      const local = readLocalOptional(USAGE_FILE) ?? "";
      const localLines = new Set(local.split("\n").filter(Boolean));
      const remoteLines = usageBuf.toString("utf8").split("\n").filter(Boolean);
      const merged = [...localLines];
      for (const line of remoteLines) {
        if (!localLines.has(line)) merged.push(line);
      }
      writeLocal(USAGE_FILE, `${merged.join("\n")}\n`);
      files.push(USAGE_FILE);
    }
  }

  const settings = readCloudSyncSettings();
  writeCloudSyncSettings({
    ...settings,
    lastSyncAt: new Date().toISOString(),
    lastSyncDirection: "pull",
    lastDeviceId: getOrCreateDeviceId(),
  });

  return {
    direction: "pull",
    remoteRoot: remoteSyncRootDescription(),
    files,
    hasVault,
    updatedAt: manifest.updatedAt,
  };
}

export async function readRemoteManifest(): Promise<CloudSyncManifest | null> {
  const buf = await downloadFile(MANIFEST_FILE);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as CloudSyncManifest;
  } catch {
    return null;
  }
}
