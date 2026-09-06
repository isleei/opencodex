import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";

const MAX_DIFF_BYTES = 2_000_000;
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_DIFF_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function validateWorkspace(path: string): string {
  if (!isAbsolute(path)) throw new Error("workspaceDir must be an absolute directory path");
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) throw new Error("workspaceDir must be a directory");
  return real;
}

export function resolveBaseRevision(workspace: string, requested?: string): string | undefined {
  try {
    return git(workspace, ["rev-parse", "--verify", "--end-of-options", `${requested || "HEAD"}^{commit}`]).trim();
  } catch {
    if (requested) throw new Error("baseRevision must resolve to a commit in the workspace");
    return undefined;
  }
}

/** Includes commits since the run started, staged/unstaged edits, and untracked files. */
export function collectDiff(workspace: string | undefined, baseRevision: string | undefined) {
  if (!workspace || !baseRevision) throw new Error("diff review requires a Git workspace and a base revision; start the run with --workspace and optionally --base");
  const headRevision = git(workspace, ["rev-parse", "HEAD"]).trim();
  const pieces = [git(workspace, ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseRevision, "--"])];
  const untracked = git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const file of untracked) {
    try {
      pieces.push(git(workspace, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", "/dev/null", file]));
    } catch (error) {
      const result = error as { status?: number; stdout?: string };
      if (result.status !== 1 || typeof result.stdout !== "string") throw error;
      pieces.push(result.stdout);
    }
    if (Buffer.byteLength(pieces.join("\n")) > MAX_DIFF_BYTES) throw new Error("diff exceeds 2 MB; split the task before review (no diff was truncated)");
  }
  return { baseRevision, headRevision, diff: pieces.join("\n").trim() || "(No code changes relative to the base revision.)" };
}
