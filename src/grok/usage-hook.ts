/**
 * Install / remove the managed Grok Build usage hook that reports native-session
 * token usage into opencodex (POST /api/usage/ingest → usage.jsonl + live Logs).
 *
 * Lifecycle mirrors the Grok config fence: installed by sync/start/ensure, removed
 * by stop/eject/uninstall. Only touches files we own (manifest + script dir marked
 * with MANAGED_MARKER); never deletes other user hooks.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface GrokUsageHookResult {
  ok: boolean;
  changed: boolean;
  message: string;
  /** Homes we attempted to install into / strip from. */
  homes: string[];
}

/** Stable marker so strip only removes manifests we wrote. */
export const GROK_USAGE_HOOK_MARKER = "opencodex-managed-grok-usage-hook";
const HOOK_DIR_NAME = "opencodex-usage";
const MANIFEST_NAME = "opencodex-usage.json";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveGrokHome(explicit?: string): string {
  return explicit ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
}

/**
 * Grok homes that should receive the managed usage hook.
 * - When `explicit` is set (tests, targeted install), only that home is used.
 * - Otherwise: `$GROK_HOME` (if set) and the canonical `~/.grok`, when they exist.
 */
export function resolveGrokUsageHookHomes(explicit?: string): string[] {
  const ordered: string[] = [];
  const add = (path: string | undefined) => {
    if (!path) return;
    const normalized = path.replace(/\/+$/, "") || path;
    if (!ordered.includes(normalized) && isDirectory(normalized)) ordered.push(normalized);
  };
  if (explicit !== undefined) {
    add(explicit);
    return ordered;
  }
  add(process.env.GROK_HOME);
  add(join(homedir(), ".grok"));
  return ordered;
}

/** Absolute path to the bundled report.mjs shipped next to this module. */
export function bundledGrokUsageHookScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "usage-hook", "report.mjs");
}

function buildManifest(scriptPath: string): string {
  // Absolute path so Grok can invoke the script regardless of cwd.
  const command = `node ${JSON.stringify(scriptPath)}`;
  const body = {
    description:
      `Report native Grok Build turn usage into opencodex (${GROK_USAGE_HOOK_MARKER}).`,
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: 10,
              statusMessage: "Recording usage to opencodex",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function installIntoHome(grokHome: string, sourceScript: string): boolean {
  const hooksRoot = join(grokHome, "hooks");
  const hookDir = join(hooksRoot, HOOK_DIR_NAME);
  const scriptDest = join(hookDir, "report.mjs");
  const manifestPath = join(hooksRoot, MANIFEST_NAME);

  mkdirSync(hookDir, { recursive: true });

  let changed = false;
  const nextScript = readFileSync(sourceScript);
  let scriptSame = false;
  try {
    scriptSame = existsSync(scriptDest) && readFileSync(scriptDest).equals(nextScript);
  } catch {
    scriptSame = false;
  }
  if (!scriptSame) {
    copyFileSync(sourceScript, scriptDest);
    try {
      chmodSync(scriptDest, 0o755);
    } catch {
      /* Windows */
    }
    changed = true;
  }

  const nextManifest = buildManifest(scriptDest);
  let manifestSame = false;
  try {
    manifestSame = existsSync(manifestPath) && readFileSync(manifestPath, "utf8") === nextManifest;
  } catch {
    manifestSame = false;
  }
  if (!manifestSame) {
    writeFileSync(manifestPath, nextManifest, "utf8");
    changed = true;
  }

  return changed;
}

/**
 * Install (or refresh) the managed usage hook into every resolvable Grok home.
 * No-op when no Grok home directory exists. Never throws — callers treat this as best-effort.
 */
export function installGrokUsageHooks(opts: { grokHome?: string } = {}): GrokUsageHookResult {
  const source = bundledGrokUsageHookScriptPath();
  if (!existsSync(source)) {
    return {
      ok: false,
      changed: false,
      message: `Grok usage hook script missing at ${source}`,
      homes: [],
    };
  }

  const homes = resolveGrokUsageHookHomes(opts.grokHome);
  // If the caller passed an explicit home that does not exist yet but is the only target
  // they care about, do not create a random ~/.grok just for hooks.
  if (homes.length === 0) {
    return {
      ok: true,
      changed: false,
      message: "No Grok home found; usage hook install skipped.",
      homes: [],
    };
  }

  try {
    let changed = false;
    const touched: string[] = [];
    for (const home of homes) {
      if (installIntoHome(home, source)) {
        changed = true;
        touched.push(home);
      }
    }
    return {
      ok: true,
      changed,
      message: changed
        ? `Grok usage hook installed/updated (${touched.map(h => join(h, "hooks", MANIFEST_NAME)).join(", ")}).`
        : "Grok usage hook already up to date.",
      homes,
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      message: `Grok usage hook install failed: ${error instanceof Error ? error.message : String(error)}`,
      homes,
    };
  }
}

function isManagedManifest(path: string): boolean {
  try {
    const text = readFileSync(path, "utf8");
    return text.includes(GROK_USAGE_HOOK_MARKER);
  } catch {
    return false;
  }
}

function stripFromHome(grokHome: string): boolean {
  const hooksRoot = join(grokHome, "hooks");
  const hookDir = join(hooksRoot, HOOK_DIR_NAME);
  const manifestPath = join(hooksRoot, MANIFEST_NAME);
  let changed = false;

  if (existsSync(manifestPath) && isManagedManifest(manifestPath)) {
    rmSync(manifestPath, { force: true });
    changed = true;
  }
  if (existsSync(hookDir)) {
    // Only remove our directory if the manifest was ours or the dir only holds report.mjs.
    // When the manifest is already gone but the dir remains from a partial install, still clean.
    try {
      rmSync(hookDir, { recursive: true, force: true });
      changed = true;
    } catch {
      /* best-effort */
    }
  }
  return changed;
}

/**
 * Remove managed usage-hook files from Grok homes. Leaves other user hooks untouched.
 */
export function stripGrokUsageHooks(opts: { grokHome?: string } = {}): GrokUsageHookResult {
  // Always consider the explicit/env/canonical set — even if a home vanished mid-flight,
  // resolveGrokUsageHookHomes only returns existing dirs.
  const homes = resolveGrokUsageHookHomes(opts.grokHome);
  // Also try the unresolved path so a partially-created home still gets cleaned when present.
  const candidates = new Set(homes);
  const primary = resolveGrokHome(opts.grokHome);
  if (isDirectory(primary)) candidates.add(primary);

  if (candidates.size === 0) {
    return {
      ok: true,
      changed: false,
      message: "No Grok home found; no usage hook to remove.",
      homes: [],
    };
  }

  try {
    let changed = false;
    for (const home of candidates) {
      if (stripFromHome(home)) changed = true;
    }
    return {
      ok: true,
      changed,
      message: changed
        ? "Removed the opencodex Grok usage hook."
        : "No opencodex Grok usage hook found to remove.",
      homes: [...candidates],
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      message: `Grok usage hook cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      homes: [...candidates],
    };
  }
}
