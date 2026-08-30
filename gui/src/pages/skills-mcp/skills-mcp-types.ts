/**
 * Shared Type Definitions for Skills & MCP Management Subsystem.
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

export type SkillLinkedAgent = "claude" | "codex" | "project" | "antigravity";

export interface SkillItem {
  name: string;
  path: string;
  isSymlink: boolean;
  targetPath?: string;
  isSystem?: boolean;
  metadata: SkillMetadata;
  content: string; // Markdown body without frontmatter
  linkedAgents: SkillLinkedAgent[];
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
  deletedAt: string;
  linkedClients: string[];
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

import type { TKey } from "../../i18n/shared";

export const MCP_CLIENT_INFO: Record<
  McpClientType,
  { labelKey: TKey; iconName: string; configPathHint: string }
> = {
  claude_desktop: {
    labelKey: "skillsMcp.mcp.client.claudeDesktop",
    iconName: "desktop",
    configPathHint: "claude_desktop_config.json",
  },
  claude_code: {
    labelKey: "skillsMcp.mcp.client.claudeCode",
    iconName: "terminal",
    configPathHint: "~/.claude.json",
  },
  codex: {
    labelKey: "skillsMcp.mcp.client.codex",
    iconName: "key",
    configPathHint: "~/.codex/config.toml",
  },
  antigravity: {
    labelKey: "skillsMcp.mcp.client.antigravity",
    iconName: "bot",
    configPathHint: ".agents/mcp_config.json",
  },
};
