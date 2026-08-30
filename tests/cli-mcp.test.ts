import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcpCommand } from "../src/cli/mcp";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import type { CustomPathMap } from "../src/mcp/config-manager";

describe("ocx mcp CLI", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let tempBase: string;
  let mcpCustomPaths: CustomPathMap;
  let baseConfig: OcxConfig;

  let logs: string[] = [];
  let errors: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const deps: ManagementApiDeps = {
          mcpCustomPaths,
        };
        const res = await handleManagementAPI(req, url, baseConfig, deps);
        if (res) return res;
        return new Response("Not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-cli-mcp-test-"));
    mcpCustomPaths = {
      claude_desktop: join(tempBase, "claude_desktop_config.json"),
      claude_code: join(tempBase, "claude.json"),
      codex: join(tempBase, "codex_config.toml"),
      antigravity: join(tempBase, "mcp_config.json"),
    };
    baseConfig = {
      port: server.port,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };

    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function runMcp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    logs = [];
    errors = [];
    const code = await handleMcpCommand(args, { baseUrl });
    return {
      code,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  }

  test("1: mcp list on clean config", async () => {
    const human = await runMcp(["list"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("No MCP servers configured.");

    const json = await runMcp(["list", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ servers: [] });
  });

  test("2: mcp add creates servers and formats table", async () => {
    const addDesktop = await runMcp([
      "add",
      "sqlite",
      "--client",
      "claude-desktop",
      "--command",
      "sqlite-server",
      "--args",
      "/tmp/db.sqlite",
      "--env",
      "READONLY=1,MODE=fast",
    ]);

    expect(addDesktop.code).toBe(0);
    expect(addDesktop.stdout).toContain('Added MCP server "sqlite" to client "claude_desktop".');

    const addCodex = await runMcp([
      "add",
      "memory",
      "--client",
      "codex",
      "--command",
      "npx",
      "--args",
      "-y,@modelcontextprotocol/server-memory",
    ]);
    expect(addCodex.code).toBe(0);

    // List all
    const listRes = await runMcp(["list"]);
    expect(listRes.code).toBe(0);
    expect(listRes.stdout).toContain("CLIENT");
    expect(listRes.stdout).toContain("sqlite");
    expect(listRes.stdout).toContain("memory");
    expect(listRes.stdout).toContain("claude_desktop");
    expect(listRes.stdout).toContain("codex");

    // List filtered by client
    const listDesktop = await runMcp(["list", "--client", "claude-desktop", "--json"]);
    expect(listDesktop.code).toBe(0);
    const parsed = JSON.parse(listDesktop.stdout);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].id).toBe("sqlite");
  });

  test("3: mcp get returns detailed server configuration", async () => {
    await runMcp([
      "add",
      "inspectable",
      "--client",
      "claude_code",
      "--command",
      "test-tool",
      "--args",
      "arg1,arg2",
      "--env",
      "FOO=bar",
    ]);

    const getHuman = await runMcp(["get", "inspectable", "--client", "claude-code"]);
    expect(getHuman.code).toBe(0);
    expect(getHuman.stdout).toContain("ID:          inspectable");
    expect(getHuman.stdout).toContain("Client:      claude_code");
    expect(getHuman.stdout).toContain("Command:     test-tool");
    expect(getHuman.stdout).toContain("Args:        arg1 arg2");
    expect(getHuman.stdout).toContain("Env:         FOO=bar");

    const getJson = await runMcp(["get", "inspectable", "--client", "claude-code", "--json"]);
    expect(getJson.code).toBe(0);
    const parsed = JSON.parse(getJson.stdout);
    expect(parsed.server.id).toBe("inspectable");
    expect(parsed.server.args).toEqual(["arg1", "arg2"]);
  });

  test("4: mcp edit updates server configuration", async () => {
    await runMcp([
      "add",
      "editable",
      "--client",
      "antigravity",
      "--command",
      "old-tool",
    ]);

    const editRes = await runMcp([
      "edit",
      "editable",
      "--client",
      "antigravity",
      "--command",
      "new-tool",
      "--args",
      "new-arg",
    ]);
    expect(editRes.code).toBe(0);
    expect(editRes.stdout).toContain('Updated MCP server "editable" in client "antigravity".');

    const getRes = await runMcp(["get", "editable", "--client", "antigravity", "--json"]);
    const parsed = JSON.parse(getRes.stdout);
    expect(parsed.server.command).toBe("new-tool");
    expect(parsed.server.args).toEqual(["new-arg"]);
  });

  test("5: mcp toggle enables and disables server", async () => {
    await runMcp([
      "add",
      "toggleable",
      "--client",
      "codex",
      "--command",
      "srv",
    ]);

    const disableRes = await runMcp(["toggle", "toggleable", "--client", "codex", "--disable"]);
    expect(disableRes.code).toBe(0);
    expect(disableRes.stdout).toContain('MCP server "toggleable" in "codex" is now disabled.');

    const enableRes = await runMcp(["toggle", "toggleable", "--client", "codex", "--enable"]);
    expect(enableRes.code).toBe(0);
    expect(enableRes.stdout).toContain('MCP server "toggleable" in "codex" is now enabled.');
  });

  test("6: mcp delete requires --yes and deletes server", async () => {
    await runMcp([
      "add",
      "deletable",
      "--client",
      "claude_desktop",
      "--command",
      "srv",
    ]);

    const noYes = await runMcp(["delete", "deletable", "--client", "claude_desktop"]);
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain("delete requires --yes");

    const delRes = await runMcp(["delete", "deletable", "--client", "claude_desktop", "--yes"]);
    expect(delRes.code).toBe(0);

    const listRes = await runMcp(["list", "--client", "claude_desktop", "--json"]);
    const parsed = JSON.parse(listRes.stdout);
    expect(parsed.servers).toHaveLength(0);
  });

  test("7: mcp clone copies server definition to another client", async () => {
    await runMcp([
      "add",
      "source-srv",
      "--client",
      "claude_desktop",
      "--command",
      "npx",
      "--args",
      "-y,my-mcp",
    ]);

    const cloneRes = await runMcp([
      "clone",
      "source-srv",
      "--from",
      "claude_desktop",
      "--to",
      "antigravity",
      "--new-id",
      "cloned-srv",
    ]);

    expect(cloneRes.code).toBe(0);
    expect(cloneRes.stdout).toContain('Cloned MCP server "source-srv" from "claude_desktop" to "antigravity" as "cloned-srv".');

    const getRes = await runMcp(["get", "cloned-srv", "--client", "antigravity", "--json"]);
    expect(getRes.code).toBe(0);
    const parsed = JSON.parse(getRes.stdout);
    expect(parsed.server.id).toBe("cloned-srv");
    expect(parsed.server.client).toBe("antigravity");
  });

  test("8: error handling for missing arguments", async () => {
    const unknown = await runMcp(["unknown-sub"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown mcp subcommand");

    const noClient = await runMcp(["add", "srv", "--command", "cmd"]);
    expect(noClient.code).toBe(2);
    expect(noClient.stderr).toContain("--client is required");
  });
});
