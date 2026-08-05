/**
 * Inject / remove the managed `providers.opencodex` block in Pi's models.json.
 *
 * Ownership model (user choice: managed block only):
 * - We own ONLY the provider key `opencodex`.
 * - Other providers, top-level keys, and formatting of the rest of the file are
 *   preserved as far as JSON round-trip allows (re-pretty-printed with 2-space
 *   indent; unknown sibling keys stay).
 * - Apply upserts `providers.opencodex`; remove deletes that key alone.
 *
 * Non-loopback binds refuse to write: the emitted apiKey is an env reference, and
 * a remote baseUrl would silently send traffic somewhere the local dashboard
 * cannot prove is this proxy (same policy as Grok inject).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../config";
import {
  OPENCODE_PROVIDER_ID,
  PI_API_KEY_ENV_REF,
  buildClientConfig,
  type ExportModel,
  type PiGeneratedConfig,
  type PiProviderBlock,
} from "../clients/config-export";
import { isLoopbackHostname, providerBaseHost } from "../codex/inject";
import { piAgentDirExists, piModelsPath, resolvePiAgentDir } from "./home";

export interface PiInjectModel {
  namespaced: string;
  provider: string;
  id: string;
  native?: boolean;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
}

export interface PiInjectResult {
  ok: boolean;
  changed: boolean;
  message: string;
  modelsPath: string;
  modelCount: number;
  skippedReason?: "no-pi-home" | "non-loopback" | "invalid-file";
}

export interface PiModelsStatus {
  modelsPath: string;
  present: boolean;
  baseUrl: string | null;
  modelCount: number;
  models: Array<{ id: string; name?: string; contextWindow?: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelsDocument(path: string): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, doc: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (raw.trim() === "") return { ok: true, doc: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ok: false, error: "models.json root must be an object" };
    return { ok: true, doc: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function providersOf(doc: Record<string, unknown>): Record<string, unknown> {
  const providers = doc.providers;
  if (isRecord(providers)) return { ...providers };
  return {};
}

function asPiProviderBlock(value: unknown): PiProviderBlock | null {
  if (!isRecord(value)) return null;
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : null;
  const api = typeof value.api === "string" ? value.api : null;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey : null;
  const models = Array.isArray(value.models) ? value.models : null;
  if (!baseUrl || !api || !apiKey || !models) return null;
  return value as unknown as PiProviderBlock;
}

/** Build the opencodex provider block using the shared Pi export serializer. */
export function buildPiOpencodexProvider(
  baseUrl: string,
  models: readonly PiInjectModel[],
): PiProviderBlock {
  const exportModels: ExportModel[] = models.map(model => ({
    namespaced: model.namespaced,
    provider: model.provider,
    id: model.id,
    ...(model.native !== undefined ? { native: model.native } : {}),
    ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {}),
  }));
  const generated = buildClientConfig("pi", { baseUrl, models: exportModels }) as PiGeneratedConfig;
  const block = generated.providers[OPENCODE_PROVIDER_ID];
  if (!block) {
    // Defensive: the exporter always emits OPENCODE_PROVIDER_ID.
    return {
      baseUrl,
      api: "openai-completions",
      apiKey: PI_API_KEY_ENV_REF,
      models: [],
    };
  }
  return block;
}

export function readPiModelsStatus(opts: { piHome?: string } = {}): PiModelsStatus {
  const modelsPath = piModelsPath(opts.piHome);
  const empty: PiModelsStatus = { modelsPath, present: false, baseUrl: null, modelCount: 0, models: [] };
  const loaded = readModelsDocument(modelsPath);
  if (!loaded.ok) return empty;
  const block = asPiProviderBlock(providersOf(loaded.doc)[OPENCODE_PROVIDER_ID]);
  if (!block) return empty;
  const models = block.models.map(entry => ({
    id: entry.id,
    ...(entry.name ? { name: entry.name } : {}),
    ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
  }));
  return {
    modelsPath,
    present: true,
    baseUrl: block.baseUrl,
    modelCount: models.length,
    models,
  };
}

/**
 * Upsert providers.opencodex. Refuses non-loopback hostnames and missing agent dir
 * (we create models.json, but not a whole ~/.pi tree the user never installed).
 */
export function injectPiModels(
  port: number,
  models: readonly PiInjectModel[],
  opts: { hostname?: string; piHome?: string } = {},
): PiInjectResult {
  const modelsPath = piModelsPath(opts.piHome);
  const host = providerBaseHost(opts.hostname);
  if (!isLoopbackHostname(host)) {
    return {
      ok: true,
      changed: false,
      message: `Pi models inject skipped: hostname ${host} is not loopback.`,
      modelsPath,
      modelCount: 0,
      skippedReason: "non-loopback",
    };
  }
  if (!piAgentDirExists(opts.piHome)) {
    return {
      ok: true,
      changed: false,
      message: `Pi models inject skipped: ${resolvePiAgentDir(opts.piHome)} does not exist (install Pi first).`,
      modelsPath,
      modelCount: 0,
      skippedReason: "no-pi-home",
    };
  }

  const baseUrl = `http://${host}:${port}/v1`;
  const block = buildPiOpencodexProvider(baseUrl, models);
  const loaded = readModelsDocument(modelsPath);
  if (!loaded.ok) {
    return {
      ok: false,
      changed: false,
      message: `Pi models inject failed: ${loaded.error}`,
      modelsPath,
      modelCount: 0,
      skippedReason: "invalid-file",
    };
  }

  const previous = JSON.stringify(loaded.doc);
  const providers = providersOf(loaded.doc);
  providers[OPENCODE_PROVIDER_ID] = block;
  const nextDoc: Record<string, unknown> = { ...loaded.doc, providers };
  const next = `${JSON.stringify(nextDoc, null, 2)}\n`;
  if (next === `${previous.trim() === "" ? "{}" : JSON.stringify(loaded.doc, null, 2)}\n`) {
    // Compare structured equality instead of string form of the read file (may lack trailing newline).
    const same = JSON.stringify(loaded.doc) === JSON.stringify(nextDoc);
    if (same) {
      return {
        ok: true,
        changed: false,
        message: `Pi models unchanged (${block.models.length} model${block.models.length === 1 ? "" : "s"}).`,
        modelsPath,
        modelCount: block.models.length,
      };
    }
  }

  mkdirSync(dirname(modelsPath), { recursive: true });
  if (existsSync(modelsPath)) {
    try {
      copyFileSync(modelsPath, `${modelsPath}.opencodex.bak`);
    } catch {
      // Backup is best-effort; write still proceeds.
    }
  }
  atomicWriteFile(modelsPath, next);
  return {
    ok: true,
    changed: true,
    message: `Pi models updated: ${block.models.length} model${block.models.length === 1 ? "" : "s"} → ${modelsPath}`,
    modelsPath,
    modelCount: block.models.length,
  };
}

/** Delete only providers.opencodex; leave the rest of models.json alone. */
export function removePiModels(opts: { piHome?: string } = {}): PiInjectResult {
  const modelsPath = piModelsPath(opts.piHome);
  if (!existsSync(modelsPath)) {
    return {
      ok: true,
      changed: false,
      message: "Pi models: nothing to remove (file absent).",
      modelsPath,
      modelCount: 0,
    };
  }
  const loaded = readModelsDocument(modelsPath);
  if (!loaded.ok) {
    return {
      ok: false,
      changed: false,
      message: `Pi models remove failed: ${loaded.error}`,
      modelsPath,
      modelCount: 0,
      skippedReason: "invalid-file",
    };
  }
  const providers = providersOf(loaded.doc);
  if (!(OPENCODE_PROVIDER_ID in providers)) {
    return {
      ok: true,
      changed: false,
      message: "Pi models: opencodex provider not present.",
      modelsPath,
      modelCount: 0,
    };
  }
  delete providers[OPENCODE_PROVIDER_ID];
  // Pi requires a top-level `providers` object even when empty — bare `{}` fails schema
  // validation ("must have required properties providers"). Always keep the key.
  const nextDoc: Record<string, unknown> = { ...loaded.doc, providers };
  if (existsSync(modelsPath)) {
    try {
      copyFileSync(modelsPath, `${modelsPath}.opencodex.bak`);
    } catch {
      // best-effort
    }
  }
  atomicWriteFile(modelsPath, `${JSON.stringify(nextDoc, null, 2)}\n`);
  return {
    ok: true,
    changed: true,
    message: `Pi models: removed providers.opencodex from ${modelsPath}`,
    modelsPath,
    modelCount: 0,
  };
}
