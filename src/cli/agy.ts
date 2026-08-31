/**
 * `ocx agy [agy args...]` — launch Antigravity CLI with account discovery,
 * interactive multi-account picker, automatic proxy readiness, and usage hooks.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { commandInvocation, resolveWindowsCommand } from "../lib/win-exec";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { apiJson, fetchOAuthRows, resolveBaseUrl, type AccountDeps, type AccountRow } from "./account-api";
import { takeFlag, takeOption } from "./runtime-api";

export interface AgyDeps extends AccountDeps {
  findBinaryImpl?: () => string | null;
  spawnImpl?: typeof spawn;
  stdinImpl?: NodeJS.ReadStream;
  stdoutImpl?: NodeJS.WriteStream;
  isInteractive?: boolean;
  findLiveProxyImpl?: () => Promise<LiveProxy | null>;
  exitImpl?: (code: number) => void;
}

export const AGY_USAGE = `Usage:
  ocx agy [agy args...]                     Launch Antigravity CLI (interactive account picker if multiple)
  ocx agy --account <id|email|index> [...]  Launch Antigravity CLI with the specified account
  ocx agy -a <id|email|index> [...]         Alias of --account
  ocx agy --no-select [...]                 Launch using currently active account without prompt
  ocx agy accounts [--json]                 List all configured Google Antigravity accounts
  ocx agy list [--json]                     Alias of ocx agy accounts
  ocx agy use <id|email|index>              Switch the active Google Antigravity account
  ocx agy switch <id|email|index>           Alias of ocx agy use
  ocx agy hook <install|uninstall|status>   Manage the AGY token usage ingestion hook`;

export const AGY_INSTALL_HINT = `❌ \`agy\` CLI not found.
Make sure Antigravity is installed and accessible in your PATH.
Default locations checked:
  - ~/.local/bin/agy
  - /usr/local/bin/agy
  - ~/.antigravity/bin/agy
  - Antigravity IDE application bundle`;

/**
 * Locate the Antigravity CLI (`agy`) executable across standard platforms.
 */
export function resolveAgyBinary(deps: AgyDeps = {}): string | null {
  if (deps.findBinaryImpl) return deps.findBinaryImpl();

  const envBin = process.env.AGY_BIN || process.env.AGY_PATH;
  if (envBin && existsSync(envBin)) return envBin;

  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand("agy");
    if (resolved !== "agy" && existsSync(resolved)) return resolved;
    const localAppData = process.env.LOCALAPPDATA || "";
    const winCandidates = [
      join(localAppData, "Programs", "Antigravity", "bin", "agy.cmd"),
      join(localAppData, "Programs", "Antigravity", "agy.exe"),
      join(homedir(), ".local", "bin", "agy.cmd"),
      join(homedir(), ".local", "bin", "agy.exe"),
    ];
    for (const cand of winCandidates) {
      if (cand && existsSync(cand)) return cand;
    }
    return null;
  }

  const homedirPath = homedir();
  const pathDirs = (process.env.PATH || "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const p = join(dir, "agy");
    if (existsSync(p)) return p;
  }

  const candidates = [
    join(homedirPath, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    join(homedirPath, ".antigravity", "bin", "agy"),
    join(homedirPath, "bin", "agy"),
    "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/agy",
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }

  return null;
}

/**
 * Ensure the local OpenCodex proxy is running so account queries and usage tracking succeed.
 */
export async function ensureProxyForAgy(deps: AgyDeps = {}): Promise<number | null> {
  const findLive = deps.findLiveProxyImpl ?? findLiveProxy;
  const live = await findLive();
  if (live) return live.port;

  if (deps.baseUrl) {
    try {
      const url = new URL(deps.baseUrl);
      return Number(url.port) || 10100;
    } catch {
      return 10100;
    }
  }

  const cfg = deps.loadConfigImpl?.() ?? loadConfig();
  const pinPort = typeof cfg.port === "number" && cfg.port > 0 ? cfg.port : 10100;
  const spawnProc = deps.spawnImpl ?? spawn;
  const child = spawnProc(process.execPath, selfLaunchArgv(["start", "--port", String(pinPort)]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withProcessRuntimeProvenance({ ...process.env, OCX_SERVICE: "1" }),
  });
  if (typeof child.unref === "function") child.unref();

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLive();
    if (started) return started.port;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Match an account row by 1-based index, exact ID, ID prefix, or email/label substring.
 */
export function matchAntigravityAccount(rows: AccountRow[], query: string): AccountRow | null {
  if (!query || rows.length === 0) return null;
  const trimmed = query.trim();

  // 1. 1-based index (e.g. "1", "2", "3")
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= rows.length) {
      return rows[num - 1];
    }
    return null;
  }

  // 2. Exact ID match
  const exactId = rows.find(r => r.id === trimmed);
  if (exactId) return exactId;

  // 3. ID prefix match
  if (trimmed.length >= 4) {
    const prefixMatches = rows.filter(r => r.id.toLowerCase().startsWith(trimmed.toLowerCase()));
    if (prefixMatches.length === 1) return prefixMatches[0];
  }

  // 4. Email / Label match
  const labelMatches = rows.filter(r => {
    const email = (r.email || "").toLowerCase();
    const label = (r.label || "").toLowerCase();
    const q = trimmed.toLowerCase();
    return email.includes(q) || label.includes(q);
  });
  if (labelMatches.length === 1) return labelMatches[0];
  if (labelMatches.length > 1) {
    const exact = labelMatches.find(r => (r.email || "").toLowerCase() === trimmed.toLowerCase());
    if (exact) return exact;
    return labelMatches[0];
  }

  return null;
}

/**
 * Interactive prompt displaying available accounts and asking the user to choose.
 */
export async function promptAccountSelection(
  rows: AccountRow[],
  defaultActiveId: string | null,
  deps: AgyDeps = {},
): Promise<AccountRow | null> {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const stdin = (deps.stdinImpl ?? process.stdin) as NodeJS.ReadStream;
  const stdout = (deps.stdoutImpl ?? process.stdout) as NodeJS.WriteStream;

  const activeIndex = rows.findIndex(r => r.id === defaultActiveId || r.active);
  const defaultIndex = activeIndex >= 0 ? activeIndex + 1 : 1;

  stdout.write("\n\x1b[1m\x1b[36mGoogle Antigravity Accounts:\x1b[0m\n");
  rows.forEach((row, i) => {
    const idx = i + 1;
    const isAct = row.id === defaultActiveId || row.active;
    const mark = isAct ? " \x1b[32m[active]\x1b[0m" : "";
    const email = row.email || row.label || "unknown";
    const shortId = row.id.length > 12 ? `${row.id.slice(0, 8)}...` : row.id;
    stdout.write(`  \x1b[33m[${idx}]\x1b[0m ${email.padEnd(24)} (id: ${shortId})${mark}\n`);
  });
  stdout.write("\n");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Select account (1-${rows.length}) or press Enter for [${defaultIndex}]: `)).trim();
    if (answer === "") {
      return rows[defaultIndex - 1];
    }
    const matched = matchAntigravityAccount(rows, answer);
    if (!matched) {
      stdout.write(`\x1b[31mInvalid selection "${answer}". Using default [${defaultIndex}].\x1b[0m\n`);
      return rows[defaultIndex - 1];
    }
    return matched;
  } finally {
    rl.close();
  }
}

/**
 * Fetch the list of Google Antigravity accounts from the proxy.
 */
export async function getAntigravityAccounts(deps: AgyDeps, baseUrl: string): Promise<{ rows: AccountRow[]; activeId: string | null }> {
  const result = await fetchOAuthRows(deps, baseUrl, "google-antigravity");
  return { rows: result.rows, activeId: result.activeId };
}

/**
 * Switch the active account for Google Antigravity.
 */
export async function setAntigravityActiveAccount(deps: AgyDeps, baseUrl: string, accountId: string): Promise<boolean> {
  const res = await apiJson(deps, baseUrl, "PUT", "/api/oauth/accounts/active", {
    provider: "google-antigravity",
    accountId,
  });
  return res.status === 200;
}

/**
 * Main entry point for `ocx agy`.
 */
export async function cmdAgy(args: string[], deps: AgyDeps = {}): Promise<number> {
  const rest = [...args];

  if (rest[0] === "--help" || rest[0] === "-h") {
    console.log(AGY_USAGE);
    return 0;
  }

  // Handle explicit subcommands: accounts / list
  if (rest[0] === "accounts" || rest[0] === "list") {
    rest.shift();
    const wantsJson = takeFlag(rest, "--json");
    const port = await ensureProxyForAgy(deps);
    if (!port) {
      console.error("❌ Proxy did not become healthy.");
      return 1;
    }
    const baseUrl = deps.baseUrl || `http://127.0.0.1:${port}`;
    const { rows, activeId } = await getAntigravityAccounts(deps, baseUrl);

    if (wantsJson) {
      console.log(JSON.stringify({ ok: true, provider: "google-antigravity", activeId, accounts: rows }, null, 2));
      return 0;
    }

    if (rows.length === 0) {
      console.log("No Google Antigravity accounts configured. Log in with: ocx login google-antigravity");
      return 0;
    }

    console.log("Google Antigravity Accounts:");
    rows.forEach((row, i) => {
      const idx = i + 1;
      const isAct = row.id === activeId || row.active;
      const mark = isAct ? " [active]" : "";
      const email = row.email || row.label || "unknown";
      console.log(`  [${idx}] ${email.padEnd(24)} (id: ${row.id.slice(0, 12)})${mark}`);
    });
    return 0;
  }

  // Handle explicit subcommands: use / switch
  if (rest[0] === "use" || rest[0] === "switch") {
    rest.shift();
    const target = rest.shift();
    const wantsJson = takeFlag(rest, "--json");
    if (!target) {
      console.error("Usage: ocx agy use <id|email|index>");
      return 1;
    }
    const port = await ensureProxyForAgy(deps);
    if (!port) {
      console.error("❌ Proxy did not become healthy.");
      return 1;
    }
    const baseUrl = deps.baseUrl || `http://127.0.0.1:${port}`;
    const { rows } = await getAntigravityAccounts(deps, baseUrl);
    const matched = matchAntigravityAccount(rows, target);
    if (!matched) {
      console.error(`Error: Unknown Antigravity account "${target}".`);
      return 1;
    }
    const ok = await setAntigravityActiveAccount(deps, baseUrl, matched.id);
    if (!ok) {
      console.error(`Error: Failed to switch to account ${matched.id}`);
      return 1;
    }
    if (wantsJson) {
      console.log(JSON.stringify({ ok: true, activeId: matched.id, email: matched.email || matched.label }, null, 2));
    } else {
      console.log(`✅ google-antigravity: active account is now ${matched.email || matched.label || matched.id} (id: ${matched.id.slice(0, 8)})`);
    }
    return 0;
  }

  // Handle explicit subcommands: hook
  if (rest[0] === "hook") {
    rest.shift();
    const action = (rest.shift() || "status").toLowerCase();
    const projectRoot = join(__dirname, "..", "..");
    const hookScript = join(projectRoot, "agy-opencodex-usage", "install.sh");

    if (!existsSync(hookScript)) {
      console.log("AGY usage ingestion hook script not found in repository.");
      return 1;
    }

    const hookArgs = action === "uninstall" ? ["--uninstall"] : [];
    return await new Promise<number>(resolve => {
      const child = spawn("bash", [hookScript, ...hookArgs], { stdio: "inherit" });
      child.on("exit", code => resolve(code ?? 0));
    });
  }

  // Extract account flag (--account <id> or -a <id>)
  let accountQuery = takeOption(rest, "--account") ?? takeOption(rest, "-a");
  const noSelect = takeFlag(rest, "--no-select");

  // Ensure proxy is running
  const port = await ensureProxyForAgy(deps);
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }

  const baseUrl = deps.baseUrl || `http://127.0.0.1:${port}`;

  // Read accounts
  let accounts: AccountRow[] = [];
  let currentActiveId: string | null = null;
  try {
    const res = await getAntigravityAccounts(deps, baseUrl);
    accounts = res.rows;
    currentActiveId = res.activeId;
  } catch (err) {
    // Non-fatal if account query fails
  }

  // Account selection logic
  if (accountQuery) {
    const matched = matchAntigravityAccount(accounts, accountQuery);
    if (!matched) {
      console.error(`❌ Error: Unknown Antigravity account "${accountQuery}".`);
      if (accounts.length > 0) {
        console.error("Available accounts:");
        accounts.forEach((a, i) => console.error(`  [${i + 1}] ${a.email || a.label || a.id} (id: ${a.id.slice(0, 8)})`));
      }
      return 1;
    }
    if (matched.id !== currentActiveId) {
      await setAntigravityActiveAccount(deps, baseUrl, matched.id);
      console.log(`🔄 Switched to Antigravity account: ${matched.email || matched.label || matched.id}`);
    }
  } else if (!noSelect && accounts.length > 1) {
    const isInteractive = deps.isInteractive ?? (deps.stdinImpl ? deps.stdinImpl.isTTY : process.stdin.isTTY);
    if (isInteractive) {
      const selected = await promptAccountSelection(accounts, currentActiveId, deps);
      if (selected && selected.id !== currentActiveId) {
        await setAntigravityActiveAccount(deps, baseUrl, selected.id);
        console.log(`🔄 Switched to Antigravity account: ${selected.email || selected.label || selected.id}`);
      }
    }
  }

  // Locate agy executable
  const agyBinary = resolveAgyBinary(deps);
  if (!agyBinary) {
    console.error(AGY_INSTALL_HINT);
    return 1;
  }

  // Execute agy with inherited stdio
  return await new Promise<number>(resolve => {
    const inv = commandInvocation(agyBinary, rest);
    const spawnProc = deps.spawnImpl ?? spawn;
    const child = spawnProc(inv.file, inv.args, {
      stdio: "inherit",
      env: { ...process.env, OPENCODEX_PROXY_PORT: String(port) },
      ...inv.options,
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(AGY_INSTALL_HINT);
      } else {
        console.error(`❌ Failed to launch agy: ${err.message}`);
      }
      resolve(1);
    });

    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : code ?? 0);
    });
  });
}
