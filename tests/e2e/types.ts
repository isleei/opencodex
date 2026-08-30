/**
 * Type declarations and interface contracts for OpenCodex Centralized Skills & Multi-Client MCP Management.
 * Sourced directly from PROJECT.md and TEST_INFRA.md contracts.
 */

export interface SkillMetadata {
  name: string;
  description: string;
  tags?: string[];
  version?: string;
  author?: string;
  source?: string;
  disabled?: boolean;
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
  id: string;
  skillName: string;
  originalPath: string;
  trashedAt: string; // ISO timestamp
  metadata?: SkillMetadata;
}

export type McpClientType = "claude_desktop" | "claude_code" | "codex" | "antigravity";
export type McpTransportType = "stdio" | "sse" | "http";

export interface UnifiedMcpServer {
  id: string;
  client: McpClientType;
  scope: "global" | "project";
  transport: McpTransportType;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  timeoutSec?: number;
  autoApprove?: string[];
  rawConfig?: Record<string, unknown>;
}

export interface McpCloneOptions {
  fromClient: McpClientType;
  toClient: McpClientType;
  serverId: string;
  newId?: string;
  overwrite?: boolean;
}
