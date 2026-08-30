/**
 * Management routes for Multi-Client MCP Server Configuration Engine.
 *
 * REST Endpoints:
 * - GET /api/mcp: List all MCP servers across all supported clients
 * - GET /api/mcp/:client: List MCP servers for a specific client
 * - POST /api/mcp/:client: Add a new MCP server to a client
 * - PUT /api/mcp/:client/:id: Update an existing MCP server
 * - POST /api/mcp/:client/:id/toggle: Toggle an MCP server enabled state
 * - DELETE /api/mcp/:client/:id: Remove an MCP server from a client
 * - POST /api/mcp/clone: One-click cross-client MCP server cloning
 */

import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import {
  ALL_MCP_CLIENTS,
  McpConfigManager,
} from "../../mcp/config-manager";
import {
  McpConflictError,
  McpNotFoundError,
  McpValidationError,
  type McpClientType,
  type McpCloneOptions,
  type McpScope,
  type McpTransportType,
  type UnifiedMcpServer,
} from "../../mcp/types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(ctx: ManagementContext): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(ctx.req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({
      error: "invalid JSON body",
      code: "invalid_json_body",
    }, 400, ctx.req, ctx.config);
  }
}

export function normalizeClientParam(raw: string): McpClientType | null {
  const norm = raw.trim().toLowerCase().replace(/-/g, "_");
  if (norm === "claude_desktop" || norm === "desktop") return "claude_desktop";
  if (norm === "claude_code" || norm === "claude") return "claude_code";
  if (norm === "codex") return "codex";
  if (norm === "antigravity" || norm === "gemini") return "antigravity";
  return null;
}

export async function handleMcpRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (!url.pathname.startsWith("/api/mcp")) {
    return null;
  }

  const manager = ctx.deps.mcpConfigManager ?? new McpConfigManager({ customPaths: ctx.deps.mcpCustomPaths });

  // 1. GET /api/mcp
  if (url.pathname === "/api/mcp" && req.method === "GET") {
    try {
      const clientParam = url.searchParams.get("client");
      const scopeParam = url.searchParams.get("scope") as McpScope | null;

      let client: McpClientType | undefined;
      if (clientParam && clientParam !== "all") {
        const norm = normalizeClientParam(clientParam);
        if (!norm) {
          return jsonResponse({
            error: `Unknown MCP client: "${clientParam}". Valid clients are: ${ALL_MCP_CLIENTS.join(", ")}`,
            code: "invalid_mcp_client",
          }, 400, req, ctx.config);
        }
        client = norm;
      }

      const scope = scopeParam === "global" || scopeParam === "project" ? scopeParam : undefined;
      const servers = await manager.listServers({ client, scope, customPaths: ctx.deps.mcpCustomPaths });
      return jsonResponse({ servers }, 200, req, ctx.config);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        code: "mcp_list_error",
      }, 500, req, ctx.config);
    }
  }

  // 2. POST /api/mcp/clone
  if (url.pathname === "/api/mcp/clone" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed)) {
      return jsonResponse({
        error: "Request body must be a JSON object",
        code: "invalid_request_body",
      }, 400, req, ctx.config);
    }

    if (typeof parsed.fromClient !== "string" || typeof parsed.toClient !== "string" || typeof parsed.serverId !== "string") {
      return jsonResponse({
        error: "fromClient, toClient, and serverId are required fields",
        code: "missing_clone_parameters",
      }, 400, req, ctx.config);
    }

    const fromClient = normalizeClientParam(parsed.fromClient);
    const toClient = normalizeClientParam(parsed.toClient);

    if (!fromClient) {
      return jsonResponse({
        error: `Invalid source client: "${parsed.fromClient}". Valid clients are: ${ALL_MCP_CLIENTS.join(", ")}`,
        code: "invalid_source_client",
      }, 400, req, ctx.config);
    }

    if (!toClient) {
      return jsonResponse({
        error: `Invalid target client: "${parsed.toClient}". Valid clients are: ${ALL_MCP_CLIENTS.join(", ")}`,
        code: "invalid_target_client",
      }, 400, req, ctx.config);
    }

    const serverId = parsed.serverId.trim();
    if (!serverId) {
      return jsonResponse({
        error: "serverId cannot be empty",
        code: "invalid_server_id",
      }, 400, req, ctx.config);
    }

    const cloneOptions: McpCloneOptions & { scope?: McpScope; customPaths?: typeof ctx.deps.mcpCustomPaths } = {
      fromClient,
      toClient,
      serverId,
      newId: typeof parsed.newId === "string" && parsed.newId.trim() ? parsed.newId.trim() : undefined,
      overwrite: typeof parsed.overwrite === "boolean" ? parsed.overwrite : false,
      scope: (parsed.scope === "global" || parsed.scope === "project") ? parsed.scope : undefined,
      customPaths: ctx.deps.mcpCustomPaths,
    };

    try {
      const created = await manager.cloneServer(cloneOptions);
      return jsonResponse({ ok: true, created }, 200, req, ctx.config);
    } catch (error) {
      if (error instanceof McpNotFoundError) {
        return jsonResponse({ error: error.message, code: "server_not_found" }, 404, req, ctx.config);
      }
      if (error instanceof McpConflictError) {
        return jsonResponse({ error: error.message, code: "server_conflict" }, 409, req, ctx.config);
      }
      if (error instanceof McpValidationError) {
        return jsonResponse({ error: error.message, code: "validation_error" }, 400, req, ctx.config);
      }
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        code: "mcp_clone_error",
      }, 500, req, ctx.config);
    }
  }

  // 3. POST /api/mcp/:client/:id/toggle
  const toggleMatch = url.pathname.match(/^\/api\/mcp\/([^/]+)\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === "POST") {
    const rawClient = toggleMatch[1];
    const client = normalizeClientParam(rawClient);
    if (!client) {
      return jsonResponse({
        error: `Unknown MCP client: "${rawClient}". Valid clients are: ${ALL_MCP_CLIENTS.join(", ")}`,
        code: "invalid_mcp_client",
      }, 400, req, ctx.config);
    }

    const id = decodeURIComponent(toggleMatch[2]);
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed) || typeof parsed.enabled !== "boolean") {
      return jsonResponse({
        error: "enabled must be a boolean",
        code: "invalid_toggle_body",
      }, 400, req, ctx.config);
    }

    const scope = (parsed.scope === "global" || parsed.scope === "project") ? parsed.scope : undefined;
    try {
      const updated = await manager.toggleServer(id, parsed.enabled, {
        client,
        scope,
        customPaths: ctx.deps.mcpCustomPaths,
      });
      return jsonResponse({ ok: true, enabled: updated.enabled }, 200, req, ctx.config);
    } catch (error) {
      if (error instanceof McpNotFoundError) {
        return jsonResponse({ error: error.message, code: "server_not_found" }, 404, req, ctx.config);
      }
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        code: "mcp_toggle_error",
      }, 500, req, ctx.config);
    }
  }

  // 4. PUT /api/mcp/:client/:id & DELETE /api/mcp/:client/:id
  const itemMatch = url.pathname.match(/^\/api\/mcp\/([^/]+)\/([^/]+)$/);
  if (itemMatch && itemMatch[2] !== "toggle") {
    const rawClient = itemMatch[1];
    const client = normalizeClientParam(rawClient);
    if (!client) {
      return jsonResponse({
        error: `Unknown MCP client: "${rawClient}". Valid clients are: ${ALL_MCP_CLIENTS.join(", ")}`,
        code: "invalid_mcp_client",
      }, 400, req, ctx.config);
    }

    const id = decodeURIComponent(itemMatch[2]);
    const scopeParam = url.searchParams.get("scope") as McpScope | null;
    const scope = (scopeParam === "global" || scopeParam === "project") ? scopeParam : undefined;

    // PUT
    if (req.method === "PUT") {
      const parsed = await readJsonBody(ctx);
      if (parsed instanceof Response) return parsed;
      if (!isPlainRecord(parsed)) {
        return jsonResponse({
          error: "Request body must be a JSON object",
          code: "invalid_request_body",
        }, 400, req, ctx.config);
      }

      const updates: Partial<Omit<UnifiedMcpServer, "id" | "client">> = {};
      if (typeof parsed.transport === "string") updates.transport = parsed.transport as McpTransportType;
      if (typeof parsed.command === "string") updates.command = parsed.command;
      if (Array.isArray(parsed.args)) updates.args = parsed.args.map(String);
      if (isPlainRecord(parsed.env)) updates.env = Object.fromEntries(Object.entries(parsed.env).map(([k, v]) => [k, String(v)]));
      if (typeof parsed.cwd === "string") updates.cwd = parsed.cwd;
      if (typeof parsed.url === "string") updates.url = parsed.url;
      if (isPlainRecord(parsed.headers)) updates.headers = Object.fromEntries(Object.entries(parsed.headers).map(([k, v]) => [k, String(v)]));
      if (typeof parsed.enabled === "boolean") updates.enabled = parsed.enabled;
      if (typeof parsed.timeoutSec === "number") updates.timeoutSec = parsed.timeoutSec;
      if (Array.isArray(parsed.autoApprove)) updates.autoApprove = parsed.autoApprove.map(String);
      if (isPlainRecord(parsed.rawConfig)) updates.rawConfig = parsed.rawConfig;

      try {
        const server = await manager.updateServer(id, updates, {
          client,
          scope: (parsed.scope === "global" || parsed.scope === "project") ? parsed.scope : scope,
          customPaths: ctx.deps.mcpCustomPaths,
        });
        return jsonResponse({ ok: true, server }, 200, req, ctx.config);
      } catch (error) {
        if (error instanceof McpNotFoundError) {
          return jsonResponse({ error: error.message, code: "server_not_found" }, 404, req, ctx.config);
        }
        if (error instanceof McpValidationError) {
          return jsonResponse({ error: error.message, code: "validation_error" }, 400, req, ctx.config);
        }
        return jsonResponse({
          error: error instanceof Error ? error.message : String(error),
          code: "mcp_update_error",
        }, 500, req, ctx.config);
      }
    }

    // DELETE
    if (req.method === "DELETE") {
      try {
        await manager.deleteServer(id, {
          client,
          scope,
          customPaths: ctx.deps.mcpCustomPaths,
        });
        return jsonResponse({
          ok: true,
          message: `MCP server '${id}' removed from client '${client}'`,
        }, 200, req, ctx.config);
      } catch (error) {
        if (error instanceof McpNotFoundError) {
          return jsonResponse({ error: error.message, code: "server_not_found" }, 404, req, ctx.config);
        }
        return jsonResponse({
          error: error instanceof Error ? error.message : String(error),
          code: "mcp_delete_error",
        }, 500, req, ctx.config);
      }
    }
  }

  // 5. GET /api/mcp/:client & POST /api/mcp/:client
  const clientMatch = url.pathname.match(/^\/api\/mcp\/([^/]+)$/);
  if (clientMatch && clientMatch[1] !== "clone") {
    const rawClient = clientMatch[1];
    const client = normalizeClientParam(rawClient);
    if (!client) {
      return jsonResponse({
        error: `Unknown MCP client: "${rawClient}". Valid clients are: ${ALL_MCP_CLIENTS.join(", ")}`,
        code: "invalid_mcp_client",
      }, 400, req, ctx.config);
    }

    // GET /api/mcp/:client
    if (req.method === "GET") {
      try {
        const scopeParam = url.searchParams.get("scope") as McpScope | null;
        const scope = (scopeParam === "global" || scopeParam === "project") ? scopeParam : undefined;
        const servers = await manager.listServers({
          client,
          scope,
          customPaths: ctx.deps.mcpCustomPaths,
        });
        return jsonResponse({ client, servers }, 200, req, ctx.config);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : String(error),
          code: "mcp_client_list_error",
        }, 500, req, ctx.config);
      }
    }

    // POST /api/mcp/:client
    if (req.method === "POST") {
      const parsed = await readJsonBody(ctx);
      if (parsed instanceof Response) return parsed;
      if (!isPlainRecord(parsed)) {
        return jsonResponse({
          error: "Request body must be a JSON object",
          code: "invalid_request_body",
        }, 400, req, ctx.config);
      }

      if (typeof parsed.id !== "string" || !parsed.id.trim()) {
        return jsonResponse({
          error: "Server ID is required and must be a non-empty string",
          code: "missing_server_id",
        }, 400, req, ctx.config);
      }

      const id = parsed.id.trim();
      const scope = (parsed.scope === "global" || parsed.scope === "project") ? parsed.scope : "global";
      const transport = (parsed.transport === "stdio" || parsed.transport === "sse" || parsed.transport === "http")
        ? parsed.transport
        : (parsed.url ? "sse" : "stdio");

      const serverDef: UnifiedMcpServer = {
        id,
        client,
        scope,
        transport,
        command: typeof parsed.command === "string" ? parsed.command : undefined,
        args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
        env: isPlainRecord(parsed.env) ? Object.fromEntries(Object.entries(parsed.env).map(([k, v]) => [k, String(v)])) : {},
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
        url: typeof parsed.url === "string" ? parsed.url : undefined,
        headers: isPlainRecord(parsed.headers) ? Object.fromEntries(Object.entries(parsed.headers).map(([k, v]) => [k, String(v)])) : undefined,
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
        timeoutSec: typeof parsed.timeoutSec === "number" ? parsed.timeoutSec : undefined,
        autoApprove: Array.isArray(parsed.autoApprove) ? parsed.autoApprove.map(String) : undefined,
        rawConfig: isPlainRecord(parsed.rawConfig) ? parsed.rawConfig : undefined,
      };

      try {
        const added = await manager.addServer(serverDef, {
          scope,
          overwrite: typeof parsed.overwrite === "boolean" ? parsed.overwrite : false,
          customPaths: ctx.deps.mcpCustomPaths,
        });
        return jsonResponse({ ok: true, server: added }, 200, req, ctx.config);
      } catch (error) {
        if (error instanceof McpConflictError) {
          return jsonResponse({ error: error.message, code: "server_conflict" }, 409, req, ctx.config);
        }
        if (error instanceof McpValidationError) {
          return jsonResponse({ error: error.message, code: "validation_error" }, 400, req, ctx.config);
        }
        return jsonResponse({
          error: error instanceof Error ? error.message : String(error),
          code: "mcp_add_error",
        }, 500, req, ctx.config);
      }
    }
  }

  return null;
}
