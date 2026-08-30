import { homedir } from "node:os";
import { join } from "node:path";

export type McpClientType = "claude_desktop" | "claude_code" | "codex" | "antigravity";
export type McpTransportType = "stdio" | "sse" | "http";
export type McpScope = "global" | "project";

/**
 * Universal Normalized Intermediate Representation (IR) for MCP Servers.
 */
export interface UnifiedMcpServer {
  /** Unique server key identifier (e.g. "sqlite", "context7", "memory") */
  id: string;
  /** Originating or target client format */
  client: McpClientType;
  /** Scope level: global user config vs local repository project config */
  scope: McpScope;
  /** Transport type: stdio subprocess or remote sse / http */
  transport: McpTransportType;
  /** Command / executable for stdio transport (e.g. "npx", "uvx", "node", "python") */
  command?: string;
  /** Command line arguments array */
  args: string[];
  /** Environment key-value pairs */
  env: Record<string, string>;
  /** Optional working directory for stdio execution */
  cwd?: string;
  /** Remote SSE or HTTP endpoint URL */
  url?: string;
  /** Custom HTTP request headers for remote transports */
  headers?: Record<string, string>;
  /** Normalized active / enabled state */
  enabled: boolean;
  /** Startup timeout in seconds (Codex startup_timeout_sec) */
  timeoutSec?: number;
  /** Auto-approved tool names (Claude Desktop) */
  autoApprove?: string[];
  /** Preserved client-specific vendor fields */
  rawConfig?: Record<string, unknown>;
}

/**
 * Options for cross-client cloning / sharing.
 */
export interface McpCloneOptions {
  fromClient: McpClientType;
  toClient: McpClientType;
  serverId: string;
  newId?: string;
  overwrite?: boolean;
}

/**
 * Claude Desktop Raw Schema Types
 */
export interface ClaudeDesktopMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
  url?: string;
  [key: string]: unknown;
}

export interface ClaudeDesktopConfigFile {
  mcpServers?: Record<string, ClaudeDesktopMcpServerConfig>;
  [key: string]: unknown;
}

/**
 * Claude Code Raw Schema Types
 */
export interface ClaudeCodeMcpServerConfig {
  type?: "stdio" | "sse" | "http" | string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface ClaudeCodeConfigFile {
  mcpServers?: Record<string, ClaudeCodeMcpServerConfig>;
  [key: string]: unknown;
}

/**
 * Codex TOML Raw Schema Types
 */
export interface CodexTomlMcpServerConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled?: boolean;
  startup_timeout_sec?: number;
  timeout_sec?: number;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface CodexTomlConfigFile {
  mcp_servers?: Record<string, CodexTomlMcpServerConfig>;
  [key: string]: unknown;
}

/**
 * Antigravity / Gemini Raw Schema Types
 */
export interface AntigravityMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  serverUrl?: string;
  url?: string;
  disabled?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AntigravityConfigFile {
  mcpServers?: Record<string, AntigravityMcpServerConfig>;
  [key: string]: unknown;
}

/**
 * Base MCP Engine Error
 */
export class McpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpError";
  }
}

export class McpNotFoundError extends McpError {
  constructor(serverId: string, client: McpClientType) {
    super(`MCP server '${serverId}' not found for client '${client}'`);
    this.name = "McpNotFoundError";
  }
}

export class McpConflictError extends McpError {
  constructor(serverId: string, client: McpClientType) {
    super(`MCP server '${serverId}' already exists in client '${client}'. Use --overwrite or provide a new ID.`);
    this.name = "McpConflictError";
  }
}

export class McpValidationError extends McpError {
  constructor(message: string) {
    super(message);
    this.name = "McpValidationError";
  }
}

export class McpLockError extends McpError {
  constructor(filePath: string, details?: string) {
    super(`Could not acquire file lock for '${filePath}'${details ? `: ${details}` : ""}`);
    this.name = "McpLockError";
  }
}

export class McpParseError extends McpError {
  constructor(filePath: string, cause?: unknown) {
    super(`Failed to parse MCP configuration file '${filePath}': ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "McpParseError";
  }
}

/**
 * Common Manager Options
 */
export interface McpManagerOptions {
  client?: McpClientType;
  scope?: McpScope;
  projectRoot?: string;
  customPaths?: Partial<Record<McpClientType, string>>;
}
