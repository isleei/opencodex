import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertServerForClient,
  executeMcpClone,
} from "../src/mcp/cross-client";
import { McpConfigManager } from "../src/mcp/config-manager";
import {
  McpConflictError,
  McpNotFoundError,
  type McpClientType,
  type UnifiedMcpServer,
} from "../src/mcp/types";

describe("MCP Cross-Client Cloning & Conversion", () => {
  let tempDir: string;
  let manager: McpConfigManager;
  let customPaths: Record<McpClientType, string>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ocx-mcp-clone-test-"));
    customPaths = {
      claude_desktop: join(tempDir, "claude_desktop_config.json"),
      claude_code: join(tempDir, ".claude.json"),
      codex: join(tempDir, "config.toml"),
      antigravity: join(tempDir, "mcp_config.json"),
    };
    manager = new McpConfigManager({ customPaths });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("convertServerForClient IR Translation", () => {
    it("converts Claude Desktop server to Codex representation", () => {
      const source: UnifiedMcpServer = {
        id: "sqlite-tool",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "sqlite-mcp-server",
        args: ["/data/app.db"],
        env: { DB_READONLY: "1" },
        enabled: false,
        autoApprove: ["read_query"],
      };

      const converted = convertServerForClient(source, "codex");
      expect(converted.client).toBe("codex");
      expect(converted.id).toBe("sqlite-tool");
      expect(converted.command).toBe("sqlite-mcp-server");
      expect(converted.args).toEqual(["/data/app.db"]);
      expect(converted.env).toEqual({ DB_READONLY: "1" });
      expect(converted.enabled).toBe(false);
    });

    it("converts Codex remote SSE server to Antigravity format", () => {
      const source: UnifiedMcpServer = {
        id: "remote-stream",
        client: "codex",
        scope: "global",
        transport: "sse",
        url: "https://mcp.service.internal/sse",
        args: [],
        env: { AUTH: "tok" },
        enabled: true,
      };

      const converted = convertServerForClient(source, "antigravity", { newId: "remote-stream-copy" });
      expect(converted.client).toBe("antigravity");
      expect(converted.id).toBe("remote-stream-copy");
      expect(converted.transport).toBe("sse");
      expect(converted.url).toBe("https://mcp.service.internal/sse");
      expect(converted.enabled).toBe(true);
    });
  });

  describe("executeMcpClone End-to-End Cloner", () => {
    it("clones server from Claude Desktop to Codex", async () => {
      // 1. Add server to Claude Desktop
      const desktopServer: UnifiedMcpServer = {
        id: "git-tool",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-git"],
        env: { GIT_EXEC: "/bin/git" },
        enabled: true,
      };
      await manager.addServer(desktopServer, { customPaths });

      // 2. Clone to Codex
      const cloned = await manager.cloneServer({
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "git-tool",
        customPaths,
      });

      expect(cloned.client).toBe("codex");
      expect(cloned.id).toBe("git-tool");

      // Verify Codex has it stored
      const codexServer = await manager.getServer("git-tool", { client: "codex", customPaths });
      expect(codexServer).not.toBeNull();
      expect(codexServer!.command).toBe("uvx");
      expect(codexServer!.args).toEqual(["mcp-server-git"]);
      expect(codexServer!.env).toEqual({ GIT_EXEC: "/bin/git" });
    });

    it("clones remote SSE server from Codex to Claude Code and Antigravity", async () => {
      // 1. Add server to Codex
      const codexServer: UnifiedMcpServer = {
        id: "weather-service",
        client: "codex",
        scope: "global",
        transport: "sse",
        url: "https://mcp.weather.gov/sse",
        args: [],
        env: { REGION: "US" },
        headers: { "X-Api-Version": "2" },
        enabled: true,
      };
      await manager.addServer(codexServer, { customPaths });

      // 2. Clone to Claude Code
      const claudeCodeCopy = await manager.cloneServer({
        fromClient: "codex",
        toClient: "claude_code",
        serverId: "weather-service",
        customPaths,
      });
      expect(claudeCodeCopy.client).toBe("claude_code");
      expect(claudeCodeCopy.transport).toBe("sse");
      expect(claudeCodeCopy.url).toBe("https://mcp.weather.gov/sse");

      // 3. Clone to Antigravity with a new ID
      const agyCopy = await manager.cloneServer({
        fromClient: "codex",
        toClient: "antigravity",
        serverId: "weather-service",
        newId: "weather-renamed",
        customPaths,
      });
      expect(agyCopy.client).toBe("antigravity");
      expect(agyCopy.id).toBe("weather-renamed");

      const agyFound = await manager.getServer("weather-renamed", { client: "antigravity", customPaths });
      expect(agyFound).not.toBeNull();
      expect(agyFound!.url).toBe("https://mcp.weather.gov/sse");
    });

    it("throws McpConflictError when target server already exists without overwrite flag", async () => {
      const server1: UnifiedMcpServer = {
        id: "duplicate-id",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "cmd-desktop",
        args: [],
        env: {},
        enabled: true,
      };
      const server2: UnifiedMcpServer = {
        id: "duplicate-id",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "cmd-codex",
        args: [],
        env: {},
        enabled: true,
      };

      await manager.addServer(server1, { customPaths });
      await manager.addServer(server2, { customPaths });

      // Attempt clone without overwrite -> should reject
      await expect(
        manager.cloneServer({
          fromClient: "claude_desktop",
          toClient: "codex",
          serverId: "duplicate-id",
          customPaths,
        }),
      ).rejects.toThrow(McpConflictError);

      // Attempt clone with overwrite: true -> should succeed
      const overwritten = await manager.cloneServer({
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "duplicate-id",
        overwrite: true,
        customPaths,
      });

      expect(overwritten.command).toBe("cmd-desktop");
      const codexCheck = await manager.getServer("duplicate-id", { client: "codex", customPaths });
      expect(codexCheck!.command).toBe("cmd-desktop");
    });

    it("throws McpNotFoundError when source server does not exist", async () => {
      await expect(
        manager.cloneServer({
          fromClient: "claude_desktop",
          toClient: "codex",
          serverId: "non-existent",
          customPaths,
        }),
      ).rejects.toThrow(McpNotFoundError);
    });
  });
});
