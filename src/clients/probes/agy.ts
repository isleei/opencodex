/**
 * Antigravity / agy best-effort probe.
 *
 * ocx does not own agy config; we only report binary presence, Paseo-facing
 * hints (via aggregator), and any obvious config path if present.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface AgyProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
  binary: string | null;
}

function resolveBinary(name: string): string | null {
  try {
    // Bun.which is the project standard for PATH lookups.
    const which = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
    if (typeof which === "function") {
      return which(name) ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

export function probeAgy(opts: { home: string } = { home: "" }): AgyProbeResult {
  const notes: string[] = [];
  const binary = resolveBinary("agy") ?? resolveBinary("agy-acp");
  const candidates = [
    join(opts.home, ".gemini", "antigravity"),
    join(opts.home, ".local", "bin", "agy"),
    join(opts.home, ".agy"),
  ];
  const configPaths = candidates.filter(p => existsSync(p));
  const present = Boolean(binary) || configPaths.length > 0;
  if (!present) {
    notes.push("agy binary not on PATH and no known config dir found.");
  } else if (!binary) {
    notes.push("agy binary not on PATH.");
  } else {
    notes.push("Routing is managed by Antigravity/Google; ocx does not inject agy base URL.");
  }
  return {
    present,
    baseUrl: null,
    model: null,
    configPaths,
    notes,
    binary,
  };
}
