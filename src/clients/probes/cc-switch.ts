/**
 * CC Switch current-profile probe (optional).
 *
 * Opens `~/.cc-switch/cc-switch.db` read-only and returns only
 * `app_type` + `name` for `is_current=1` rows. Never reads settings_config.
 *
 * Falls back to settings.json currentProvider* ids → name lookup when the
 * is_current flag is absent for an app (some builds only store ids in settings).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export interface CcSwitchProfile {
  appType: string;
  name: string | null;
  id: string | null;
}

export function ccSwitchDbPath(home: string): string {
  return join(home, ".cc-switch", "cc-switch.db");
}

export function ccSwitchSettingsPath(home: string): string {
  return join(home, ".cc-switch", "settings.json");
}

const SETTINGS_CURRENT_KEYS: Record<string, string> = {
  currentProviderClaude: "claude",
  currentProviderCodex: "codex",
  currentProviderGemini: "gemini",
  currentProviderGrokbuild: "grokbuild",
  currentProviderOpencode: "opencode",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCcSwitchCurrentProfiles(opts: {
  home: string;
  dbPath?: string;
  settingsPath?: string;
} = { home: "" }): CcSwitchProfile[] {
  const dbPath = opts.dbPath ?? ccSwitchDbPath(opts.home);
  const settingsPath = opts.settingsPath ?? ccSwitchSettingsPath(opts.home);
  if (!existsSync(dbPath)) return [];

  let db: Database;
  try {
    // Read-only URI so we never take a write lock against a running CC Switch.
    db = new Database(dbPath, { readonly: true, create: false });
  } catch {
    return [];
  }

  try {
    const byCurrent = new Map<string, CcSwitchProfile>();
    try {
      const rows = db.query(
        "SELECT id, app_type, name FROM providers WHERE is_current = 1",
      ).all() as Array<{ id: string; app_type: string; name: string }>;
      for (const row of rows) {
        byCurrent.set(row.app_type, {
          appType: row.app_type,
          name: row.name ?? null,
          id: row.id ?? null,
        });
      }
    } catch {
      // Schema may differ; fall through to settings.json ids.
    }

    // Fill gaps from settings.json currentProvider* → id → name (name only).
    if (existsSync(settingsPath)) {
      try {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
        if (isRecord(raw)) {
          for (const [key, appType] of Object.entries(SETTINGS_CURRENT_KEYS)) {
            if (byCurrent.has(appType)) continue;
            const id = raw[key];
            if (typeof id !== "string" || !id) continue;
            try {
              const row = db.query(
                "SELECT id, app_type, name FROM providers WHERE id = ? LIMIT 1",
              ).get(id) as { id: string; app_type: string; name: string } | null;
              if (row) {
                byCurrent.set(appType, {
                  appType: row.app_type || appType,
                  name: row.name ?? null,
                  id: row.id,
                });
              } else {
                byCurrent.set(appType, { appType, name: null, id });
              }
            } catch {
              byCurrent.set(appType, { appType, name: null, id });
            }
          }
        }
      } catch {
        // settings unreadable — keep whatever is_current gave us
      }
    }

    return [...byCurrent.values()];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
