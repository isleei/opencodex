/**
 * Types and interfaces for the Centralized Skills Engine.
 */

export type AgentClient = "claude" | "codex" | "project";

export interface SkillMetadata {
  name: string;
  description: string;
  tags?: string[];
  version?: string;
  author?: string;
  source?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface SkillItem {
  name: string;
  path: string;
  isSymlink: boolean;
  targetPath?: string;
  isSystem?: boolean;
  metadata: SkillMetadata;
  content: string; // Markdown body without frontmatter
  linkedAgents: ("claude" | "codex" | "project")[];
}

export interface SyncResult {
  synced: number;
  migrated: string[];
  deduped: string[];
  broken: string[];
  conflicts: string[];
}

export interface TrashRecord {
  trashId: string;
  skillName: string;
  originalPath: string;
  deletedAt: string; // ISO 8601 string
  linkedClients: ("claude" | "codex" | "project" | string)[];
  reason?: string;
}

export interface ClientSkillLocation {
  agent: "claude" | "codex" | "project" | "central" | "system";
  path: string;
  isSymlink: boolean;
  targetPath?: string;
}

export interface SkillDetail extends SkillItem {
  locations?: ClientSkillLocation[];
}

export interface SkillsDirectoryConfig {
  centralDir?: string;        // default: ~/.agents/skills
  claudeDir?: string;         // default: ~/.claude/skills
  codexDir?: string;          // default: ~/.codex/skills
  projectDir?: string;        // default: <cwd>/.agents/skills
  trashDir?: string;          // default: ~/.agents/.trash/skills
  systemSkillsDir?: string;   // default: ~/.codex/skills/.system
  customClientDirs?: { agent: AgentClient; path: string }[];
}

export interface SkillFilterOptions {
  status?: "active" | "disabled" | "all";
  agent?: "all" | "claude" | "codex" | "project" | string;
  search?: string;
  tags?: string[];
  config?: SkillsDirectoryConfig;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  tags?: string[];
  version?: string;
  author?: string;
  source?: string;
  content?: string;
  disabled?: boolean;
  linkAgents?: ("claude" | "codex" | "project")[];
}

export interface UpdateSkillInput {
  description?: string;
  tags?: string[];
  version?: string;
  author?: string;
  source?: string;
  content?: string;
  disabled?: boolean;
}

export interface ToggleSkillOptions {
  agent?: "all" | "claude" | "codex" | "project" | string;
  config?: SkillsDirectoryConfig;
}

export interface DeleteSkillOptions {
  permanent?: boolean;
  reason?: string;
  config?: SkillsDirectoryConfig;
}

export interface SyncOptions {
  dryRun?: boolean;
  migrate?: boolean;
  config?: SkillsDirectoryConfig;
}
