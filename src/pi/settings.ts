/**
 * Curated read/patch of Pi's global settings.json.
 *
 * Only a allowlisted subset is writable through opencodex. `packages` and path
 * resource arrays are managed by the packages/extensions modules (which shell out
 * to `pi` or list directories), never by free-form JSON merge here — that keeps
 * shell-source injection and arbitrary extension paths out of a single PUT body.
 *
 * Unknown keys already on disk are always preserved.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../config";
import { piAgentDirExists, piSettingsPath, resolvePiAgentDir } from "./home";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TRUST_VALUES = new Set(["ask", "always", "never"]);

export interface PiCuratedSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  hideThinkingBlock?: boolean;
  theme?: string;
  quietStartup?: boolean;
  defaultProjectTrust?: string;
  enabledModels?: string[];
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
  };
  /** Present in the file; packages are managed separately but shown for context. */
  packages?: unknown[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

export interface PiSettingsStatus {
  settingsPath: string;
  present: boolean;
  settings: PiCuratedSettings;
  /** Raw top-level keys we did not map — count only, never values (may hold secrets). */
  otherKeyCount: number;
}

export interface PiSettingsWriteResult {
  ok: boolean;
  changed: boolean;
  message: string;
  settingsPath: string;
  settings?: PiCuratedSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDoc(path: string): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, doc: {} };
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.trim() === "") return { ok: true, doc: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ok: false, error: "settings.json root must be an object" };
    return { ok: true, doc: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && Number.isInteger(value)
    ? value
    : undefined;
}

function nonNegInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
    ? value
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(entry => typeof entry === "string")) return undefined;
  return value as string[];
}

/** Project a raw settings object onto the curated surface. */
export function projectPiSettings(doc: Record<string, unknown>): { settings: PiCuratedSettings; otherKeyCount: number } {
  const known = new Set([
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "hideThinkingBlock",
    "theme",
    "quietStartup",
    "defaultProjectTrust",
    "enabledModels",
    "compaction",
    "retry",
    "packages",
    "extensions",
    "skills",
    "prompts",
    "themes",
  ]);
  const settings: PiCuratedSettings = {};
  if (typeof doc.defaultProvider === "string") settings.defaultProvider = doc.defaultProvider;
  if (typeof doc.defaultModel === "string") settings.defaultModel = doc.defaultModel;
  if (typeof doc.defaultThinkingLevel === "string") settings.defaultThinkingLevel = doc.defaultThinkingLevel;
  if (typeof doc.hideThinkingBlock === "boolean") settings.hideThinkingBlock = doc.hideThinkingBlock;
  if (typeof doc.theme === "string") settings.theme = doc.theme;
  if (typeof doc.quietStartup === "boolean") settings.quietStartup = doc.quietStartup;
  if (typeof doc.defaultProjectTrust === "string") settings.defaultProjectTrust = doc.defaultProjectTrust;
  const enabledModels = asStringArray(doc.enabledModels);
  if (enabledModels) settings.enabledModels = enabledModels;
  if (isRecord(doc.compaction)) {
    const c: NonNullable<PiCuratedSettings["compaction"]> = {};
    if (typeof doc.compaction.enabled === "boolean") c.enabled = doc.compaction.enabled;
    const reserve = positiveInt(doc.compaction.reserveTokens);
    if (reserve !== undefined) c.reserveTokens = reserve;
    const keep = positiveInt(doc.compaction.keepRecentTokens);
    if (keep !== undefined) c.keepRecentTokens = keep;
    if (Object.keys(c).length > 0) settings.compaction = c;
  }
  if (isRecord(doc.retry)) {
    const r: NonNullable<PiCuratedSettings["retry"]> = {};
    if (typeof doc.retry.enabled === "boolean") r.enabled = doc.retry.enabled;
    const maxRetries = nonNegInt(doc.retry.maxRetries);
    if (maxRetries !== undefined) r.maxRetries = maxRetries;
    const baseDelayMs = nonNegInt(doc.retry.baseDelayMs);
    if (baseDelayMs !== undefined) r.baseDelayMs = baseDelayMs;
    if (Object.keys(r).length > 0) settings.retry = r;
  }
  if (Array.isArray(doc.packages)) settings.packages = doc.packages;
  const extensions = asStringArray(doc.extensions);
  if (extensions) settings.extensions = extensions;
  const skills = asStringArray(doc.skills);
  if (skills) settings.skills = skills;
  const prompts = asStringArray(doc.prompts);
  if (prompts) settings.prompts = prompts;
  const themes = asStringArray(doc.themes);
  if (themes) settings.themes = themes;

  let otherKeyCount = 0;
  for (const key of Object.keys(doc)) {
    if (!known.has(key)) otherKeyCount += 1;
  }
  return { settings, otherKeyCount };
}

export function readPiSettings(opts: { piHome?: string } = {}): PiSettingsStatus {
  const settingsPath = piSettingsPath(opts.piHome);
  const loaded = readDoc(settingsPath);
  if (!loaded.ok) {
    return { settingsPath, present: false, settings: {}, otherKeyCount: 0 };
  }
  const present = existsSync(settingsPath);
  const { settings, otherKeyCount } = projectPiSettings(loaded.doc);
  return { settingsPath, present, settings, otherKeyCount };
}

/**
 * Validate and apply a partial patch. Returns a user-facing error string on bad input.
 * `null` fields clear the key when the property is present with value null.
 */
export function validatePiSettingsPatch(patch: unknown): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(patch)) return { ok: false, error: "body must be an object" };
  const out: Record<string, unknown> = {};

  const stringOrNull = (key: string, max = 200): string | null | undefined | false => {
    if (!(key in patch)) return undefined;
    const value = patch[key];
    if (value === null) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
    return value;
  };

  for (const key of ["defaultProvider", "defaultModel", "theme"] as const) {
    const value = stringOrNull(key);
    if (value === false) return { ok: false, error: `${key} must be a non-empty string or null` };
    if (value !== undefined) out[key] = value;
  }

  if ("defaultThinkingLevel" in patch) {
    const value = patch.defaultThinkingLevel;
    if (value === null) out.defaultThinkingLevel = null;
    else if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
      return { ok: false, error: `defaultThinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")} or null` };
    } else out.defaultThinkingLevel = value;
  }

  if ("defaultProjectTrust" in patch) {
    const value = patch.defaultProjectTrust;
    if (value === null) out.defaultProjectTrust = null;
    else if (typeof value !== "string" || !TRUST_VALUES.has(value)) {
      return { ok: false, error: `defaultProjectTrust must be one of ${[...TRUST_VALUES].join(", ")} or null` };
    } else out.defaultProjectTrust = value;
  }

  for (const key of ["hideThinkingBlock", "quietStartup"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null) out[key] = null;
    else if (typeof value !== "boolean") return { ok: false, error: `${key} must be a boolean or null` };
    else out[key] = value;
  }

  if ("enabledModels" in patch) {
    const value = patch.enabledModels;
    if (value === null) out.enabledModels = null;
    else {
      const arr = asStringArray(value);
      if (!arr || arr.length > 500) return { ok: false, error: "enabledModels must be a string array (max 500) or null" };
      out.enabledModels = arr;
    }
  }

  if ("compaction" in patch) {
    const value = patch.compaction;
    if (value === null) out.compaction = null;
    else if (!isRecord(value)) return { ok: false, error: "compaction must be an object or null" };
    else {
      const c: Record<string, unknown> = {};
      if ("enabled" in value) {
        if (typeof value.enabled !== "boolean") return { ok: false, error: "compaction.enabled must be boolean" };
        c.enabled = value.enabled;
      }
      if ("reserveTokens" in value) {
        const n = positiveInt(value.reserveTokens);
        if (n === undefined) return { ok: false, error: "compaction.reserveTokens must be a positive integer" };
        c.reserveTokens = n;
      }
      if ("keepRecentTokens" in value) {
        const n = positiveInt(value.keepRecentTokens);
        if (n === undefined) return { ok: false, error: "compaction.keepRecentTokens must be a positive integer" };
        c.keepRecentTokens = n;
      }
      out.compaction = c;
    }
  }

  if ("retry" in patch) {
    const value = patch.retry;
    if (value === null) out.retry = null;
    else if (!isRecord(value)) return { ok: false, error: "retry must be an object or null" };
    else {
      const r: Record<string, unknown> = {};
      if ("enabled" in value) {
        if (typeof value.enabled !== "boolean") return { ok: false, error: "retry.enabled must be boolean" };
        r.enabled = value.enabled;
      }
      if ("maxRetries" in value) {
        const n = nonNegInt(value.maxRetries);
        if (n === undefined || n > 20) return { ok: false, error: "retry.maxRetries must be an integer 0–20" };
        r.maxRetries = n;
      }
      if ("baseDelayMs" in value) {
        const n = nonNegInt(value.baseDelayMs);
        if (n === undefined || n > 600_000) return { ok: false, error: "retry.baseDelayMs must be an integer 0–600000" };
        r.baseDelayMs = n;
      }
      out.retry = r;
    }
  }

  // Reject unknown top-level patch keys so clients cannot smuggle packages/extensions.
  const allowed = new Set([
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "hideThinkingBlock",
    "theme",
    "quietStartup",
    "defaultProjectTrust",
    "enabledModels",
    "compaction",
    "retry",
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return { ok: false, error: `unsupported settings key: ${key}` };
  }

  return { ok: true, patch: out };
}

function applyPatch(doc: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...doc };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    if ((key === "compaction" || key === "retry") && isRecord(value) && isRecord(next[key])) {
      next[key] = { ...next[key], ...value };
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function writePiSettings(
  patchInput: unknown,
  opts: { piHome?: string } = {},
): PiSettingsWriteResult {
  const settingsPath = piSettingsPath(opts.piHome);
  if (!piAgentDirExists(opts.piHome)) {
    return {
      ok: false,
      changed: false,
      message: `Pi settings write skipped: ${resolvePiAgentDir(opts.piHome)} does not exist.`,
      settingsPath,
    };
  }
  const validated = validatePiSettingsPatch(patchInput);
  if (!validated.ok) {
    return { ok: false, changed: false, message: validated.error, settingsPath };
  }
  if (Object.keys(validated.patch).length === 0) {
    return { ok: true, changed: false, message: "No settings changes.", settingsPath, settings: readPiSettings(opts).settings };
  }

  const loaded = readDoc(settingsPath);
  if (!loaded.ok) {
    return { ok: false, changed: false, message: loaded.error, settingsPath };
  }
  const nextDoc = applyPatch(loaded.doc, validated.patch);
  if (JSON.stringify(loaded.doc) === JSON.stringify(nextDoc)) {
    const projected = projectPiSettings(nextDoc);
    return {
      ok: true,
      changed: false,
      message: "Pi settings unchanged.",
      settingsPath,
      settings: projected.settings,
    };
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existsSync(settingsPath)) {
    try {
      copyFileSync(settingsPath, `${settingsPath}.opencodex.bak`);
    } catch {
      // best-effort
    }
  }
  atomicWriteFile(settingsPath, `${JSON.stringify(nextDoc, null, 2)}\n`);
  const projected = projectPiSettings(nextDoc);
  return {
    ok: true,
    changed: true,
    message: `Pi settings updated → ${settingsPath}`,
    settingsPath,
    settings: projected.settings,
  };
}
