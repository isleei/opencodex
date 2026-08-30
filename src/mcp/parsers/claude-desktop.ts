import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../config";
import {
  McpParseError,
  type ClaudeDesktopConfigFile,
  type ClaudeDesktopMcpServerConfig,
  type McpScope,
  type UnifiedMcpServer,
} from "../types";

export interface ClaudeDesktopParserOptions {
  customPath?: string;
  scope?: McpScope;
  projectRoot?: string;
}

/**
 * Resolve the standard Claude Desktop config path across operating systems.
 */
export function resolveClaudeDesktopConfigPath(options: ClaudeDesktopParserOptions = {}): string {
  if (options.customPath) return options.customPath;

  const envOverride = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_PATH?.trim();
  if (envOverride) return envOverride;

  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return appData ? join(appData, "Claude", "claude_desktop_config.json") : join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "Claude", "claude_desktop_config.json") : join(home, ".config", "Claude", "claude_desktop_config.json");
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
 * Read and parse Claude Desktop configuration.
 */
export function readClaudeDesktopConfig(
  configPath: string,
  _scope: McpScope = "global",
): { servers: UnifiedMcpServer[]; raw: ClaudeDesktopConfigFile } {
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
    throw new McpParseError(configPath, new Error("Root of claude_desktop_config.json must be a JSON object"));
  }

  const rawDoc = parsed as ClaudeDesktopConfigFile;
  const rawServers = rawDoc.mcpServers;
  const servers: UnifiedMcpServer[] = [];

  if (typeof rawServers === "object" && rawServers !== null && !Array.isArray(rawServers)) {
    for (const [id, cfg] of Object.entries(rawServers)) {
      if (typeof cfg !== "object" || cfg === null) continue;
      const conf = cfg as ClaudeDesktopMcpServerConfig;
      const hasUrl = typeof conf.url === "string" && conf.url.trim().length > 0;
      const transport = hasUrl ? (conf.url!.startsWith("http") && !conf.url!.includes("/sse") ? "http" : "sse") : "stdio";
      const enabled = conf.disabled !== true;

      const server: UnifiedMcpServer = {
        id,
        client: "claude_desktop",
        scope: "global",
        transport,
        command: typeof conf.command === "string" ? conf.command : undefined,
        args: Array.isArray(conf.args) ? conf.args.map(String) : [],
        env: stringRecord(conf.env),
        url: hasUrl ? conf.url : undefined,
        enabled,
        autoApprove: Array.isArray(conf.autoApprove) ? conf.autoApprove.map(String) : undefined,
        rawConfig: conf as Record<string, unknown>,
      };

      servers.push(server);
    }
  }

  return { servers, raw: rawDoc };
}

/**
 * Non-destructively write or remove an MCP server in Claude Desktop config.
 * Preserves all surrounding keys in claude_desktop_config.json.
 */
export function writeClaudeDesktopServer(
  configPath: string,
  server: UnifiedMcpServer,
  options: { remove?: boolean } = {},
): void {
  const { raw } = readClaudeDesktopConfig(configPath, "global");
  const mcpServers = (raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers))
    ? { ...raw.mcpServers }
    : {};

  if (options.remove) {
    delete mcpServers[server.id];
  } else {
    const existingEntry = mcpServers[server.id] ?? {};
    const updatedEntry: ClaudeDesktopMcpServerConfig = {
      ...existingEntry,
      env: server.env,
      disabled: !server.enabled,
    };

    if (server.transport === "stdio") {
      updatedEntry.command = server.command ?? "";
      updatedEntry.args = server.args;
      delete updatedEntry.url;
    } else {
      updatedEntry.url = server.url ?? "";
      delete updatedEntry.command;
      delete updatedEntry.args;
    }

    if (server.autoApprove) {
      updatedEntry.autoApprove = server.autoApprove;
    }

    mcpServers[server.id] = updatedEntry;
  }

  const updatedDoc: ClaudeDesktopConfigFile = {
    ...raw,
    mcpServers,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFile(configPath, JSON.stringify(updatedDoc, null, 2) + "\n");
}
