import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpConfigManager,
  addMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
  toggleMcpServer,
  deleteMcpServer,
  cloneMcpServer,
  type CustomPathMap,
} from "../src/mcp/config-manager";
import { withFileLock } from "../src/mcp/locks";
import {
  McpConflictError,
  McpNotFoundError,
  McpValidationError,
  type McpClientType,
  type UnifiedMcpServer,
} from "../src/mcp/types";

describe("MCP Configuration Engine & Facade", () => {
  let tempDir: string;
  let customPaths: CustomPathMap;
  let manager: McpConfigManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ocx-mcp-engine-test-"));
    customPaths = {
      claude_desktop: join(tempDir, "claude_desktop_config.json"),
      claude_code_global: join(tempDir, "global_claude.json"),
      claude_code_project: join(tempDir, "project_claude.json"),
      codex_global: join(tempDir, "global_config.toml"),
      codex_project: join(tempDir, "project_config.toml"),
      antigravity_global: join(tempDir, "global_mcp_config.json"),
      antigravity_project: join(tempDir, "project_mcp_config.json"),
    };
    manager = new McpConfigManager({ customPaths, projectRoot: tempDir });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("CRUD Lifecycle", () => {
    it("performs full add -> get -> update -> toggle -> delete lifecycle across all clients", async () => {
      const clients: McpClientType[] = ["claude_desktop", "claude_code", "codex", "antigravity"];

      for (const client of clients) {
        // 1. Add
        const initial: UnifiedMcpServer = {
          id: `test-server-${client}`,
          client,
          scope: "global",
          transport: "stdio",
          command: "node",
          args: ["./cli.js", "--flag"],
          env: { ENV_VAR: "true" },
          enabled: true,
        };
        const created = await manager.addServer(initial, { customPaths });
        expect(created.id).toBe(`test-server-${client}`);
        expect(created.enabled).toBe(true);

        // 2. Get
        const fetched = await manager.getServer(`test-server-${client}`, { client, customPaths });
        expect(fetched).not.toBeNull();
        expect(fetched!.command).toBe("node");
        expect(fetched!.args).toEqual(["./cli.js", "--flag"]);
        expect(fetched!.env).toEqual({ ENV_VAR: "true" });

        // 3. Update
        const updated = await manager.updateServer(
          `test-server-${client}`,
          {
            args: ["./cli.js", "--new-flag"],
            env: { ENV_VAR: "true", NEW_VAR: "123" },
          },
          { client, customPaths },
        );
        expect(updated.args).toEqual(["./cli.js", "--new-flag"]);
        expect(updated.env).toEqual({ ENV_VAR: "true", NEW_VAR: "123" });

        // 4. Toggle
        const toggled = await manager.toggleServer(`test-server-${client}`, false, { client, customPaths });
        expect(toggled.enabled).toBe(false);

        const fetchedDisabled = await manager.getServer(`test-server-${client}`, { client, customPaths });
        expect(fetchedDisabled!.enabled).toBe(false);

        // 5. Delete
        const deleted = await manager.deleteServer(`test-server-${client}`, { client, customPaths });
        expect(deleted).toBe(true);

        const fetchedAfterDelete = await manager.getServer(`test-server-${client}`, { client, customPaths });
        expect(fetchedAfterDelete).toBeNull();
      }
    });

    it("aggregates list of servers across all clients", async () => {
      await manager.addServer({
        id: "server-1",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "cmd1",
        args: [],
        env: {},
        enabled: true,
      }, { customPaths });

      await manager.addServer({
        id: "server-2",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "cmd2",
        args: [],
        env: {},
        enabled: true,
      }, { customPaths });

      await manager.addServer({
        id: "server-3",
        client: "antigravity",
        scope: "project",
        transport: "sse",
        url: "https://example.com/sse",
        args: [],
        env: {},
        enabled: true,
      }, { customPaths });

      // List all
      const all = await manager.listServers({ customPaths });
      expect(all).toHaveLength(3);

      // Filter by client
      const codexOnly = await manager.listServers({ client: "codex", customPaths });
      expect(codexOnly).toHaveLength(1);
      expect(codexOnly[0].id).toBe("server-2");

      // Filter by scope
      const projectOnly = await manager.listServers({ scope: "project", customPaths });
      expect(projectOnly).toHaveLength(1);
      expect(projectOnly[0].id).toBe("server-3");
    });
  });

  describe("Validation & Integrity Guarantees", () => {
    it("rejects invalid server identifiers", async () => {
      await expect(
        manager.addServer({
          id: "",
          client: "codex",
          scope: "global",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          enabled: true,
        }, { customPaths }),
      ).rejects.toThrow(McpValidationError);

      await expect(
        manager.addServer({
          id: "invalid id with spaces!",
          client: "codex",
          scope: "global",
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          enabled: true,
        }, { customPaths }),
      ).rejects.toThrow(McpValidationError);
    });

    it("rejects stdio server without command", async () => {
      await expect(
        manager.addServer({
          id: "no-cmd",
          client: "claude_code",
          scope: "global",
          transport: "stdio",
          command: "  ",
          args: [],
          env: {},
          enabled: true,
        }, { customPaths }),
      ).rejects.toThrow(McpValidationError);
    });

    it("rejects remote server with invalid URL", async () => {
      await expect(
        manager.addServer({
          id: "bad-url",
          client: "antigravity",
          scope: "global",
          transport: "sse",
          url: "not-a-url",
          args: [],
          env: {},
          enabled: true,
        }, { customPaths }),
      ).rejects.toThrow(McpValidationError);
    });

    it("rejects duplicate server without overwrite flag", async () => {
      const server: UnifiedMcpServer = {
        id: "unique-server",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "cmd",
        args: [],
        env: {},
        enabled: true,
      };

      await manager.addServer(server, { customPaths });

      await expect(manager.addServer(server, { customPaths })).rejects.toThrow(McpConflictError);

      // With overwrite: true -> succeeds
      const overwritten = await manager.addServer({ ...server, command: "cmd-v2" }, { overwrite: true, customPaths });
      expect(overwritten.command).toBe("cmd-v2");
    });

    it("throws McpNotFoundError when updating or deleting non-existent server", async () => {
      await expect(
        manager.updateServer("ghost-server", { command: "cmd" }, { client: "claude_desktop", customPaths }),
      ).rejects.toThrow(McpNotFoundError);

      await expect(
        manager.deleteServer("ghost-server", { client: "claude_desktop", customPaths }),
      ).rejects.toThrow(McpNotFoundError);
    });
  });

  describe("Concurrency & File Locking", () => {
    it("handles concurrent writes cleanly using file locks", async () => {
      const fileToLock = join(tempDir, "shared_resource.json");

      let counter = 0;
      const tasks = Array.from({ length: 10 }, async () => {
        await withFileLock(fileToLock, async () => {
          const current = counter;
          await new Promise((resolve) => setTimeout(resolve, 10));
          counter = current + 1;
        });
      });

      await Promise.all(tasks);
      expect(counter).toBe(10);
    });

    it("concurrently adds distinct MCP servers without file corruption", async () => {
      const tasks = Array.from({ length: 8 }, async (_, index) => {
        const server: UnifiedMcpServer = {
          id: `concurrent-server-${index}`,
          client: "claude_code",
          scope: "global",
          transport: "stdio",
          command: `cmd-${index}`,
          args: [`--arg=${index}`],
          env: { INDEX: String(index) },
          enabled: true,
        };
        return manager.addServer(server, { customPaths });
      });

      await Promise.all(tasks);

      const servers = await manager.listServers({ client: "claude_code", customPaths });
      expect(servers).toHaveLength(8);
      for (let i = 0; i < 8; i++) {
        expect(servers.some((s) => s.id === `concurrent-server-${i}`)).toBe(true);
      }
    });
  });
});
