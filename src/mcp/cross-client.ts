import {
  McpConflictError,
  McpNotFoundError,
  McpValidationError,
  type McpClientType,
  type McpCloneOptions,
  type McpScope,
  type UnifiedMcpServer,
} from "./types";

/**
 * Validate unified MCP server integrity before persistence.
 */
export function validateServerDefinition(server: Partial<UnifiedMcpServer>): void {
  if (!server.id || typeof server.id !== "string" || !server.id.trim()) {
    throw new McpValidationError("Server ID cannot be blank");
  }

  if (!/^[a-zA-Z0-9_.-]+$/.test(server.id.trim())) {
    throw new McpValidationError(`Server ID '${server.id}' contains invalid characters. Use alphanumeric, hyphens, underscores, or dots.`);
  }

  const transport = server.transport ?? (server.url ? "sse" : "stdio");

  if (transport === "stdio") {
    if (!server.command || typeof server.command !== "string" || !server.command.trim()) {
      throw new McpValidationError(`Stdio MCP server '${server.id}' must specify a non-empty 'command'`);
    }
  } else if (transport === "sse" || transport === "http") {
    if (!server.url || typeof server.url !== "string" || !server.url.trim()) {
      throw new McpValidationError(`Remote MCP server '${server.id}' must specify a non-empty 'url'`);
    }
    try {
      new URL(server.url);
    } catch {
      throw new McpValidationError(`Remote MCP server '${server.id}' specifies invalid URL: '${server.url}'`);
    }
  }
}

/**
 * Convert a server definition into a target client's UnifiedMcpServer IR.
 */
export function convertServerForClient(
  sourceServer: UnifiedMcpServer,
  targetClient: McpClientType,
  options: { newId?: string; scope?: McpScope } = {},
): UnifiedMcpServer {
  const targetId = (options.newId && options.newId.trim()) ? options.newId.trim() : sourceServer.id;
  const targetScope = options.scope ?? sourceServer.scope;

  const cloned: UnifiedMcpServer = {
    id: targetId,
    client: targetClient,
    scope: targetScope,
    transport: sourceServer.transport,
    command: sourceServer.command,
    args: [...(sourceServer.args ?? [])],
    env: { ...(sourceServer.env ?? {}) },
    cwd: sourceServer.cwd,
    url: sourceServer.url,
    headers: sourceServer.headers ? { ...sourceServer.headers } : undefined,
    enabled: sourceServer.enabled,
    timeoutSec: sourceServer.timeoutSec,
    autoApprove: sourceServer.autoApprove ? [...sourceServer.autoApprove] : undefined,
  };

  validateServerDefinition(cloned);
  return cloned;
}

/**
 * Dependency interface for cross-client cloning.
 */
export interface McpClonerContext {
  getServer: (id: string, client: McpClientType, scope?: McpScope) => Promise<UnifiedMcpServer | null>;
  saveServer: (server: UnifiedMcpServer, options?: { overwrite?: boolean }) => Promise<UnifiedMcpServer>;
}

/**
 * Execute cross-client cloning with conflict detection.
 */
export async function executeMcpClone(
  options: McpCloneOptions,
  context: McpClonerContext,
  targetScope: McpScope = "global",
): Promise<UnifiedMcpServer> {
  const sourceServer = await context.getServer(options.serverId, options.fromClient, targetScope);
  if (!sourceServer) {
    throw new McpNotFoundError(options.serverId, options.fromClient);
  }

  const targetId = options.newId?.trim() || options.serverId;
  const existingTarget = await context.getServer(targetId, options.toClient, targetScope);

  if (existingTarget && !options.overwrite) {
    throw new McpConflictError(targetId, options.toClient);
  }

  const converted = convertServerForClient(sourceServer, options.toClient, {
    newId: targetId,
    scope: targetScope,
  });

  return await context.saveServer(converted, { overwrite: options.overwrite });
}
