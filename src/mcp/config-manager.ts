import { withFileLock } from "./locks";
import {
  readClaudeDesktopConfig,
  resolveClaudeDesktopConfigPath,
  writeClaudeDesktopServer,
} from "./parsers/claude-desktop";
import {
  readClaudeCodeConfig,
  resolveClaudeCodeConfigPath,
  writeClaudeCodeServer,
} from "./parsers/claude-code";
import {
  readCodexTomlConfig,
  resolveCodexTomlConfigPath,
  writeCodexTomlServer,
} from "./parsers/codex-toml";
import {
  readAntigravityConfig,
  resolveAntigravityConfigPath,
  writeAntigravityServer,
} from "./parsers/antigravity";
import {
  executeMcpClone,
  validateServerDefinition,
} from "./cross-client";
import {
  McpConflictError,
  McpNotFoundError,
  type McpClientType,
  type McpCloneOptions,
  type McpManagerOptions,
  type McpScope,
  type UnifiedMcpServer,
} from "./types";

export const ALL_MCP_CLIENTS: McpClientType[] = [
  "claude_desktop",
  "claude_code",
  "codex",
  "antigravity",
];

export type CustomPathMap = Partial<Record<McpClientType | `${McpClientType}_${McpScope}`, string>>;

export interface AddMcpServerOptions {
  scope?: McpScope;
  projectRoot?: string;
  customPaths?: CustomPathMap;
  overwrite?: boolean;
}

export interface UpdateMcpServerOptions {
  client: McpClientType;
  scope?: McpScope;
  projectRoot?: string;
  customPaths?: CustomPathMap;
}

export interface DeleteMcpServerOptions {
  client: McpClientType;
  scope?: McpScope;
  projectRoot?: string;
  customPaths?: CustomPathMap;
}

export interface ToggleMcpServerOptions {
  client: McpClientType;
  scope?: McpScope;
  projectRoot?: string;
  customPaths?: CustomPathMap;
}

export interface GetMcpServerOptions {
  client: McpClientType;
  scope?: McpScope;
  projectRoot?: string;
  customPaths?: CustomPathMap;
}

/**
 * Resolve client configuration file path with custom override fallback.
 */
export function getClientConfigPath(
  client: McpClientType,
  scope: McpScope = "global",
  projectRoot?: string,
  customPaths?: CustomPathMap,
): string {
  const scopedKey = `${client}_${scope}` as `${McpClientType}_${McpScope}`;
  const custom = customPaths?.[scopedKey] ?? customPaths?.[client];

  // If a scope-agnostic custom path is provided and scope is project,
  // let's see if projectRoot was specified to resolve project path
  if (!custom && scope === "project" && projectRoot) {
    switch (client) {
      case "claude_desktop":
        return resolveClaudeDesktopConfigPath({ scope: "global" });
      case "claude_code":
        return resolveClaudeCodeConfigPath({ scope: "project", projectRoot });
      case "codex":
        return resolveCodexTomlConfigPath({ scope: "project", projectRoot });
      case "antigravity":
        return resolveAntigravityConfigPath({ scope: "project", projectRoot });
    }
  }

  switch (client) {
    case "claude_desktop":
      return resolveClaudeDesktopConfigPath({ customPath: custom, scope: "global", projectRoot });
    case "claude_code":
      return resolveClaudeCodeConfigPath({ customPath: custom, scope, projectRoot });
    case "codex":
      return resolveCodexTomlConfigPath({ customPath: custom, scope, projectRoot });
    case "antigravity":
      return resolveAntigravityConfigPath({ customPath: custom, scope, projectRoot });
  }
}

/**
 * Multi-Client MCP Configuration Manager
 */
export class McpConfigManager {
  private customPaths?: CustomPathMap;
  private defaultProjectRoot?: string;

  constructor(options: { customPaths?: CustomPathMap; projectRoot?: string } = {}) {
    this.customPaths = options.customPaths;
    this.defaultProjectRoot = options.projectRoot;
  }

  /**
   * Resolve effective config path for a client.
   */
  resolvePath(client: McpClientType, scope: McpScope = "global", projectRoot?: string): string {
    return getClientConfigPath(client, scope, projectRoot ?? this.defaultProjectRoot, this.customPaths);
  }

  /**
   * List configured MCP servers across specified or all clients.
   */
  async listServers(options: McpManagerOptions = {}): Promise<UnifiedMcpServer[]> {
    const clientsToQuery: McpClientType[] = options.client ? [options.client] : ALL_MCP_CLIENTS;
    const requestedScope = options.scope;
    const projectRoot = options.projectRoot ?? this.defaultProjectRoot;
    const customPaths = (options.customPaths as CustomPathMap) ?? this.customPaths;

    const scopesToQuery: McpScope[] = requestedScope
      ? [requestedScope]
      : (projectRoot ? ["global", "project"] : ["global"]);

    const allServers: UnifiedMcpServer[] = [];
    const seenPaths = new Set<string>();

    for (const scope of scopesToQuery) {
      for (const client of clientsToQuery) {
        if (scope === "project" && client === "claude_desktop") {
          // Claude Desktop does not have project-level config
          continue;
        }

        const configPath = getClientConfigPath(client, scope, projectRoot, customPaths);
        const queryKey = `${client}:${configPath}:${scope}`;
        if (seenPaths.has(queryKey)) continue;
        seenPaths.add(queryKey);

        let servers: UnifiedMcpServer[] = [];
        switch (client) {
          case "claude_desktop":
            servers = readClaudeDesktopConfig(configPath, "global").servers;
            break;
          case "claude_code":
            servers = readClaudeCodeConfig(configPath, scope).servers;
            break;
          case "codex":
            servers = readCodexTomlConfig(configPath, scope).servers;
            break;
          case "antigravity":
            servers = readAntigravityConfig(configPath, scope).servers;
            break;
        }

        allServers.push(...servers);
      }
    }

    if (requestedScope) {
      return allServers.filter((s) => s.scope === requestedScope);
    }
    return allServers;
  }

  /**
   * Get a single MCP server by ID and client type.
   */
  async getServer(id: string, options: GetMcpServerOptions): Promise<UnifiedMcpServer | null> {
    const configPath = getClientConfigPath(
      options.client,
      options.scope ?? "global",
      options.projectRoot ?? this.defaultProjectRoot,
      options.customPaths ?? this.customPaths,
    );

    let servers: UnifiedMcpServer[] = [];
    switch (options.client) {
      case "claude_desktop":
        servers = readClaudeDesktopConfig(configPath, "global").servers;
        break;
      case "claude_code":
        servers = readClaudeCodeConfig(configPath, options.scope ?? "global").servers;
        break;
      case "codex":
        servers = readCodexTomlConfig(configPath, options.scope ?? "global").servers;
        break;
      case "antigravity":
        servers = readAntigravityConfig(configPath, options.scope ?? "global").servers;
        break;
    }

    const found = servers.find((s) => s.id === id);
    return found ?? null;
  }

  /**
   * Add a new MCP server to a client configuration.
   */
  async addServer(
    server: UnifiedMcpServer,
    options: AddMcpServerOptions = {},
  ): Promise<UnifiedMcpServer> {
    validateServerDefinition(server);

    const effectiveScope = options.scope ?? server.scope ?? "global";
    const configPath = getClientConfigPath(
      server.client,
      effectiveScope,
      options.projectRoot ?? this.defaultProjectRoot,
      options.customPaths ?? this.customPaths,
    );

    return await withFileLock(configPath, async () => {
      const existing = await this.getServer(server.id, {
        client: server.client,
        scope: effectiveScope,
        projectRoot: options.projectRoot,
        customPaths: options.customPaths,
      });

      if (existing && !options.overwrite) {
        throw new McpConflictError(server.id, server.client);
      }

      const normalized: UnifiedMcpServer = {
        ...server,
        scope: server.client === "claude_desktop" ? "global" : effectiveScope,
        args: server.args ?? [],
        env: server.env ?? {},
        enabled: server.enabled !== false,
      };

      switch (server.client) {
        case "claude_desktop":
          writeClaudeDesktopServer(configPath, normalized);
          break;
        case "claude_code":
          writeClaudeCodeServer(configPath, normalized);
          break;
        case "codex":
          writeCodexTomlServer(configPath, normalized);
          break;
        case "antigravity":
          writeAntigravityServer(configPath, normalized);
          break;
      }

      return normalized;
    });
  }

  /**
   * Update an existing MCP server.
   */
  async updateServer(
    id: string,
    updates: Partial<Omit<UnifiedMcpServer, "id" | "client">>,
    options: UpdateMcpServerOptions,
  ): Promise<UnifiedMcpServer> {
    const configPath = getClientConfigPath(
      options.client,
      options.scope ?? "global",
      options.projectRoot ?? this.defaultProjectRoot,
      options.customPaths ?? this.customPaths,
    );

    return await withFileLock(configPath, async () => {
      const existing = await this.getServer(id, {
        client: options.client,
        scope: options.scope,
        projectRoot: options.projectRoot,
        customPaths: options.customPaths,
      });

      if (!existing) {
        throw new McpNotFoundError(id, options.client);
      }

      const merged: UnifiedMcpServer = {
        ...existing,
        ...updates,
        id,
        client: options.client,
        args: updates.args ? [...updates.args] : existing.args,
        env: updates.env ? { ...updates.env } : existing.env,
        enabled: updates.enabled !== undefined ? updates.enabled : existing.enabled,
      };

      validateServerDefinition(merged);

      switch (options.client) {
        case "claude_desktop":
          writeClaudeDesktopServer(configPath, merged);
          break;
        case "claude_code":
          writeClaudeCodeServer(configPath, merged);
          break;
        case "codex":
          writeCodexTomlServer(configPath, merged);
          break;
        case "antigravity":
          writeAntigravityServer(configPath, merged);
          break;
      }

      return merged;
    });
  }

  /**
   * Toggle enabled status of an MCP server.
   */
  async toggleServer(
    id: string,
    enabled: boolean,
    options: ToggleMcpServerOptions,
  ): Promise<UnifiedMcpServer> {
    return await this.updateServer(id, { enabled }, options);
  }

  /**
   * Delete an MCP server from a client configuration.
   */
  async deleteServer(id: string, options: DeleteMcpServerOptions): Promise<boolean> {
    const configPath = getClientConfigPath(
      options.client,
      options.scope ?? "global",
      options.projectRoot ?? this.defaultProjectRoot,
      options.customPaths ?? this.customPaths,
    );

    return await withFileLock(configPath, async () => {
      const existing = await this.getServer(id, {
        client: options.client,
        scope: options.scope,
        projectRoot: options.projectRoot,
        customPaths: options.customPaths,
      });

      if (!existing) {
        throw new McpNotFoundError(id, options.client);
      }

      switch (options.client) {
        case "claude_desktop":
          writeClaudeDesktopServer(configPath, existing, { remove: true });
          break;
        case "claude_code":
          writeClaudeCodeServer(configPath, existing, { remove: true });
          break;
        case "codex":
          writeCodexTomlServer(configPath, existing, { remove: true });
          break;
        case "antigravity":
          writeAntigravityServer(configPath, existing, { remove: true });
          break;
      }

      return true;
    });
  }

  /**
   * Clone / share an MCP server between different client configurations.
   */
  async cloneServer(
    options: McpCloneOptions & {
      scope?: McpScope;
      projectRoot?: string;
      customPaths?: CustomPathMap;
    },
  ): Promise<UnifiedMcpServer> {
    return await executeMcpClone(
      options,
      {
        getServer: (id, client, scope) =>
          this.getServer(id, {
            client,
            scope,
            projectRoot: options.projectRoot,
            customPaths: options.customPaths,
          }),
        saveServer: (server, saveOpts) =>
          this.addServer(server, {
            scope: options.scope ?? server.scope,
            projectRoot: options.projectRoot,
            customPaths: options.customPaths,
            overwrite: saveOpts?.overwrite,
          }),
      },
      options.scope ?? "global",
    );
  }
}

// Top-level functional helpers using default singleton instance
const defaultManager = new McpConfigManager();

export const listMcpServers = (options?: McpManagerOptions) => defaultManager.listServers(options);
export const getMcpServer = (id: string, options: GetMcpServerOptions) => defaultManager.getServer(id, options);
export const addMcpServer = (server: UnifiedMcpServer, options?: AddMcpServerOptions) => defaultManager.addServer(server, options);
export const updateMcpServer = (id: string, updates: Partial<Omit<UnifiedMcpServer, "id" | "client">>, options: UpdateMcpServerOptions) => defaultManager.updateServer(id, updates, options);
export const toggleMcpServer = (id: string, enabled: boolean, options: ToggleMcpServerOptions) => defaultManager.toggleServer(id, enabled, options);
export const deleteMcpServer = (id: string, options: DeleteMcpServerOptions) => defaultManager.deleteServer(id, options);
export const cloneMcpServer = (options: McpCloneOptions & { scope?: McpScope; projectRoot?: string; customPaths?: CustomPathMap }) => defaultManager.cloneServer(options);
