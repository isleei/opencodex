import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { readSkillFromDir, writeSkillToDir } from "./parser";
import { resolveSkillsDirectories } from "./scanner";
import { createDirectorySymlink, getSymlinkTarget, isSymlink } from "./symlinks";
import type {
  DeleteSkillOptions,
  SkillsDirectoryConfig,
  ToggleSkillOptions,
  TrashRecord,
} from "./types";

/**
 * Moves a skill to the centralized trash store or permanently deletes it.
 */
export async function trashSkill(
  skillName: string,
  config?: SkillsDirectoryConfig,
  options: DeleteSkillOptions = {}
): Promise<TrashRecord> {
  const dirs = resolveSkillsDirectories(config);

  // Protection: Never delete system skills
  if (skillName.startsWith("system:") || skillName.includes(".system")) {
    throw new Error(`Cannot delete protected system skill: ${skillName}`);
  }

  // Find the physical skill directory
  let originalPath = join(dirs.centralDir, skillName);
  let isPhysical = existsSync(originalPath) && !isSymlink(originalPath);

  if (!isPhysical) {
    // Check if it exists only in a client directory
    const clientCandidates = [
      join(dirs.claudeDir, skillName),
      join(dirs.codexDir, skillName),
      join(dirs.projectDir, skillName),
    ];

    for (const cand of clientCandidates) {
      if (existsSync(cand) && !isSymlink(cand)) {
        originalPath = cand;
        isPhysical = true;
        break;
      }
    }
  }

  if (!isPhysical && !existsSync(originalPath)) {
    throw new Error(`Skill not found: ${skillName}`);
  }

  // Detect which client directories have symlinks pointing to this skill
  const linkedClients: string[] = [];
  const clientDirs: { name: string; path: string }[] = [
    { name: "claude", path: join(dirs.claudeDir, skillName) },
    { name: "codex", path: join(dirs.codexDir, skillName) },
    { name: "project", path: join(dirs.projectDir, skillName) },
  ];

  for (const client of clientDirs) {
    if (isSymlink(client.path)) {
      linkedClients.push(client.name);
      try {
        unlinkSync(client.path);
      } catch {
        // Ignore
      }
    }
  }

  const now = new Date();
  const isoDate = now.toISOString();
  const fileSafeDate = isoDate.replace(/:/g, "-");
  const trashId = `${fileSafeDate}_${skillName}`;

  if (options.permanent) {
    if (existsSync(originalPath)) {
      rmSync(originalPath, { recursive: true, force: true });
    }
    return {
      trashId: "permanent",
      skillName,
      originalPath,
      deletedAt: isoDate,
      linkedClients,
      reason: options.reason ?? "Permanent deletion",
    };
  }

  // Ensure trash directory exists
  if (!existsSync(dirs.trashDir)) {
    mkdirSync(dirs.trashDir, { recursive: true, mode: 0o755 });
  }

  const trashItemDir = join(dirs.trashDir, trashId);
  mkdirSync(trashItemDir, { recursive: true, mode: 0o755 });

  const record: TrashRecord = {
    trashId,
    skillName,
    originalPath,
    deletedAt: isoDate,
    linkedClients,
    reason: options.reason,
  };

  // Write manifest inside trash item folder
  writeFileSync(
    join(trashItemDir, "manifest.json"),
    JSON.stringify(record, null, 2),
    "utf8"
  );

  // Move physical skill folder into trash folder
  if (existsSync(originalPath)) {
    const payloadDir = join(trashItemDir, "content");
    mkdirSync(payloadDir, { recursive: true, mode: 0o755 });
    cpSync(originalPath, payloadDir, { recursive: true });
    rmSync(originalPath, { recursive: true, force: true });
  }

  return record;
}

/**
 * Lists all deleted skills currently recoverable in the trash store.
 */
export async function listTrashRecords(config?: SkillsDirectoryConfig): Promise<TrashRecord[]> {
  const dirs = resolveSkillsDirectories(config);
  if (!existsSync(dirs.trashDir)) {
    return [];
  }

  const records: TrashRecord[] = [];

  try {
    const entries = readdirSync(dirs.trashDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const itemDir = join(dirs.trashDir, entry.name);
      const manifestFile = join(itemDir, "manifest.json");

      if (existsSync(manifestFile)) {
        try {
          const raw = readFileSync(manifestFile, "utf8");
          const parsed = JSON.parse(raw) as TrashRecord;
          records.push(parsed);
          continue;
        } catch {
          // Fallback to directory name parsing
        }
      }

      // Synthesize record from folder name if manifest is absent
      const parts = entry.name.split("_");
      const deletedAt = parts[0] ? parts[0].replace(/-/g, ":") : new Date().toISOString();
      const skillName = parts.slice(1).join("_") || entry.name;

      records.push({
        trashId: entry.name,
        skillName,
        originalPath: join(dirs.centralDir, skillName),
        deletedAt,
        linkedClients: ["claude", "codex"],
      });
    }
  } catch {
    // Ignore read errors
  }

  return records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * Restores a deleted skill from the trash store and recreates client symlinks.
 */
export async function restoreSkillFromTrash(
  trashIdOrName: string,
  config?: SkillsDirectoryConfig
): Promise<{ ok: boolean; restored: string; linkedAgents: string[] }> {
  const dirs = resolveSkillsDirectories(config);
  const items = await listTrashRecords(config);

  const target = items.find(
    (item) =>
      item.trashId === trashIdOrName ||
      item.skillName === trashIdOrName ||
      item.trashId.includes(trashIdOrName)
  );

  if (!target) {
    throw new Error(`Trash item not found: ${trashIdOrName}`);
  }

  const trashItemDir = join(dirs.trashDir, target.trashId);
  const payloadDir = join(trashItemDir, "content");
  const restoreDest = target.originalPath || join(dirs.centralDir, target.skillName);

  if (existsSync(restoreDest)) {
    throw new Error(`Cannot restore: target directory already exists at ${restoreDest}`);
  }

  // Restore physical directory
  mkdirSync(restoreDest, { recursive: true, mode: 0o755 });
  if (existsSync(payloadDir)) {
    cpSync(payloadDir, restoreDest, { recursive: true });
  } else if (existsSync(trashItemDir)) {
    // Direct folder content fallback
    const files = readdirSync(trashItemDir);
    for (const f of files) {
      if (f === "manifest.json") continue;
      cpSync(join(trashItemDir, f), join(restoreDest, f), { recursive: true });
    }
  }

  // Re-create symlinks for previously linked clients
  const recreatedLinks: string[] = [];
  for (const client of target.linkedClients) {
    let clientDir: string | null = null;
    if (client === "claude") clientDir = dirs.claudeDir;
    else if (client === "codex") clientDir = dirs.codexDir;
    else if (client === "project") clientDir = dirs.projectDir;

    if (clientDir) {
      const linkPath = join(clientDir, target.skillName);
      try {
        createDirectorySymlink(restoreDest, linkPath);
        recreatedLinks.push(client);
      } catch {
        // Ignore symlink recreation errors
      }
    }
  }

  // Clean up trash item folder
  rmSync(trashItemDir, { recursive: true, force: true });

  return {
    ok: true,
    restored: target.skillName,
    linkedAgents: recreatedLinks,
  };
}

/**
 * Toggles a skill's enabled/disabled status in-place safely without deleting files.
 */
export async function toggleSkillState(
  skillName: string,
  enabled: boolean,
  options: ToggleSkillOptions = {}
): Promise<{ ok: boolean; enabled: boolean }> {
  const dirs = resolveSkillsDirectories(options.config);

  // Protection: System skills cannot be disabled this way
  if (skillName.startsWith("system:")) {
    throw new Error(`Cannot toggle protected system skill: ${skillName}`);
  }

  // Locate skill directory in central store or client directories
  const candidateDirs = [
    join(dirs.centralDir, skillName),
    join(dirs.claudeDir, skillName),
    join(dirs.codexDir, skillName),
    join(dirs.projectDir, skillName),
  ];

  let skillDir: string | null = null;
  for (const cand of candidateDirs) {
    if (existsSync(cand)) {
      skillDir = cand;
      break;
    }
  }

  if (!skillDir) {
    throw new Error(`Skill not found: ${skillName}`);
  }

  const skillData = readSkillFromDir(skillDir);
  if (!skillData) {
    throw new Error(`Failed to read skill metadata for: ${skillName}`);
  }

  const updatedMetadata = {
    ...skillData.metadata,
    disabled: !enabled,
  };

  writeSkillToDir(skillDir, updatedMetadata, skillData.content);

  return { ok: true, enabled };
}
