/**
 * Codex `config.toml` effective-routing probe.
 *
 * Uses the same marker semantics as inject (`hasInjectedOpenaiBaseUrl` /
 * `rootTomlString`) so the Clients page agrees with `ocx status` / journal.
 * Never returns bearer tokens from model_providers tables.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasInjectedCodexRouting,
  hasInjectedOpenaiBaseUrl,
  providerTableString,
  rootTomlString,
} from "../../codex/injected-marker";

export interface CodexProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
  /** True when root is ocx but extra non-ocx model_providers remain. */
  mixed: boolean;
  injected: boolean;
}

export function codexConfigPath(home: string, codexHome?: string): string {
  if (codexHome) return join(codexHome, "config.toml");
  return join(home, ".codex", "config.toml");
}

/** List bare `[model_providers.X]` table names in a TOML document. */
export function listModelProviderNames(content: string): string[] {
  const names: string[] = [];
  const re = /^\s*\[\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*\]\s*(?:#.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.push(name);
  }
  return names;
}

export function probeCodex(opts: {
  home: string;
  codexHome?: string;
  configPath?: string;
} = { home: "" }): CodexProbeResult {
  const path = opts.configPath ?? codexConfigPath(opts.home, opts.codexHome);
  const notes: string[] = [];
  if (!existsSync(path)) {
    return {
      present: false,
      baseUrl: null,
      model: null,
      configPaths: [path],
      notes,
      mixed: false,
      injected: false,
    };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return {
      present: true,
      baseUrl: null,
      model: null,
      configPaths: [path],
      notes: [`Could not read config.toml: ${error instanceof Error ? error.message : String(error)}`],
      mixed: false,
      injected: false,
    };
  }

  const injected = hasInjectedCodexRouting(content);
  // Effective base URL priority:
  // 1. Marker-owned root openai_base_url (Design B)
  // 2. model_providers.opencodex.base_url when model_provider=opencodex
  // 3. Any root openai_base_url (user-owned)
  // 4. Selected model_provider's base_url
  let baseUrl: string | null = null;
  if (hasInjectedOpenaiBaseUrl(content)) {
    baseUrl = rootTomlString(content, "openai_base_url");
  } else {
    const provider = rootTomlString(content, "model_provider");
    if (provider === "opencodex") {
      baseUrl = providerTableString(content, "opencodex", "base_url");
    }
    if (!baseUrl) {
      baseUrl = rootTomlString(content, "openai_base_url");
    }
    if (!baseUrl && provider) {
      baseUrl = providerTableString(content, provider, "base_url");
    }
  }

  const model = rootTomlString(content, "model");
  const providers = listModelProviderNames(content);
  const foreignProviders = providers.filter(name => name !== "opencodex" && name !== "openai");
  // mixed: root routes via ocx inject, but leftover third-party provider tables exist
  // (e.g. CC Switch / custom entries that can still be selected).
  const mixed = injected && foreignProviders.length > 0;
  if (mixed) {
    notes.push(`Extra model_providers on disk: ${foreignProviders.join(", ")}`);
  }
  if (!baseUrl) notes.push("No openai_base_url / model_provider base_url found.");

  const catalog = rootTomlString(content, "model_catalog_json");
  const configPaths = [path];
  if (catalog) configPaths.push(catalog);

  return {
    present: true,
    baseUrl,
    model,
    configPaths,
    notes,
    mixed,
    injected,
  };
}
