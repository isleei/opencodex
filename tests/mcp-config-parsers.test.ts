import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readClaudeDesktopConfig,
  writeClaudeDesktopServer,
} from "../src/mcp/parsers/claude-desktop";
import {
  readClaudeCodeConfig,
  writeClaudeCodeServer,
} from "../src/mcp/parsers/claude-code";
import {
  formatCodexTomlServerBlock,
  quoteTomlKey,
  readCodexTomlConfig,
  writeCodexTomlServer,
} from "../src/mcp/parsers/codex-toml";
import {
  readAntigravityConfig,
  writeAntigravityServer,
} from "../src/mcp/parsers/antigravity";
import { McpParseError, type UnifiedMcpServer } from "../src/mcp/types";

describe("MCP Config Parsers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ocx-mcp-parsers-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("Claude Desktop Parser", () => {
    it("returns empty result on non-existent config file", () => {
      const configPath = join(tempDir, "claude_desktop_config.json");
      const result = readClaudeDesktopConfig(configPath);
      expect(result.servers).toEqual([]);
      expect(result.raw).toEqual({ mcpServers: {} });
    });

    it("parses stdio and remote SSE MCP servers correctly", () => {
      const configPath = join(tempDir, "claude_desktop_config.json");
      const configData = {
        mcpServers: {
          "sqlite-helper": {
            command: "sqlite-mcp-server",
            args: ["/path/to/db.sqlite"],
            env: { DB_READONLY: "true" },
            disabled: false,
            autoApprove: ["read_query"],
          },
          "remote-weather": {
            url: "https://mcp.weather.com/sse",
            disabled: true,
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf8");

      const { servers } = readClaudeDesktopConfig(configPath);
      expect(servers).toHaveLength(2);

      const sqlite = servers.find((s) => s.id === "sqlite-helper")!;
      expect(sqlite).toBeDefined();
      expect(sqlite.client).toBe("claude_desktop");
      expect(sqlite.transport).toBe("stdio");
      expect(sqlite.command).toBe("sqlite-mcp-server");
      expect(sqlite.args).toEqual(["/path/to/db.sqlite"]);
      expect(sqlite.env).toEqual({ DB_READONLY: "true" });
      expect(sqlite.enabled).toBe(true);
      expect(sqlite.autoApprove).toEqual(["read_query"]);

      const weather = servers.find((s) => s.id === "remote-weather")!;
      expect(weather).toBeDefined();
      expect(weather.transport).toBe("sse");
      expect(weather.url).toBe("https://mcp.weather.com/sse");
      expect(weather.enabled).toBe(false);
    });

    it("writes new stdio server to Claude Desktop config atomically", () => {
      const configPath = join(tempDir, "claude_desktop_config.json");
      const server: UnifiedMcpServer = {
        id: "git-tool",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-git"],
        env: { GIT_PATH: "/usr/bin/git" },
        enabled: true,
      };

      writeClaudeDesktopServer(configPath, server);

      expect(existsSync(configPath)).toBe(true);
      const { servers, raw } = readClaudeDesktopConfig(configPath);
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("git-tool");
      expect(servers[0].command).toBe("uvx");
      expect(raw.mcpServers?.["git-tool"]?.disabled).toBe(false);
    });

    it("throws McpParseError on corrupted JSON", () => {
      const configPath = join(tempDir, "claude_desktop_config.json");
      writeFileSync(configPath, "{ broken json ...", "utf8");

      expect(() => readClaudeDesktopConfig(configPath)).toThrow(McpParseError);
    });
  });

  describe("Claude Code Parser", () => {
    it("returns empty result on non-existent config file", () => {
      const configPath = join(tempDir, ".claude.json");
      const result = readClaudeCodeConfig(configPath);
      expect(result.servers).toEqual([]);
      expect(result.raw).toEqual({ mcpServers: {} });
    });

    it("parses stdio and sse types with custom headers and cwd", () => {
      const configPath = join(tempDir, ".claude.json");
      const configData = {
        mcpServers: {
          context7: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
            env: { API_KEY: "secret123" },
            cwd: "/tmp/work",
          },
          remote: {
            type: "sse",
            url: "https://mcp.company.internal/sse",
            headers: { Authorization: "Bearer tok_123" },
            disabled: false,
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf8");

      const { servers } = readClaudeCodeConfig(configPath);
      expect(servers).toHaveLength(2);

      const context7 = servers.find((s) => s.id === "context7")!;
      expect(context7.client).toBe("claude_code");
      expect(context7.transport).toBe("stdio");
      expect(context7.command).toBe("npx");
      expect(context7.cwd).toBe("/tmp/work");
      expect(context7.env).toEqual({ API_KEY: "secret123" });

      const remote = servers.find((s) => s.id === "remote")!;
      expect(remote.transport).toBe("sse");
      expect(remote.url).toBe("https://mcp.company.internal/sse");
      expect(remote.headers).toEqual({ Authorization: "Bearer tok_123" });
    });

    it("writes Claude Code server with correct type and properties", () => {
      const configPath = join(tempDir, ".claude.json");
      const server: UnifiedMcpServer = {
        id: "fetch-server",
        client: "claude_code",
        scope: "project",
        transport: "sse",
        url: "https://fetch.mcp.io/sse",
        headers: { "X-Custom": "val" },
        args: [],
        env: {},
        enabled: true,
      };

      writeClaudeCodeServer(configPath, server);

      const { servers, raw } = readClaudeCodeConfig(configPath, "project");
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("fetch-server");
      expect(servers[0].transport).toBe("sse");
      expect(raw.mcpServers?.["fetch-server"]?.type).toBe("sse");
      expect(raw.mcpServers?.["fetch-server"]?.url).toBe("https://fetch.mcp.io/sse");
    });
  });

  describe("Codex TOML Parser", () => {
    it("returns empty result on non-existent config file", () => {
      const configPath = join(tempDir, "config.toml");
      const result = readCodexTomlConfig(configPath);
      expect(result.servers).toEqual([]);
      expect(result.raw).toEqual({});
    });

    it("parses TOML mcp_servers with command, args, timeout, env, and headers", () => {
      const configPath = join(tempDir, "config.toml");
      const tomlContent = `
[mcp_servers.memory]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-memory"]
cwd = "/Users/slee"
enabled = true
startup_timeout_sec = 120

[mcp_servers.memory.env]
DEBUG = "true"
LOG_LEVEL = "verbose"

[mcp_servers.remote_service]
url = "https://mcp.example.com/sse"
enabled = false
`;
      writeFileSync(configPath, tomlContent, "utf8");

      const { servers } = readCodexTomlConfig(configPath);
      expect(servers).toHaveLength(2);

      const memory = servers.find((s) => s.id === "memory")!;
      expect(memory.client).toBe("codex");
      expect(memory.transport).toBe("stdio");
      expect(memory.command).toBe("npx");
      expect(memory.args).toEqual(["-y", "@modelcontextprotocol/server-memory"]);
      expect(memory.cwd).toBe("/Users/slee");
      expect(memory.enabled).toBe(true);
      expect(memory.timeoutSec).toBe(120);
      expect(memory.env).toEqual({ DEBUG: "true", LOG_LEVEL: "verbose" });

      const remote = servers.find((s) => s.id === "remote_service")!;
      expect(remote.transport).toBe("sse");
      expect(remote.url).toBe("https://mcp.example.com/sse");
      expect(remote.enabled).toBe(false);
    });

    it("quotes complex TOML keys properly", () => {
      expect(quoteTomlKey("memory")).toBe("memory");
      expect(quoteTomlKey("my-server_v1")).toBe("my-server_v1");
      expect(quoteTomlKey("my server with spaces")).toBe('"my server with spaces"');
      expect(quoteTomlKey("server.with.dots")).toBe('"server.with.dots"');
    });

    it("formats and writes valid Codex TOML server blocks", () => {
      const configPath = join(tempDir, "config.toml");
      const server: UnifiedMcpServer = {
        id: "postgres",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/db"],
        cwd: "/var/data",
        env: { PGUSER: "postgres", PGPASSWORD: "secret" },
        enabled: true,
        timeoutSec: 60,
      };

      writeCodexTomlServer(configPath, server);

      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, "utf8");
      expect(content).toContain("[mcp_servers.postgres]");
      expect(content).toContain('command = "npx"');
      expect(content).toContain("[mcp_servers.postgres.env]");
      expect(content).toContain('PGUSER = "postgres"');

      // Roundtrip read
      const { servers } = readCodexTomlConfig(configPath);
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("postgres");
      expect(servers[0].timeoutSec).toBe(60);
      expect(servers[0].env.PGPASSWORD).toBe("secret");
    });
  });

  describe("Antigravity Parser", () => {
    it("returns empty result on non-existent config file", () => {
      const configPath = join(tempDir, "mcp_config.json");
      const result = readAntigravityConfig(configPath);
      expect(result.servers).toEqual([]);
      expect(result.raw).toEqual({ mcpServers: {} });
    });

    it("parses stdio and serverUrl remote configs", () => {
      const configPath = join(tempDir, "mcp_config.json");
      const configData = {
        mcpServers: {
          "fast-context": {
            command: "npx",
            args: ["-y", "--prefer-online", "fast-context-mcp@latest"],
            env: { NODE_ENV: "production" },
          },
          "remote-service": {
            serverUrl: "https://mcp.mycompany.com/sse",
            disabled: true,
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf8");

      const { servers } = readAntigravityConfig(configPath);
      expect(servers).toHaveLength(2);

      const fastContext = servers.find((s) => s.id === "fast-context")!;
      expect(fastContext.client).toBe("antigravity");
      expect(fastContext.transport).toBe("stdio");
      expect(fastContext.command).toBe("npx");
      expect(fastContext.args).toEqual(["-y", "--prefer-online", "fast-context-mcp@latest"]);
      expect(fastContext.enabled).toBe(true);

      const remote = servers.find((s) => s.id === "remote-service")!;
      expect(remote.transport).toBe("sse");
      expect(remote.url).toBe("https://mcp.mycompany.com/sse");
      expect(remote.enabled).toBe(false);
    });

    it("writes Antigravity config preserving serverUrl format", () => {
      const configPath = join(tempDir, "mcp_config.json");
      const server: UnifiedMcpServer = {
        id: "remote-agent",
        client: "antigravity",
        scope: "project",
        transport: "sse",
        url: "https://agent.example.com/sse",
        args: [],
        env: {},
        enabled: true,
      };

      writeAntigravityServer(configPath, server);

      const { servers, raw } = readAntigravityConfig(configPath, "project");
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("remote-agent");
      expect(servers[0].url).toBe("https://agent.example.com/sse");
      expect(raw.mcpServers?.["remote-agent"]?.serverUrl).toBe("https://agent.example.com/sse");
    });
  });
});
