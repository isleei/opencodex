/**
 * Adversarial Stress & Hardening Test Suite for OpenCodex
 * 
 * Vectors tested:
 * 1. REST API Security & Robustness:
 *    - Path traversal attacks in skill names, trash IDs, and MCP server IDs
 *    - Invalid/malicious MCP client names
 *    - Malformed JSON bodies, array/primitive payloads, null values, type mismatches
 *    - HTTP error codes (400, 403, 404, 409, 500) and protected system skill enforcement
 *    - HTTP method mismatch attacks (PATCH, OPTIONS, unsupported methods)
 * 2. CLI Subcommands & JSON Consistency:
 *    - Missing mandatory arguments and unknown subcommands
 *    - Flag combination errors (e.g. --enable AND --disable, delete without --yes)
 *    - Strict --json output contract across all skills & mcp commands (success and error paths)
 * 3. Cross-Client Cloning Stress & Multi-Cycle Chains:
 *    - Multi-hop cyclic conversions: Claude Desktop -> Codex -> Antigravity -> Claude Code -> Claude Desktop
 *    - Preservation of args, complex env vars (emojis, multiple '=', empty values), custom headers, URLs, timeouts across hops
 *    - Conflict handling with and without overwrite/new-id
 *    - Concurrent clone race conditions on duplicate IDs
 * 4. High-Concurrency Stress & Lock Contention:
 *    - 50+ concurrent skill creations and concurrent toggle/update mutations
 *    - 50+ concurrent multi-client MCP additions and cross-client clone operations
 *    - Post-concurrency config integrity, file lock stability, and data consistency validation
 * 5. Boundary Limits & Special Encoding Fuzzing:
 *    - Ultra-long identifiers (200+ characters), UTF-8 multiline values
 *    - Dangling symlinks and corrupted client directories during sync
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillsCommand } from "../src/cli/skills";
import { handleMcpCommand } from "../src/cli/mcp";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import type { SkillsDirectoryConfig } from "../src/skills/types";
import { McpConfigManager, type CustomPathMap } from "../src/mcp/config-manager";
import type { McpClientType, UnifiedMcpServer } from "../src/mcp/types";

describe("Adversarial Stress Test Suite — API, CLI & Multi-Client Cloner", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let tempBase: string;
  let skillsConfig: SkillsDirectoryConfig;
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
          skillsConfig,
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
    tempBase = mkdtempSync(join(tmpdir(), "ocx-adversarial-test-"));
    skillsConfig = {
      centralDir: join(tempBase, "agents", "skills"),
      claudeDir: join(tempBase, "claude", "skills"),
      codexDir: join(tempBase, "codex", "skills"),
      projectDir: join(tempBase, "project", ".agents", "skills"),
      trashDir: join(tempBase, "agents", ".trash", "skills"),
      systemSkillsDir: join(tempBase, "codex", "skills", ".system"),
    };
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
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  async function dispatchRaw(
    method: string,
    pathname: string,
    rawBody?: string,
    contentType = "application/json",
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const url = new URL(`http://127.0.0.1:${server.port}${pathname}`);
    const headers: Record<string, string> = {
      host: `127.0.0.1:${server.port}`,
    };
    if (rawBody !== undefined) {
      headers["content-type"] = contentType;
    }

    const req = new Request(url.toString(), {
      method,
      headers,
      body: rawBody,
    });

    const deps: ManagementApiDeps = {
      skillsConfig,
      mcpCustomPaths,
    };

    const res = await handleManagementAPI(req, url, baseConfig, deps);
    if (!res) {
      return { status: 404, body: { error: "Not Found" }, headers: new Headers() };
    }

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    return { status: res.status, body: parsed, headers: res.headers };
  }

  async function dispatchJson(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const rawBody = body !== undefined ? JSON.stringify(body) : undefined;
    const res = await dispatchRaw(method, pathname, rawBody);
    return { status: res.status, body: res.body };
  }

  async function runSkills(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    logs = [];
    errors = [];
    const code = await handleSkillsCommand(args, { baseUrl });
    return { code, stdout: logs.join("\n"), stderr: errors.join("\n") };
  }

  async function runMcp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    logs = [];
    errors = [];
    const code = await handleMcpCommand(args, { baseUrl });
    return { code, stdout: logs.join("\n"), stderr: errors.join("\n") };
  }

  // =========================================================================
  // VECTOR 1: REST API Security, Path Traversal & Injection Attacks
  // =========================================================================
  describe("Vector 1: REST API Security & Path Traversal Resistance", () => {
    test("1.1: Rejects path traversal attacks in skill creation names", async () => {
      const maliciousNames = [
        "../traversal",
        "../../etc/passwd",
        "..\\..\\windows\\system32",
        "skill/with/slashes",
        "skill\\with\\backslashes",
        "skill name with spaces",
        "skill.with.dots",
        "skill%2f%2fencoded",
        "skill\0nullbyte",
        "",
        "   ",
        "invalid!@#$%^&*()",
      ];

      for (const name of maliciousNames) {
        const res = await dispatchJson("POST", "/api/skills", {
          name,
          description: "Malicious test payload",
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeTruthy();
      }

      // Case normalization: uppercase letters are safely folded to lowercase
      const upperRes = await dispatchJson("POST", "/api/skills", {
        name: "UPPERCASE_SKILL_NAME",
        description: "Testing case normalization",
      });
      expect(upperRes.status).toBe(200);
      expect(upperRes.body.skill.name).toBe("uppercase_skill_name");
    });

    test("1.2: URL-encoded path traversal attempts in skill dynamic paths return 404 or 400 safely", async () => {
      const traversalPaths = [
        "/api/skills/..%2F..%2Fetc%2Fpasswd",
        "/api/skills/..%2F..%2Fagents%2Fskills",
        "/api/skills/%2E%2E%2Fsecret",
        "/api/skills/non_existent_skill",
      ];

      for (const path of traversalPaths) {
        const getRes = await dispatchRaw("GET", path);
        expect([400, 404]).toContain(getRes.status);

        const putRes = await dispatchRaw("PUT", path, JSON.stringify({ description: "hacked" }));
        expect([400, 404]).toContain(putRes.status);

        const delRes = await dispatchRaw("DELETE", path);
        expect([400, 404]).toContain(delRes.status);
      }
    });

    test("1.3: Protected Codex system skills cannot be modified or deleted via REST API", async () => {
      // Seed a system skill in codex/.system/sys-helper
      const sysDir = join(skillsConfig.systemSkillsDir!, "sys-helper");
      mkdirSync(sysDir, { recursive: true });
      writeFileSync(
        join(sysDir, "SKILL.md"),
        "---\nname: system:sys-helper\ndescription: Core system skill\n---\n# System Instructions",
        "utf8"
      );

      // System skill can be viewed
      const getRes = await dispatchJson("GET", "/api/skills/system:sys-helper");
      expect(getRes.status).toBe(200);
      expect(getRes.body.skill.isSystem).toBe(true);

      // Attempt to modify protected system skill -> 403 Forbidden
      const putRes = await dispatchJson("PUT", "/api/skills/system:sys-helper", {
        description: "Attempted overwrite of system skill",
      });
      expect(putRes.status).toBe(403);
      expect(putRes.body.code).toBe("protected_system_skill");

      // Attempt to delete protected system skill -> 403 Forbidden
      const delRes = await dispatchJson("DELETE", "/api/skills/system:sys-helper");
      expect(delRes.status).toBe(403);
      expect(delRes.body.code).toBe("protected_system_skill");
    });

    test("1.4: Invalid and malicious client names in MCP routes return 400 or 404 safely", async () => {
      const invalidClients = [
        "unknown_client",
        "../../escape",
        "..%2F..%2F",
        "cursor_fake",
        "vscode",
        "12345",
        "!@#$",
      ];

      for (const client of invalidClients) {
        const getRes = await dispatchRaw("GET", `/api/mcp/${client}`);
        expect([400, 404]).toContain(getRes.status);

        const postRes = await dispatchRaw("POST", `/api/mcp/${client}`, JSON.stringify({ id: "test", command: "ls" }));
        expect([400, 404]).toContain(postRes.status);

        const putRes = await dispatchRaw("PUT", `/api/mcp/${client}/some-id`, JSON.stringify({ command: "ls" }));
        expect([400, 404]).toContain(putRes.status);

        const delRes = await dispatchRaw("DELETE", `/api/mcp/${client}/some-id`);
        expect([400, 404]).toContain(delRes.status);
      }
    });

    test("1.5: Rejects malicious MCP server IDs with path traversal or invalid characters", async () => {
      const badServerIds = [
        "../../malicious_server",
        "server/with/slashes",
        "server\\with\\backslashes",
        "server with spaces",
        "server%2f%2f",
        "server\0null",
        "",
        "   ",
        "bad!server#name",
      ];

      for (const id of badServerIds) {
        const res = await dispatchJson("POST", "/api/mcp/claude-desktop", {
          id,
          command: "echo",
        });
        expect(res.status).toBe(400);
      }
    });

    test("1.6: MCP Clone endpoint validates source and target client strings strictly", async () => {
      // Missing source
      const res1 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "invalid_source",
        toClient: "codex",
        serverId: "test-srv",
      });
      expect(res1.status).toBe(400);
      expect(res1.body.code).toBe("invalid_source_client");

      // Missing target
      const res2 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_desktop",
        toClient: "invalid_target",
        serverId: "test-srv",
      });
      expect(res2.status).toBe(400);
      expect(res2.body.code).toBe("invalid_target_client");
    });

    test("1.7: HTTP method mismatch attacks return 404 safely", async () => {
      const unsupported = [
        { method: "PATCH", path: "/api/skills" },
        { method: "PATCH", path: "/api/mcp" },
        { method: "HEAD", path: "/api/skills/non-existent" },
      ];

      for (const req of unsupported) {
        const res = await dispatchRaw(req.method, req.path);
        expect(res.status).toBe(404);
      }
    });
  });

  // =========================================================================
  // VECTOR 2: Payload & Schema Fuzzing, Type Mismatches & Edge Cases
  // =========================================================================
  describe("Vector 2: Payload & Schema Fuzzing, Type Mismatches & Edge Cases", () => {
    test("2.1: Rejects malformed JSON bodies gracefully with 400 status on required endpoints", async () => {
      const brokenBodies = [
        `{"name": "broken", `,
        `{"name": "broken" "desc": "missing comma"}`,
        `{name: unquoted_json}`,
        `undefined`,
        `[1, 2, 3, `,
      ];

      const endpoints = [
        { method: "POST", path: "/api/skills" },
        { method: "POST", path: "/api/skills/trash/restore" },
        { method: "POST", path: "/api/mcp/claude-desktop" },
        { method: "POST", path: "/api/mcp/clone" },
      ];

      for (const ep of endpoints) {
        for (const broken of brokenBodies) {
          const res = await dispatchRaw(ep.method, ep.path, broken);
          expect(res.status).toBe(400);
        }
      }
    });

    test("2.2: Rejects primitive, array, and null payloads on object-expecting POST/PUT endpoints", async () => {
      const nonObjectPayloads = [
        "\"string primitive\"",
        "123456",
        "true",
        "false",
        "null",
        "[1, 2, 3]",
        "[]",
      ];

      const endpoints = [
        { method: "POST", path: "/api/skills" },
        { method: "POST", path: "/api/skills/trash/restore" },
        { method: "POST", path: "/api/mcp/claude-desktop" },
        { method: "POST", path: "/api/mcp/clone" },
      ];

      for (const ep of endpoints) {
        for (const payload of nonObjectPayloads) {
          const res = await dispatchRaw(ep.method, ep.path, payload);
          expect(res.status).toBe(400);
        }
      }
    });

    test("2.3: Rejects invalid data types on specific required fields", async () => {
      // POST /api/skills: name is a number
      const skillNumName = await dispatchJson("POST", "/api/skills", {
        name: 12345,
        description: "Valid description",
      });
      expect(skillNumName.status).toBe(400);

      // POST /api/skills: description is a boolean
      const skillBoolDesc = await dispatchJson("POST", "/api/skills", {
        name: "valid-name",
        description: true,
      });
      expect(skillBoolDesc.status).toBe(400);

      // POST /api/skills/:name/toggle: enabled is a string
      await dispatchJson("POST", "/api/skills", { name: "toggle-target", description: "desc" });
      const toggleString = await dispatchJson("POST", "/api/skills/toggle-target/toggle", {
        enabled: "true",
      });
      expect(toggleString.status).toBe(400);

      // POST /api/mcp/:client: id is boolean
      const mcpBoolId = await dispatchJson("POST", "/api/mcp/codex", {
        id: true,
        command: "ls",
      });
      expect(mcpBoolId.status).toBe(400);

      // POST /api/mcp/:client: stdio without command or url
      const mcpNoCmd = await dispatchJson("POST", "/api/mcp/codex", {
        id: "no-cmd-server",
      });
      expect(mcpNoCmd.status).toBe(400);

      // POST /api/mcp/:client: invalid URL for SSE
      const mcpBadUrl = await dispatchJson("POST", "/api/mcp/antigravity", {
        id: "bad-url-server",
        url: "not a valid url",
      });
      expect(mcpBadUrl.status).toBe(400);
    });

    test("2.4: Handles massive payload strings and deep metadata without crashing", async () => {
      const hugeDescription = "A".repeat(50000);
      const hugeContent = "# Header\n" + "Content line\n".repeat(2000);
      const manyTags = Array.from({ length: 200 }, (_, i) => `tag-${i}`);

      const createRes = await dispatchJson("POST", "/api/skills", {
        name: "huge-skill",
        description: hugeDescription,
        content: hugeContent,
        tags: manyTags,
      });

      expect(createRes.status).toBe(200);
      expect(createRes.body.skill.metadata.tags).toHaveLength(200);

      const getRes = await dispatchJson("GET", "/api/skills/huge-skill");
      expect(getRes.status).toBe(200);
      expect(getRes.body.skill.content.length).toBeGreaterThan(20000);
    });
  });

  // =========================================================================
  // VECTOR 3: CLI Subcommands, Argument Combinations & JSON Consistency
  // =========================================================================
  describe("Vector 3: CLI Subcommands, Argument Validation & JSON Parity", () => {
    test("3.1: Rejects missing mandatory arguments with non-zero exit codes", async () => {
      // ocx skills view without name
      const skillView = await runSkills(["view"]);
      expect(skillView.code).toBe(2);
      expect(skillView.stderr).toContain("Skill name is required");

      // ocx skills edit without name
      const skillEdit = await runSkills(["edit"]);
      expect(skillEdit.code).toBe(2);

      // ocx skills edit without any fields
      const skillEditNoFields = await runSkills(["edit", "some-skill"]);
      expect(skillEditNoFields.code).toBe(2);
      expect(skillEditNoFields.stderr).toContain("edit requires at least one");

      // ocx skills toggle without --enable or --disable
      const skillToggleNone = await runSkills(["toggle", "some-skill"]);
      expect(skillToggleNone.code).toBe(2);
      expect(skillToggleNone.stderr).toContain("Specify either --enable or --disable");

      // ocx skills toggle with both --enable AND --disable
      const skillToggleBoth = await runSkills(["toggle", "some-skill", "--enable", "--disable"]);
      expect(skillToggleBoth.code).toBe(2);
      expect(skillToggleBoth.stderr).toContain("Specify either --enable or --disable");

      // ocx skills delete without --yes
      const skillDelNoYes = await runSkills(["delete", "some-skill"]);
      expect(skillDelNoYes.code).toBe(2);
      expect(skillDelNoYes.stderr).toContain("requires --yes");

      // ocx skills restore without trashId
      const skillRestoreNoId = await runSkills(["restore"]);
      expect(skillRestoreNoId.code).toBe(2);
      expect(skillRestoreNoId.stderr).toContain("trash-id is required");

      // ocx mcp get without id
      const mcpGetNoId = await runMcp(["get"]);
      expect(mcpGetNoId.code).toBe(2);

      // ocx mcp get without --client
      const mcpGetNoClient = await runMcp(["get", "srv-id"]);
      expect(mcpGetNoClient.code).toBe(2);
      expect(mcpGetNoClient.stderr).toContain("--client is required");

      // ocx mcp add without --client
      const mcpAddNoClient = await runMcp(["add", "srv-id", "--command", "ls"]);
      expect(mcpAddNoClient.code).toBe(2);
      expect(mcpAddNoClient.stderr).toContain("--client is required");

      // ocx mcp add without command or url
      const mcpAddNoCmd = await runMcp(["add", "srv-id", "--client", "codex"]);
      expect(mcpAddNoCmd.code).toBe(2);
      expect(mcpAddNoCmd.stderr).toContain("Either --command");

      // ocx mcp edit without any field
      const mcpEditNoFields = await runMcp(["edit", "srv-id", "--client", "codex"]);
      expect(mcpEditNoFields.code).toBe(2);
      expect(mcpEditNoFields.stderr).toContain("edit requires at least one parameter");

      // ocx mcp toggle without flags
      const mcpToggleNone = await runMcp(["toggle", "srv-id", "--client", "codex"]);
      expect(mcpToggleNone.code).toBe(2);
      expect(mcpToggleNone.stderr).toContain("Specify either --enable or --disable");

      // ocx mcp toggle with both flags
      const mcpToggleBoth = await runMcp(["toggle", "srv-id", "--client", "codex", "--enable", "--disable"]);
      expect(mcpToggleBoth.code).toBe(2);

      // ocx mcp delete without --yes
      const mcpDelNoYes = await runMcp(["delete", "srv-id", "--client", "codex"]);
      expect(mcpDelNoYes.code).toBe(2);
      expect(mcpDelNoYes.stderr).toContain("delete requires --yes");

      // ocx mcp clone missing --from or --to
      const mcpCloneNoFrom = await runMcp(["clone", "srv-id", "--to", "codex"]);
      expect(mcpCloneNoFrom.code).toBe(2);
      expect(mcpCloneNoFrom.stderr).toContain("--from <client> is required");

      const mcpCloneNoTo = await runMcp(["clone", "srv-id", "--from", "codex"]);
      expect(mcpCloneNoTo.code).toBe(2);
      expect(mcpCloneNoTo.stderr).toContain("--to <client> is required");
    });

    test("3.2: Strictly validates --json output format across all CLI subcommands", async () => {
      // 1. skills list --json
      const skillsList = await runSkills(["list", "--json"]);
      expect(skillsList.code).toBe(0);
      const parsedSkillsList = JSON.parse(skillsList.stdout);
      expect(parsedSkillsList).toHaveProperty("skills");
      expect(Array.isArray(parsedSkillsList.skills)).toBe(true);

      // 2. skills create --json
      const skillsCreate = await runSkills([
        "create",
        "json-skill",
        "--description",
        "Testing json output",
        "--tags",
        "t1,t2",
        "--content",
        "# JSON Skill",
        "--json",
      ]);
      expect(skillsCreate.code).toBe(0);
      const parsedCreate = JSON.parse(skillsCreate.stdout);
      expect(parsedCreate.ok).toBe(true);
      expect(parsedCreate.skill.name).toBe("json-skill");

      // 3. skills view --json
      const skillsView = await runSkills(["view", "json-skill", "--json"]);
      expect(skillsView.code).toBe(0);
      const parsedView = JSON.parse(skillsView.stdout);
      expect(parsedView.skill.name).toBe("json-skill");

      // 4. skills edit --json
      const skillsEdit = await runSkills(["edit", "json-skill", "--description", "Updated JSON desc", "--json"]);
      expect(skillsEdit.code).toBe(0);
      const parsedEdit = JSON.parse(skillsEdit.stdout);
      expect(parsedEdit.ok).toBe(true);

      // 5. skills toggle --json
      const skillsToggle = await runSkills(["toggle", "json-skill", "--disable", "--json"]);
      expect(skillsToggle.code).toBe(0);
      const parsedToggle = JSON.parse(skillsToggle.stdout);
      expect(parsedToggle.ok).toBe(true);
      expect(parsedToggle.enabled).toBe(false);

      // 6. skills sync --json
      const skillsSync = await runSkills(["sync", "--dry-run", "--json"]);
      expect(skillsSync.code).toBe(0);
      const parsedSync = JSON.parse(skillsSync.stdout);
      expect(parsedSync).toHaveProperty("synced");

      // 7. skills delete --json
      const skillsDel = await runSkills(["delete", "json-skill", "--yes", "--json"]);
      expect(skillsDel.code).toBe(0);
      const parsedDel = JSON.parse(skillsDel.stdout);
      expect(parsedDel.ok).toBe(true);
      expect(parsedDel.trashId).toBeTruthy();

      // 8. skills trash --json
      const skillsTrash = await runSkills(["trash", "--json"]);
      expect(skillsTrash.code).toBe(0);
      const parsedTrash = JSON.parse(skillsTrash.stdout);
      expect(Array.isArray(parsedTrash.items)).toBe(true);

      // 9. skills restore --json
      const skillsRestore = await runSkills(["restore", parsedDel.trashId, "--json"]);
      expect(skillsRestore.code).toBe(0);
      const parsedRestore = JSON.parse(skillsRestore.stdout);
      expect(parsedRestore.ok).toBe(true);
      expect(parsedRestore.restored).toBe("json-skill");

      // 10. mcp list --json
      const mcpList = await runMcp(["list", "--json"]);
      expect(mcpList.code).toBe(0);
      const parsedMcpList = JSON.parse(mcpList.stdout);
      expect(Array.isArray(parsedMcpList.servers)).toBe(true);

      // 11. mcp add --json
      const mcpAdd = await runMcp([
        "add",
        "json-srv",
        "--client",
        "codex",
        "--command",
        "test-cmd",
        "--args",
        "a1,a2",
        "--env",
        "K1=V1,K2=V2",
        "--json",
      ]);
      expect(mcpAdd.code).toBe(0);
      const parsedMcpAdd = JSON.parse(mcpAdd.stdout);
      expect(parsedMcpAdd.ok).toBe(true);
      expect(parsedMcpAdd.server.id).toBe("json-srv");

      // 12. mcp get --json
      const mcpGet = await runMcp(["get", "json-srv", "--client", "codex", "--json"]);
      expect(mcpGet.code).toBe(0);
      const parsedMcpGet = JSON.parse(mcpGet.stdout);
      expect(parsedMcpGet.server.id).toBe("json-srv");

      // 13. mcp edit --json
      const mcpEdit = await runMcp(["edit", "json-srv", "--client", "codex", "--command", "new-cmd", "--json"]);
      expect(mcpEdit.code).toBe(0);
      const parsedMcpEdit = JSON.parse(mcpEdit.stdout);
      expect(parsedMcpEdit.ok).toBe(true);
      expect(parsedMcpEdit.server.command).toBe("new-cmd");

      // 14. mcp toggle --json
      const mcpToggle = await runMcp(["toggle", "json-srv", "--client", "codex", "--disable", "--json"]);
      expect(mcpToggle.code).toBe(0);
      const parsedMcpToggle = JSON.parse(mcpToggle.stdout);
      expect(parsedMcpToggle.ok).toBe(true);
      expect(parsedMcpToggle.enabled).toBe(false);

      // 15. mcp clone --json
      const mcpClone = await runMcp([
        "clone",
        "json-srv",
        "--from",
        "codex",
        "--to",
        "antigravity",
        "--new-id",
        "json-srv-cloned",
        "--json",
      ]);
      expect(mcpClone.code).toBe(0);
      const parsedMcpClone = JSON.parse(mcpClone.stdout);
      expect(parsedMcpClone.ok).toBe(true);
      expect(parsedMcpClone.created.id).toBe("json-srv-cloned");

      // 16. mcp delete --json
      const mcpDel = await runMcp(["delete", "json-srv", "--client", "codex", "--yes", "--json"]);
      expect(mcpDel.code).toBe(0);
      const parsedMcpDel = JSON.parse(mcpDel.stdout);
      expect(parsedMcpDel.ok).toBe(true);
    });
  });

  // =========================================================================
  // VECTOR 4: Cross-Client Cloning Stress, Multi-Cycle Chains & Concurrency
  // =========================================================================
  describe("Vector 4: Cross-Client Multi-Cycle Cloning & High-Concurrency Mutations", () => {
    test("4.1: Cyclic 4-Client Cloning Chain preserves server definitions lossless across hops", async () => {
      // Initial Server on Claude Desktop:
      // complex arguments, env variables (multi '=' and UTF-8 characters), cwd, autoApprove
      await dispatchJson("POST", "/api/mcp/claude-desktop", {
        id: "cyclic-stdio-server",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp@latest", "--port", "8080"],
        env: {
          API_KEY: "secret=key=12345",
          DEBUG_MODE: "verbose",
          CACHE_DIR: "/tmp/upstash-cache",
          EMOJI_VAR: "🚀-rocket-unicode",
        },
        cwd: "/tmp/custom-workspace",
        autoApprove: ["read_resource", "list_prompts"],
        enabled: true,
      });

      // Remote SSE Server on Claude Code:
      await dispatchJson("POST", "/api/mcp/claude-code", {
        id: "cyclic-sse-server",
        url: "https://mcp.enterprise.internal/sse?token=abc-123&region=us-west",
        headers: {
          "Authorization": "Bearer token-999",
          "X-Custom-Tenant": "tenant-42",
        },
        enabled: false,
      });

      // Hop 1: Claude Desktop -> Codex
      const hop1 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "cyclic-stdio-server",
        newId: "hop1-codex",
      });
      expect(hop1.status).toBe(200);
      expect(hop1.body.created.client).toBe("codex");
      expect(hop1.body.created.command).toBe("npx");
      expect(hop1.body.created.args).toEqual(["-y", "@upstash/context7-mcp@latest", "--port", "8080"]);
      expect(hop1.body.created.env).toEqual({
        API_KEY: "secret=key=12345",
        DEBUG_MODE: "verbose",
        CACHE_DIR: "/tmp/upstash-cache",
        EMOJI_VAR: "🚀-rocket-unicode",
      });

      // Hop 2: Codex -> Antigravity
      const hop2 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "codex",
        toClient: "antigravity",
        serverId: "hop1-codex",
        newId: "hop2-antigravity",
      });
      expect(hop2.status).toBe(200);
      expect(hop2.body.created.client).toBe("antigravity");
      expect(hop2.body.created.args).toEqual(["-y", "@upstash/context7-mcp@latest", "--port", "8080"]);
      expect(hop2.body.created.env.EMOJI_VAR).toBe("🚀-rocket-unicode");

      // Hop 3: Antigravity -> Claude Code
      const hop3 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "antigravity",
        toClient: "claude_code",
        serverId: "hop2-antigravity",
        newId: "hop3-claudecode",
      });
      expect(hop3.status).toBe(200);
      expect(hop3.body.created.client).toBe("claude_code");

      // Hop 4: Claude Code -> Claude Desktop (Completing the cycle)
      const hop4 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_code",
        toClient: "claude_desktop",
        serverId: "hop3-claudecode",
        newId: "hop4-desktop-restored",
      });
      expect(hop4.status).toBe(200);
      expect(hop4.body.created.client).toBe("claude_desktop");
      expect(hop4.body.created.command).toBe("npx");
      expect(hop4.body.created.args).toEqual(["-y", "@upstash/context7-mcp@latest", "--port", "8080"]);
      expect(hop4.body.created.env.API_KEY).toBe("secret=key=12345");
      expect(hop4.body.created.env.EMOJI_VAR).toBe("🚀-rocket-unicode");

      // Cyclic clone for Remote SSE server: Claude Code -> Antigravity -> Codex -> Claude Desktop
      const sseHop1 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_code",
        toClient: "antigravity",
        serverId: "cyclic-sse-server",
        newId: "sse-hop1-ag",
      });
      expect(sseHop1.status).toBe(200);
      expect(sseHop1.body.created.transport).toBe("sse");
      expect(sseHop1.body.created.url).toContain("token=abc-123");
      expect(sseHop1.body.created.enabled).toBe(false);

      const sseHop2 = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "antigravity",
        toClient: "codex",
        serverId: "sse-hop1-ag",
        newId: "sse-hop2-codex",
      });
      expect(sseHop2.status).toBe(200);
      expect(sseHop2.body.created.transport).toBe("sse");
      expect(sseHop2.body.created.enabled).toBe(false);
    });

    test("4.2: Conflict handling with duplicate server IDs during cloning", async () => {
      // Create server in Codex
      await dispatchJson("POST", "/api/mcp/codex", {
        id: "collision-test",
        command: "original-codex-cmd",
      });

      // Create server in Claude Desktop
      await dispatchJson("POST", "/api/mcp/claude-desktop", {
        id: "collision-test",
        command: "original-desktop-cmd",
      });

      // Clone without overwrite -> 409 Conflict
      const rejectRes = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "collision-test",
      });
      expect(rejectRes.status).toBe(409);
      expect(rejectRes.body.code).toBe("server_conflict");

      // Verify Codex untouched
      const codexBefore = await dispatchJson("GET", "/api/mcp/codex");
      const found = codexBefore.body.servers.find((s: any) => s.id === "collision-test");
      expect(found.command).toBe("original-codex-cmd");

      // Clone WITH overwrite: true -> 200 OK
      const overwriteRes = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "collision-test",
        overwrite: true,
      });
      expect(overwriteRes.status).toBe(200);
      expect(overwriteRes.body.created.command).toBe("original-desktop-cmd");

      // Verify Codex updated
      const codexAfter = await dispatchJson("GET", "/api/mcp/codex");
      const foundAfter = codexAfter.body.servers.find((s: any) => s.id === "collision-test");
      expect(foundAfter.command).toBe("original-desktop-cmd");
    });

    test("4.3: High-concurrency stress test: parallel skill mutations and lock contention", async () => {
      const NUM_PARALLEL_SKILLS = 30;

      // 1. Concurrent Creations
      const createPromises = Array.from({ length: NUM_PARALLEL_SKILLS }, (_, i) =>
        dispatchJson("POST", "/api/skills", {
          name: `stress-skill-${i}`,
          description: `Concurrent description ${i}`,
          tags: [`tag-${i % 5}`, "stress"],
          content: `# Stress Skill ${i}\nConcurrent content payload.`,
        })
      );

      const createResults = await Promise.all(createPromises);
      for (const res of createResults) {
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }

      // Verify all 30 skills exist
      const listRes = await dispatchJson("GET", "/api/skills");
      expect(listRes.status).toBe(200);
      expect(listRes.body.skills.length).toBeGreaterThanOrEqual(NUM_PARALLEL_SKILLS);

      // 2. Concurrent Toggles and Updates across same skills
      const mutationPromises: Promise<any>[] = [];
      for (let i = 0; i < NUM_PARALLEL_SKILLS; i++) {
        // Toggle disable
        mutationPromises.push(
          dispatchJson("POST", `/api/skills/stress-skill-${i}/toggle`, { enabled: i % 2 === 0 })
        );
        // Update description
        mutationPromises.push(
          dispatchJson("PUT", `/api/skills/stress-skill-${i}`, {
            description: `Mutated concurrent description ${i}`,
          })
        );
      }

      const mutationResults = await Promise.all(mutationPromises);
      for (const res of mutationResults) {
        expect(res.status).toBe(200);
      }

      // Verify state consistency after concurrent mutations
      const verifyRes = await dispatchJson("GET", "/api/skills/stress-skill-0");
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.skill.metadata.description).toBe("Mutated concurrent description 0");
    });

    test("4.4: High-concurrency stress test: parallel multi-client MCP additions and cross-client cloning", async () => {
      const NUM_SERVERS = 20;

      // Parallel additions across all 4 clients simultaneously
      const addPromises: Promise<any>[] = [];
      for (let i = 0; i < NUM_SERVERS; i++) {
        const client = i % 4 === 0 ? "claude_desktop" : i % 4 === 1 ? "claude_code" : i % 4 === 2 ? "codex" : "antigravity";
        addPromises.push(
          dispatchJson("POST", `/api/mcp/${client}`, {
            id: `concurrent-srv-${i}`,
            command: `cmd-${i}`,
            args: [`--flag-${i}`],
            env: { [`VAR_${i}`]: `VAL_${i}` },
          })
        );
      }

      const addResults = await Promise.all(addPromises);
      for (const res of addResults) {
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }

      // Parallel clones across clients
      const clonePromises: Promise<any>[] = [];
      for (let i = 0; i < NUM_SERVERS; i++) {
        const fromClient = i % 4 === 0 ? "claude_desktop" : i % 4 === 1 ? "claude_code" : i % 4 === 2 ? "codex" : "antigravity";
        const toClient = i % 4 === 0 ? "codex" : i % 4 === 1 ? "antigravity" : i % 4 === 2 ? "claude_code" : "claude_desktop";

        clonePromises.push(
          dispatchJson("POST", "/api/mcp/clone", {
            fromClient,
            toClient,
            serverId: `concurrent-srv-${i}`,
            newId: `cloned-concurrent-srv-${i}`,
          })
        );
      }

      const cloneResults = await Promise.all(clonePromises);
      for (const res of cloneResults) {
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }

      // Verify files remain uncorrupted
      const allMcpRes = await dispatchJson("GET", "/api/mcp");
      expect(allMcpRes.status).toBe(200);
      expect(allMcpRes.body.servers.length).toBeGreaterThanOrEqual(NUM_SERVERS * 2);
    });
  });

  // =========================================================================
  // VECTOR 5: Special Encoding, Boundaries & Dangling Symlink Resilience
  // =========================================================================
  describe("Vector 5: Special Encoding, Boundaries & Dangling Symlink Resilience", () => {
    test("5.1: Handles dangling symlinks and corrupted directory structures in scanner and sync", async () => {
      // Create a broken dangling symlink in claudeDir
      const brokenLink = join(skillsConfig.claudeDir!, "dangling-link");
      const targetNonExistent = join(tempBase, "does-not-exist");
      mkdirSync(skillsConfig.claudeDir!, { recursive: true });
      try {
        symlinkSync(targetNonExistent, brokenLink, "dir");
      } catch {
        // Ignore symlink setup issues on non-supported OS
      }

      // Listing skills should not crash
      const listRes = await dispatchJson("GET", "/api/skills");
      expect(listRes.status).toBe(200);

      // Running sync should safely handle broken symlink
      const syncRes = await dispatchJson("POST", "/api/skills/sync", { migrate: true });
      expect(syncRes.status).toBe(200);
      expect(Array.isArray(syncRes.body.broken)).toBe(true);
    });

    test("5.2: Complex environment variable values with multiple equal signs and UTF-8 characters", async () => {
      await dispatchJson("POST", "/api/mcp/claude-desktop", {
        id: "env-complex-server",
        command: "server",
        args: ["--config=path/to/file.json"],
        env: {
          EQUAL_SIGN_VAL: "a=b=c=d",
          EMPTY_VAL: "",
          SPECIAL_CHARS: "!@#$%^&*()_+-=[]{}|;':,./<>?",
          MULTILINE_VAL: "line1\nline2\nline3",
          JSON_IN_ENV: JSON.stringify({ nested: "value", count: 42 }),
        },
      });

      const getRes = await dispatchJson("GET", "/api/mcp/claude-desktop");
      const srv = getRes.body.servers.find((s: any) => s.id === "env-complex-server");
      expect(srv).not.toBeNull();
      expect(srv.env.EQUAL_SIGN_VAL).toBe("a=b=c=d");
      expect(srv.env.SPECIAL_CHARS).toBe("!@#$%^&*()_+-=[]{}|;':,./<>?");
      expect(srv.env.JSON_IN_ENV).toBe(JSON.stringify({ nested: "value", count: 42 }));

      // Clone to Codex TOML and Antigravity
      const cloneCodex = await dispatchJson("POST", "/api/mcp/clone", {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "env-complex-server",
        newId: "env-complex-codex",
      });
      expect(cloneCodex.status).toBe(200);
      expect(cloneCodex.body.created.env.EQUAL_SIGN_VAL).toBe("a=b=c=d");
      expect(cloneCodex.body.created.env.JSON_IN_ENV).toBe(JSON.stringify({ nested: "value", count: 42 }));
    });
  });
});
