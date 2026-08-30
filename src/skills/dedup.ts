import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveSkillsDirectories } from "./scanner";
import {
  createDirectorySymlink,
  getSymlinkTarget,
  isDanglingSymlink,
  isSymlink,
} from "./symlinks";
import type { SkillsDirectoryConfig, SyncOptions, SyncResult } from "./types";

interface SkillHashRecord {
  name: string;
  path: string;
  hash: string;
  mtimeMs: number;
}

/**
 * Computes deterministic SHA256 content hash of a directory tree.
 */
export function computeSkillContentHash(dirPath: string): string {
  if (!existsSync(dirPath)) return "";

  const hash = createHash("sha256");
  const fileEntries: { relPath: string; content: Buffer }[] = [];

  function collectFiles(currentDir: string) {
    try {
      const items = readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith(".") && item.name !== ".paseo-managed-files.json") {
          continue;
        }

        const fullPath = join(currentDir, item.name);
        if (item.isDirectory()) {
          collectFiles(fullPath);
        } else if (item.isFile()) {
          const rel = relative(dirPath, fullPath).replace(/\\/g, "/");
          try {
            const buf = readFileSync(fullPath);
            fileEntries.push({ relPath: rel, content: buf });
          } catch {
            // Ignore unreadable files
          }
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  collectFiles(dirPath);

  // Sort files deterministically by relative path
  fileEntries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  for (const entry of fileEntries) {
    hash.update(entry.relPath);
    hash.update(entry.content);
  }

  return hash.digest("hex");
}

/**
 * Executes the Centralized Skills Deduplication & Migration algorithm.
 */
export async function deduplicateAndMigrateSkills(
  options: SyncOptions = {}
): Promise<SyncResult> {
  const dirs = resolveSkillsDirectories(options.config);
  const dryRun = Boolean(options.dryRun);

  const result: SyncResult = {
    synced: 0,
    migrated: [],
    deduped: [],
    broken: [],
    conflicts: [],
  };

  // Step 1: Ensure CentralDir exists
  if (!existsSync(dirs.centralDir) && !dryRun) {
    mkdirSync(dirs.centralDir, { recursive: true, mode: 0o755 });
  }

  // Step 2: Scan CentralDir and compute hashes
  const centralSkills = new Map<string, SkillHashRecord>();
  if (existsSync(dirs.centralDir)) {
    try {
      const entries = readdirSync(dirs.centralDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = join(dirs.centralDir, entry.name);
        if (entry.isDirectory() && !isSymlink(entryPath)) {
          const hash = computeSkillContentHash(entryPath);
          const stats = statSync(entryPath);
          centralSkills.set(entry.name, {
            name: entry.name,
            path: entryPath,
            hash,
            mtimeMs: stats.mtimeMs,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  // Target client directories to scan and synchronize
  const clientDirs: { agent: string; path: string }[] = [
    { agent: "claude", path: dirs.claudeDir },
    { agent: "codex", path: dirs.codexDir },
    ...dirs.customClientDirs,
  ];

  // Step 3: Scan each client directory
  for (const client of clientDirs) {
    if (!existsSync(client.path)) {
      if (!dryRun) {
        mkdirSync(client.path, { recursive: true, mode: 0o755 });
      }
      continue;
    }

    try {
      const entries = readdirSync(client.path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".system" || entry.name.startsWith(".")) {
          continue; // Do not touch system skills or hidden files
        }

        const clientSkillPath = join(client.path, entry.name);
        const skillName = entry.name;

        // If it's a symbolic link
        if (isSymlink(clientSkillPath)) {
          if (isDanglingSymlink(clientSkillPath)) {
            result.broken.push(`${client.agent}:${skillName}`);
            if (!dryRun) {
              unlinkSync(clientSkillPath);
              // If central skill exists, re-create symlink
              if (centralSkills.has(skillName)) {
                createDirectorySymlink(join(dirs.centralDir, skillName), clientSkillPath);
              }
            }
          }
          continue;
        }

        // If it's a physical directory
        if (entry.isDirectory()) {
          const clientHash = computeSkillContentHash(clientSkillPath);
          const clientStats = statSync(clientSkillPath);
          const centralRecord = centralSkills.get(skillName);

          if (!centralRecord) {
            // CASE 1: SkillName not in Central -> Migrate to Central
            result.migrated.push(skillName);
            if (!dryRun) {
              const centralDest = join(dirs.centralDir, skillName);
              // Move directory
              moveDirectory(clientSkillPath, centralDest);
              // Create symlink in client directory pointing to central store
              createDirectorySymlink(centralDest, clientSkillPath);
              centralSkills.set(skillName, {
                name: skillName,
                path: centralDest,
                hash: clientHash,
                mtimeMs: clientStats.mtimeMs,
              });
            }
          } else if (clientHash === centralRecord.hash) {
            // CASE 2: Identical duplicate copy -> Deduplicate
            result.deduped.push(`${client.agent}:${skillName}`);
            if (!dryRun) {
              rmSync(clientSkillPath, { recursive: true, force: true });
              createDirectorySymlink(centralRecord.path, clientSkillPath);
            }
          } else {
            // CASE 3: Content mismatch -> Conflict
            result.conflicts.push(`${client.agent}:${skillName}`);
            if (!dryRun) {
              const timestamp = new Date().toISOString().replace(/:/g, "-");
              const conflictBackupDir = join(
                dirs.trashDir,
                `${timestamp}_${skillName}_from_${client.agent}`
              );

              if (centralRecord.mtimeMs >= clientStats.mtimeMs) {
                // Central is newer or equal: move client physical dir to trash backup
                moveDirectory(clientSkillPath, conflictBackupDir);
                createDirectorySymlink(centralRecord.path, clientSkillPath);
              } else {
                // Client is strictly newer: central backed up to trash, client moves to central
                const centralBackupDir = join(
                  dirs.trashDir,
                  `${timestamp}_${skillName}_from_central`
                );
                moveDirectory(centralRecord.path, centralBackupDir);
                moveDirectory(clientSkillPath, centralRecord.path);
                createDirectorySymlink(centralRecord.path, clientSkillPath);

                centralRecord.hash = clientHash;
                centralRecord.mtimeMs = clientStats.mtimeMs;
              }
            }
          }
        }
      }
    } catch {
      // Ignore directory scan errors
    }
  }

  // Step 4: Ensure all central skills are symlinked to client directories
  for (const [skillName, record] of centralSkills.entries()) {
    for (const client of clientDirs) {
      const clientLinkPath = join(client.path, skillName);
      if (!existsSync(clientLinkPath) && !isSymlink(clientLinkPath)) {
        if (!dryRun) {
          createDirectorySymlink(record.path, clientLinkPath);
        }
      }
    }
    result.synced += 1;
  }

  return result;
}

/**
 * Cross-device / cross-directory safe move operation.
 */
function moveDirectory(source: string, destination: string) {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  try {
    cpSync(source, destination, { recursive: true });
    rmSync(source, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Failed to move directory from ${source} to ${destination}: ${String(err)}`);
  }
}
