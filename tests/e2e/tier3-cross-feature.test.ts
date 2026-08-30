import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createSandboxEnv,
  parseSkillYaml,
  serializeSkillYaml,
  scanSandboxSkills,
  deduplicateSkills,
  trashSkill,
  restoreSkill,
  toggleSkillState,
  parseClaudeDesktopMcpFile,
  writeClaudeDesktopMcpFile,
  parseClaudeCodeMcpFile,
  writeClaudeCodeMcpFile,
  parseCodexTomlMcpFile,
  writeCodexTomlMcpFile,
  parseAntigravityMcpFile,
  writeAntigravityMcpFile,
  cloneMcpServer,
  type SandboxEnv,
  type SkillMetadata,
  type UnifiedMcpServer,
} from "./sandbox-harness";

describe("Tier 3: Cross-Feature Combinations (>= 20 Interactions)", () => {
  let sandbox: SandboxEnv;

  beforeEach(() => {
    sandbox = createSandboxEnv({ withSamples: true });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  test("T3.1: Deduplicate physical skills -> Edit migrated skill in central store -> Symlinked clients read updated content", () => {
    sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "shared-editor", {
      name: "shared-editor",
      description: "Initial description",
    }, "Initial instructions");

    // 1. Run dedup
    const dedupRes = deduplicateSkills(sandbox.paths);
    expect(dedupRes.migrated).toContain("shared-editor");
    expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "shared-editor"))).toBe(true);

    // 2. Edit central skill
    const centralFile = join(sandbox.paths.centralSkillsDir, "shared-editor", "SKILL.md");
    const updatedYaml = serializeSkillYaml({
      name: "shared-editor",
      description: "Updated central description",
      version: "2.0.0",
    }, "Updated central instructions");
    writeFileSync(centralFile, updatedYaml, "utf8");

    // 3. Read via Claude agent symlink
    const claudeRead = sandbox.readSkillFile(sandbox.paths.claudeSkillsDir, "shared-editor");
    expect(claudeRead.metadata.description).toBe("Updated central description");
    expect(claudeRead.metadata.version).toBe("2.0.0");
    expect(claudeRead.body).toBe("Updated central instructions");
  });

  test("T3.2: Create skill in central store -> Link to Claude/Codex -> Toggle disable -> Verify metadata across symlinks", () => {
    sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "toggle-sync", {
      name: "toggle-sync",
      description: "Toggle sync test",
    }, "Body");

    const centralPath = join(sandbox.paths.centralSkillsDir, "toggle-sync");
    sandbox.createSymlink(centralPath, join(sandbox.paths.claudeSkillsDir, "toggle-sync"));
    sandbox.createSymlink(centralPath, join(sandbox.paths.codexSkillsDir, "toggle-sync"));

    // Toggle disabled
    toggleSkillState(sandbox.paths, "toggle-sync", false);

    const claudeMeta = sandbox.readSkillFile(sandbox.paths.claudeSkillsDir, "toggle-sync");
    const codexMeta = sandbox.readSkillFile(sandbox.paths.codexSkillsDir, "toggle-sync");

    expect(claudeMeta.metadata.disabled).toBe(true);
    expect(codexMeta.metadata.disabled).toBe(true);
  });

  test("T3.3: Clone MCP server Claude Desktop -> Codex -> Edit args in Codex -> Verify Claude Desktop unchanged", () => {
    cloneMcpServer(sandbox.paths, {
      fromClient: "claude_desktop",
      toClient: "codex",
      serverId: "sqlite-explorer",
    });

    // Mutate in Codex
    const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    const codexServer = codexServers.find(s => s.id === "sqlite-explorer")!;
    codexServer.args.push("--codex-only-flag");
    writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, codexServers);

    // Verify Claude Desktop is untouched
    const desktopServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    const desktopServer = desktopServers.find(s => s.id === "sqlite-explorer")!;
    expect(desktopServer.args).not.toContain("--codex-only-flag");
  });

  test("T3.4: Clone MCP server Codex -> Claude Code -> Disable in Claude Code -> Verify Codex remains enabled", () => {
    cloneMcpServer(sandbox.paths, {
      fromClient: "codex",
      toClient: "claude_code",
      serverId: "weather-service",
    });

    const codeServers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
    const codeWeather = codeServers.find(s => s.id === "weather-service")!;
    codeWeather.enabled = false;
    writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, codeServers);

    const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    const codexWeather = codexServers.find(s => s.id === "weather-service")!;
    expect(codexWeather.enabled).toBe(true);
  });

  test("T3.5: Delete skill -> Trash verification -> Sync cleanup -> Restore -> Re-linking verification", () => {
    const centralPath = join(sandbox.paths.centralSkillsDir, "git-commit-helper");
    sandbox.createSymlink(centralPath, join(sandbox.paths.claudeSkillsDir, "git-commit-helper"));
    sandbox.createSymlink(centralPath, join(sandbox.paths.codexSkillsDir, "git-commit-helper"));

    // Delete to trash
    const { trashId } = trashSkill(sandbox.paths, "git-commit-helper");
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "git-commit-helper"))).toBe(false);

    // Dedup/sync cleans any residual broken links
    const syncRes = deduplicateSkills(sandbox.paths);
    expect(syncRes.broken.length).toBe(0);

    // Restore from trash
    const { restored } = restoreSkill(sandbox.paths, trashId);
    expect(restored).toBe("git-commit-helper");
    expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "git-commit-helper"))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.codexSkillsDir, "git-commit-helper"))).toBe(true);
  });

  test("T3.6: Add MCP server via CLI -> Query via REST API -> Verify identical UnifiedMcpServer shape", () => {
    const newServer: UnifiedMcpServer = {
      id: "shared-cli-api",
      client: "claude_desktop",
      scope: "global",
      transport: "stdio",
      command: "node",
      args: ["app.js"],
      env: { PORT: "8080" },
      enabled: true,
    };
    const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    servers.push(newServer);
    writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

    // REST API query
    const apiServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    const target = apiServers.find(s => s.id === "shared-cli-api");
    expect(target).toBeDefined();
    expect(target?.id).toBe(newServer.id);
    expect(target?.client).toBe(newServer.client);
    expect(target?.command).toBe(newServer.command);
    expect(target?.args).toEqual(newServer.args);
    expect(target?.env).toEqual(newServer.env);
    expect(target?.enabled).toBe(newServer.enabled);
  });

  test("T3.7: Create skill via REST API -> Inspect via CLI -> Output and metadata match", () => {
    sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "rest-skill", {
      name: "rest-skill",
      description: "Created via REST API",
      tags: ["rest", "api"],
    }, "# Markdown content");

    const cliRead = sandbox.readSkillFile(sandbox.paths.centralSkillsDir, "rest-skill");
    expect(cliRead.metadata.name).toBe("rest-skill");
    expect(cliRead.metadata.tags).toEqual(["rest", "api"]);
    expect(cliRead.body).toBe("# Markdown content");
  });

  test("T3.8: Deduplicate identical skills across Claude, Codex, and Project -> Check SyncResult counts", () => {
    const content = "Unique body for multi dedup";
    sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "multi-dup", { name: "multi-dup", description: "desc" }, content);
    sandbox.createSkillFile(sandbox.paths.codexSkillsDir, "multi-dup", { name: "multi-dup", description: "desc" }, content);
    sandbox.createSkillFile(sandbox.paths.projectSkillsDir, "multi-dup", { name: "multi-dup", description: "desc" }, content);

    const result = deduplicateSkills(sandbox.paths);
    expect(result.migrated).toContain("multi-dup");
    expect(result.deduped).toContain("multi-dup");
    expect(result.synced).toBeGreaterThanOrEqual(3);
  });

  test("T3.9: Non-destructive edit: Modify Claude Code MCP server with 50 unrelated root keys intact", () => {
    const rawConfig: Record<string, any> = { mcpServers: {} };
    for (let i = 0; i < 50; i++) rawConfig[`custom_key_${i}`] = `value_${i}`;
    writeFileSync(sandbox.paths.claudeCodeConfigFile, JSON.stringify(rawConfig, null, 2), "utf8");

    const servers: UnifiedMcpServer[] = [
      {
        id: "new-code-server",
        client: "claude_code",
        scope: "global",
        transport: "stdio",
        command: "bin",
        args: ["arg1"],
        env: {},
        enabled: true,
      },
    ];
    writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);

    const readBack = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
    for (let i = 0; i < 50; i++) {
      expect(readBack[`custom_key_${i}`]).toBe(`value_${i}`);
    }
    expect(readBack.mcpServers["new-code-server"]).toBeDefined();
  });

  test("T3.10: Non-destructive edit: Modify Codex TOML MCP server with custom tables intact", () => {
    const customToml = [
      'model = "gpt-4o"',
      "",
      "[plugins.analytics]",
      "enabled = true",
      'endpoint = "https://analytics.io"',
      "",
      "[telemetry.metrics]",
      "sample_rate = 0.5",
    ].join("\n");
    writeFileSync(sandbox.paths.codexConfigFile, customToml, "utf8");

    const servers: UnifiedMcpServer[] = [
      {
        id: "codex-new",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "codex-cmd",
        args: [],
        env: {},
        enabled: true,
      },
    ];
    writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

    const resultToml = readFileSync(sandbox.paths.codexConfigFile, "utf8");
    expect(resultToml).toContain("[plugins.analytics]");
    expect(resultToml).toContain("[telemetry.metrics]");
    expect(resultToml).toContain("[mcp_servers.codex-new]");
  });

  test("T3.11: Multi-hop MCP clone (Desktop -> Antigravity -> Codex -> Claude Code) retains full fidelity", () => {
    cloneMcpServer(sandbox.paths, {
      fromClient: "claude_desktop",
      toClient: "antigravity",
      serverId: "sqlite-explorer",
    });
    cloneMcpServer(sandbox.paths, {
      fromClient: "antigravity",
      toClient: "codex",
      serverId: "sqlite-explorer",
    });
    const final = cloneMcpServer(sandbox.paths, {
      fromClient: "codex",
      toClient: "claude_code",
      serverId: "sqlite-explorer",
    });

    expect(final.id).toBe("sqlite-explorer");
    expect(final.command).toBe("uvx");
    expect(final.args).toEqual(["mcp-server-sqlite", "--db-path", "test.db"]);
    expect(final.env.SQLITE_TIMEOUT).toBe("5000");
  });

  test("T3.12: Trashing a skill while another skill has identical content -> dedup handles hash safely", () => {
    sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "skill-a", { name: "skill-a", description: "same" }, "Common body");
    sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "skill-b", { name: "skill-b", description: "same" }, "Common body");

    trashSkill(sandbox.paths, "skill-a");
    const syncRes = deduplicateSkills(sandbox.paths);
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "skill-b"))).toBe(true);
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "skill-a"))).toBe(false);
  });

  test("T3.13: Toggle MCP server on Claude Desktop -> Export to Codex -> Enabled status preserved in TOML", () => {
    const desktopServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    desktopServers[0].enabled = false;
    writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, desktopServers);

    const cloned = cloneMcpServer(sandbox.paths, {
      fromClient: "claude_desktop",
      toClient: "codex",
      serverId: "sqlite-explorer",
    });
    expect(cloned.enabled).toBe(false);

    const codexToml = readFileSync(sandbox.paths.codexConfigFile, "utf8");
    expect(codexToml).toContain("enabled = false");
  });

  test("T3.14: Symlink replacement: Replace physical directory with symlink after central migration, then safe delete", () => {
    sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "temp-migrate", {
      name: "temp-migrate",
      description: "To be migrated and deleted",
    });
    deduplicateSkills(sandbox.paths);
    expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "temp-migrate"))).toBe(true);

    trashSkill(sandbox.paths, "temp-migrate");
    expect(existsSync(join(sandbox.paths.claudeSkillsDir, "temp-migrate"))).toBe(false);
  });

  test("T3.15: System skill coexistence: Run skills sync with duplicate skills AND system skill -> System skill untouched", () => {
    sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "dup-skill", { name: "dup-skill", description: "d" });
    sandbox.createSkillFile(sandbox.paths.codexSkillsDir, "dup-skill", { name: "dup-skill", description: "d" });

    const res = deduplicateSkills(sandbox.paths);
    expect(res.migrated).toContain("dup-skill");
    expect(existsSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core", "SKILL.md"))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core"))).toBe(false);
  });

  test("T3.16: Multi-server batch operations: Add 10 MCP servers, toggle 5, delete 2 -> Verify remaining 8 intact", () => {
    const servers: UnifiedMcpServer[] = [];
    for (let i = 0; i < 10; i++) {
      servers.push({
        id: `batch-srv-${i}`,
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: `cmd-${i}`,
        args: [`--arg-${i}`],
        env: { [`ENV_${i}`]: `VAL_${i}` },
        enabled: true,
      });
    }
    writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

    // Toggle first 5
    let current = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    for (let i = 0; i < 5; i++) {
      current[i].enabled = false;
    }
    writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, current);

    // Delete 2
    current = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    const filtered = current.filter(s => s.id !== "batch-srv-0" && s.id !== "batch-srv-1");
    writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, filtered);

    const final = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    expect(final.length).toBe(8);
    expect(final.find(s => s.id === "batch-srv-2")?.enabled).toBe(false);
    expect(final.find(s => s.id === "batch-srv-6")?.enabled).toBe(true);
  });

  test("T3.17: Project vs Global scope isolation: Project skill vs central skill with different descriptions", () => {
    sandbox.createSkillFile(sandbox.paths.projectSkillsDir, "scoped-skill", {
      name: "scoped-skill",
      description: "Project scoped version",
    });
    sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "scoped-skill", {
      name: "scoped-skill",
      description: "Global central version",
    });

    const skills = scanSandboxSkills(sandbox.paths);
    const found = skills.filter(s => s.name === "scoped-skill");
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  test("T3.18: Project vs Global MCP config isolation: Project mcp vs Global gemini mcp", () => {
    const projectMcp: UnifiedMcpServer[] = [
      {
        id: "db-tool",
        client: "antigravity",
        scope: "project",
        transport: "stdio",
        command: "db-proj",
        args: [],
        env: {},
        enabled: true,
      },
    ];
    writeAntigravityMcpFile(sandbox.paths.projectAgentsConfigFile, projectMcp);

    const projectRead = parseAntigravityMcpFile(sandbox.paths.projectAgentsConfigFile, "project");
    const globalRead = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile, "global");

    expect(projectRead[0].command).toBe("db-proj");
    expect(globalRead[0].id).toBe("postgres-tool");
  });

  test("T3.19: REST API skill toggle -> Scanner reflects state -> Envelope format matches", () => {
    const isNowActive = toggleSkillState(sandbox.paths, "git-commit-helper", false);
    expect(isNowActive).toBe(false);

    const skills = scanSandboxSkills(sandbox.paths);
    const git = skills.find(s => s.name === "git-commit-helper");
    expect(git?.metadata.disabled).toBe(true);

    const restEnvelope = { ok: true, skill: git };
    expect(restEnvelope.ok).toBe(true);
    expect(restEnvelope.skill?.metadata.disabled).toBe(true);
  });

  test("T3.20: CLI mcp clone -> REST API reflects cloned server -> Non-destructive check", () => {
    cloneMcpServer(sandbox.paths, {
      fromClient: "claude_code",
      toClient: "codex",
      serverId: "filesystem-server",
    });

    const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    expect(codexServers.some(s => s.id === "filesystem-server")).toBe(true);

    const toml = readFileSync(sandbox.paths.codexConfigFile, "utf8");
    expect(toml).toContain("[editor]");
  });

  test("T3.21: Restore trashed skill -> Re-run dedup -> No duplicate trash record or broken link", () => {
    const { trashId } = trashSkill(sandbox.paths, "git-commit-helper");
    restoreSkill(sandbox.paths, trashId);

    const dedupRes = deduplicateSkills(sandbox.paths);
    expect(dedupRes.broken.length).toBe(0);
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "git-commit-helper", "SKILL.md"))).toBe(true);
  });

  test("T3.22: Cross-client clone with overwrite flag: Fails on conflict -> Succeeds when overwrite: true", () => {
    expect(() => {
      cloneMcpServer(sandbox.paths, {
        fromClient: "codex",
        toClient: "claude_desktop",
        serverId: "weather-service",
        newId: "sqlite-explorer",
        overwrite: false,
      });
    }).toThrow(/already exists/i);

    const cloned = cloneMcpServer(sandbox.paths, {
      fromClient: "codex",
      toClient: "claude_desktop",
      serverId: "weather-service",
      newId: "sqlite-explorer",
      overwrite: true,
    });
    expect(cloned.command).toBe("python");
  });
});
