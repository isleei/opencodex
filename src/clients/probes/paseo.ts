/**
 * Paseo launcher command probe (optional).
 *
 * Reads `~/.paseo/config.json` → `agents.providers.*.command` only.
 * Env maps are ignored (may hold secrets).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PaseoProviderCommand {
  provider: string;
  command: string[];
}

export function paseoConfigPath(home: string): string {
  return join(home, ".paseo", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPaseoProviderCommands(opts: {
  home: string;
  configPath?: string;
} = { home: "" }): PaseoProviderCommand[] {
  const path = opts.configPath ?? paseoConfigPath(opts.home);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  // Support both top-level `providers` and nested `agents.providers`.
  const providersRoot = isRecord(parsed.agents) && isRecord(parsed.agents.providers)
    ? parsed.agents.providers
    : isRecord(parsed.providers)
      ? parsed.providers
      : null;
  if (!providersRoot) return [];

  const out: PaseoProviderCommand[] = [];
  for (const [provider, value] of Object.entries(providersRoot)) {
    if (!isRecord(value)) continue;
    const command = value.command;
    if (!Array.isArray(command) || !command.every(c => typeof c === "string")) continue;
    if (command.length === 0) continue;
    out.push({ provider, command: command as string[] });
  }
  return out;
}
