import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../config";
import {
  McpParseError,
  type AntigravityConfigFile,
  type AntigravityMcpServerConfig,
  type McpScope,
  type McpTransportType,
  type UnifiedMcpServer,
} from "../types";

export interface AntigravityParserOptions {
  customPath?: string;
  scope?: McpScope;
  projectRoot?: string;
}

/**
 * Resolve Antigravity configuration path.
 * Scope 'project' points to <projectRoot>/.agents/mcp_config.json
 * Scope 'global' points to ~/.gemini/config/mcp_config.json
 */
export function resolveAntigravityConfigPath(options: AntigravityParserOptions = {}): string {
  if (options.customPath) return options.customPath;

  const envOverride = process.env.OPENCODEX_ANTIGRAVITY_CONFIG_PATH?.trim();
  if (envOverride) return envOverride;

  if (options.scope === "project") {
    const root = options.projectRoot ?? process.cwd();
    return join(root, ".agents", "mcp_config.json");
  }

  const home = homedir();
  const globalPath = join(home, ".gemini", "config", "mcp_config.json");
  return globalPath;
}

function stringRecord(record: unknown): Record<string, string> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (val !== undefined && val !== null) {
      result[key] = String(val);
    }
  }
  return result;
}

/**
 * Read and parse Antigravity mcp_config.json configuration.
 */
export function readAntigravityConfig(
  configPath: string,
  scope: McpScope = "global",
): { servers: UnifiedMcpServer[]; raw: AntigravityConfigFile } {
  if (!existsSync(configPath)) {
    return { servers: [], raw: { mcpServers: {} } };
  }

  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new McpParseError(configPath, err);
  }

  if (!content.trim()) {
    return { servers: [], raw: { mcpServers: {} } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new McpParseError(configPath, err);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpParseError(configPath, new Error("Root of mcp_config.json must be a JSON object"));
  }

  const rawDoc = parsed as AntigravityConfigFile;
  const rawServers = rawDoc.mcpServers;
  const servers: UnifiedMcpServer[] = [];

  if (typeof rawServers === "object" && rawServers !== null && !Array.isArray(rawServers)) {
    for (const [id, cfg] of Object.entries(rawServers)) {
      if (typeof cfg !== "object" || cfg === null) continue;
      const conf = cfg as AntigravityMcpServerConfig;

      const remoteUrl = conf.serverUrl ?? conf.url;
      const hasUrl = typeof remoteUrl === "string" && remoteUrl.trim().length > 0;
      const transport: McpTransportType = hasUrl ? "sse" : "stdio";
      const enabled = conf.disabled !== true && conf.enabled !== false;

      const server: UnifiedMcpServer = {
        id,
        client: "antigravity",
        scope,
        transport,
        command: typeof conf.command === "string" ? conf.command : undefined,
        args: Array.isArray(conf.args) ? conf.args.map(String) : [],
        env: stringRecord(conf.env),
        cwd: typeof conf.cwd === "string" ? conf.cwd : undefined,
        url: hasUrl ? remoteUrl : undefined,
        enabled,
        rawConfig: conf as Record<string, unknown>,
      };

      servers.push(server);
    }
  }

  return { servers, raw: rawDoc };
}

/**
 * Non-destructively write or remove an MCP server in Antigravity config.
 * Preserves all surrounding keys in mcp_config.json.
 */
export function writeAntigravityServer(
  configPath: string,
  server: UnifiedMcpServer,
  options: { remove?: boolean } = {},
): void {
  const { raw } = readAntigravityConfig(configPath, server.scope);
  const mcpServers = (raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers))
    ? { ...raw.mcpServers }
    : {};

  if (options.remove) {
    delete mcpServers[server.id];
  } else {
    const existingEntry = mcpServers[server.id] ?? {};
    const updatedEntry: AntigravityMcpServerConfig = {
      ...existingEntry,
    };

    if (server.transport === "stdio") {
      updatedEntry.command = server.command ?? "";
      updatedEntry.args = server.args;
      updatedEntry.env = server.env;
      if (server.cwd) updatedEntry.cwd = server.cwd;
      delete updatedEntry.serverUrl;
      delete updatedEntry.url;
    } else {
      updatedEntry.serverUrl = server.url ?? "";
      delete updatedEntry.command;
      delete updatedEntry.args;
      delete updatedEntry.cwd;
      if (server.env && Object.keys(server.env).length > 0) {
        updatedEntry.env = server.env;
      }
    }

    if (!server.enabled) {
      updatedEntry.disabled = true;
      delete updatedEntry.enabled;
    } else {
      delete updatedEntry.disabled;
    }

    mcpServers[server.id] = updatedEntry;
  }

  const updatedDoc: AntigravityConfigFile = {
    ...raw,
    mcpServers,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFile(configPath, JSON.stringify(updatedDoc, null, 2) + "\n");
}
