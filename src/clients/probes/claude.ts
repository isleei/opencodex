/**
 * Claude Code disk settings probe.
 *
 * Reads only non-secret fields from `~/.claude/settings.json` env:
 * ANTHROPIC_BASE_URL and model selectors. Never returns AUTH_TOKEN or any key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEnv(env: Record<string, unknown>, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function claudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

export function probeClaude(opts: { home: string; settingsPath?: string } = { home: "" }): ClaudeProbeResult {
  const path = opts.settingsPath ?? claudeSettingsPath(opts.home);
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
      notes: [`Could not read settings.json: ${error instanceof Error ? error.message : String(error)}`],
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
      notes: ["settings.json is not valid JSON"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      present: true,
      baseUrl: null,
      model: null,
      configPaths: [path],
      notes: ["settings.json root is not an object"],
    };
  }

  const env = isRecord(parsed.env) ? parsed.env : {};
  // Only non-secret routing fields. AUTH_TOKEN / API keys are intentionally ignored.
  const baseUrl = stringEnv(env, "ANTHROPIC_BASE_URL");
  const model = stringEnv(env, "ANTHROPIC_MODEL")
    ?? stringEnv(env, "ANTHROPIC_DEFAULT_OPUS_MODEL")
    ?? stringEnv(env, "ANTHROPIC_DEFAULT_SONNET_MODEL")
    ?? (typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null);

  if (!baseUrl) notes.push("No ANTHROPIC_BASE_URL in settings.json env.");
  return {
    present: true,
    baseUrl,
    model,
    configPaths: [path],
    notes,
  };
}
