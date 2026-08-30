import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../config";
import {
  McpParseError,
  type CodexTomlConfigFile,
  type CodexTomlMcpServerConfig,
  type McpScope,
  type McpTransportType,
  type UnifiedMcpServer,
} from "../types";

export interface CodexTomlParserOptions {
  customPath?: string;
  scope?: McpScope;
  projectRoot?: string;
}

/**
 * Bare key when safe, JSON-quoted string otherwise (TOML 1.0 §Keys).
 */
export function quoteTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Resolve Codex configuration path.
 */
export function resolveCodexTomlConfigPath(options: CodexTomlParserOptions = {}): string {
  if (options.customPath) return options.customPath;

  const envOverride = process.env.OPENCODEX_CODEX_CONFIG_PATH?.trim();
  if (envOverride) return envOverride;

  if (options.scope === "project") {
    const root = options.projectRoot ?? process.cwd();
    return join(root, ".codex", "config.toml");
  }

  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    return join(codexHome, "config.toml");
  }

  return join(homedir(), ".codex", "config.toml");
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
 * Read and parse Codex config.toml configuration.
 */
export function readCodexTomlConfig(
  configPath: string,
  scope: McpScope = "global",
): { servers: UnifiedMcpServer[]; raw: CodexTomlConfigFile } {
  if (!existsSync(configPath)) {
    return { servers: [], raw: {} };
  }

  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new McpParseError(configPath, err);
  }

  if (!content.trim()) {
    return { servers: [], raw: {} };
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(content);
  } catch (err) {
    throw new McpParseError(configPath, err);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpParseError(configPath, new Error("Root of config.toml must be a TOML table"));
  }

  const rawDoc = parsed as CodexTomlConfigFile;
  const rawServers = rawDoc.mcp_servers;
  const servers: UnifiedMcpServer[] = [];

  if (typeof rawServers === "object" && rawServers !== null && !Array.isArray(rawServers)) {
    for (const [id, cfg] of Object.entries(rawServers)) {
      if (typeof cfg !== "object" || cfg === null) continue;
      const conf = cfg as CodexTomlMcpServerConfig;

      const hasUrl = typeof conf.url === "string" && conf.url.trim().length > 0;
      const transport: McpTransportType = hasUrl
        ? (conf.url!.startsWith("http") && !conf.url!.includes("/sse") ? "http" : "sse")
        : "stdio";

      const enabled = conf.enabled !== false;
      const timeoutSec = typeof conf.startup_timeout_sec === "number"
        ? conf.startup_timeout_sec
        : typeof conf.timeout_sec === "number"
          ? conf.timeout_sec
          : undefined;

      const server: UnifiedMcpServer = {
        id,
        client: "codex",
        scope,
        transport,
        command: typeof conf.command === "string" ? conf.command : undefined,
        args: Array.isArray(conf.args) ? conf.args.map(String) : [],
        env: stringRecord(conf.env),
        cwd: typeof conf.cwd === "string" ? conf.cwd : undefined,
        url: hasUrl ? conf.url : undefined,
        headers: conf.headers ? stringRecord(conf.headers) : undefined,
        enabled,
        timeoutSec,
        rawConfig: conf as Record<string, unknown>,
      };

      servers.push(server);
    }
  }

  return { servers, raw: rawDoc };
}

/**
 * Format a single MCP server into TOML table blocks.
 */
export function formatCodexTomlServerBlock(server: UnifiedMcpServer): string {
  const lines: string[] = [];
  const serverKey = quoteTomlKey(server.id);

  lines.push(`[mcp_servers.${serverKey}]`);
  if (server.transport === "stdio") {
    if (server.command !== undefined) {
      lines.push(`command = ${JSON.stringify(server.command)}`);
    }
    if (server.args && server.args.length > 0) {
      const argsFormatted = `[${server.args.map((a) => JSON.stringify(a)).join(", ")}]`;
      lines.push(`args = ${argsFormatted}`);
    } else {
      lines.push(`args = []`);
    }
    if (server.cwd) {
      lines.push(`cwd = ${JSON.stringify(server.cwd)}`);
    }
  } else {
    if (server.url) {
      lines.push(`url = ${JSON.stringify(server.url)}`);
    }
  }

  lines.push(`enabled = ${server.enabled ? "true" : "false"}`);

  if (server.timeoutSec !== undefined) {
    lines.push(`startup_timeout_sec = ${server.timeoutSec}`);
  }

  if (server.env && Object.keys(server.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${serverKey}.env]`);
    for (const [k, v] of Object.entries(server.env)) {
      lines.push(`${quoteTomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }

  if (server.headers && Object.keys(server.headers).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${serverKey}.headers]`);
    for (const [k, v] of Object.entries(server.headers)) {
      lines.push(`${quoteTomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Check whether a TOML line starts a table or array-of-tables header.
 */
function parseTableHeader(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).trim();
  }
  return null;
}

/**
 * Check whether a table header path belongs to a specific mcp_servers ID.
 */
function headerMatchesServerId(header: string, id: string): boolean {
  const quoted = quoteTomlKey(id);
  const prefix1 = `mcp_servers.${id}`;
  const prefix2 = `mcp_servers.${quoted}`;
  const prefix3 = `mcp_servers."${id}"`;

  return (
    header === prefix1 ||
    header === prefix2 ||
    header === prefix3 ||
    header.startsWith(`${prefix1}.`) ||
    header.startsWith(`${prefix2}.`) ||
    header.startsWith(`${prefix3}.`)
  );
}

/**
 * Check whether a table header is any mcp_servers table.
 */
function isAnyMcpServersHeader(header: string): boolean {
  return header === "mcp_servers" || header.startsWith("mcp_servers.");
}

/**
 * Non-destructively write or remove an MCP server in Codex config.toml.
 * Preserves all surrounding tables ([model_providers], [plugins], [[skills.config]], comments, whitespace).
 */
export function writeCodexTomlServer(
  configPath: string,
  server: UnifiedMcpServer,
  options: { remove?: boolean } = {},
): void {
  let existingContent = "";
  if (existsSync(configPath)) {
    try {
      existingContent = readFileSync(configPath, "utf8");
    } catch (err) {
      throw new McpParseError(configPath, err);
    }
  }

  let updatedContent = "";

  if (!existingContent.trim()) {
    if (!options.remove) {
      updatedContent = `${formatCodexTomlServerBlock(server)}\n`;
    } else {
      updatedContent = "";
    }
  } else {
    const lines = existingContent.split("\n");
    // Group lines into blocks/chunks
    interface Chunk {
      header: string | null;
      lines: string[];
    }

    const chunks: Chunk[] = [];
    let currentChunk: Chunk = { header: null, lines: [] };

    for (const line of lines) {
      const header = parseTableHeader(line);
      if (header !== null) {
        chunks.push(currentChunk);
        currentChunk = { header, lines: [line] };
      } else {
        currentChunk.lines.push(line);
      }
    }
    chunks.push(currentChunk);

    // Filter out existing chunks that match this server ID
    const chunksWithoutServer: Chunk[] = [];
    let replaced = false;

    for (const chunk of chunks) {
      if (chunk.header && headerMatchesServerId(chunk.header, server.id)) {
        if (!options.remove && !replaced) {
          // Replace with new formatted block
          const blockLines = formatCodexTomlServerBlock(server).split("\n");
          chunksWithoutServer.push({
            header: `mcp_servers.${quoteTomlKey(server.id)}`,
            lines: blockLines,
          });
          replaced = true;
        }
        // Skip any matching subtable chunks (like .env) since replaced block includes them
        continue;
      }
      chunksWithoutServer.push(chunk);
    }

    // If adding/updating and was not an in-place replacement
    if (!options.remove && !replaced) {
      // Find the last mcp_servers chunk to insert after, or append at the end
      let lastMcpIndex = -1;
      for (let i = chunksWithoutServer.length - 1; i >= 0; i--) {
        if (chunksWithoutServer[i].header && isAnyMcpServersHeader(chunksWithoutServer[i].header!)) {
          lastMcpIndex = i;
          break;
        }
      }

      const newBlockLines = formatCodexTomlServerBlock(server).split("\n");
      const newChunk: Chunk = {
        header: `mcp_servers.${quoteTomlKey(server.id)}`,
        lines: newBlockLines,
      };

      if (lastMcpIndex >= 0) {
        chunksWithoutServer.splice(lastMcpIndex + 1, 0, newChunk);
      } else {
        chunksWithoutServer.push(newChunk);
      }
    }

    // Reassemble text
    const reassembledLines: string[] = [];
    for (let i = 0; i < chunksWithoutServer.length; i++) {
      const chunk = chunksWithoutServer[i];
      if (chunk.lines.length === 0) continue;
      reassembledLines.push(chunk.lines.join("\n"));
    }

    updatedContent = reassembledLines.join("\n").trim() + "\n";
  }

  // Validate the resulting TOML before writing to disk
  if (updatedContent.trim().length > 0) {
    try {
      Bun.TOML.parse(updatedContent);
    } catch (parseErr) {
      throw new McpParseError(configPath, new Error(`Generated invalid TOML: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`));
    }
  }

  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFile(configPath, updatedContent);
}
