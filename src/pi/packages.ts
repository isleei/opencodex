/**
 * Pi package management via the real `pi` CLI.
 *
 * We deliberately do not re-implement npm/git install: packages run with full
 * system access (Pi docs). Spawning `pi install|remove|list` keeps the same
 * trust model the user already accepts when using Pi interactively, and avoids
 * inventing a second installer that could diverge from Pi's pin/reconcile rules.
 *
 * Source strings are validated before spawn (no shell metacharacters; argv only).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { readPiSettings } from "./settings";

export interface PiPackageEntry {
  /** Canonical source string as stored in settings (string form or object.source). */
  source: string;
  /** When settings used object form, optional resource filters. */
  filters?: {
    skills?: string[];
    extensions?: string[];
    prompts?: string[];
    themes?: string[];
  };
}

export interface PiPackagesStatus {
  packages: PiPackageEntry[];
  /** Output of `pi list` when available (may be empty if pi is missing). */
  listOutput: string | null;
  piBinary: string | null;
}

export interface PiPackageCommandResult {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const SOURCE_MAX = 512;
const RUN_TIMEOUT_MS = 120_000;

/**
 * Accept Pi's documented source forms only. Reject anything that looks like shell
 * composition — we always pass argv, but defense in depth still matters.
 */
export function validatePiPackageSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > SOURCE_MAX) return "package source is empty or too long";
  if (/[\0\n\r;|&`$]/.test(trimmed)) return "package source contains forbidden characters";
  if (
    trimmed.startsWith("npm:")
    || trimmed.startsWith("git:")
    || trimmed.startsWith("https://")
    || trimmed.startsWith("http://")
    || trimmed.startsWith("ssh://")
    || trimmed.startsWith("git://")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(trimmed) // Windows path
  ) {
    return null;
  }
  // Bare npm package name / @scope/name (Pi accepts these inside packages array).
  if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^\s]+)?$/i.test(trimmed)) {
    return null;
  }
  return "unsupported package source form";
}

function packageEntriesFromSettings(packages: unknown[] | undefined): PiPackageEntry[] {
  if (!packages) return [];
  const out: PiPackageEntry[] = [];
  for (const entry of packages) {
    if (typeof entry === "string" && entry.trim()) {
      out.push({ source: entry.trim() });
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      const source = typeof rec.source === "string" ? rec.source.trim() : "";
      if (!source) continue;
      const filters: PiPackageEntry["filters"] = {};
      for (const key of ["skills", "extensions", "prompts", "themes"] as const) {
        const value = rec[key];
        if (Array.isArray(value) && value.every(v => typeof v === "string")) {
          filters[key] = value as string[];
        }
      }
      out.push({
        source,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      });
    }
  }
  return out;
}

/** Resolve `pi` on PATH (and common nvm locations are already on PATH when the user runs ocx). */
export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = `${dir.replace(/[/\\]$/, "")}${process.platform === "win32" ? "\\" : "/"}${name}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function readPiPackages(opts: { piHome?: string } = {}): PiPackagesStatus {
  const settings = readPiSettings(opts);
  return {
    packages: packageEntriesFromSettings(settings.settings.packages),
    listOutput: null,
    piBinary: resolvePiBinary(),
  };
}

export async function listPiPackagesDetailed(opts: { piHome?: string } = {}): Promise<PiPackagesStatus> {
  const base = readPiPackages(opts);
  if (!base.piBinary) return base;
  const result = await runPiCli(base.piBinary, ["list"]);
  return {
    ...base,
    listOutput: result.ok || result.stdout ? result.stdout.trim() || result.stderr.trim() : null,
  };
}

function runPiCli(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<PiPackageCommandResult> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  return new Promise(resolve => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        message: `pi ${args[0]} timed out after ${timeoutMs}ms`,
        stdout,
        stderr,
        exitCode: null,
      });
    }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        message: error.message,
        stdout,
        stderr,
        exitCode: null,
      });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? null;
      const ok = exitCode === 0;
      resolve({
        ok,
        message: ok
          ? (stdout.trim() || `pi ${args.join(" ")} ok`)
          : (stderr.trim() || stdout.trim() || `pi exited ${exitCode}`),
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}

export async function installPiPackage(source: string): Promise<PiPackageCommandResult> {
  const error = validatePiPackageSource(source);
  if (error) {
    return { ok: false, message: error, stdout: "", stderr: "", exitCode: null };
  }
  const binary = resolvePiBinary();
  if (!binary) {
    return { ok: false, message: "pi binary not found on PATH", stdout: "", stderr: "", exitCode: null };
  }
  // Global install only (matches dashboard scope). Project-local needs a cwd we do not own.
  return runPiCli(binary, ["install", source.trim()]);
}

export async function removePiPackage(source: string): Promise<PiPackageCommandResult> {
  const error = validatePiPackageSource(source);
  if (error) {
    return { ok: false, message: error, stdout: "", stderr: "", exitCode: null };
  }
  const binary = resolvePiBinary();
  if (!binary) {
    return { ok: false, message: "pi binary not found on PATH", stdout: "", stderr: "", exitCode: null };
  }
  return runPiCli(binary, ["remove", source.trim()]);
}
