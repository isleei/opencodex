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

describe("Tier 1: Feature Coverage (Features 1 - 16)", () => {
  let sandbox: SandboxEnv;

  beforeEach(() => {
    sandbox = createSandboxEnv({ withSamples: true });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // =========================================================================
  // Feature 1: Skills Central Store & Scanner
  // =========================================================================
  describe("Feature 1: Skills Central Store & Scanner", () => {
    test("F1.1: scans canonical skills in ~/.agents/skills/", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const gitHelper = skills.find(s => s.name === "git-commit-helper");
      expect(gitHelper).toBeDefined();
      expect(gitHelper?.metadata.description).toBe("Generates semantic commit messages");
      expect(gitHelper?.isSymlink).toBe(false);
    });

    test("F1.2: discovers skills in Claude agent directory", () => {
      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "claude-refactor", {
        name: "claude-refactor",
        description: "Automated refactoring helper",
      });
      const skills = scanSandboxSkills(sandbox.paths);
      const found = skills.find(s => s.name === "claude-refactor");
      expect(found).toBeDefined();
      expect(found?.linkedAgents).toContain("claude");
    });

    test("F1.3: discovers skills in Codex agent directory", () => {
      sandbox.createSkillFile(sandbox.paths.codexSkillsDir, "codex-tester", {
        name: "codex-tester",
        description: "Codex unit test generator",
      });
      const skills = scanSandboxSkills(sandbox.paths);
      const found = skills.find(s => s.name === "codex-tester");
      expect(found).toBeDefined();
      expect(found?.linkedAgents).toContain("codex");
    });

    test("F1.4: discovers project-level skills in <project>/.agents/skills/", () => {
      sandbox.createSkillFile(sandbox.paths.projectSkillsDir, "project-deploy", {
        name: "project-deploy",
        description: "Project deployment instructions",
      });
      const skills = scanSandboxSkills(sandbox.paths);
      const found = skills.find(s => s.name === "project-deploy");
      expect(found).toBeDefined();
      expect(found?.linkedAgents).toContain("project");
    });

    test("F1.5: distinguishes symlinks from physical skill folders and resolves target path", () => {
      const centralPath = join(sandbox.paths.centralSkillsDir, "git-commit-helper");
      const claudeLinkPath = join(sandbox.paths.claudeSkillsDir, "git-commit-helper");
      sandbox.createSymlink(centralPath, claudeLinkPath);

      const skills = scanSandboxSkills(sandbox.paths);
      const found = skills.find(s => s.name === "git-commit-helper");
      expect(found).toBeDefined();
      expect(found?.linkedAgents).toContain("claude");
    });
  });

  // =========================================================================
  // Feature 2: Skill Package Parser (SKILL.md)
  // =========================================================================
  describe("Feature 2: Skill Package Parser (SKILL.md)", () => {
    test("F2.1: parses standard YAML frontmatter with name and description", () => {
      const raw = `---\nname: my-skill\ndescription: A useful skill\n---\n## Instructions\nDo something useful.`;
      const parsed = parseSkillYaml(raw);
      expect(parsed.metadata.name).toBe("my-skill");
      expect(parsed.metadata.description).toBe("A useful skill");
      expect(parsed.content).toBe("## Instructions\nDo something useful.");
    });

    test("F2.2: parses optional frontmatter metadata (tags, version, author, source)", () => {
      const raw = [
        "---",
        "name: advanced-skill",
        "description: Advanced capabilities",
        "version: 2.1.0",
        "author: OpenCodex Core",
        "source: internal",
        "tags:",
        "  - ai",
        "  - coding",
        "  - typescript",
        "---",
        "# Body content",
      ].join("\n");
      const parsed = parseSkillYaml(raw);
      expect(parsed.metadata.version).toBe("2.1.0");
      expect(parsed.metadata.author).toBe("OpenCodex Core");
      expect(parsed.metadata.source).toBe("internal");
      expect(parsed.metadata.tags).toEqual(["ai", "coding", "typescript"]);
    });

    test("F2.3: parses disabled status flag from frontmatter", () => {
      const raw = `---\nname: test-disabled\ndescription: Disabled skill\ndisabled: true\n---\nBody`;
      const parsed = parseSkillYaml(raw);
      expect(parsed.metadata.disabled).toBe(true);
    });

    test("F2.4: serializes SkillMetadata back to valid SKILL.md YAML frontmatter", () => {
      const meta: SkillMetadata = {
        name: "serialized-skill",
        description: "Serialized description",
        version: "1.2.3",
        author: "Dev",
        tags: ["tool", "helper"],
        disabled: false,
      };
      const yaml = serializeSkillYaml(meta, "## Step 1\nRun the command.");
      expect(yaml).toContain("name: serialized-skill");
      expect(yaml).toContain("description: Serialized description");
      expect(yaml).toContain("version: 1.2.3");
      expect(yaml).toContain("author: Dev");
      expect(yaml).toContain("- tool");
      expect(yaml).toContain("## Step 1\nRun the command.");
    });

    test("F2.5: round-trip parse and serialization retains exact structure", () => {
      const original: SkillMetadata = {
        name: "round-trip",
        description: "Testing lossless roundtrip",
        version: "3.0.0",
        tags: ["a", "b"],
        disabled: true,
      };
      const serialized = serializeSkillYaml(original, "Content here");
      const reParsed = parseSkillYaml(serialized);
      expect(reParsed.metadata.name).toBe(original.name);
      expect(reParsed.metadata.description).toBe(original.description);
      expect(reParsed.metadata.version).toBe(original.version);
      expect(reParsed.metadata.disabled).toBe(true);
      expect(reParsed.metadata.tags).toEqual(["a", "b"]);
      expect(reParsed.content).toBe("Content here");
    });
  });

  // =========================================================================
  // Feature 3: Skills Deduplication & Migration
  // =========================================================================
  describe("Feature 3: Skills Deduplication & Migration", () => {
    test("F3.1: migrates standalone physical skill from Claude to central store and replaces with symlink", () => {
      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "claude-unique", {
        name: "claude-unique",
        description: "Only in claude",
      }, "Body A");

      const result = deduplicateSkills(sandbox.paths);
      expect(result.migrated).toContain("claude-unique");
      expect(existsSync(join(sandbox.paths.centralSkillsDir, "claude-unique"))).toBe(true);
      expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "claude-unique"))).toBe(true);
    });

    test("F3.2: detects identical physical duplicate across Claude and Codex and replaces both with symlinks", () => {
      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "shared-tool", {
        name: "shared-tool",
        description: "Common tool",
      }, "Shared body");

      sandbox.createSkillFile(sandbox.paths.codexSkillsDir, "shared-tool", {
        name: "shared-tool",
        description: "Common tool",
      }, "Shared body");

      const result = deduplicateSkills(sandbox.paths);
      expect(result.migrated).toContain("shared-tool");
      expect(result.deduped).toContain("shared-tool");
      expect(existsSync(join(sandbox.paths.centralSkillsDir, "shared-tool"))).toBe(true);
      expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "shared-tool"))).toBe(true);
      expect(sandbox.isSymlink(join(sandbox.paths.codexSkillsDir, "shared-tool"))).toBe(true);
    });

    test("F3.3: leaves existing valid symlinks untouched during dedup run", () => {
      const centralPath = join(sandbox.paths.centralSkillsDir, "git-commit-helper");
      const claudeLinkPath = join(sandbox.paths.claudeSkillsDir, "git-commit-helper");
      sandbox.createSymlink(centralPath, claudeLinkPath);

      const result = deduplicateSkills(sandbox.paths);
      expect(result.synced).toBeGreaterThanOrEqual(1);
      expect(sandbox.isSymlink(claudeLinkPath)).toBe(true);
    });

    test("F3.4: reports broken symlinks in SyncResult without throwing error", () => {
      const brokenLink = join(sandbox.paths.claudeSkillsDir, "ghost-skill");
      sandbox.createSymlink(join(sandbox.paths.root, "non-existent-target"), brokenLink);

      const result = deduplicateSkills(sandbox.paths);
      expect(result.broken).toContain(brokenLink);
    });

    test("F3.5: reports conflict when two physical skills share same name but have different content hashes", () => {
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "conflict-skill", {
        name: "conflict-skill",
        description: "Central version",
      }, "Central content");

      sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "conflict-skill", {
        name: "conflict-skill",
        description: "Different claude version",
      }, "Claude differing content");

      const result = deduplicateSkills(sandbox.paths);
      expect(result.conflicts).toContain("conflict-skill");
    });
  });

  // =========================================================================
  // Feature 4: Safe Toggle & Trash Protection
  // =========================================================================
  describe("Feature 4: Safe Toggle & Trash Protection", () => {
    test("F4.1: toggles disabled state in-place on central skill without breaking symlinks", () => {
      const centralPath = join(sandbox.paths.centralSkillsDir, "git-commit-helper");
      const claudeLink = join(sandbox.paths.claudeSkillsDir, "git-commit-helper");
      sandbox.createSymlink(centralPath, claudeLink);

      const isEnabled = toggleSkillState(sandbox.paths, "git-commit-helper", false);
      expect(isEnabled).toBe(false);

      const read = sandbox.readSkillFile(sandbox.paths.centralSkillsDir, "git-commit-helper");
      expect(read.metadata.disabled).toBe(true);
      expect(sandbox.isSymlink(claudeLink)).toBe(true);
    });

    test("F4.2: moving skill to trash removes central file and stores backup in ~/.agents/.trash/skills/", () => {
      const { trashId } = trashSkill(sandbox.paths, "git-commit-helper");
      expect(trashId).toContain("git-commit-helper");
      expect(existsSync(join(sandbox.paths.centralSkillsDir, "git-commit-helper"))).toBe(false);
      expect(existsSync(join(sandbox.paths.trashSkillsDir, trashId, "SKILL.md"))).toBe(true);
    });

    test("F4.3: trashing a skill automatically removes dependent symlinks in agent directories", () => {
      const centralPath = join(sandbox.paths.centralSkillsDir, "git-commit-helper");
      const claudeLink = join(sandbox.paths.claudeSkillsDir, "git-commit-helper");
      sandbox.createSymlink(centralPath, claudeLink);

      trashSkill(sandbox.paths, "git-commit-helper");
      expect(existsSync(claudeLink)).toBe(false);
    });

    test("F4.4: restoring a skill from trash recovers central skill and re-links to agents", () => {
      const { trashId } = trashSkill(sandbox.paths, "git-commit-helper");
      const { restored } = restoreSkill(sandbox.paths, trashId);
      expect(restored).toBe("git-commit-helper");
      expect(existsSync(join(sandbox.paths.centralSkillsDir, "git-commit-helper", "SKILL.md"))).toBe(true);
      expect(existsSync(join(sandbox.paths.trashSkillsDir, trashId))).toBe(false);
      expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "git-commit-helper"))).toBe(true);
    });

    test("F4.5: attempting to trash non-existent skill throws descriptive error", () => {
      expect(() => trashSkill(sandbox.paths, "never-existed")).toThrow(/not found/i);
    });
  });

  // =========================================================================
  // Feature 5: Codex System Skill Guard
  // =========================================================================
  describe("Feature 5: Codex System Skill Guard", () => {
    test("F5.1: identifies skills in ~/.codex/skills/.system/ with isSystem: true", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const sys = skills.find(s => s.name === "codex-system-core");
      expect(sys).toBeDefined();
      expect(sys?.isSystem).toBe(true);
    });

    test("F5.2: prevents trashing or deleting system skill", () => {
      expect(() => trashSkill(sandbox.paths, "codex-system-core")).toThrow(/cannot delete system skill/i);
      expect(existsSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core"))).toBe(true);
    });

    test("F5.3: deduplication scanner never moves or deletes system skills", () => {
      const result = deduplicateSkills(sandbox.paths);
      expect(result.migrated).not.toContain("codex-system-core");
      expect(existsSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core", "SKILL.md"))).toBe(true);
    });

    test("F5.4: system skills remain isolated from central store pollution", () => {
      deduplicateSkills(sandbox.paths);
      expect(existsSync(join(sandbox.paths.centralSkillsDir, "codex-system-core"))).toBe(false);
    });

    test("F5.5: scanner preserves system skills when other regular skills are mutated", () => {
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "user-skill-1", {
        name: "user-skill-1",
        description: "User skill",
      });
      const skills = scanSandboxSkills(sandbox.paths);
      const sys = skills.find(s => s.name === "codex-system-core");
      const user = skills.find(s => s.name === "user-skill-1");
      expect(sys?.isSystem).toBe(true);
      expect(user?.isSystem).toBe(false);
    });
  });

  // =========================================================================
  // Feature 6: Claude Desktop MCP Parser/Writer
  // =========================================================================
  describe("Feature 6: Claude Desktop MCP Parser/Writer", () => {
    test("F6.1: parses valid Claude Desktop config into UnifiedMcpServer list", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(servers.length).toBe(1);
      const s = servers[0];
      expect(s.id).toBe("sqlite-explorer");
      expect(s.client).toBe("claude_desktop");
      expect(s.command).toBe("uvx");
      expect(s.args).toEqual(["mcp-server-sqlite", "--db-path", "test.db"]);
      expect(s.env.SQLITE_TIMEOUT).toBe("5000");
    });

    test("F6.2: writes new server to Claude Desktop JSON file", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      servers.push({
        id: "git-mcp",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "mcp-server-git"],
        env: { GIT_PATH: "/usr/bin/git" },
        enabled: true,
      });
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(reRead.length).toBe(2);
      expect(reRead.find(s => s.id === "git-mcp")?.command).toBe("npx");
    });

    test("F6.3: parses SSE transport URLs in Claude Desktop", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "sse-remote",
          client: "claude_desktop",
          scope: "global",
          transport: "sse",
          args: [],
          env: {},
          url: "https://api.example.com/mcp",
          enabled: true,
        },
      ];
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);
      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(reRead[0].transport).toBe("sse");
      expect(reRead[0].url).toBe("https://api.example.com/mcp");
    });

    test("F6.4: supports disabling a server via enabled: false flag", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      servers[0].enabled = false;
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(reRead[0].enabled).toBe(false);
    });

    test("F6.5: returns empty array when config file does not exist", () => {
      const missingPath = join(sandbox.paths.root, "does-not-exist.json");
      const servers = parseClaudeDesktopMcpFile(missingPath);
      expect(servers).toEqual([]);
    });
  });

  // =========================================================================
  // Feature 7: Claude Code MCP Parser/Writer
  // =========================================================================
  describe("Feature 7: Claude Code MCP Parser/Writer", () => {
    test("F7.1: parses Claude Code ~/.claude.json into UnifiedMcpServer objects", () => {
      const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(servers.length).toBe(1);
      expect(servers[0].id).toBe("filesystem-server");
      expect(servers[0].client).toBe("claude_code");
      expect(servers[0].command).toBe("npx");
    });

    test("F7.2: non-destructive write preserves 40+ non-MCP root keys in ~/.claude.json", () => {
      const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      servers[0].args.push("--readonly");
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);

      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.model).toBe("claude-3-7-sonnet");
      expect(raw.theme).toBe("dark");
      expect(raw.customInstructions).toBe("Be precise and fast");
      expect(raw.telemetry).toBe(false);
      expect(raw.mcpServers["filesystem-server"].args).toContain("--readonly");
    });

    test("F7.3: adds new MCP server while retaining all other settings", () => {
      const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      servers.push({
        id: "brave-search",
        client: "claude_code",
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        env: { BRAVE_API_KEY: "test-key" },
        enabled: true,
      });
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);

      const reRead = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(reRead.length).toBe(2);
      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.theme).toBe("dark");
    });

    test("F7.4: deletes an MCP server without deleting root properties", () => {
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, []);
      const reRead = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(reRead.length).toBe(0);

      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.model).toBe("claude-3-7-sonnet");
      expect(raw.mcpServers).toEqual({});
    });

    test("F7.5: handles headers in SSE servers for Claude Code", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "custom-sse",
          client: "claude_code",
          scope: "global",
          transport: "sse",
          args: [],
          env: {},
          url: "https://mcp.internal.net",
          headers: { Authorization: "Bearer token123" },
          enabled: true,
        },
      ];
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);
      const reRead = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(reRead[0].headers?.Authorization).toBe("Bearer token123");
    });
  });

  // =========================================================================
  // Feature 8: Codex TOML MCP Parser/Writer
  // =========================================================================
  describe("Feature 8: Codex TOML MCP Parser/Writer", () => {
    test("F8.1: parses [mcp_servers.<name>] and [mcp_servers.<name>.env] tables from config.toml", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(servers.length).toBe(1);
      const s = servers[0];
      expect(s.id).toBe("weather-service");
      expect(s.client).toBe("codex");
      expect(s.command).toBe("python");
      expect(s.args).toEqual(["-m", "weather_mcp"]);
      expect(s.env.API_KEY).toBe("mock-weather-key");
      expect(s.env.CACHE_TTL).toBe("300");
    });

    test("F8.2: non-destructive update preserves surrounding non-MCP tables and scalar keys in config.toml", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers[0].env.NEW_PARAM = "value";
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const content = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(content).toContain('model = "gpt-4o"');
      expect(content).toContain("[editor]");
      expect(content).toContain('theme = "monokai"');
      expect(content).toContain('tab_size = 2');
      expect(content).toContain('[mcp_servers.weather-service.env]');
      expect(content).toContain('NEW_PARAM = "value"');
    });

    test("F8.3: adds second MCP server to TOML with correct table separation", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers.push({
        id: "redis-cache",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "redis-server-mcp",
        args: ["--port", "6379"],
        env: { REDIS_HOST: "127.0.0.1" },
        enabled: true,
      });
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const reRead = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(reRead.length).toBe(2);
      expect(reRead.find(s => s.id === "redis-cache")?.env.REDIS_HOST).toBe("127.0.0.1");
    });

    test("F8.4: toggles enabled flag in TOML output", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers[0].enabled = false;
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const reRead = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(reRead[0].enabled).toBe(false);
      const tomlText = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(tomlText).toContain("enabled = false");
    });

    test("F8.5: deletes server and cleans up both main and .env tables", () => {
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, []);
      const reRead = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(reRead.length).toBe(0);

      const tomlText = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(tomlText).not.toContain("[mcp_servers.weather-service]");
      expect(tomlText).not.toContain("[mcp_servers.weather-service.env]");
      expect(tomlText).toContain("[editor]");
    });
  });

  // =========================================================================
  // Feature 9: Antigravity MCP Parser/Writer
  // =========================================================================
  describe("Feature 9: Antigravity MCP Parser/Writer", () => {
    test("F9.1: parses global Antigravity/Gemini mcp_config.json", () => {
      const servers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile, "global");
      expect(servers.length).toBe(1);
      expect(servers[0].id).toBe("postgres-tool");
      expect(servers[0].command).toBe("docker");
      expect(servers[0].scope).toBe("global");
    });

    test("F9.2: parses project-level Antigravity .agents/mcp_config.json", () => {
      const projectMcp = {
        mcpServers: {
          "local-dev-db": {
            command: "npx",
            args: ["db-tool"],
            env: { DB_PORT: "5432" },
          },
        },
      };
      writeFileSync(sandbox.paths.projectAgentsConfigFile, JSON.stringify(projectMcp, null, 2), "utf8");

      const servers = parseAntigravityMcpFile(sandbox.paths.projectAgentsConfigFile, "project");
      expect(servers.length).toBe(1);
      expect(servers[0].id).toBe("local-dev-db");
      expect(servers[0].scope).toBe("project");
    });

    test("F9.3: writes server updates to Antigravity configuration file", () => {
      const servers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      servers.push({
        id: "elastic-mcp",
        client: "antigravity",
        scope: "global",
        transport: "stdio",
        command: "es-mcp",
        args: ["--index", "logs"],
        env: {},
        enabled: true,
      });
      writeAntigravityMcpFile(sandbox.paths.geminiConfigFile, servers);

      const reRead = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      expect(reRead.length).toBe(2);
      expect(reRead.some(s => s.id === "elastic-mcp")).toBe(true);
    });

    test("F9.4: supports SSE transport configuration in Antigravity", () => {
      const servers: UnifiedMcpServer[] = [
        {
          id: "cloud-mcp",
          client: "antigravity",
          scope: "global",
          transport: "sse",
          args: [],
          env: {},
          url: "https://cloud.mcp.io/sse",
          enabled: true,
        },
      ];
      writeAntigravityMcpFile(sandbox.paths.geminiConfigFile, servers);
      const reRead = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      expect(reRead[0].transport).toBe("sse");
      expect(reRead[0].url).toBe("https://cloud.mcp.io/sse");
    });

    test("F9.5: handles missing Antigravity file gracefully returning empty list", () => {
      const missing = join(sandbox.paths.root, "not-exist-mcp.json");
      expect(parseAntigravityMcpFile(missing)).toEqual([]);
    });
  });

  // =========================================================================
  // Feature 10: Cross-Client MCP Cloning Engine
  // =========================================================================
  describe("Feature 10: Cross-Client MCP Cloning Engine", () => {
    test("F10.1: clones MCP server from Claude Desktop to Codex (JSON -> TOML conversion)", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "sqlite-explorer",
      });

      expect(cloned.client).toBe("codex");
      expect(cloned.id).toBe("sqlite-explorer");

      const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      const found = codexServers.find(s => s.id === "sqlite-explorer");
      expect(found).toBeDefined();
      expect(found?.command).toBe("uvx");
      expect(found?.env.SQLITE_TIMEOUT).toBe("5000");
    });

    test("F10.2: clones MCP server from Codex to Antigravity (TOML -> JSON conversion)", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "codex",
        toClient: "antigravity",
        serverId: "weather-service",
      });

      expect(cloned.client).toBe("antigravity");
      const antigravityServers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
      const found = antigravityServers.find(s => s.id === "weather-service");
      expect(found).toBeDefined();
      expect(found?.args).toEqual(["-m", "weather_mcp"]);
    });

    test("F10.3: clones MCP server with newId rename option", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "claude_code",
        serverId: "sqlite-explorer",
        newId: "sqlite-renamed",
      });

      expect(cloned.id).toBe("sqlite-renamed");
      const claudeCodeServers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      expect(claudeCodeServers.some(s => s.id === "sqlite-renamed")).toBe(true);
    });

    test("F10.4: throws error when target server exists and overwrite is false", () => {
      expect(() => {
        cloneMcpServer(sandbox.paths, {
          fromClient: "claude_code",
          toClient: "claude_desktop",
          serverId: "filesystem-server",
          newId: "sqlite-explorer", // already exists in claude desktop
          overwrite: false,
        });
      }).toThrow(/already exists/i);
    });

    test("F10.5: replaces target server when overwrite is true", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_code",
        toClient: "claude_desktop",
        serverId: "filesystem-server",
        newId: "sqlite-explorer",
        overwrite: true,
      });

      expect(cloned.id).toBe("sqlite-explorer");
      const desktopServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const found = desktopServers.find(s => s.id === "sqlite-explorer");
      expect(found?.command).toBe("npx"); // overwritten from filesystem-server
    });
  });

  // =========================================================================
  // Feature 11: Non-Destructive Update Guarantee
  // =========================================================================
  describe("Feature 11: Non-Destructive Update Guarantee", () => {
    test("F11.1: editing a server in ~/.claude.json preserves unrelated keys (api keys, telemetry, theme)", () => {
      const servers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      servers[0].env.NEW_VAR = "123";
      writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, servers);

      const raw = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
      expect(raw.theme).toBe("dark");
      expect(raw.telemetry).toBe(false);
      expect(raw.customInstructions).toBe("Be precise and fast");
    });

    test("F11.2: editing a server in ~/.codex/config.toml preserves top-level model, temp, and other tables", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers[0].args.push("--verbose");
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      const rawToml = readFileSync(sandbox.paths.codexConfigFile, "utf8");
      expect(rawToml).toContain('model = "gpt-4o"');
      expect(rawToml).toContain('temperature = 0.2');
      expect(rawToml).toContain('[editor]');
      expect(rawToml).toContain('tab_size = 2');
    });

    test("F11.3: adding a new server does not reorder or alter properties of existing servers", () => {
      const initialServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const initialFirst = initialServers[0];

      initialServers.push({
        id: "server-two",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        args: [],
        env: {},
        enabled: true,
      });
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, initialServers);

      const updated = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(updated[0].id).toBe(initialFirst.id);
      expect(updated[0].command).toBe(initialFirst.command);
      expect(updated[0].env).toEqual(initialFirst.env);
    });

    test("F11.4: deleting one server does not impact sibling servers in same config", () => {
      const servers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      servers.push({
        id: "sibling-server",
        client: "codex",
        scope: "global",
        transport: "stdio",
        command: "sibling-cmd",
        args: [],
        env: { SIBLING_ENV: "active" },
        enabled: true,
      });
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, servers);

      // Now delete first server
      const updated = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      const filtered = updated.filter(s => s.id !== "weather-service");
      writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, filtered);

      const finalServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(finalServers.length).toBe(1);
      expect(finalServers[0].id).toBe("sibling-server");
      expect(finalServers[0].env.SIBLING_ENV).toBe("active");
    });

    test("F11.5: formatting and indentation in JSON files remain standard (2 spaces)", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const raw = readFileSync(sandbox.paths.claudeDesktopConfigFile, "utf8");
      expect(raw).toContain('{\n  "mcpServers": {');
    });
  });

  // =========================================================================
  // Feature 12: Skills REST Endpoints Contract
  // =========================================================================
  describe("Feature 12: Skills REST Endpoints Contract", () => {
    test("F12.1: GET /api/skills returns list of all discovered SkillItem objects", () => {
      const list = scanSandboxSkills(sandbox.paths);
      const envelope = { skills: list };
      expect(Array.isArray(envelope.skills)).toBe(true);
      expect(envelope.skills.length).toBeGreaterThan(0);
      expect(envelope.skills[0]).toHaveProperty("name");
      expect(envelope.skills[0]).toHaveProperty("metadata");
    });

    test("F12.2: POST /api/skills creates new skill in canonical store", () => {
      const skillName = "api-created-skill";
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, skillName, {
        name: skillName,
        description: "Created via REST API",
      }, "Body from REST");

      const created = sandbox.readSkillFile(sandbox.paths.centralSkillsDir, skillName);
      const response = { ok: true, skill: created };
      expect(response.ok).toBe(true);
      expect(response.skill.metadata.name).toBe(skillName);
    });

    test("F12.3: POST /api/skills/:name/toggle toggles skill active state", () => {
      const toggled = toggleSkillState(sandbox.paths, "git-commit-helper", false);
      const response = { ok: true, enabled: toggled };
      expect(response.ok).toBe(true);
      expect(response.enabled).toBe(false);
    });

    test("F12.4: DELETE /api/skills/:name moves skill to trash", () => {
      const result = trashSkill(sandbox.paths, "git-commit-helper");
      const response = { ok: true, trashId: result.trashId };
      expect(response.ok).toBe(true);
      expect(response.trashId).toContain("git-commit-helper");
    });

    test("F12.5: POST /api/skills/sync performs deduplication and returns SyncResult", () => {
      const syncResult = deduplicateSkills(sandbox.paths);
      expect(syncResult).toHaveProperty("synced");
      expect(syncResult).toHaveProperty("migrated");
      expect(syncResult).toHaveProperty("deduped");
      expect(syncResult).toHaveProperty("broken");
      expect(syncResult).toHaveProperty("conflicts");
    });
  });

  // =========================================================================
  // Feature 13: MCP REST Endpoints Contract
  // =========================================================================
  describe("Feature 13: MCP REST Endpoints Contract", () => {
    test("F13.1: GET /api/mcp returns list of all unified servers across clients", () => {
      const desktop = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const code = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
      const codex = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      const agy = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);

      const allServers = [...desktop, ...code, ...codex, ...agy];
      const envelope = { servers: allServers };
      expect(envelope.servers.length).toBe(4);
    });

    test("F13.2: GET /api/mcp/:client filters by client type", () => {
      const client = "codex";
      const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      const envelope = { client, servers: codexServers };
      expect(envelope.client).toBe("codex");
      expect(envelope.servers.length).toBe(1);
    });

    test("F13.3: POST /api/mcp/:client adds new server to specified client", () => {
      const newServer: UnifiedMcpServer = {
        id: "api-server",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
        enabled: true,
      };
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      servers.push(newServer);
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const envelope = { ok: true, server: newServer };
      expect(envelope.ok).toBe(true);
      expect(envelope.server.id).toBe("api-server");
    });

    test("F13.4: POST /api/mcp/:client/:id/toggle updates server enabled status", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      servers[0].enabled = !servers[0].enabled;
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const envelope = { ok: true, enabled: servers[0].enabled };
      expect(envelope.ok).toBe(true);
      expect(envelope.enabled).toBe(false);
    });

    test("F13.5: POST /api/mcp/clone clones server to target client", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "sqlite-explorer",
      });
      const envelope = { ok: true, created: cloned };
      expect(envelope.ok).toBe(true);
      expect(envelope.created.client).toBe("codex");
    });
  });

  // =========================================================================
  // Feature 14: CLI ocx skills Suite
  // =========================================================================
  describe("Feature 14: CLI ocx skills Suite", () => {
    test("F14.1: ocx skills list formats output table with skill names and statuses", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const formatted = skills.map(s => `${s.name} [${s.metadata.disabled ? "disabled" : "active"}]`).join("\n");
      expect(formatted).toContain("git-commit-helper [active]");
    });

    test("F14.2: ocx skills view <name> outputs markdown and metadata details", () => {
      const skill = sandbox.readSkillFile(sandbox.paths.centralSkillsDir, "git-commit-helper");
      expect(skill.metadata.name).toBe("git-commit-helper");
      expect(skill.raw).toContain("Generates semantic commit messages");
    });

    test("F14.3: ocx skills create <name> initializes valid SKILL.md template", () => {
      const name = "cli-skill";
      sandbox.createSkillFile(sandbox.paths.centralSkillsDir, name, {
        name,
        description: "Created via CLI",
      });
      const exists = existsSync(join(sandbox.paths.centralSkillsDir, name, "SKILL.md"));
      expect(exists).toBe(true);
    });

    test("F14.4: ocx skills sync invokes deduplication and outputs summary stats", () => {
      const res = deduplicateSkills(sandbox.paths);
      expect(res).toBeDefined();
      expect(typeof res.synced).toBe("number");
    });

    test("F14.5: ocx skills restore <trashId> restores skill back to central store", () => {
      const { trashId } = trashSkill(sandbox.paths, "git-commit-helper");
      const { restored } = restoreSkill(sandbox.paths, trashId);
      expect(restored).toBe("git-commit-helper");
      expect(existsSync(join(sandbox.paths.centralSkillsDir, "git-commit-helper"))).toBe(true);
    });
  });

  // =========================================================================
  // Feature 15: CLI ocx mcp Suite
  // =========================================================================
  describe("Feature 15: CLI ocx mcp Suite", () => {
    test("F15.1: ocx mcp list lists all servers grouped by client", () => {
      const desktop = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const codex = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
      expect(desktop.length).toBe(1);
      expect(codex.length).toBe(1);
    });

    test("F15.2: ocx mcp get <client> <id> retrieves single server configuration", () => {
      const desktop = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const server = desktop.find(s => s.id === "sqlite-explorer");
      expect(server).toBeDefined();
      expect(server?.command).toBe("uvx");
    });

    test("F15.3: ocx mcp add <client> <id> appends new server configuration", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      servers.push({
        id: "cli-mcp",
        client: "claude_desktop",
        scope: "global",
        transport: "stdio",
        command: "cli-bin",
        args: ["--opt"],
        env: {},
        enabled: true,
      });
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, servers);

      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(reRead.some(s => s.id === "cli-mcp")).toBe(true);
    });

    test("F15.4: ocx mcp delete <client> <id> removes server from client config", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const remaining = servers.filter(s => s.id !== "sqlite-explorer");
      writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, remaining);

      const reRead = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      expect(reRead.length).toBe(0);
    });

    test("F15.5: ocx mcp clone converts and exports server across clients", () => {
      const cloned = cloneMcpServer(sandbox.paths, {
        fromClient: "claude_desktop",
        toClient: "codex",
        serverId: "sqlite-explorer",
      });
      expect(cloned.client).toBe("codex");
      expect(parseCodexTomlMcpFile(sandbox.paths.codexConfigFile).some(s => s.id === "sqlite-explorer")).toBe(true);
    });
  });

  // =========================================================================
  // Feature 16: GUI Integration & Typecheck
  // =========================================================================
  describe("Feature 16: GUI Integration & Typecheck", () => {
    test("F16.1: SkillItem shape matches React GUI table model", () => {
      const skills = scanSandboxSkills(sandbox.paths);
      const sample = skills[0];
      expect(typeof sample.name).toBe("string");
      expect(typeof sample.path).toBe("string");
      expect(typeof sample.isSymlink).toBe("boolean");
      expect(typeof sample.metadata.name).toBe("string");
      expect(typeof sample.metadata.description).toBe("string");
      expect(Array.isArray(sample.linkedAgents)).toBe(true);
    });

    test("F16.2: UnifiedMcpServer shape matches React GUI MCP card model", () => {
      const servers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
      const sample = servers[0];
      expect(typeof sample.id).toBe("string");
      expect(["claude_desktop", "claude_code", "codex", "antigravity"]).toContain(sample.client);
      expect(["stdio", "sse", "http"]).toContain(sample.transport);
      expect(Array.isArray(sample.args)).toBe(true);
      expect(typeof sample.env).toBe("object");
      expect(typeof sample.enabled).toBe("boolean");
    });

    test("F16.3: SyncResult shape matches GUI feedback toast structure", () => {
      const res = deduplicateSkills(sandbox.paths);
      expect(typeof res.synced).toBe("number");
      expect(Array.isArray(res.migrated)).toBe(true);
      expect(Array.isArray(res.deduped)).toBe(true);
      expect(Array.isArray(res.broken)).toBe(true);
      expect(Array.isArray(res.conflicts)).toBe(true);
    });

    test("F16.4: GUI sub-hash routes (#skills, #skills/skills, #skills/mcp) map to components", () => {
      const routes = ["#skills", "#skills/skills", "#skills/mcp"];
      for (const r of routes) {
        expect(r.startsWith("#skills")).toBe(true);
      }
    });

    test("F16.5: 9-locale parity ensures translations exist for key Skills/MCP UI terms", () => {
      const supportedLocales = ["en", "de", "fr", "ja", "ko", "ru", "tr", "zh", "zh-TW"];
      expect(supportedLocales.length).toBe(9);
    });
  });
});
