import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deduplicateAndMigrateSkills } from "./dedup";
import { readSkillFromDir, writeSkillToDir } from "./parser";
import { resolveSkillsDirectories, scanSingleSkill, scanSkillsSync } from "./scanner";
import { createDirectorySymlink } from "./symlinks";
import { listTrashRecords, restoreSkillFromTrash, toggleSkillState, trashSkill } from "./trash";
import type {
  CreateSkillInput,
  DeleteSkillOptions,
  SkillFilterOptions,
  SkillItem,
  SkillMetadata,
  SkillsDirectoryConfig,
  SyncOptions,
  SyncResult,
  ToggleSkillOptions,
  TrashRecord,
  UpdateSkillInput,
} from "./types";

/**
 * Lists all skills matching the specified filter options.
 */
export async function listSkills(options: SkillFilterOptions = {}): Promise<SkillItem[]> {
  const allSkills = scanSkillsSync(options.config);

  return allSkills.filter((item) => {
    // Status filter
    if (options.status === "active" && item.metadata.disabled) return false;
    if (options.status === "disabled" && !item.metadata.disabled) return false;

    // Agent filter
    if (options.agent && options.agent !== "all") {
      if (!item.linkedAgents.includes(options.agent as "claude" | "codex" | "project")) {
        return false;
      }
    }

    // Search query filter
    if (options.search && options.search.trim().length > 0) {
      const q = options.search.toLowerCase();
      const matchName = item.name.toLowerCase().includes(q);
      const matchDesc = (item.metadata.description ?? "").toLowerCase().includes(q);
      const matchTags = (item.metadata.tags ?? []).some((t) => t.toLowerCase().includes(q));
      if (!matchName && !matchDesc && !matchTags) return false;
    }

    // Tags filter
    if (options.tags && options.tags.length > 0) {
      const itemTags = new Set((item.metadata.tags ?? []).map((t) => t.toLowerCase()));
      const hasAllTags = options.tags.every((t) => itemTags.has(t.toLowerCase()));
      if (!hasAllTags) return false;
    }

    return true;
  });
}

/**
 * Retrieves a single skill by name.
 */
export async function getSkill(
  name: string,
  config?: SkillsDirectoryConfig
): Promise<SkillItem | null> {
  return scanSingleSkill(name, config);
}

/**
 * Creates a new skill in the central store and links it to agent directories.
 */
export async function createSkill(
  input: CreateSkillInput,
  config?: SkillsDirectoryConfig
): Promise<SkillItem> {
  const dirs = resolveSkillsDirectories(config);
  const normalizedName = input.name.trim().toLowerCase();

  // Validate name
  if (!/^[a-z0-9-_]+$/.test(normalizedName)) {
    throw new Error(
      `Invalid skill name: "${input.name}". Skill names must contain only lowercase letters, numbers, hyphens, and underscores.`
    );
  }

  // Ensure central directory exists
  if (!existsSync(dirs.centralDir)) {
    mkdirSync(dirs.centralDir, { recursive: true, mode: 0o755 });
  }

  const skillDir = join(dirs.centralDir, normalizedName);
  if (existsSync(skillDir)) {
    throw new Error(`Skill "${normalizedName}" already exists at ${skillDir}`);
  }

  const metadata: SkillMetadata = {
    name: normalizedName,
    description: input.description.trim(),
    tags: input.tags ?? [],
    version: input.version ?? "1.0.0",
    author: input.author ?? "",
    source: input.source ?? "",
    disabled: input.disabled ?? false,
  };

  const content = input.content ?? `# ${normalizedName}\n\nSkill description and instructions.`;
  writeSkillToDir(skillDir, metadata, content);

  // Link to specified agents (default: claude and codex)
  const agentsToLink = input.linkAgents ?? ["claude", "codex"];
  const linkedAgents: ("claude" | "codex" | "project")[] = [];

  for (const agent of agentsToLink) {
    let agentDir: string | null = null;
    if (agent === "claude") agentDir = dirs.claudeDir;
    else if (agent === "codex") agentDir = dirs.codexDir;
    else if (agent === "project") agentDir = dirs.projectDir;

    if (agentDir) {
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true, mode: 0o755 });
      }
      const linkPath = join(agentDir, normalizedName);
      try {
        createDirectorySymlink(skillDir, linkPath);
        linkedAgents.push(agent);
      } catch {
        // Ignore symlink creation failure
      }
    }
  }

  return {
    name: normalizedName,
    path: skillDir,
    isSymlink: false,
    isSystem: false,
    metadata,
    content,
    linkedAgents,
  };
}

/**
 * Updates an existing skill's metadata and/or content.
 */
export async function updateSkill(
  name: string,
  input: UpdateSkillInput,
  config?: SkillsDirectoryConfig
): Promise<SkillItem> {
  const existing = await getSkill(name, config);
  if (!existing) {
    throw new Error(`Skill not found: "${name}"`);
  }

  if (existing.isSystem) {
    throw new Error(`Cannot modify protected system skill: "${name}"`);
  }

  const skillDir = existing.path;
  const currentData = readSkillFromDir(skillDir);
  if (!currentData) {
    throw new Error(`Failed to read skill files for "${name}"`);
  }

  const updatedMetadata: SkillMetadata = {
    ...currentData.metadata,
    description: input.description !== undefined ? input.description.trim() : currentData.metadata.description,
    tags: input.tags !== undefined ? input.tags : currentData.metadata.tags,
    version: input.version !== undefined ? input.version : currentData.metadata.version,
    author: input.author !== undefined ? input.author : currentData.metadata.author,
    source: input.source !== undefined ? input.source : currentData.metadata.source,
    disabled: input.disabled !== undefined ? input.disabled : currentData.metadata.disabled,
  };

  const updatedContent = input.content !== undefined ? input.content : currentData.content;
  writeSkillToDir(skillDir, updatedMetadata, updatedContent);

  return {
    ...existing,
    metadata: updatedMetadata,
    content: updatedContent,
  };
}

/**
 * Toggles a skill's active status.
 */
export async function toggleSkill(
  name: string,
  enabled: boolean,
  options: ToggleSkillOptions = {}
): Promise<{ ok: boolean; enabled: boolean }> {
  return toggleSkillState(name, enabled, options);
}

/**
 * Deletes a skill safely (moves to trash or permanent removal).
 */
export async function deleteSkill(
  name: string,
  options: DeleteSkillOptions = {}
): Promise<{ ok: boolean; trashId?: string }> {
  const record = await trashSkill(name, options.config, options);
  return { ok: true, trashId: record.trashId };
}

/**
 * Synchronizes and deduplicates skills across central store and agent directories.
 */
export async function syncSkills(options: SyncOptions = {}): Promise<SyncResult> {
  return deduplicateAndMigrateSkills(options);
}

/**
 * Lists all deleted skills recoverable from trash.
 */
export async function listTrash(config?: SkillsDirectoryConfig): Promise<TrashRecord[]> {
  return listTrashRecords(config);
}

/**
 * Restores a deleted skill from trash.
 */
export async function restoreSkill(
  trashId: string,
  config?: SkillsDirectoryConfig
): Promise<{ ok: boolean; restored: string }> {
  const res = await restoreSkillFromTrash(trashId, config);
  return { ok: res.ok, restored: res.restored };
}

/**
 * Object-oriented SkillsManager class wrapper.
 */
export class SkillsManager {
  private config: SkillsDirectoryConfig;

  constructor(config: SkillsDirectoryConfig = {}) {
    this.config = config;
  }

  async list(options?: Omit<SkillFilterOptions, "config">): Promise<SkillItem[]> {
    return listSkills({ ...options, config: this.config });
  }

  async get(name: string): Promise<SkillItem | null> {
    return getSkill(name, this.config);
  }

  async create(input: CreateSkillInput): Promise<SkillItem> {
    return createSkill(input, this.config);
  }

  async update(name: string, input: UpdateSkillInput): Promise<SkillItem> {
    return updateSkill(name, input, this.config);
  }

  async toggle(name: string, enabled: boolean, options?: Omit<ToggleSkillOptions, "config">): Promise<{ ok: boolean; enabled: boolean }> {
    return toggleSkill(name, enabled, { ...options, config: this.config });
  }

  async delete(name: string, options?: Omit<DeleteSkillOptions, "config">): Promise<{ ok: boolean; trashId?: string }> {
    return deleteSkill(name, { ...options, config: this.config });
  }

  async sync(options?: Omit<SyncOptions, "config">): Promise<SyncResult> {
    return syncSkills({ ...options, config: this.config });
  }

  async listTrash(): Promise<TrashRecord[]> {
    return listTrash(this.config);
  }

  async restore(trashId: string): Promise<{ ok: boolean; restored: string }> {
    return restoreSkill(trashId, this.config);
  }
}
