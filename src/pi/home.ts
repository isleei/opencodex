/**
 * Pi agent home paths.
 *
 * Default root is `~/.pi/agent` (Pi's documented global agent dir). `PI_HOME` may
 * override the parent `~/.pi` (so `PI_HOME=/tmp/pi` → `/tmp/pi/agent/...`), matching
 * the "home of the product" pattern used by Grok's `GROK_HOME`.
 *
 * We never invent a second state root under `~/.opencodex` for Pi files: Pi owns
 * these paths; opencodex only reads/writes well-known keys inside them.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolvePiRoot(piHome?: string): string {
  return piHome ?? process.env.PI_HOME ?? join(homedir(), ".pi");
}

export function resolvePiAgentDir(piHome?: string): string {
  return join(resolvePiRoot(piHome), "agent");
}

export function piModelsPath(piHome?: string): string {
  return join(resolvePiAgentDir(piHome), "models.json");
}

export function piSettingsPath(piHome?: string): string {
  return join(resolvePiAgentDir(piHome), "settings.json");
}

export function piExtensionsDir(piHome?: string): string {
  return join(resolvePiAgentDir(piHome), "extensions");
}

export function piAgentDirExists(piHome?: string): boolean {
  const dir = resolvePiAgentDir(piHome);
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
