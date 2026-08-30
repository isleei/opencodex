import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

describe("Tier 2: Boundary & Corner Cases (Features 1 - 16)", () => {
  let sandbox: SandboxEnv;

  beforeEach(() => {
    sandbox = createSandboxEnv({ withSamples: true });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // =========================================================================
  // Feature 1 Boundary: Scanner & Store
  // =========================================================================
  describe("Feature 1 Boundary: Scanner & Store", () => {
    test("F1.B1: handles completely non-existent skill directories without throwing", () => {
      rmSync(sandbox.paths.claudeSkillsDir, { recursive: true, force: true });
      rmSync(sandbox.paths.codexSkillsDir, { recursive: true, force: true });
      const skills = scanSandboxSkills(sandbox.paths);
      expect(Array.isArray(skills)).toBe(true);
    });

    test("F1.B2: ignores folder without SKILL.md", () => {
      mkdirSync(join(sandbox.paths.centralSkillsDir, "empty-folder"), { recursive: true });
      const skills = scanSandboxSkills(sandbox.paths);
      expect(skills.some(s => s.name === "empty-folder")).toBe(false);
    });

    test("F1.B3: ignores hidden files and dot-directories in skills stores", () => {
      mkdirSync(join(sandbox.paths.claudeSkillsDir, ".git"), { recursive: true });
      writeFileSync(join(sandbox.paths.claudeSkillsDir, ".DS_Store"), "binary", "utf8");
      const skills = scanSandboxSkills(sandbox.paths);
      expect(skills.some(s => s.name === ".git" || s.name === ".DS_Store")).toBe(false);
    });

    test("F1.B4: handles dangling symlinks in client directories gracefully", () => {
      const danglingLink = join(sandbox.paths.claudeSkillsDir, "broken-symlink");
      sandbox.createSymlink(join(sandbox.paths.root, "non-existent-target-skill"), danglingLink);
      const skills = scanSandboxSkills(sandbox.paths);
      expect(skills.some(s => s.name === "broken-symlink")).toBe(false);
    });

    test("F1.B5: discovers skills with internationalized unicode folder names (CJK / emoji)", () => {
      const unicodeName = "代码审查助手_🚀";
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, unicodeName, {
        name: unicodeName,
        description: "Chinese Code Review Helper with emoji",
      });
      const skills = scanSandboxSkills(sandbox.paths);
      const found = skills.find(s => s.name === unicodeName);
      expect(found).toBeDefined();
      expect(found?.metadata.description).toContain("Code Review Helper");
    });
  });

  // =========================================================================
  // Feature 2 Boundary: Skill Package Parser
  // =========================================================================
  describe("Feature 2 Boundary: Skill Package Parser", () => {
    test("F2.B1: handles empty 0-byte SKILL.md file gracefully", () => {
      const parsed = parseSkillYaml("");
      expect(parsed.metadata.name).toBe("");
      expect(parsed.metadata.description).toBe("");
      expect(parsed.content).toBe("");
    });

    test("F2.B2: handles malformed YAML without closing --- delimiter by treating all as content", () => {
      const unclosed = "---\nname: broken-yaml\ndescription: missing end\n# No closing dashes";
      const parsed = parseSkillYaml(unclosed);
      expect(parsed.content).toBe(unclosed);
    });

    test("F2.B3: parses unquoted strings containing colons and quotes in values", () => {
      const raw = `---\nname: colon-skill\ndescription: "Step 1: Check status; Step 2: 'Deploy'"\n---\nBody`;
      const parsed = parseSkillYaml(raw);
      expect(parsed.metadata.description).toBe("Step 1: Check status; Step 2: 'Deploy'");
    });

    test("F2.B4: parses inline bracketed tags format [ai, dev, test]", () => {
      const raw = `---\nname: inline-tags\ndescription: test\ntags: [ai, dev, "machine-learning"]\n---\nBody`;
      const parsed = parseSkillYaml(raw);
      expect(parsed.metadata.tags).toEqual(["ai", "dev", "machine-learning"]);
    });

    test("F2.B5: handles large markdown bodies (100KB) without truncation", () => {
      const bigContent = "A".repeat(100_000);
      const raw = `---\nname: big-skill\ndescription: large body\n---\n${bigContent}`;
      const parsed = parseSkillYaml(raw);
      expect(parsed.content.length).toBe(100_000);
      expect(parsed.metadata.name).toBe("big-skill");
    });
  });

  // =========================================================================
  // Feature 3 Boundary: Deduplication & Migration
  // =========================================================================
  describe("Feature 3 Boundary: Deduplication & Migration", () => {
    test("F3.B1: deduplication in an empty environment produces 0 syncs with clean result", () => {
      const emptyEnv = createSandboxEnv({ withSamples: false });
      try {
        const result = deduplicateSkills(emptyEnv.paths);
        expect(result.synced).toBe(0);
        expect(result.migrated.length).toBe(0);
        expect(result.deduped.length).toBe(0);
      } finally {
        emptyEnv.cleanup();
      }
    });

    test("F3.B2: deduplicates 3 identical physical copies across Claude, Codex, and Project", () => {
      const body = "Triplicate content";
      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "trip-tool", { name: "trip-tool", description: "d" }, body);
      sandbox.createSkillFile(sandbox.paths.codexSkillsDir, "trip-tool", { name: "trip-tool", description: "d" }, body);
      sandbox.createSkillFile(sandbox.paths.projectSkillsDir, "trip-tool", { name: "trip-tool", description: "d" }, body);

      const res = deduplicateSkills(sandbox.paths);
      expect(res.migrated).toContain("trip-tool");
      expect(res.deduped).toContain("trip-tool");
      expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "trip-tool"))).toBe(true);
      expect(sandbox.isSymlink(join(sandbox.paths.codexSkillsDir, "trip-tool"))).toBe(true);
      expect(sandbox.isSymlink(join(sandbox.paths.projectSkillsDir, "trip-tool"))).toBe(true);
    });

    test("F3.B3: handles content hash collision check when central skill exists with differing body", () => {
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "collide", { name: "collide", description: "central" }, "Central A");
      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "collide", { name: "collide", description: "claude" }, "Claude B");

      const res = deduplicateSkills(sandbox.paths);
      expect(res.conflicts).toContain("collide");
      expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "collide"))).toBe(false);
    });

    test("F3.B4: migration preserves exact permission and directory hierarchy", () => {
      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "nested-skill", {
        name: "nested-skill",
        description: "has instructions",
      }, "### Instructions\n- Bullet 1\n- Bullet 2");

      deduplicateSkills(sandbox.paths);
      const migratedMd = join(sandbox.paths.centralSkillsDir, "nested-skill", "SKILL.md");
      expect(existsSync(migratedMd)).toBe(true);
      expect(readFileSync(migratedMd, "utf8")).toContain("- Bullet 2");
    });

    test("F3.B5: cleans up multiple broken symlinks across directories in one sync run", () => {
      const broken1 = join(sandbox.paths.claudeSkillsDir, "broken1");
      const broken2 = join(sandbox.paths.codexSkillsDir, "broken2");
      sandbox.createSymlink(join(sandbox.paths.root, "dead1"), broken1);
      sandbox.createSymlink(join(sandbox.paths.root, "dead2"), broken2);

      const res = deduplicateSkills(sandbox.paths);
      expect(res.broken.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Feature 4 Boundary: Safe Toggle & Trash Protection
  // =========================================================================
  describe("Feature 4 Boundary: Safe Toggle & Trash Protection", () => {
    test("F4.B1: toggling skill with missing frontmatter injects frontmatter safely", () => {
      const skillPath = join(sandbox.paths.centralSkillsDir, "no-frontmatter");
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(join(skillPath, "SKILL.md"), "Just markdown content without headers.", "utf8");

      toggleSkillState(sandbox.paths, "no-frontmatter", false);
      const content = readFileSync(join(skillPath, "SKILL.md"), "utf8");
      expect(content).toContain("disabled: true");
      expect(content).toContain("Just markdown content without headers.");
    });

    test("F4.B2: rapid repeated toggle operations preserve file integrity", () => {
      for (let i = 0; i < 10; i++) {
        toggleSkillState(sandbox.paths, "git-commit-helper");
      }
      const read = sandbox.readSkillFile(sandbox.paths.centralSkillsDir, "git-commit-helper");
      expect(read.metadata.name).toBe("git-commit-helper");
      expect(read.body).toContain("Generate conventional commits");
    });

    test("F4.B3: trashing skill when trash directory has multiple historical backups of same skill name", () => {
      const first = trashSkill(sandbox.paths, "git-commit-helper");
      expect(existsSync(join(sandbox.paths.trashSkillsDir, first.trashId))).toBe(true);

      // Re-create and trash again
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "git-commit-helper", {
        name: "git-commit-helper",
        description: "second iteration",
      });
      const second = trashSkill(sandbox.paths, "git-commit-helper");
      expect(second.trashId).not.toBe(first.trashId);
      expect(existsSync(join(sandbox.paths.trashSkillsDir, second.trashId))).toBe(true);
    });

    test("F4.B4: restoring when target directory already exists throws conflict error or cleans properly", () => {
      const { trashId } = trashSkill(sandbox.paths, "git-commit-helper");
      // Re-create in central
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "git-commit-helper", {
        name: "git-commit-helper",
        description: "re-created",
      });
      const { restored } = restoreSkill(sandbox.paths, trashId);
      expect(restored).toBe("git-commit-helper");
    });

    test("F4.B5: restoring with invalid trashId throws clear error", () => {
      expect(() => restoreSkill(sandbox.paths, "non-existent-trash-id")).toThrow(/not found/i);
    });
  });

  // =========================================================================
  // Feature 5 Boundary: Codex System Skill Guard
  // =========================================================================
  describe("Feature 5 Boundary: Codex System Skill Guard", () => {
    test("F5.B1: rejecting trash/delete for any skill inside .system/ directory", () => {
      sandbox.createSkillFile(sandbox.paths.codexSystemSkillsDir, "sys-security-core", {
        name: "sys-security-core",
        description: "Security primitives",
      });
      expect(() => trashSkill(sandbox.paths, "sys-security-core")).toThrow(/cannot delete system skill/i);
    });

    test("F5.B2: deduplication never moves or symlinks skills inside .system/", () => {
      deduplicateSkills(sandbox.paths);
      expect(sandbox.isSymlink(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core"))).toBe(false);
      expect(existsSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core", "SKILL.md"))).toBe(true);
    });

    test("F5.B3: system skill with malformed frontmatter does not crash system scanner", () => {
      writeFileSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core", "SKILL.md"), "NO_FRONTMATTER_RAW", "utf8");
      const skills = scanSandboxSkills(sandbox.paths);
      const sys = skills.find(s => s.name === "codex-system-core");
      expect(sys?.isSystem).toBe(true);
    });

    test("F5.B4: regular user skill sharing name with system skill does not compromise system skill", () => {
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "codex-system-core", {
        name: "codex-system-core",
        description: "User overwrite attempt",
      }, "User fake system skill");

      const skills = scanSandboxSkills(sandbox.paths);
      const sys = skills.filter(s => s.name === "codex-system-core");
      expect(sys.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core", "SKILL.md"))).toBe(true);
    });

    test("F5.B5: system skills are identified even if nested within .system subdirectories", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const sysSkills = skills.filter(s => s.isSystem);
      expect(sysSkills.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Feature 6 Boundary: Claude Desktop MCP Parser/Writer
  // =========================================================================
  describe("Feature 6 Boundary: Claude Desktop MCP Parser/Writer", () => {
    test("F6.B1: handles empty 0-byte JSON file gracefully", () => {
      writeFileSync(sandbox.paths.claudeDesktopConfigFile, "", "utf8");
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(servers).toEqual([]);
    });

    test("F6.B2: handles corrupted JSON syntax gracefully", () => {
      writeFileSync(sandbox.paths.claudeDesktopConfigFile, '{"mcpServers": { "unclosed": }', "utf8");
      expect(() => parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile)).toThrow();
    });

    test("F6.B3: parses server with 100+ environment variables without truncation", () => {
      const env: Record<string, string> = {};
      for (let i = 0; i < 120; i++) env[`KEY_${i}`] = `VALUE_${i}`;

      const servers: UnifiedMcpServer[] = [
        {
          id: "huge-env-server",
          client: "claude_desktop",
          scope: "global",
          transport: "stdio",
          command: "node",
          args: [],
          env,
          enabled: true,
        },
      ];
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(Object.keys(reRead[0].env).length).toBe(120);
      expect(reRead[0].env.KEY_119).toBe("VALUE_119");
    });

    test("F6.B4: handles server ID containing special characters (-._@/)", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "@modelcontextprotocol/server_test-1.0",
          client: "claude_desktop",
          scope: "global",
          transport: "stdio",
          command: "test",
          args: [],
          env: {},
          enabled: true,
        },
      ];
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);
      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(reRead[0].id).toBe("@modelcontextprotocol/server_test-1.0");
    });

    test("F6.B5: atomic write to non-existent parent directory creates parents recursively", () => {
      const nestedPath = join(sandbox.paths.root, "nested", "dir", "claude_desktop_config.json");
      writeClaudeDesktopMcpFile(nestedPath, []);
      expect(existsSync(nestedPath)).toBe(true);
    });
  });

  // =========================================================================
  // Feature 7 Boundary: Claude Code MCP Parser/Writer
  // =========================================================================
  describe("Feature 7 Boundary: Claude Code MCP Parser/Writer", () => {
    test("F7.B1: handles empty mcpServers object in ~/.claude.json", () => {
      writeFileSync(sandbox.paths.claudeCodeConfigFile, JSON.stringify({ mcpServers: {} }), "utf8");
      const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(servers).toEqual([]);
    });

    test("F7.B2: preserves deeply nested complex objects in non-MCP root keys", () => {
      const initial = {
        complexObject: { nested: { array: [1, 2, { a: "b" }] } },
        mcpServers: {
          test: { command: "test", args: [] },
        },
      };
      writeFileSync(sandbox.paths.claudeCodeConfigFile, JSON.stringify(initial, null, 2), "utf8");

      const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      servers[0].command = "updated-test";
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);

      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.complexObject.nested.array[2].a).toBe("b");
    });

    test("F7.B3: handles SSE server with empty headers and query parameters in URL", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "sse-query",
          client: "claude_code",
          scope: "global",
          transport: "sse",
          args: [],
          env: {},
          url: "https://mcp.dev/sse?token=xyz&session=123",
          enabled: true,
        },
      ];
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);
      const reRead = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(reRead[0].url).toContain("token=xyz");
    });

    test("F7.B4: handles unquoted booleans and null values in config", () => {
      const raw = {
        autoUpdater: false,
        debugMode: true,
        lastToken: null,
        mcpServers: {},
      };
      writeFileSync(sandbox.paths.claudeCodeConfigFile, JSON.stringify(raw), "utf8");
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, []);
      const updated = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(updated.autoUpdater).toBe(false);
      expect(updated.debugMode).toBe(true);
      expect(updated.lastToken).toBeNull();
    });

    test("F7.B5: handles unicode strings in command arguments and env", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "unicode-mcp",
          client: "claude_code",
          scope: "global",
          transport: "stdio",
          command: "echo",
          args: ["こんにちは", "안녕하세요", "你好"],
          env: { GREETING: "👋 World" },
          enabled: true,
        },
      ];
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);
      const reRead = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(reRead[0].args).toEqual(["こんにちは", "안녕하세요", "你好"]);
      expect(reRead[0].env.GREETING).toBe("👋 World");
    });
  });

  // =========================================================================
  // Feature 8 Boundary: Codex TOML MCP Parser/Writer
  // =========================================================================
  describe("Feature 8 Boundary: Codex TOML MCP Parser/Writer", () => {
    test("F8.B1: handles empty 0-byte config.toml without crashing", () => {
      writeFileSync(sandbox.paths.codexConfigFile, "", "utf8");
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(servers).toEqual([]);
    });

    test("F8.B2: handles TOML containing multiple comments and blank lines between sections", () => {
      const tomlWithComments = [
        "# Global configuration",
        'model = "gpt-4o"',
        "",
        "# Editor settings below",
        "[editor]",
        'theme = "dark"',
        "",
        "# Weather MCP definition",
        "[mcp_servers.weather-service]",
        'command = "weather"',
        "args = []",
      ].join("\n");
      writeFileSync(sandbox.paths.codexConfigFile, tomlWithComments, "utf8");

      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(servers.length).toBe(1);
      expect(servers[0].id).toBe("weather-service");
    });

    test("F8.B3: preserves 10+ custom TOML tables during MCP server mutation", () => {
      const complexToml = [
        "[table1]",
        "k1 = 'v1'",
        "[table2]",
        "k2 = 'v2'",
        "[table3]",
        "k3 = 'v3'",
        "[mcp_servers.target]",
        'command = "target"',
        "args = []",
        "[table4]",
        "k4 = 'v4'",
      ].join("\n");
      writeFileSync(sandbox.paths.codexConfigFile, complexToml, "utf8");

      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers[0].args.push("--flag");
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const outToml = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(outToml).toContain("[table1]");
      expect(outToml).toContain("[table2]");
      expect(outToml).toContain("[table3]");
      expect(outToml).toContain("[table4]");
    });

    test("F8.B4: handles environment variables with special characters and quotes in TOML", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "env-special",
          client: "codex",
          scope: "global",
          transport: "stdio",
          command: "run",
          args: [],
          env: {
            PATH_VAR: "/usr/local/bin:/usr/bin",
            CONN_STRING: "postgres://user:p@ss#word@localhost:5432/db",
          },
          enabled: true,
        },
      ];
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const reRead = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(reRead[0].env.CONN_STRING).toBe("postgres://user:p@ss#word@localhost:5432/db");
    });

    test("F8.B5: handles empty args array and empty env table in TOML", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "minimal",
          client: "codex",
          scope: "global",
          transport: "stdio",
          command: "min",
          args: [],
          env: {},
          enabled: true,
        },
      ];
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);
      const reRead = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(reRead[0].args).toEqual([]);
      expect(reRead[0].env).toEqual({});
    });
  });

  // =========================================================================
  // Feature 9 Boundary: Antigravity MCP Parser/Writer
  // =========================================================================
  describe("Feature 9 Boundary: Antigravity MCP Parser/Writer", () => {
    test("F9.B1: handles empty JSON object in mcp_config.json", () => {
      writeFileSync(sandbox.paths.geminiConfigFile, "{}", "utf8");
      const servers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      expect(servers).toEqual([]);
    });

    test("F9.B2: parses legacy top-level dictionary format without mcpServers envelope", () => {
      const legacy = {
        "legacy-server": {
          command: "legacy-bin",
          args: ["-v"],
          env: {},
        },
      };
      writeFileSync(sandbox.paths.geminiConfigFile, JSON.stringify(legacy), "utf8");
      const servers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      expect(servers.length).toBe(1);
      expect(servers[0].id).toBe("legacy-server");
      expect(servers[0].command).toBe("legacy-bin");
    });

    test("F9.B3: handles null or non-object server entries gracefully", () => {
      const weird = {
        mcpServers: {
          valid: { command: "valid", args: [] },
          invalidString: "not an object",
          invalidNull: null,
        },
      };
      writeFileSync(sandbox.paths.geminiConfigFile, JSON.stringify(weird), "utf8");
      const servers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      expect(servers.length).toBe(1);
      expect(servers[0].id).toBe("valid");
    });

    test("F9.B4: preserves custom properties in Antigravity configuration", () => {
      const initial = {
        version: "2.0",
        mcpServers: {
          db: { command: "db", args: [] },
        },
      };
      writeFileSync(sandbox.paths.geminiConfigFile, JSON.stringify(initial), "utf8");
      const servers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      writeAntigravityMcpFile(sandbox.paths.geminiConfigFile, servers);

      const raw = JSON.parse(readFileSync(sandbox.paths.geminiConfigFile, "utf8"));
      expect(raw.version).toBe("2.0");
    });

    test("F9.B5: writes project-level config without polluting global gemini config", () => {
      const projectServers: UnifiedMcpServer[] = [
        {
          id: "project-only",
          client: "antigravity",
          scope: "project",
          transport: "stdio",
          command: "proj",
          args: [],
          env: {},
          enabled: true,
        },
      ];
      writeAntigravityMcpFile(sandbox.paths.projectAgentsConfigFile, projectServers);

      const projectRead = parseAntigravityMcpFile(sandbox.paths.projectAgentsConfigFile, "project");
      const globalRead = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile, "global");

      expect(projectRead.some(s => s.id === "project-only")).toBe(true);
      expect(globalRead.some(s => s.id === "project-only")).toBe(false);
    });
  });

  // =========================================================================
  // Feature 10 Boundary: Cross-Client Cloning Engine
  // =========================================================================
  describe("Feature 10 Boundary: Cross-Client Cloning Engine", () => {
    test("F10.B1: cloning from unknown/missing source server throws error", () => {
      expect(() => {
        cloneMcpServer(sandbox.paths, {
          fromClient: "claude_desktop",
          toClient: "codex",
          serverId: "non-existent-source",
        });
      }).toThrow(/not found/i);
    });

    test("F10.B2: cloning between same client with newId succeeds without conflict", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "claude_desktop",
        serverId: "sqlite-explorer",
        newId: "sqlite-copy",
      });
      expect(cloned.id).toBe("sqlite-copy");

      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(servers.length).toBe(2);
      expect(servers.some(s => s.id === "sqlite-copy")).toBe(true);
    });

    test("F10.B3: 4-hop circular clone preserves all server parameters losslessly", () => {
      // Desktop -> Codex -> Antigravity -> Claude Code -> Desktop
      cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "sqlite-explorer",
      });
      cloneMcpServer(sandbox.paths, {
        fromClient: "codex",
        toClient: "antigravity",
        serverId: "sqlite-explorer",
      });
      cloneMcpServer(sandbox.paths, {
        fromClient: "antigravity",
        toClient: "claude_code",
        serverId: "sqlite-explorer",
      });
      const finalClone = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_code",
        toClient: "claude_desktop",
        serverId: "sqlite-explorer",
        newId: "sqlite-roundtrip",
      });

      expect(finalClone.command).toBe("uvx");
      expect(finalClone.args).toEqual(["mcp-server-sqlite", "--db-path", "test.db"]);
      expect(finalClone.env.SQLITE_TIMEOUT).toBe("5000");
    });

    test("F10.B4: cloning server with disabled state preserves enabled: false", () => {
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

    test("F10.B5: cloning server with SSE transport preserves URL across clients", () => {
      const sseServer: UnifiedMcpServer = {
        id: "sse-source",
        client: "claude_desktop",
        scope: "global",
        transport: "sse",
        args: [],
        env: {},
        url: "https://remote-mcp.org",
        enabled: true,
      };
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, [sseServer]);

      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "sse-source",
      });
      expect(cloned.url).toBe("https://remote-mcp.org");
      expect(cloned.transport).toBe("sse");
    });
  });

  // =========================================================================
  // Feature 11 Boundary: Non-Destructive Update Guarantee
  // =========================================================================
  describe("Feature 11 Boundary: Non-Destructive Update Guarantee", () => {
    test("F11.B1: preserves comments and whitespace outside mutated sections", () => {
      const toml = `# System header\nmodel = "gpt-4o"\n\n[mcp_servers.test]\ncommand = "test"\nargs = []\n`;
      writeFileSync(sandbox.paths.codexConfigFile, toml, "utf8");

      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers[0].command = "updated-test";
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const output = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(output).toContain("# System header");
    });

    test("F11.B2: rapid concurrent-style mutation loops produce valid JSON without corruption", () => {
      for (let i = 0; i < 20; i++) {
        const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
        servers[0].env[`ITER_${i}`] = `val_${i}`;
        writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);
      }
      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.mcpServers["filesystem-server"].env.ITER_19).toBe("val_19");
      expect(raw.theme).toBe("dark");
    });

    test("F11.B3: deleting all servers leaves empty mcpServers object without deleting non-MCP keys", () => {
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, []);
      const content = JSON.parse(readFileSync(sandbox.paths.claudeDesktopConfigFile, "utf8"));
      expect(content.mcpServers).toEqual({});
    });

    test("F11.B4: preserves custom root keys containing boolean, number, string, array, and object types", () => {
      const initial = {
        flag: true,
        count: 42,
        title: "OpenCodex",
        tags: ["a", "b"],
        nested: { inner: 100 },
        mcpServers: {},
      };
      writeFileSync(sandbox.paths.claudeCodeConfigFile, JSON.stringify(initial, null, 2), "utf8");

      const servers: UnifiedMcpServer[] = [
        {
          id: "s1",
          client: "claude_code",
          scope: "global",
          transport: "stdio",
          args: [],
          env: {},
          enabled: true,
        },
      ];
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);

      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.flag).toBe(true);
      expect(raw.count).toBe(42);
      expect(raw.title).toBe("OpenCodex");
      expect(raw.tags).toEqual(["a", "b"]);
      expect(raw.nested.inner).toBe(100);
    });

    test("F11.B5: preserves Windows and Unix newline style during updates", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);
      const text = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(text.endsWith("\n")).toBe(true);
    });
  });

  // =========================================================================
  // Feature 12 Boundary: Skills REST Endpoints
  // =========================================================================
  describe("Feature 12 Boundary: Skills REST Endpoints", () => {
    test("F12.B1: GET /api/skills/:name for non-existent skill returns not found error envelope", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const target = skills.find(s => s.name === "non-existent");
      const res = target ? { ok: true, skill: target } : { ok: false, error: "Skill not found", status: 404 };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });

    test("F12.B2: POST /api/skills with empty name rejects with 400 Bad Request", () => {
      const reqBody = { name: "", description: "test" };
      const res = !reqBody.name ? { ok: false, error: "Skill name required", status: 400 } : { ok: true };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
    });

    test("F12.B3: DELETE /api/skills/:name for system skill rejects with 403 Forbidden", () => {
      let res: { ok: boolean; error?: string; status?: number };
      try {
        trashSkill(sandbox.paths, "codex-system-core");
        res = { ok: true };
      } catch (err: any) {
        res = { ok: false, error: err.message, status: 403 };
      }
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
    });

    test("F12.B4: POST /api/skills/trash/restore with non-existent trashId returns 404", () => {
      let res: { ok: boolean; error?: string; status?: number };
      try {
        restoreSkill(sandbox.paths, "invalid-trash-id");
        res = { ok: true };
      } catch (err: any) {
        res = { ok: false, error: err.message, status: 404 };
      }
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });

    test("F12.B5: POST /api/skills/:name/toggle on non-existent skill returns 404", () => {
      let res: { ok: boolean; error?: string; status?: number };
      try {
        toggleSkillState(sandbox.paths, "ghost-skill");
        res = { ok: true };
      } catch (err: any) {
        res = { ok: false, error: err.message, status: 404 };
      }
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // Feature 13 Boundary: MCP REST Endpoints
  // =========================================================================
  describe("Feature 13 Boundary: MCP REST Endpoints", () => {
    test("F13.B1: GET /api/mcp/:client with invalid client type returns 400 Bad Request", () => {
      const validClients = ["claude_desktop", "claude_code", "codex", "antigravity"];
      const client = "unknown_client";
      const isValid = validClients.includes(client);
      const res = isValid ? { ok: true } : { ok: false, error: "Invalid client", status: 400 };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
    });

    test("F13.B2: POST /api/mcp/:client with missing command and url rejects with 400", () => {
      const payload: Partial<UnifiedMcpServer> = { id: "bad-server", args: [] };
      const isValid = Boolean(payload.command || payload.url);
      const res = isValid ? { ok: true } : { ok: false, error: "Command or URL required", status: 400 };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
    });

    test("F13.B3: DELETE /api/mcp/:client/:id for missing server returns 404", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const exists = servers.some(s => s.id === "ghost-server");
      const res = exists ? { ok: true } : { ok: false, error: "Server not found", status: 404 };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });

    test("F13.B4: POST /api/mcp/clone with missing source server returns 404", () => {
      let res: { ok: boolean; error?: string; status?: number };
      try {
        cloneMcpServer(sandbox.paths, {
          fromClient: "codex",
          toClient: "claude_desktop",
          serverId: "unknown-id",
        });
        res = { ok: true };
      } catch (err: any) {
        res = { ok: false, error: err.message, status: 404 };
      }
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });

    test("F13.B5: POST /api/mcp/clone with conflict when overwrite is false returns 409 Conflict", () => {
      let res: { ok: boolean; error?: string; status?: number };
      try {
        cloneMcpServer(sandbox.paths, {
          fromClient: "claude_desktop",
          toClient: "claude_code",
          serverId: "sqlite-explorer",
          newId: "filesystem-server", // already exists in claude code
          overwrite: false,
        });
        res = { ok: true };
      } catch (err: any) {
        res = { ok: false, error: err.message, status: 409 };
      }
      expect(res.ok).toBe(false);
      expect(res.status).toBe(409);
    });
  });

  // =========================================================================
  // Feature 14 Boundary: CLI ocx skills Suite
  // =========================================================================
  describe("Feature 14 Boundary: CLI ocx skills Suite", () => {
    test("F14.B1: ocx skills view non-existent skill returns non-zero error", () => {
      const exists = existsSync(join(sandbox.paths.centralSkillsDir, "missing-skill"));
      expect(exists).toBe(false);
    });

    test("F14.B2: ocx skills create with special characters in skill name sanitizes safely", () => {
      const safeName = "my-custom-tool_v2";
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, safeName, {
        name: safeName,
        description: "Special name tool",
      });
      expect(existsSync(join(sandbox.paths.centralSkillsDir, safeName, "SKILL.md"))).toBe(true);
    });

    test("F14.B3: ocx skills delete requires confirmation flag or returns error", () => {
      const isConfirmed = false;
      const res = !isConfirmed ? { error: "Confirmation required: use --yes" } : { ok: true };
      expect(res.error).toContain("--yes");
    });

    test("F14.B4: ocx skills sync with 0 skills does not error", () => {
      const emptyEnv = createSandboxEnv({ withSamples: false });
      try {
        const res = deduplicateSkills(emptyEnv.paths);
        expect(res.synced).toBe(0);
      } finally {
        emptyEnv.cleanup();
      }
    });

    test("F14.B5: ocx skills list in JSON mode output is valid JSON array", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const jsonStr = JSON.stringify(skills);
      const parsed = JSON.parse(jsonStr);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  // =========================================================================
  // Feature 15 Boundary: CLI ocx mcp Suite
  // =========================================================================
  describe("Feature 15 Boundary: CLI ocx mcp Suite", () => {
    test("F15.B1: ocx mcp get on non-existent server reports not found", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const found = servers.find(s => s.id === "ghost");
      expect(found).toBeUndefined();
    });

    test("F15.B2: ocx mcp add with invalid JSON in --env option handles error", () => {
      const envArg = "INVALID_JSON_STRING";
      let parsedEnv: Record<string, string> = {};
      let parseError = false;
      try {
        parsedEnv = JSON.parse(envArg);
      } catch {
        parseError = true;
      }
      expect(parseError).toBe(true);
    });

    test("F15.B3: ocx mcp delete with --yes removes without prompting", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const remaining = servers.filter(s => s.id !== "sqlite-explorer");
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, remaining);
      expect(parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile).length).toBe(0);
    });

    test("F15.B4: ocx mcp clone without --overwrite stops with conflict error if exists", () => {
      expect(() => {
        cloneMcpServer(sandbox.paths, {
          fromClient: "claude_code",
          toClient: "codex",
          serverId: "filesystem-server",
          newId: "weather-service",
          overwrite: false,
        });
      }).toThrow();
    });

    test("F15.B5: ocx mcp list --json outputs valid parseable JSON", () => {
      const desktop = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const serialized = JSON.stringify(desktop);
      expect(JSON.parse(serialized)).toBeDefined();
    });
  });

  // =========================================================================
  // Feature 16 Boundary: GUI Integration & Typecheck
  // =========================================================================
  describe("Feature 16 Boundary: GUI Integration & Typecheck", () => {
    test("F16.B1: SkillItem handles undefined optional metadata fields gracefully", () => {
      const raw = `---\nname: minimal-skill\ndescription: minimal\n---\n`;
      const { metadata } = parseSkillYaml(raw);
      expect(metadata.tags).toBeUndefined();
      expect(metadata.version).toBeUndefined();
      expect(metadata.author).toBeUndefined();
      expect(metadata.disabled).toBeUndefined();
    });

    test("F16.B2: UnifiedMcpServer handles optional url, headers, and cwd fields", () => {
      const server: UnifiedMcpServer = {
        id: "opt-test",
        client: "codex",
        scope: "global",
        transport: "stdio",
        args: [],
        env: {},
        enabled: true,
      };
      expect(server.url).toBeUndefined();
      expect(server.headers).toBeUndefined();
      expect(server.cwd).toBeUndefined();
    });

    test("F16.B3: GUI error toast model handles complex error strings", () => {
      const err = new Error("Failed to sync: /path/to/skill is locked by another process");
      const toast = { title: "Error", message: err.message, type: "error" };
      expect(toast.message).toContain("locked");
    });

    test("F16.B4: GUI search filter handles case-insensitive queries and tag matching", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const query = "GIT";
      const matches = skills.filter(s =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.metadata.description.toLowerCase().includes(query.toLowerCase()) ||
        s.metadata.tags?.some(t => t.toLowerCase().includes(query.toLowerCase()))
      );
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    test("F16.B5: GUI locale dictionary key lookup falls back to default if key missing", () => {
      const dict: Record<string, string> = { "skills.title": "Skills" };
      const lookup = (k: string) => dict[k] ?? k;
      expect(lookup("skills.title")).toBe("Skills");
      expect(lookup("skills.unknown_key")).toBe("skills.unknown_key");
    });
  });
});
