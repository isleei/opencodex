/**
 * OpenCode global config probe.
 *
 * Reads `options.baseURL` only — apiKey is never returned (privacy red line).
 */
import { existsSync, readFileSync } from "node:fs";
import { opencodeGlobalConfigPath } from "../config-export";

export interface OpencodeProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function probeOpencode(opts: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): OpencodeProbeResult {
  const path = opts.configPath
    ?? opencodeGlobalConfigPath(opts.env ?? process.env, opts.home);
  const notes: string[] = [];
  if (!existsSync(path)) {
    return { present: false, baseUrl: null, model: null, configPaths: [path], notes };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      present: true,
      baseUrl: null,
      model: null,
      configPaths: [path],
      notes: [`Could not read opencode.json: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      present: true,
      baseUrl: null,
      model: null,
      configPaths: [path],
      notes: ["opencode.json is not valid JSON"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      present: true,
      baseUrl: null,
      model: null,
      configPaths: [path],
      notes: ["opencode.json root is not an object"],
    };
  }

  const provider = isRecord(parsed.provider) ? parsed.provider : {};
  // Prefer an explicit opencodex provider block; otherwise take the first baseURL found.
  let baseUrl: string | null = null;
  let model: string | null = null;
  const providerIds = Object.keys(provider);

  const prefer = providerIds.includes("opencodex")
    ? ["opencodex", ...providerIds.filter(id => id !== "opencodex")]
    : providerIds;

  for (const id of prefer) {
    const block = provider[id];
    if (!isRecord(block)) continue;
    const options = isRecord(block.options) ? block.options : {};
    // NEVER read options.apiKey.
    const url = typeof options.baseURL === "string" ? options.baseURL.trim()
      : typeof options.baseUrl === "string" ? options.baseUrl.trim()
        : "";
    if (!url) continue;
    if (!baseUrl) {
      baseUrl = url;
      if (id !== "opencodex") notes.push(`Using provider "${id}" baseURL (no opencodex provider block).`);
    }
    const models = isRecord(block.models) ? block.models : null;
    if (models && !model) {
      const first = Object.keys(models)[0];
      if (first) model = first;
    }
    if (baseUrl && id === "opencodex") break;
  }

  if (!baseUrl) notes.push("No provider options.baseURL found.");

  return {
    present: true,
    baseUrl,
    model,
    configPaths: [path],
    notes,
  };
}
