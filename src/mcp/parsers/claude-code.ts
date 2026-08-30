import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../config";
import {
  McpParseError,
  type ClaudeCodeConfigFile,
  type ClaudeCodeMcpServerConfig,
  type McpScope,
  type McpTransportType,
  type UnifiedMcpServer,
} from "../types";

export interface ClaudeCodeParserOptions {
  customPath?: string;
  scope?: McpScope;
  projectRoot?: string;
}

/**
 * Resolve Claude Code configuration path.
 * Scope 'global' points to ~/.claude.json, scope 'project' points to <projectRoot>/.claude.json
 */
export function resolveClaudeCodeConfigPath(options: ClaudeCodeParserOptions = {}): string {
  if (options.customPath) return options.customPath;

  const envOverride = process.env.OPENCODEX_CLAUDE_CODE_CONFIG_PATH?.trim();
  if (envOverride) return envOverride;

  if (options.scope === "project") {
    const root = options.projectRoot ?? process.cwd();
    return join(root, ".claude.json");
  }

  const home = homedir();
  const globalPath = join(home, ".claude.json");
  if (existsSync(globalPath)) return globalPath;

  const settingsPath = join(home, ".claude", "settings.json");
  if (existsSync(settingsPath)) return settingsPath;

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
 * Read and parse Claude Code configuration.
 */
export function readClaudeCodeConfig(
  configPath: string,
  scope: McpScope = "global",
): { servers: UnifiedMcpServer[]; raw: ClaudeCodeConfigFile } {
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
    throw new McpParseError(configPath, new Error("Root of claude.json must be a JSON object"));
  }

  const rawDoc = parsed as ClaudeCodeConfigFile;
  const rawServers = rawDoc.mcpServers;
  const servers: UnifiedMcpServer[] = [];

  if (typeof rawServers === "object" && rawServers !== null && !Array.isArray(rawServers)) {
    for (const [id, cfg] of Object.entries(rawServers)) {
      if (typeof cfg !== "object" || cfg === null) continue;
      const conf = cfg as ClaudeCodeMcpServerConfig;

      let transport: McpTransportType = "stdio";
      if (conf.type === "sse" || conf.type === "http" || conf.type === "stdio") {
        transport = conf.type;
      } else if (conf.url) {
        transport = conf.url.includes("/sse") ? "sse" : "http";
      }

      const enabled = conf.disabled !== true && conf.enabled !== false;

      const server: UnifiedMcpServer = {
        id,
        client: "claude_code",
        scope,
        transport,
        command: typeof conf.command === "string" ? conf.command : undefined,
        args: Array.isArray(conf.args) ? conf.args.map(String) : [],
        env: stringRecord(conf.env),
        cwd: typeof conf.cwd === "string" ? conf.cwd : undefined,
        url: typeof conf.url === "string" ? conf.url : undefined,
        headers: conf.headers ? stringRecord(conf.headers) : undefined,
        enabled,
        rawConfig: conf as Record<string, unknown>,
      };

      servers.push(server);
    }
  }

  return { servers, raw: rawDoc };
}

/**
 * Non-destructively write or remove an MCP server in Claude Code config.
 * Preserves all surrounding keys in ~/.claude.json.
 */
export function writeClaudeCodeServer(
  configPath: string,
  server: UnifiedMcpServer,
  options: { remove?: boolean } = {},
): void {
  const { raw } = readClaudeCodeConfig(configPath, server.scope);
  const mcpServers = (raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers))
    ? { ...raw.mcpServers }
    : {};

  if (options.remove) {
    delete mcpServers[server.id];
  } else {
    const existingEntry = mcpServers[server.id] ?? {};
    const updatedEntry: ClaudeCodeMcpServerConfig = {
      ...existingEntry,
      type: server.transport,
    };

    if (server.transport === "stdio") {
      updatedEntry.command = server.command ?? "";
      updatedEntry.args = server.args;
      updatedEntry.env = server.env;
      if (server.cwd) updatedEntry.cwd = server.cwd;
      delete updatedEntry.url;
      delete updatedEntry.headers;
    } else {
      updatedEntry.url = server.url ?? "";
      if (server.headers && Object.keys(server.headers).length > 0) {
        updatedEntry.headers = server.headers;
      }
      if (server.env && Object.keys(server.env).length > 0) {
        updatedEntry.env = server.env;
      }
      delete updatedEntry.command;
      delete updatedEntry.args;
      delete updatedEntry.cwd;
    }

    if (!server.enabled) {
      updatedEntry.disabled = true;
      delete updatedEntry.enabled;
    } else {
      delete updatedEntry.disabled;
    }

    mcpServers[server.id] = updatedEntry;
  }

  const updatedDoc: ClaudeCodeConfigFile = {
    ...raw,
    mcpServers,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFile(configPath, JSON.stringify(updatedDoc, null, 2) + "\n");
}
