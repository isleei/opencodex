import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readSkillFromDir } from "./parser";
import { getSymlinkTarget, isDanglingSymlink, isSymlink, safeRealpath } from "./symlinks";
import type { AgentClient, SkillItem, SkillMetadata, SkillsDirectoryConfig } from "./types";

export interface ResolvedSkillsDirectories {
  centralDir: string;
  claudeDir: string;
  codexDir: string;
  projectDir: string;
  trashDir: string;
  systemSkillsDir: string;
  customClientDirs: { agent: AgentClient; path: string }[];
}

/**
 * Resolves standard directory paths for skills management, respecting overrides.
 */
export function resolveSkillsDirectories(config?: SkillsDirectoryConfig): ResolvedSkillsDirectories {
  const home = homedir();
  const centralDir = config?.centralDir ? resolve(config.centralDir) : join(home, ".agents", "skills");
  const claudeDir = config?.claudeDir ? resolve(config.claudeDir) : join(home, ".claude", "skills");
  const codexDir = config?.codexDir ? resolve(config.codexDir) : join(home, ".codex", "skills");
  const projectDir = config?.projectDir ? resolve(config.projectDir) : join(process.cwd(), ".agents", "skills");
  const trashDir = config?.trashDir ? resolve(config.trashDir) : join(home, ".agents", ".trash", "skills");
  const systemSkillsDir = config?.systemSkillsDir
    ? resolve(config.systemSkillsDir)
    : join(codexDir, ".system");

  const customClientDirs = (config?.customClientDirs ?? []).map((c) => ({
    agent: c.agent,
    path: resolve(c.path),
  }));

  return {
    centralDir,
    claudeDir,
    codexDir,
    projectDir,
    trashDir,
    systemSkillsDir,
    customClientDirs,
  };
}

/**
 * Scans directories and returns a consolidated list of skills.
 */
export function scanSkillsSync(config?: SkillsDirectoryConfig): SkillItem[] {
  const dirs = resolveSkillsDirectories(config);
  const skillsMap = new Map<string, SkillItem>();
  const visitedRealPaths = new Set<string>();

  // 1. Scan Central Store (~/.agents/skills)
  if (existsSync(dirs.centralDir)) {
    scanDirectoryEntries(dirs.centralDir, false, (name, entryPath, isLink, targetPath) => {
      const real = safeRealpath(entryPath);
      if (real && visitedRealPaths.has(real)) return;
      if (real) visitedRealPaths.add(real);

      const skillData = readSkillFromDir(entryPath);
      if (!skillData) return;

      const item: SkillItem = {
        name,
        path: entryPath,
        isSymlink: isLink,
        targetPath: targetPath ?? undefined,
        isSystem: false,
        metadata: skillData.metadata,
        content: skillData.content,
        linkedAgents: [],
      };
      skillsMap.set(name, item);
    });
  }

  // 2. Scan Codex System Skills (~/.codex/skills/.system/)
  if (existsSync(dirs.systemSkillsDir)) {
    scanDirectoryEntries(dirs.systemSkillsDir, true, (name, entryPath, isLink, targetPath) => {
      const real = safeRealpath(entryPath);
      if (real && visitedRealPaths.has(real)) return;
      if (real) visitedRealPaths.add(real);

      const skillData = readSkillFromDir(entryPath);
      if (!skillData) return;

      const systemName = `system:${name}`;
      const item: SkillItem = {
        name: systemName,
        path: entryPath,
        isSymlink: isLink,
        targetPath: targetPath ?? undefined,
        isSystem: true,
        metadata: {
          ...skillData.metadata,
          name: systemName,
        },
        content: skillData.content,
        linkedAgents: ["codex"],
      };
      skillsMap.set(systemName, item);
    });
  }

  // 3. Scan Claude Skills (~/.claude/skills)
  if (existsSync(dirs.claudeDir)) {
    scanDirectoryEntries(dirs.claudeDir, false, (name, entryPath, isLink, targetPath) => {
      handleClientSkill(name, entryPath, isLink, targetPath, "claude", dirs, skillsMap, visitedRealPaths);
    });
  }

  // 4. Scan Codex Skills (~/.codex/skills, excluding .system)
  if (existsSync(dirs.codexDir)) {
    scanDirectoryEntries(dirs.codexDir, false, (name, entryPath, isLink, targetPath) => {
      if (name === ".system") return; // Handled separately
      handleClientSkill(name, entryPath, isLink, targetPath, "codex", dirs, skillsMap, visitedRealPaths);
    });
  }

  // 5. Scan Project Skills (<project>/.agents/skills)
  if (existsSync(dirs.projectDir)) {
    scanDirectoryEntries(dirs.projectDir, false, (name, entryPath, isLink, targetPath) => {
      const real = safeRealpath(entryPath);
      if (real && visitedRealPaths.has(real)) return;
      if (real) visitedRealPaths.add(real);

      const skillData = readSkillFromDir(entryPath);
      if (!skillData) return;

      const existing = skillsMap.get(name);
      if (existing) {
        if (!existing.linkedAgents.includes("project")) {
          existing.linkedAgents.push("project");
        }
      } else {
        const item: SkillItem = {
          name,
          path: entryPath,
          isSymlink: isLink,
          targetPath: targetPath ?? undefined,
          isSystem: false,
          metadata: skillData.metadata,
          content: skillData.content,
          linkedAgents: ["project"],
        };
        skillsMap.set(name, item);
      }
    });
  }

  // 6. Scan Custom Client Dirs if configured
  for (const custom of dirs.customClientDirs) {
    if (existsSync(custom.path)) {
      scanDirectoryEntries(custom.path, false, (name, entryPath, isLink, targetPath) => {
        handleClientSkill(name, entryPath, isLink, targetPath, custom.agent, dirs, skillsMap, visitedRealPaths);
      });
    }
  }

  // Convert map to sorted array
  return Array.from(skillsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Asynchronous scanner wrapper.
 */
export async function scanSkills(config?: SkillsDirectoryConfig): Promise<SkillItem[]> {
  return scanSkillsSync(config);
}

/**
 * Scans a single skill by name across known locations.
 */
export function scanSingleSkill(name: string, config?: SkillsDirectoryConfig): SkillItem | null {
  const all = scanSkillsSync(config);
  return all.find((s) => s.name === name || s.metadata.name === name) ?? null;
}

/**
 * Helper to process an entry discovered in a client directory (claude, codex, etc.)
 */
function handleClientSkill(
  name: string,
  entryPath: string,
  isLink: boolean,
  targetPath: string | null,
  agent: AgentClient,
  dirs: ResolvedSkillsDirectories,
  skillsMap: Map<string, SkillItem>,
  visitedRealPaths: Set<string>
) {
  // If it's a symlink pointing to central store or another known skill
  if (isLink && targetPath) {
    const centralEquivalentPath = join(dirs.centralDir, name);
    const resolvedTarget = resolve(targetPath);

    if (resolvedTarget === resolve(centralEquivalentPath) || resolvedTarget.startsWith(resolve(dirs.centralDir))) {
      const targetName = basename(resolvedTarget);
      const centralSkill = skillsMap.get(targetName) ?? skillsMap.get(name);
      if (centralSkill) {
        if (!centralSkill.linkedAgents.includes(agent)) {
          centralSkill.linkedAgents.push(agent);
        }
        return;
      }
    }
  }

  // If central skill already registered with this name
  const existing = skillsMap.get(name);
  if (existing) {
    if (!existing.linkedAgents.includes(agent)) {
      existing.linkedAgents.push(agent);
    }
    return;
  }

  // Standalone or un-migrated physical skill in client directory
  const real = safeRealpath(entryPath);
  if (real && visitedRealPaths.has(real)) return;
  if (real) visitedRealPaths.add(real);

  const skillData = readSkillFromDir(entryPath);
  if (!skillData) return;

  const item: SkillItem = {
    name,
    path: entryPath,
    isSymlink: isLink,
    targetPath: targetPath ?? undefined,
    isSystem: false,
    metadata: skillData.metadata,
    content: skillData.content,
    linkedAgents: [agent],
  };
  skillsMap.set(name, item);
}

/**
 * Reads immediate child directories or symlinks inside a parent directory.
 */
function scanDirectoryEntries(
  dirPath: string,
  isSystemScan: boolean,
  callback: (name: string, entryPath: string, isLink: boolean, targetPath: string | null) => void
) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !isSystemScan) {
        // Skip hidden files/directories like .git, .DS_Store, .trash unless scanning system dir
        if (entry.name !== ".system") {
          continue;
        }
      }

      const fullPath = join(dirPath, entry.name);
      const isLink = isSymlink(fullPath);

      if (isLink) {
        if (isDanglingSymlink(fullPath)) {
          // Dangling symlink: ignore or let dedup repair it
          continue;
        }
        const target = getSymlinkTarget(fullPath);
        callback(entry.name, fullPath, true, target);
      } else if (entry.isDirectory()) {
        callback(entry.name, fullPath, false, null);
      }
    }
  } catch {
    // Ignore read errors for inaccessible/missing directories
  }
}
