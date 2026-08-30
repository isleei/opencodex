import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { McpLockError } from "./types";

export interface LockOptions {
  /** Maximum time in milliseconds to wait before failing to acquire lock (default: 5000ms) */
  timeoutMs?: number;
  /** Polling interval in milliseconds between retry attempts (default: 25ms) */
  retryIntervalMs?: number;
  /** Duration in milliseconds after which an unreleased lock is considered stale (default: 5000ms) */
  staleTimeoutMs?: number;
}

interface LockFilePayload {
  pid: number;
  createdAt: number;
  filePath: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 tests whether the process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return error.code === "EPERM"; // EPERM means process exists but we lack permission to signal
  }
}

/**
 * Acquire a file lock for the given target path.
 * Returns the lock file path on success.
 */
export async function acquireFileLock(
  filePath: string,
  options: LockOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const staleTimeoutMs = options.staleTimeoutMs ?? 5000;
  const lockPath = `${filePath}.lock`;

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const payload: LockFilePayload = {
        pid: process.pid,
        createdAt: Date.now(),
        filePath,
      };
      writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx", encoding: "utf8" });
      return lockPath;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        // Lock already exists. Check if it's stale.
        try {
          if (existsSync(lockPath)) {
            const content = readFileSync(lockPath, "utf8");
            const lockData = JSON.parse(content) as LockFilePayload;
            const isExpired = Date.now() - lockData.createdAt > staleTimeoutMs;
            const isDead = typeof lockData.pid === "number" && !isProcessAlive(lockData.pid);

            if (isExpired || isDead) {
              // Lock is stale or creator died; break the lock
              try {
                unlinkSync(lockPath);
              } catch {
                // Ignore race if another worker broke it
              }
              continue;
            }
          }
        } catch {
          // If lock file is unreadable or malformed, remove it after a brief grace
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore
          }
          continue;
        }

        // Wait before next attempt
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      } else {
        throw new McpLockError(filePath, error.message);
      }
    }
  }

  throw new McpLockError(filePath, `Timed out after ${timeoutMs}ms waiting for file lock`);
}

/**
 * Release a previously acquired file lock.
 */
export function releaseFileLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors during release (e.g. already unlinked)
  }
}

/**
 * Execute an async operation with automatic file locking and cleanup.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    releaseFileLock(lockPath);
  }
}
