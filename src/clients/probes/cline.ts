/**
 * Cline effective-status probe.
 * Reads providers.json and checks for opencodex / openai-compatible configuration.
 */
import { existsSync, readFileSync } from "node:fs";
import { clineConfigPath, clineHomeDir } from "../config-export";

export interface ClineProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
  binary: string | null;
}

function resolveBinary(name: string): string | null {
  try {
    const which = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
    if (typeof which === "function") {
      return which(name) ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

export function probeCline(opts: { home: string; env?: NodeJS.ProcessEnv } = { home: "" }): ClineProbeResult {
  const notes: string[] = [];
  const binary = resolveBinary("cline");
  const configPath = clineConfigPath(opts.env, opts.home);
  const homeDir = clineHomeDir(opts.env, opts.home);
  const exists = existsSync(configPath);
  const dirExists = existsSync(homeDir);
  const present = exists || dirExists || Boolean(binary);

  if (!exists) {
    if (present) {
      notes.push("Cline installation detected, but providers.json is not configured yet.");
    }
    return {
      present,
      baseUrl: null,
      model: null,
      configPaths: existsSync(homeDir) ? [homeDir] : [configPath],
      notes,
      binary,
    };
  }

  let baseUrl: string | null = null;
  let model: string | null = null;

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      lastUsedProvider?: string;
      providers?: Record<string, { settings?: { baseUrl?: string; model?: string; provider?: string } }>;
    };
    const providers = parsed?.providers ?? {};
    const ocxProvider = providers.opencodex ?? providers["openai-compatible"];
    if (ocxProvider?.settings?.baseUrl) {
      baseUrl = ocxProvider.settings.baseUrl;
      model = ocxProvider.settings.model ?? null;
    } else if (parsed?.lastUsedProvider && providers[parsed.lastUsedProvider]?.settings?.baseUrl) {
      const active = providers[parsed.lastUsedProvider]!;
      baseUrl = active.settings?.baseUrl ?? null;
      model = active.settings?.model ?? null;
    }
  } catch (error) {
    notes.push(`Could not read providers.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    present: true,
    baseUrl,
    model,
    configPaths: [configPath],
    notes,
    binary,
  };
}
