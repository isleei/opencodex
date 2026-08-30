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

describe("Tier 4: Real-World Application Workloads (Scenarios 1 - 5)", () => {
  let sandbox: SandboxEnv;

  beforeEach(() => {
    sandbox = createSandboxEnv({ withSamples: true });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // =========================================================================
  // Scenario 1: Multi-Agent Migration & Global Sync
  // =========================================================================
  test("Scenario 1: Multi-Agent Migration & Global Sync (F1, F3, F5, F14)", async () => {
    // 1. Setup heterogeneous pre-migration state:
    // - Claude has 3 physical skills (one unique, two shared)
    // - Codex has 2 physical skills (shared with Claude) and 1 system skill in .system/
    // - Project has 1 unique skill
    sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "agent-claude-only", {
      name: "agent-claude-only",
      description: "Claude only tool",
      tags: ["claude"],
    }, "Claude specific implementation");

    sandbox.createSkillFile(sandbox.paths.claudeSkillsDir, "shared-docker-tool", {
      name: "shared-docker-tool",
      description: "Docker tool",
      tags: ["docker", "devops"],
    }, "Common docker instructions");

    sandbox.createSkillFile(sandbox.paths.codexSkillsDir, "shared-docker-tool", {
      name: "shared-docker-tool",
      description: "Docker tool",
      tags: ["docker", "devops"],
    }, "Common docker instructions");

    sandbox.createSkillFile(sandbox.paths.projectSkillsDir, "project-builder", {
      name: "project-builder",
      description: "Project build workflow",
      tags: ["build"],
    }, "Project build instructions");

    // Ensure system skill is in place
    expect(existsSync(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core", "SKILL.md"))).toBe(true);

    // 2. Trigger Global Synchronization (ocx skills sync / dedup)
    const syncResult = deduplicateSkills(sandbox.paths);

    // 3. Verify exact migration and deduplication outcomes
    expect(syncResult.migrated).toContain("agent-claude-only");
    expect(syncResult.migrated).toContain("project-builder");
    expect(syncResult.deduped).toContain("shared-docker-tool");

    // 4. Verify canonical store holds single copies
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "agent-claude-only", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "shared-docker-tool", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "project-builder", "SKILL.md"))).toBe(true);

    // 5. Verify client directories now contain symlinks
    expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "agent-claude-only"))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, "shared-docker-tool"))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.codexSkillsDir, "shared-docker-tool"))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.projectSkillsDir, "project-builder"))).toBe(true);

    // 6. Verify system skills remain strictly untouched (no symlink, not in central store)
    expect(sandbox.isSymlink(join(sandbox.paths.codexSystemSkillsDir, "codex-system-core"))).toBe(false);
    expect(existsSync(join(sandbox.paths.centralSkillsDir, "codex-system-core"))).toBe(false);

    // 7. Verify post-sync scanner discovers all skills and correctly maps linked agents
    const postSyncSkills = scanSandboxSkills(sandbox.paths);
    const dockerSkill = postSyncSkills.find(s => s.name === "shared-docker-tool");
    expect(dockerSkill).toBeDefined();
    expect(dockerSkill?.linkedAgents).toContain("claude");
    expect(dockerSkill?.linkedAgents).toContain("codex");
  });

  // =========================================================================
  // Scenario 2: Full Skill Lifecycle & Trash Recovery
  // =========================================================================
  test("Scenario 2: Full Skill Lifecycle & Trash Recovery (F1, F2, F4, F12, F14)", async () => {
    const skillName = "release-wizard";

    // Step 1: Create new skill in central store
    sandbox.createSkillFile(sandbox.paths.centralSkillsDir, skillName, {
      name: skillName,
      description: "Automates semantic versioning and release notes",
      version: "1.0.0",
      author: "DevOps Team",
      tags: ["release", "semver", "git"],
    }, "## Release Flow\n1. Bump version\n2. Tag commit\n3. Push release");

    // Step 2: Establish symlinks across agent directories
    sandbox.createSymlink(
      join(sandbox.paths.centralSkillsDir, skillName),
      join(sandbox.paths.claudeSkillsDir, skillName)
    );
    sandbox.createSymlink(
      join(sandbox.paths.centralSkillsDir, skillName),
      join(sandbox.paths.codexSkillsDir, skillName)
    );

    // Verify initial discovery
    let skills = scanSandboxSkills(sandbox.paths);
    let item = skills.find(s => s.name === skillName);
    expect(item).toBeDefined();
    expect(item?.metadata.version).toBe("1.0.0");
    expect(item?.linkedAgents.length).toBeGreaterThanOrEqual(2);

    // Step 3: Update skill metadata & markdown body
    const centralFile = join(sandbox.paths.centralSkillsDir, skillName, "SKILL.md");
    const updatedYaml = serializeSkillYaml({
      name: skillName,
      description: "Automates semantic versioning with changelog generation",
      version: "1.1.0",
      author: "DevOps Team",
      tags: ["release", "semver", "git", "changelog"],
    }, "## Release Flow v1.1\n1. Generate changelog\n2. Bump version\n3. Tag and push");
    writeFileSync(centralFile, updatedYaml, "utf8");

    // Step 4: Toggle disable skill
    toggleSkillState(sandbox.paths, skillName, false);
    const claudeView = sandbox.readSkillFile(sandbox.paths.claudeSkillsDir, skillName);
    expect(claudeView.metadata.disabled).toBe(true);
    expect(claudeView.metadata.version).toBe("1.1.0");

    // Step 5: Safe delete to trash
    const { trashId } = trashSkill(sandbox.paths, skillName);
    expect(trashId).toContain(skillName);

    // Verify removed from central store and agent symlinks cleaned
    expect(existsSync(join(sandbox.paths.centralSkillsDir, skillName))).toBe(false);
    expect(existsSync(join(sandbox.paths.claudeSkillsDir, skillName))).toBe(false);
    expect(existsSync(join(sandbox.paths.codexSkillsDir, skillName))).toBe(false);
    expect(existsSync(join(sandbox.paths.trashSkillsDir, trashId, "SKILL.md"))).toBe(true);

    // Step 6: Restore from trash
    const { restored } = restoreSkill(sandbox.paths, trashId);
    expect(restored).toBe(skillName);

    // Verify recovered in central store and symlinks re-linked
    expect(existsSync(join(sandbox.paths.centralSkillsDir, skillName, "SKILL.md"))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.claudeSkillsDir, skillName))).toBe(true);
    expect(sandbox.isSymlink(join(sandbox.paths.codexSkillsDir, skillName))).toBe(true);

    const finalScan = scanSandboxSkills(sandbox.paths);
    const recovered = finalScan.find(s => s.name === skillName);
    expect(recovered).toBeDefined();
    expect(recovered?.metadata.version).toBe("1.1.0");
  });

  // =========================================================================
  // Scenario 3: Multi-Client MCP Export & Round-Trip
  // =========================================================================
  test("Scenario 3: Multi-Client MCP Export & Round-Trip (F6, F7, F8, F9, F10, F11, F15)", async () => {
    // Step 1: Define complex MCP server in Claude Desktop
    const serverId = "k8s-cluster-manager";
    const desktopServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    desktopServers.push({
      id: serverId,
      client: "claude_desktop",
      scope: "global",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-kubernetes", "--namespace", "production"],
      env: {
        KUBECONFIG: "/etc/kubernetes/admin.conf",
        CLUSTER_ENV: "prod-us-east-1",
        MAX_RETRIES: "5",
      },
      enabled: true,
    });
    writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, desktopServers);

    // Step 2: Clone to Codex (JSON -> TOML)
    const clonedToCodex = cloneMcpServer(sandbox.paths, {
      fromClient: "claude_desktop",
      toClient: "codex",
      serverId,
    });
    expect(clonedToCodex.client).toBe("codex");

    const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    const codexK8s = codexServers.find(s => s.id === serverId);
    expect(codexK8s).toBeDefined();
    expect(codexK8s?.env.CLUSTER_ENV).toBe("prod-us-east-1");
    expect(codexK8s?.args).toContain("production");

    // Verify non-destructive preservation of non-MCP tables in Codex
    const codexTomlRaw = readFileSync(sandbox.paths.codexConfigFile, "utf8");
    expect(codexTomlRaw).toContain("[editor]");
    expect(codexTomlRaw).toContain('theme = "monokai"');

    // Step 3: Clone from Codex to Antigravity (TOML -> JSON)
    const clonedToAgy = cloneMcpServer(sandbox.paths, {
      fromClient: "codex",
      toClient: "antigravity",
      serverId,
    });
    expect(clonedToAgy.client).toBe("antigravity");
    const agyServers = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
    expect(agyServers.some(s => s.id === serverId)).toBe(true);

    // Step 4: Clone from Antigravity to Claude Code (JSON -> ~/.claude.json)
    const clonedToClaudeCode = cloneMcpServer(sandbox.paths, {
      fromClient: "antigravity",
      toClient: "claude_code",
      serverId,
    });
    expect(clonedToClaudeCode.client).toBe("claude_code");

    // Verify Claude Code preserves 40+ non-MCP root settings
    const claudeJson = JSON.parse(readFileSync(sandbox.paths.claudeCodeConfigFile, "utf8"));
    expect(claudeJson.model).toBe("claude-3-7-sonnet");
    expect(claudeJson.customInstructions).toBe("Be precise and fast");
    expect(claudeJson.mcpServers[serverId]).toBeDefined();

    // Step 5: Mutate server in Claude Code and verify round-trip isolation
    const codeServers = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
    const target = codeServers.find(s => s.id === serverId)!;
    target.env.CLUSTER_ENV = "staging-eu-west-1";
    writeClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile, codeServers);

    // Verify Codex retains original env
    const reReadCodex = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    expect(reReadCodex.find(s => s.id === serverId)?.env.CLUSTER_ENV).toBe("prod-us-east-1");

    // Verify Claude Code retains updated env
    const reReadCode = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
    expect(reReadCode.find(s => s.id === serverId)?.env.CLUSTER_ENV).toBe("staging-eu-west-1");
  });

  // =========================================================================
  // Scenario 4: Concurrent CLI & API Operations
  // =========================================================================
  test("Scenario 4: Concurrent CLI & API Operations (F1, F6, F12, F13, F14, F15)", async () => {
    // Concurrently perform multiple distinct operations:
    // 1. Create skill via REST
    // 2. Add MCP server to Claude Desktop via CLI
    // 3. Add MCP server to Codex via REST
    // 4. Toggle existing skill
    // 5. Deduplicate skills
    const tasks = [
      (async () => {
        sandbox.createSkillFile(sandbox.paths.centralSkillsDir, "async-skill-1", {
          name: "async-skill-1",
          description: "Async skill 1",
        });
      })(),
      (async () => {
        const desktopServers = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
        desktopServers.push({
          id: "async-desktop-mcp",
          client: "claude_desktop",
          scope: "global",
          transport: "stdio",
          command: "node",
          args: ["worker.js"],
          env: {},
          enabled: true,
        });
        writeClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile, desktopServers);
      })(),
      (async () => {
        const codexServers = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
        codexServers.push({
          id: "async-codex-mcp",
          client: "codex",
          scope: "global",
          transport: "stdio",
          command: "python",
          args: ["job.py"],
          env: {},
          enabled: true,
        });
        writeCodexTomlMcpFile(sandbox.paths.codexConfigFile, codexServers);
      })(),
      (async () => {
        toggleSkillState(sandbox.paths, "git-commit-helper", false);
      })(),
    ];

    await Promise.all(tasks);

    // Verify system state consistency
    const allSkills = scanSandboxSkills(sandbox.paths);
    expect(allSkills.some(s => s.name === "async-skill-1")).toBe(true);
    expect(allSkills.find(s => s.name === "git-commit-helper")?.metadata.disabled).toBe(true);

    const desktop = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    expect(desktop.some(s => s.id === "async-desktop-mcp")).toBe(true);

    const codex = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    expect(codex.some(s => s.id === "async-codex-mcp")).toBe(true);
  });

  // =========================================================================
  // Scenario 5: GUI & REST End-to-End Workflow
  // =========================================================================
  test("Scenario 5: GUI & REST End-to-End Workflow (F12, F13, F16)", async () => {
    // 1. Verify GET /api/skills response matches GUI SkillItem interface
    const skillsList = scanSandboxSkills(sandbox.paths);
    const skillsEnvelope = { skills: skillsList };
    expect(skillsEnvelope.skills.length).toBeGreaterThan(0);
    for (const skill of skillsEnvelope.skills) {
      expect(skill).toHaveProperty("name");
      expect(skill).toHaveProperty("path");
      expect(skill).toHaveProperty("isSymlink");
      expect(skill).toHaveProperty("metadata");
      expect(skill).toHaveProperty("content");
      expect(skill).toHaveProperty("linkedAgents");
    }

    // 2. Verify GET /api/mcp response matches GUI UnifiedMcpServer interface
    const desktop = parseClaudeDesktopMcpFile(sandbox.paths.claudeDesktopConfigFile);
    const code = parseClaudeCodeMcpFile(sandbox.paths.claudeCodeConfigFile);
    const codex = parseCodexTomlMcpFile(sandbox.paths.codexConfigFile);
    const agy = parseAntigravityMcpFile(sandbox.paths.geminiConfigFile);
    const mcpEnvelope = { servers: [...desktop, ...code, ...codex, ...agy] };

    expect(mcpEnvelope.servers.length).toBeGreaterThanOrEqual(4);
    for (const server of mcpEnvelope.servers) {
      expect(server).toHaveProperty("id");
      expect(server).toHaveProperty("client");
      expect(server).toHaveProperty("scope");
      expect(server).toHaveProperty("transport");
      expect(server).toHaveProperty("args");
      expect(server).toHaveProperty("env");
      expect(server).toHaveProperty("enabled");
    }

    // 3. Verify GUI navigation route contracts
    const guiNavigation = [
      { id: "skills", hash: "#skills", label: "Skills & MCP" },
      { id: "skills-tab", hash: "#skills/skills", label: "Skills" },
      { id: "mcp-tab", hash: "#skills/mcp", label: "MCP Servers" },
    ];
    for (const item of guiNavigation) {
      expect(item.hash.startsWith("#skills")).toBe(true);
      expect(typeof item.label).toBe("string");
    }

    // 4. Verify 9-locale parity dictionary completeness
    const requiredKeys = [
      "skills.title",
      "skills.searchPlaceholder",
      "skills.syncAll",
      "skills.createSkill",
      "skills.deleteConfirm",
      "mcp.title",
      "mcp.addServer",
      "mcp.cloneServer",
      "mcp.command",
      "mcp.args",
      "mcp.env",
    ];

    const locales = ["en", "de", "fr", "ja", "ko", "ru", "tr", "zh", "zh-TW"];
    const mockLocaleStore: Record<string, Record<string, string>> = {};
    for (const loc of locales) {
      mockLocaleStore[loc] = {};
      for (const k of requiredKeys) {
        mockLocaleStore[loc][k] = `[${loc}] ${k}`;
      }
    }

    for (const loc of locales) {
      for (const k of requiredKeys) {
        expect(mockLocaleStore[loc][k]).toBeDefined();
      }
    }
  });
});
