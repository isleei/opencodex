import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import type { CustomPathMap } from "../src/mcp/config-manager";

describe("Management MCP REST API (/api/mcp/*)", () => {
  let tempBase: string;
  let mcpCustomPaths: CustomPathMap;
  let baseConfig: OcxConfig;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-mgmt-mcp-test-"));
    mcpCustomPaths = {
      claude_desktop: join(tempBase, "claude_desktop_config.json"),
      claude_code: join(tempBase, "claude.json"),
      codex: join(tempBase, "codex_config.toml"),
      antigravity: join(tempBase, "mcp_config.json"),
    };
    baseConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function dispatchRequest(
    method: string,
    pathname: string,
    body?: unknown,
    searchParams?: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    if (searchParams) {
      for (const [k, v] of Object.entries(searchParams)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      host: "127.0.0.1:10100",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const req = new Request(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const deps: ManagementApiDeps = {
      mcpCustomPaths,
    };

    const res = await handleManagementAPI(req, url, baseConfig, deps);
    if (!res) {
      throw new Error(`Route not handled: ${method} ${pathname}`);
    }

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    return { status: res.status, body: parsed };
  }

  test("GET /api/mcp returns empty server array initially", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/mcp");
    expect(status).toBe(200);
    expect(body).toEqual({ servers: [] });
  });

  test("POST /api/mcp/:client adds servers across all client types", async () => {
    // 1. Claude Desktop (stdio)
    const addDesktopRes = await dispatchRequest("POST", "/api/mcp/claude-desktop", {
      id: "desktop-db",
      command: "sqlite-server",
      args: ["/tmp/app.db"],
      env: { DB_MODE: "ro" },
    });
    expect(addDesktopRes.status).toBe(200);
    expect(addDesktopRes.body.ok).toBe(true);
    expect(addDesktopRes.body.server.id).toBe("desktop-db");
    expect(addDesktopRes.body.server.client).toBe("claude_desktop");

    // 2. Claude Code (stdio)
    const addCodeRes = await dispatchRequest("POST", "/api/mcp/claude-code", {
      id: "code-context",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
    expect(addCodeRes.status).toBe(200);
    expect(addCodeRes.body.server.client).toBe("claude_code");

    // 3. Codex TOML (stdio)
    const addCodexRes = await dispatchRequest("POST", "/api/mcp/codex", {
      id: "codex-memory",
      command: "memory-mcp",
    });
    expect(addCodexRes.status).toBe(200);
    expect(addCodexRes.body.server.client).toBe("codex");

    // 4. Antigravity (remote)
    const addAgRes = await dispatchRequest("POST", "/api/mcp/antigravity", {
      id: "remote-search",
      url: "https://mcp.search.example.com/sse",
    });
    expect(addAgRes.status).toBe(200);
    expect(addAgRes.body.server.client).toBe("antigravity");
    expect(addAgRes.body.server.transport).toBe("sse");

    // List all
    const listRes = await dispatchRequest("GET", "/api/mcp");
    expect(listRes.status).toBe(200);
    expect(listRes.body.servers).toHaveLength(4);
  });

  test("GET /api/mcp/:client lists servers for specific client", async () => {
    await dispatchRequest("POST", "/api/mcp/claude_desktop", {
      id: "srv1",
      command: "echo",
    });
    await dispatchRequest("POST", "/api/mcp/claude_desktop", {
      id: "srv2",
      command: "cat",
    });
    await dispatchRequest("POST", "/api/mcp/codex", {
      id: "srv3",
      command: "ls",
    });

    const desktopRes = await dispatchRequest("GET", "/api/mcp/claude-desktop");
    expect(desktopRes.status).toBe(200);
    expect(desktopRes.body.servers).toHaveLength(2);

    const codexRes = await dispatchRequest("GET", "/api/mcp/codex");
    expect(codexRes.status).toBe(200);
    expect(codexRes.body.servers).toHaveLength(1);
  });

  test("PUT /api/mcp/:client/:id updates server configuration", async () => {
    await dispatchRequest("POST", "/api/mcp/claude_desktop", {
      id: "update-me",
      command: "old-cmd",
      args: ["old-arg"],
    });

    const updateRes = await dispatchRequest("PUT", "/api/mcp/claude_desktop/update-me", {
      command: "new-cmd",
      args: ["new-arg-1", "new-arg-2"],
      env: { KEY: "VAL" },
    });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.ok).toBe(true);
    expect(updateRes.body.server.command).toBe("new-cmd");
    expect(updateRes.body.server.args).toEqual(["new-arg-1", "new-arg-2"]);
    expect(updateRes.body.server.env).toEqual({ KEY: "VAL" });
  });

  test("POST /api/mcp/:client/:id/toggle enables and disables server", async () => {
    await dispatchRequest("POST", "/api/mcp/claude_code", {
      id: "toggle-me",
      command: "cmd",
    });

    // Disable
    const disableRes = await dispatchRequest("POST", "/api/mcp/claude_code/toggle-me/toggle", {
      enabled: false,
    });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.enabled).toBe(false);

    // Re-enable
    const enableRes = await dispatchRequest("POST", "/api/mcp/claude_code/toggle-me/toggle", {
      enabled: true,
    });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.enabled).toBe(true);
  });

  test("DELETE /api/mcp/:client/:id removes server from client config", async () => {
    await dispatchRequest("POST", "/api/mcp/codex", {
      id: "delete-me",
      command: "cmd",
    });

    const deleteRes = await dispatchRequest("DELETE", "/api/mcp/codex/delete-me");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    const listRes = await dispatchRequest("GET", "/api/mcp/codex");
    expect(listRes.body.servers).toHaveLength(0);

    // 404 for non-existent server
    const notFoundRes = await dispatchRequest("DELETE", "/api/mcp/codex/delete-me");
    expect(notFoundRes.status).toBe(404);
  });

  test("POST /api/mcp/clone clones server across clients with format translation", async () => {
    // Add server in Claude Desktop
    await dispatchRequest("POST", "/api/mcp/claude_desktop", {
      id: "shared-server",
      command: "uvx",
      args: ["mcp-server-git"],
      env: { GIT_PATH: "/usr/bin/git" },
    });

    // Clone to Codex
    const cloneRes = await dispatchRequest("POST", "/api/mcp/clone", {
      fromClient: "claude_desktop",
      toClient: "codex",
      serverId: "shared-server",
      newId: "codex-git",
    });

    expect(cloneRes.status).toBe(200);
    expect(cloneRes.body.ok).toBe(true);
    expect(cloneRes.body.created.id).toBe("codex-git");
    expect(cloneRes.body.created.client).toBe("codex");
    expect(cloneRes.body.created.command).toBe("uvx");

    // Verify presence in Codex
    const codexList = await dispatchRequest("GET", "/api/mcp/codex");
    expect(codexList.body.servers.some((s: any) => s.id === "codex-git")).toBe(true);
  });

  test("Error handling for invalid client and duplicate servers", async () => {
    const invalidClient = await dispatchRequest("GET", "/api/mcp/unsupported-client");
    expect(invalidClient.status).toBe(400);

    // Create server
    await dispatchRequest("POST", "/api/mcp/antigravity", {
      id: "unique-server",
      command: "tool",
    });

    // Duplicate without overwrite
    const duplicate = await dispatchRequest("POST", "/api/mcp/antigravity", {
      id: "unique-server",
      command: "tool-v2",
    });
    expect(duplicate.status).toBe(409);
  });
});
