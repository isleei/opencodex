import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Checks if a given path is a symbolic link or directory junction.
 */
export function isSymlink(targetPath: string): boolean {
  try {
    const stats = lstatSync(targetPath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Gets the target path of a symbolic link.
 * If the raw target is relative, resolves it against the directory containing the link.
 */
export function getSymlinkTarget(linkPath: string): string | null {
  try {
    if (!isSymlink(linkPath)) return null;
    const rawTarget = readlinkSync(linkPath);
    if (isAbsolute(rawTarget)) {
      return rawTarget;
    }
    return resolve(dirname(linkPath), rawTarget);
  } catch {
    return null;
  }
}

/**
 * Checks if a path is a dangling (broken) symbolic link.
 * A dangling symlink exists as a link entry, but its destination does not exist.
 */
export function isDanglingSymlink(linkPath: string): boolean {
  try {
    const stats = lstatSync(linkPath);
    if (!stats.isSymbolicLink()) return false;
    return !existsSync(linkPath);
  } catch {
    return false;
  }
}

/**
 * Safely removes a symbolic link if it exists.
 * Does not remove regular files or physical directories.
 */
export function removeSymlink(linkPath: string): boolean {
  try {
    if (isSymlink(linkPath)) {
      unlinkSync(linkPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface SymlinkOptions {
  relative?: boolean;
  force?: boolean;
  type?: "dir" | "junction" | "file";
}

/**
 * Creates a cross-platform directory symbolic link (or NTFS junction on Windows).
 */
export function createDirectorySymlink(
  targetPath: string,
  linkPath: string,
  options: SymlinkOptions = {}
): void {
  const parentDir = dirname(linkPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true, mode: 0o755 });
  }

  // If linkPath already exists
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    if (isSymlink(linkPath)) {
      const currentTarget = getSymlinkTarget(linkPath);
      const normalizedTarget = resolve(targetPath);
      const normalizedCurrent = currentTarget ? resolve(currentTarget) : null;

      if (normalizedCurrent === normalizedTarget && existsSync(linkPath)) {
        // Symlink already points to the correct target and is healthy
        return;
      }
      // Remove stale / broken / mismatched symlink
      unlinkSync(linkPath);
    } else if (options.force) {
      // If forcing replacement of physical entry
      throw new Error(`Cannot replace physical directory ${linkPath} with symlink without explicit removal.`);
    } else {
      return;
    }
  }

  const isWindows = process.platform === "win32";
  let linkTarget = targetPath;

  if (!isWindows && options.relative) {
    linkTarget = relative(parentDir, targetPath);
  }

  if (isWindows) {
    try {
      // Windows directory junctions do not require administrator privileges
      symlinkSync(targetPath, linkPath, "junction");
    } catch {
      // Fallback to directory symlink
      symlinkSync(targetPath, linkPath, "dir");
    }
  } else {
    symlinkSync(linkTarget, linkPath, "dir");
  }
}

/**
 * Repairs a dangling symlink by repointing it to a valid target path.
 */
export function repairDanglingSymlink(linkPath: string, targetPath: string): boolean {
  try {
    if (isDanglingSymlink(linkPath)) {
      unlinkSync(linkPath);
      createDirectorySymlink(targetPath, linkPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolves the real absolute path if it exists, without throwing.
 */
export function safeRealpath(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}
