/**
 * Inventory of Pi local extensions (auto-discovered directory + settings paths).
 *
 * We list only; enabling/disabling package resources stays with `pi config` /
 * package filters. Writing arbitrary extension source from the dashboard is out
 * of scope (extensions are executable TypeScript).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { piExtensionsDir } from "./home";
import { readPiSettings } from "./settings";

export interface PiExtensionEntry {
  /** Display name (filename or configured path basenamed). */
  name: string;
  path: string;
  /** auto = ~/.pi/agent/extensions; settings = listed in settings.extensions */
  origin: "auto" | "settings";
  kind: "file" | "directory" | "missing";
}

export interface PiExtensionsStatus {
  autoDir: string;
  entries: PiExtensionEntry[];
}

function classify(path: string): "file" | "directory" | "missing" {
  try {
    if (!existsSync(path)) return "missing";
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

export function readPiExtensions(opts: { piHome?: string } = {}): PiExtensionsStatus {
  const autoDir = piExtensionsDir(opts.piHome);
  const entries: PiExtensionEntry[] = [];
  const seen = new Set<string>();

  if (existsSync(autoDir)) {
    try {
      for (const name of readdirSync(autoDir).sort()) {
        if (name.startsWith(".")) continue;
        const path = join(autoDir, name);
        const kind = classify(path);
        if (kind === "missing") continue;
        // Auto-load is for .ts/.js files and package directories.
        if (kind === "file" && !/\.(ts|js|mjs|cjs)$/i.test(name)) continue;
        seen.add(path);
        entries.push({ name, path, origin: "auto", kind });
      }
    } catch {
      // Unreadable dir → empty auto list.
    }
  }

  const settings = readPiSettings(opts);
  for (const configured of settings.settings.extensions ?? []) {
    const path = configured;
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({
      name: basename(path),
      path,
      origin: "settings",
      kind: classify(path),
    });
  }

  return { autoDir, entries };
}
