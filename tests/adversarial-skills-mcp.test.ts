import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Skills Engine Imports
import {
  parseSkillFrontmatter,
  readSkillFromDir,
  serializeSkill,
  writeSkillToDir,
} from "../src/skills/parser";
import {
  resolveSkillsDirectories,
  scanSingleSkill,
  scanSkills,
  scanSkillsSync,
} from "../src/skills/scanner";
import {
  createDirectorySymlink,
  getSymlinkTarget,
  isDanglingSymlink,
  isSymlink,
  removeSymlink,
  repairDanglingSymlink,
  safeRealpath,
} from "../src/skills/symlinks";
import {
  computeSkillContentHash,
  deduplicateAndMigrateSkills,
} from "../src/skills/dedup";
import {
  listTrashRecords,
  restoreSkillFromTrash,
  toggleSkillState,
  trashSkill,
} from "../src/skills/trash";
import {
  SkillsManager,
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  listTrash,
  restoreSkill,
  syncSkills,
  toggleSkill,
  updateSkill,
} from "../src/skills/manager";
import type {
  CreateSkillInput,
  SkillItem,
  SkillMetadata,
  SkillsDirectoryConfig,
} from "../src/skills/types";

// MCP Engine Imports
import {
  ALL_MCP_CLIENTS,
  McpConfigManager,
  addMcpServer,
  cloneMcpServer,
  deleteMcpServer,
  getClientConfigPath,
  getMcpServer,
  listMcpServers,
  toggleMcpServer,
  updateMcpServer,
  type CustomPathMap,
} from "../src/mcp/config-manager";
import {
  acquireFileLock,
  releaseFileLock,
  withFileLock,
} from "../src/mcp/locks";
import {
  readClaudeDesktopConfig,
  resolveClaudeDesktopConfigPath,
  writeClaudeDesktopServer,
} from "../src/mcp/parsers/claude-desktop";
import {
  readClaudeCodeConfig,
  resolveClaudeCodeConfigPath,
  writeClaudeCodeServer,
} from "../src/mcp/parsers/claude-code";
import {
  formatCodexTomlServerBlock,
  quoteTomlKey,
  readCodexTomlConfig,
  resolveCodexTomlConfigPath,
  writeCodexTomlServer,
} from "../src/mcp/parsers/codex-toml";
import {
  readAntigravityConfig,
  resolveAntigravityConfigPath,
  writeAntigravityServer,
} from "../src/mcp/parsers/antigravity";
import {
  convertServerForClient,
  executeMcpClone,
  validateServerDefinition,
} from "../src/mcp/cross-client";
import {
  McpConflictError,
  McpLockError,
  McpNotFoundError,
  McpParseError,
  McpValidationError,
  type McpClientType,
  type UnifiedMcpServer,
} from "../src/mcp/types";

describe("Adversarial Stress Testing: Skills & Multi-Client MCP Engines", () => {
  let tempBaseDir: string;
  let skillsConfig: SkillsDirectoryConfig;
  let mcpCustomPaths: CustomPathMap;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), "ocx-adversarial-test-"));

    // Isolated sandbox for Skills Engine
    skillsConfig = {
      centralDir: join(tempBaseDir, "central_skills"),
      claudeDir: join(tempBaseDir, "claude_skills"),
      codexDir: join(tempBaseDir, "codex_skills"),
      projectDir: join(tempBaseDir, "project_skills"),
      trashDir: join(tempBaseDir, "trash_skills"),
      systemSkillsDir: join(tempBaseDir, "codex_skills", ".system"),
    };

    // Isolated sandbox for MCP Engine
    mcpCustomPaths = {
      claude_desktop: join(tempBaseDir, "claude_desktop_config.json"),
      claude_code_global: join(tempBaseDir, "claude_code_global.json"),
      claude_code_project: join(tempBaseDir, "claude_code_project.json"),
      codex_global: join(tempBaseDir, "codex_global.toml"),
      codex_project: join(tempBaseDir, "codex_project.toml"),
      antigravity_global: join(tempBaseDir, "antigravity_global.json"),
      antigravity_project: join(tempBaseDir, "antigravity_project.json"),
    };

    // Initialize clean directories
    mkdirSync(skillsConfig.centralDir!, { recursive: true });
    mkdirSync(skillsConfig.claudeDir!, { recursive: true });
    mkdirSync(skillsConfig.codexDir!, { recursive: true });
    mkdirSync(skillsConfig.projectDir!, { recursive: true });
    mkdirSync(skillsConfig.trashDir!, { recursive: true });
    mkdirSync(skillsConfig.systemSkillsDir!, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // =========================================================================
  // 1. CENTRALIZED SKILLS ENGINE ADVERSARIAL CHALLENGES
  // =========================================================================

  describe("1. Centralized Skills Engine Adversarial Challenges", () => {
    describe("1.1 Malformed Frontmatter & Parser Extremes", () => {
      it("handles unclosed frontmatter delimiters gracefully without throwing", () => {
        const unclosed = `---
name: broken-skill
description: this has no end delimiter
tags: [tag1, tag2]
`;
        const result = parseSkillFrontmatter(unclosed, "fallback-folder-name");
        expect(result).toBeDefined();
        expect(result.metadata.name).toBe("fallback-folder-name");
        expect(result.content).toBe(unclosed);
      });

      it("handles invalid YAML syntax (tabs, unquoted colons, unbalanced brackets) via fallback parser", () => {
        const invalidYaml = `---
name: invalid-syntax-skill
description: bad: value: [unbalanced
tags:
\t- tab_indented_tag
  - second-tag
disabled: true
---

# Content Body Here
`;
        const result = parseSkillFrontmatter(invalidYaml, "syntax-fail");
        expect(result).toBeDefined();
        expect(result.metadata.name).toBe("invalid-syntax-skill");
        expect(result.content).toContain("# Content Body Here");
      });

      it("normalizes strange and corrupt field types in frontmatter", () => {
        const strangeTypes = `---
name: 12345
description: 99.9
tags: "tag1, tag2,  tag3 , "
disabled: "true"
version: 2
author: 404
source: true
---
Body text.
`;
        const result = parseSkillFrontmatter(strangeTypes, "strange-skill");
        // name as number is converted or falls back to string
        expect(typeof result.metadata.name).toBe("string");
        expect(result.metadata.description).toBe("99.9");
        expect(result.metadata.tags).toEqual(["tag1", "tag2", "tag3"]);
        expect(result.metadata.disabled).toBe(true);
      });

      it("handles empty files, whitespace-only files, and files with null bytes", () => {
        const emptyResult = parseSkillFrontmatter("", "empty-dir");
        expect(emptyResult.metadata.name).toBe("empty-dir");
        expect(emptyResult.content).toBe("");

        const whitespaceResult = parseSkillFrontmatter("   \n\n  \t  \n", "space-dir");
        expect(whitespaceResult.metadata.name).toBe("space-dir");

        const nullByteContent = "---\nname: null-byte-skill\n---\nHello\0World";
        const nullResult = parseSkillFrontmatter(nullByteContent, "null-dir");
        expect(nullResult.metadata.name).toBe("null-byte-skill");
        expect(nullResult.content).toContain("Hello\0World");
      });

      it("losslessly round-trips frontmatter containing unicode, multiline strings, emojis, and special characters", () => {
        const meta: SkillMetadata = {
          name: "complex-skill-🚀",
          description: 'Special "quotes", colons: and newlines\nsecond line with # comment & symbols @!$%^&*()',
          tags: ["react", "typescript", "🔥-hot", "c++"],
          version: "2.1.0-alpha.1",
          author: "Developer <dev@example.com>",
          source: "https://example.com/skills?q=1&b=2#sec",
          disabled: false,
          customField: "extra-value: with colon",
        };
        const content = "# Deep Instructions\n\n```python\nprint('hello: world')\n```\n";

        const serialized = serializeSkill(meta, content);
        const parsed = parseSkillFrontmatter(serialized, "complex-skill-🚀");

        expect(parsed.metadata.name).toBe(meta.name);
        expect(parsed.metadata.description).toBe(meta.description);
        expect(parsed.metadata.tags).toEqual(meta.tags);
        expect(parsed.metadata.version).toBe(meta.version);
        expect(parsed.metadata.author).toBe(meta.author);
        expect(parsed.metadata.source).toBe(meta.source);
        expect(parsed.metadata.disabled).toBe(false);
        expect(parsed.content.trim()).toBe(content.trim());
      });
    });

    describe("1.2 Deeply Nested Directories, Circular Symlinks & Dangling Links", () => {
      it("computes content hash for deeply nested directory trees (15 levels deep)", () => {
        const deepSkillDir = join(skillsConfig.centralDir!, "deep-skill");
        let currentPath = deepSkillDir;
        for (let i = 0; i < 15; i++) {
          currentPath = join(currentPath, `level_${i}`);
        }
        mkdirSync(currentPath, { recursive: true });
        writeFileSync(join(currentPath, "deep_file.txt"), "leaf node content", "utf8");
        writeFileSync(join(deepSkillDir, "SKILL.md"), "---\nname: deep-skill\n---\nRoot", "utf8");

        const hash1 = computeSkillContentHash(deepSkillDir);
        expect(hash1).toHaveLength(64);

        // Modifying leaf content changes root hash
        writeFileSync(join(currentPath, "deep_file.txt"), "modified leaf content", "utf8");
        const hash2 = computeSkillContentHash(deepSkillDir);
        expect(hash2).not.toBe(hash1);
      });

      it("safely handles circular symlinks inside skill folder without hanging in infinite loop", () => {
        const skillDir = join(skillsConfig.centralDir!, "circular-skill");
        const subDir = join(skillDir, "subdir");
        mkdirSync(subDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), "---\nname: circular-skill\n---\nMain", "utf8");

        // Create circular link: subdir/loop -> skillDir
        try {
          symlinkSync(skillDir, join(subDir, "loop"), "dir");
        } catch {
          // On platforms where symlinks require privileges, fallback
        }

        // computeSkillContentHash relies on readdirSync withFileTypes where symlink isDirectory() is false
        const hash = computeSkillContentHash(skillDir);
        expect(typeof hash).toBe("string");
        expect(hash.length).toBe(64);
      });

      it("discovers and repairs multiple dangling symlinks across client directories", async () => {
        const centralSkillDir = join(skillsConfig.centralDir!, "resilient-skill");
        writeSkillToDir(centralSkillDir, { name: "resilient-skill", description: "testing repair" }, "body");

        // Create valid link in claude
        const claudeLink = join(skillsConfig.claudeDir!, "resilient-skill");
        createDirectorySymlink(centralSkillDir, claudeLink);

        // Create dangling symlinks in codex and project pointing to non-existent locations
        const codexDangling = join(skillsConfig.codexDir!, "resilient-skill");
        const projectDangling = join(skillsConfig.projectDir!, "resilient-skill");
        symlinkSync(join(tempBaseDir, "ghost-target"), codexDangling, "dir");
        symlinkSync(join(tempBaseDir, "ghost-target-2"), projectDangling, "dir");

        expect(isDanglingSymlink(codexDangling)).toBe(true);
        expect(isDanglingSymlink(projectDangling)).toBe(true);

        // Run sync/dedup
        const syncResult = await deduplicateAndMigrateSkills({ config: skillsConfig });
        expect(syncResult.broken).toContain("codex:resilient-skill");

        // After sync, dangling links to known central skill are repaired
        expect(existsSync(codexLinkOrPath(codexDangling))).toBe(true);
        expect(isDanglingSymlink(codexDangling)).toBe(false);
      });
    });

    describe("1.3 Concurrent Deduplication & Migration Stress", () => {
      it("executes 10 simultaneous deduplicateAndMigrateSkills operations without race condition crashes or file loss", async () => {
        // Setup 5 physical skills in claude and 5 in codex
        for (let i = 0; i < 5; i++) {
          const claudeSkill = join(skillsConfig.claudeDir!, `race-skill-claude-${i}`);
          writeSkillToDir(claudeSkill, { name: `race-skill-claude-${i}`, description: `Claude skill ${i}` }, `Content ${i}`);

          const codexSkill = join(skillsConfig.codexDir!, `race-skill-codex-${i}`);
          writeSkillToDir(codexSkill, { name: `race-skill-codex-${i}`, description: `Codex skill ${i}` }, `Content ${i}`);
        }

        // Fire 10 simultaneous sync operations
        const tasks = Array.from({ length: 10 }, () => deduplicateAndMigrateSkills({ config: skillsConfig }));
        const results = await Promise.all(tasks);

        expect(results).toHaveLength(10);

        // Verify final state: all 10 skills migrated to central store
        const centralEntries = readdirSync(skillsConfig.centralDir!);
        for (let i = 0; i < 5; i++) {
          expect(centralEntries).toContain(`race-skill-claude-${i}`);
          expect(centralEntries).toContain(`race-skill-codex-${i}`);

          // Client directories should now be valid symlinks
          const cLink = join(skillsConfig.claudeDir!, `race-skill-claude-${i}`);
          const xLink = join(skillsConfig.codexDir!, `race-skill-codex-${i}`);
          expect(isSymlink(cLink)).toBe(true);
          expect(isSymlink(xLink)).toBe(true);
        }

        // Run scanner to confirm all 10 are visible and healthy
        const allSkills = scanSkillsSync(skillsConfig);
        expect(allSkills.length).toBeGreaterThanOrEqual(10);
      });
    });

    describe("1.4 Trash Store & Restore Conflict Resolution", () => {
      it("rejects restoring a trashed skill if target directory has been re-created out of band", async () => {
        const skillDir = join(skillsConfig.centralDir!, "conflict-restore-skill");
        writeSkillToDir(skillDir, { name: "conflict-restore-skill", description: "Original" }, "Original Body");

        // Link in claude
        const claudeLink = join(skillsConfig.claudeDir!, "conflict-restore-skill");
        createDirectorySymlink(skillDir, claudeLink);

        // Trash the skill
        const trashRecord = await trashSkill("conflict-restore-skill", skillsConfig);
        expect(existsSync(skillDir)).toBe(false);
        expect(existsSync(claudeLink)).toBe(false);

        // Now create a new conflict directory in central store with same name
        writeSkillToDir(skillDir, { name: "conflict-restore-skill", description: "Imposter" }, "Imposter Body");

        // Attempting to restore must throw error protecting existing directory
        await expect(restoreSkillFromTrash(trashRecord.trashId, skillsConfig)).rejects.toThrow(
          /target directory already exists/,
        );

        // Verify imposter was NOT overwritten
        const currentData = readSkillFromDir(skillDir);
        expect(currentData!.metadata.description).toBe("Imposter");

        // Clean imposter and restore should succeed
        rmSync(skillDir, { recursive: true, force: true });
        const restored = await restoreSkillFromTrash(trashRecord.trashId, skillsConfig);
        expect(restored.ok).toBe(true);
        expect(restored.restored).toBe("conflict-restore-skill");

        const restoredData = readSkillFromDir(skillDir);
        expect(restoredData!.metadata.description).toBe("Original");
      });

      it("handles corrupt or missing manifest.json in trash store gracefully", async () => {
        const trashItemDir = join(skillsConfig.trashDir!, "2026-08-30T10-00-00.000Z_corrupt-manifest-skill");
        mkdirSync(trashItemDir, { recursive: true });
        writeFileSync(join(trashItemDir, "manifest.json"), "{ invalid-json: true", "utf8");

        // Should not throw, should fallback to directory name synthesis
        const records = await listTrashRecords(skillsConfig);
        const found = records.find((r) => r.skillName === "corrupt-manifest-skill");
        expect(found).toBeDefined();
        expect(found!.trashId).toBe("2026-08-30T10-00-00.000Z_corrupt-manifest-skill");
      });

      it("permanently deletes skill when permanent: true is provided without creating trash entry", async () => {
        const skillDir = join(skillsConfig.centralDir!, "permanent-skill");
        writeSkillToDir(skillDir, { name: "permanent-skill", description: "To be wiped" }, "Body");

        const record = await trashSkill("permanent-skill", skillsConfig, { permanent: true });
        expect(record.trashId).toBe("permanent");
        expect(existsSync(skillDir)).toBe(false);

        const trashList = await listTrashRecords(skillsConfig);
        expect(trashList.some((t) => t.skillName === "permanent-skill")).toBe(false);
      });
    });

    describe("1.5 System Skill Protection & Security Invariants", () => {
      it("prevents deletion of Codex internal system skills (.system)", async () => {
        const sysSkillDir = join(skillsConfig.systemSkillsDir!, "core-system-tool");
        writeSkillToDir(sysSkillDir, { name: "core-system-tool", description: "Codex core tool" }, "System instructions");

        // Scanned system skills get prefixed with system:
        const scanned = scanSkillsSync(skillsConfig);
        const sysItem = scanned.find((s) => s.name === "system:core-system-tool");
        expect(sysItem).toBeDefined();
        expect(sysItem!.isSystem).toBe(true);

        // Attempting to trash system skill directly
        await expect(trashSkill("system:core-system-tool", skillsConfig)).rejects.toThrow(
          /Cannot delete protected system skill/,
        );

        // Attempting to delete by directory name containing .system
        await expect(trashSkill(".system", skillsConfig)).rejects.toThrow(
          /Cannot delete protected system skill/,
        );

        // Attempting to toggle system skill
        await expect(toggleSkillState("system:core-system-tool", false, { config: skillsConfig })).rejects.toThrow(
          /Cannot toggle protected system skill/,
        );

        // Verify physical system skill is untouched
        expect(existsSync(sysSkillDir)).toBe(true);
      });

      it("manager updateSkill rejects mutating system skills", async () => {
        const sysSkillDir = join(skillsConfig.systemSkillsDir!, "protected-sys");
        writeSkillToDir(sysSkillDir, { name: "protected-sys", description: "Immutable system skill" }, "Immutable");

        await expect(
          updateSkill("system:protected-sys", { description: "Hacked" }, skillsConfig),
        ).rejects.toThrow(/Cannot modify protected system skill/);
      });

      it("deduplicateAndMigrateSkills ignores .system directory in codex folder", async () => {
        const sysSkillDir = join(skillsConfig.systemSkillsDir!, "sys-tool-1");
        writeSkillToDir(sysSkillDir, { name: "sys-tool-1", description: "Do not move" }, "Sys 1");

        const result = await deduplicateAndMigrateSkills({ config: skillsConfig });
        expect(result.migrated).not.toContain(".system");
        expect(result.migrated).not.toContain("sys-tool-1");

        // .system directory must remain a physical directory in codex skills
        expect(existsSync(sysSkillDir)).toBe(true);
        expect(isSymlink(skillsConfig.systemSkillsDir!)).toBe(false);
      });
    });
  });

  // =========================================================================
  // 2. MULTI-CLIENT MCP CONFIGURATION ENGINE ADVERSARIAL CHALLENGES
  // =========================================================================

  describe("2. Multi-Client MCP Configuration Engine Adversarial Challenges", () => {
    let mcpManager: McpConfigManager;

    beforeEach(() => {
      mcpManager = new McpConfigManager({ customPaths: mcpCustomPaths, projectRoot: tempBaseDir });
    });

    describe("2.1 Corrupt File Handling & Parser Resilience", () => {
      it("throws McpParseError on truncated JSON in Claude Desktop, Claude Code, and Antigravity configs", () => {
        const truncatedJson = '{"mcpServers": {"broken": {"command": "node"'; // missing closing braces

        // Claude Desktop
        writeFileSync(mcpCustomPaths.claude_desktop!, truncatedJson, "utf8");
        expect(() => readClaudeDesktopConfig(mcpCustomPaths.claude_desktop!)).toThrow(McpParseError);

        // Claude Code
        writeFileSync(mcpCustomPaths.claude_code_global!, truncatedJson, "utf8");
        expect(() => readClaudeCodeConfig(mcpCustomPaths.claude_code_global!)).toThrow(McpParseError);

        // Antigravity
        writeFileSync(mcpCustomPaths.antigravity_global!, truncatedJson, "utf8");
        expect(() => readAntigravityConfig(mcpCustomPaths.antigravity_global!)).toThrow(McpParseError);
      });

      it("throws McpParseError on corrupt TOML syntax in Codex config", () => {
        const corruptToml = `
[mcp_servers.broken
command = "node"
args = ["unclosed string
`;
        writeFileSync(mcpCustomPaths.codex_global!, corruptToml, "utf8");
        expect(() => readCodexTomlConfig(mcpCustomPaths.codex_global!)).toThrow(McpParseError);
      });

      it("throws McpParseError when root of JSON config is an array or primitive", () => {
        writeFileSync(mcpCustomPaths.claude_code_global!, '["item1", "item2"]', "utf8");
        expect(() => readClaudeCodeConfig(mcpCustomPaths.claude_code_global!)).toThrow(McpParseError);

        writeFileSync(mcpCustomPaths.antigravity_global!, '"plain-string"', "utf8");
        expect(() => readAntigravityConfig(mcpCustomPaths.antigravity_global!)).toThrow(McpParseError);
      });
    });

    describe("2.2 Complex TOML Non-Destructive Preservation", () => {
      it("preserves deeply structured TOML with arbitrary tables, comments, array of tables, and blank lines", () => {
        const complexToml = `# Codex Primary Configuration
model = "gpt-4o"
preferred_timeout = 120

# 1. Custom Provider Definitions
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
api_key = "sk-or-test-key-12345"
wire_format = "openai"

[model_providers.anthropic_direct]
base_url = "https://api.anthropic.com"
api_key = "sk-ant-test"

# 2. Plugin Integrations
[plugins]
enabled = true
trusted_sources = ["github.com/org", "registry.npmjs.org"]

[plugins.linter]
rule_level = "strict"

# 3. Array of Skill Configs
[[skills.config]]
name = "skill-one"
path = "/path/to/skill-one"
auto_load = true

[[skills.config]]
name = "skill-two"
path = "/path/to/skill-two"
auto_load = false

# 4. Existing MCP Server
[mcp_servers.existing_tool]
command = "uvx"
args = ["mcp-existing-tool", "--verbose"]
enabled = true
startup_timeout_sec = 45

[mcp_servers.existing_tool.env]
API_SECRET = "secret-xyz"
LOG_FORMAT = "json"

# End of file comment
`;
        writeFileSync(mcpCustomPaths.codex_global!, complexToml, "utf8");

        // 1. Add a new server
        const newServer: UnifiedMcpServer = {
          id: "complex-new-server",
          client: "codex",
          scope: "global",
          transport: "stdio",
          command: "node",
          args: ["./dist/index.js", "--port", "8080"],
          env: {
            SPECIAL_ENV: "val:with:colon",
            MULTILINE_KEY: "line1\nline2",
          },
          enabled: true,
          timeoutSec: 60,
        };

        writeCodexTomlServer(mcpCustomPaths.codex_global!, newServer);

        // Read and verify
        const updatedContent = readFileSync(mcpCustomPaths.codex_global!, "utf8");
        expect(updatedContent).toContain('model = "gpt-4o"');
        expect(updatedContent).toContain("[model_providers.openrouter]");
        expect(updatedContent).toContain("[model_providers.anthropic_direct]");
        expect(updatedContent).toContain("[plugins.linter]");
        expect(updatedContent).toContain("[[skills.config]]");
        expect(updatedContent).toContain('name = "skill-one"');
        expect(updatedContent).toContain('name = "skill-two"');
        expect(updatedContent).toContain("[mcp_servers.existing_tool]");
        expect(updatedContent).toContain("[mcp_servers.complex-new-server]");

        // Parse with Bun.TOML
        const parsed = Bun.TOML.parse(updatedContent) as Record<string, unknown>;
        expect(parsed.model).toBe("gpt-4o");
        expect((parsed.model_providers as Record<string, unknown>).openrouter).toBeDefined();
        expect((parsed.model_providers as Record<string, unknown>).anthropic_direct).toBeDefined();
        expect((parsed.plugins as Record<string, unknown>).enabled).toBe(true);
        expect(Array.isArray((parsed.skills as Record<string, unknown>).config)).toBe(true);
        expect(((parsed.skills as Record<string, unknown>).config as unknown[])).toHaveLength(2);

        // 2. Modify the existing server
        writeCodexTomlServer(mcpCustomPaths.codex_global!, {
          ...newServer,
          id: "existing_tool",
          args: ["mcp-existing-tool", "--updated"],
          enabled: false,
        });

        const modifiedContent = readFileSync(mcpCustomPaths.codex_global!, "utf8");
        const modifiedParsed = Bun.TOML.parse(modifiedContent) as Record<string, unknown>;
        const existingToolConf = (modifiedParsed.mcp_servers as Record<string, unknown>).existing_tool as Record<string, unknown>;
        expect(existingToolConf.args).toEqual(["mcp-existing-tool", "--updated"]);
        expect(existingToolConf.enabled).toBe(false);

        // 3. Delete the newly added server
        writeCodexTomlServer(mcpCustomPaths.codex_global!, newServer, { remove: true });

        const afterDeleteContent = readFileSync(mcpCustomPaths.codex_global!, "utf8");
        const afterDeleteParsed = Bun.TOML.parse(afterDeleteContent) as Record<string, unknown>;
        expect((afterDeleteParsed.mcp_servers as Record<string, unknown>)["complex-new-server"]).toBeUndefined();
        expect((afterDeleteParsed.mcp_servers as Record<string, unknown>).existing_tool).toBeDefined();
        expect(((afterDeleteParsed.skills as Record<string, unknown>).config as unknown[])).toHaveLength(2);
      });

      it("safely quotes complex and unusual TOML keys (dots, hyphens, unicode)", () => {
        expect(quoteTomlKey("simple_key")).toBe("simple_key");
        expect(quoteTomlKey("key-with-hyphen")).toBe("key-with-hyphen");
        expect(quoteTomlKey("key.with.dots")).toBe('"key.with.dots"');
        expect(quoteTomlKey("key with spaces")).toBe('"key with spaces"');
        expect(quoteTomlKey("key_🚀_emoji")).toBe('"key_🚀_emoji"');
      });
    });

    describe("2.3 File Lock Contention, Stale Locks & Recovery", () => {
      it("coordinates 20 concurrent write operations to the same config file without corruption", async () => {
        const targetFile = mcpCustomPaths.claude_code_global!;

        const tasks = Array.from({ length: 20 }, (_, i) => {
          const server: UnifiedMcpServer = {
            id: `worker-server-${i}`,
            client: "claude_code",
            scope: "global",
            transport: "stdio",
            command: "bun",
            args: [`--worker=${i}`],
            env: { WORKER_ID: String(i) },
            enabled: true,
          };
          return mcpManager.addServer(server, { customPaths: mcpCustomPaths });
        });

        await Promise.all(tasks);

        const all = await mcpManager.listServers({ client: "claude_code", customPaths: mcpCustomPaths });
        expect(all).toHaveLength(20);
        for (let i = 0; i < 20; i++) {
          expect(all.some((s) => s.id === `worker-server-${i}`)).toBe(true);
        }
      });

      it("recovers automatically from stale or abandoned lock files (>5000ms old or dead PID)", async () => {
        const testFile = join(tempBaseDir, "stale_test.json");
        const lockFile = `${testFile}.lock`;

        // 1. Create a stale lock file with an old timestamp and non-existent PID
        const stalePayload = {
          pid: 9999999, // Unlikely to exist
          createdAt: Date.now() - 10000, // 10 seconds ago (exceeds 5000ms staleTimeout)
          filePath: testFile,
        };
        writeFileSync(lockFile, JSON.stringify(stalePayload), "utf8");

        // Attempting to acquire lock should break stale lock and succeed
        let executed = false;
        await withFileLock(testFile, async () => {
          executed = true;
        }, { timeoutMs: 1000, retryIntervalMs: 10, staleTimeoutMs: 5000 });

        expect(executed).toBe(true);
      });

      it("recovers automatically from corrupted lock files with invalid JSON payload", async () => {
        const testFile = join(tempBaseDir, "corrupt_lock_test.json");
        const lockFile = `${testFile}.lock`;

        // Create corrupt lock file
        writeFileSync(lockFile, "GARBAGE_PAYLOAD_NOT_JSON", "utf8");

        let executed = false;
        await withFileLock(testFile, async () => {
          executed = true;
        }, { timeoutMs: 1000, retryIntervalMs: 10 });

        expect(executed).toBe(true);
      });

      it("throws McpLockError when lock acquisition times out", async () => {
        const testFile = join(tempBaseDir, "timeout_test.json");

        // Hold the lock in one operation
        const activeLock = await acquireFileLock(testFile);

        try {
          // Second operation with short timeout must fail
          await expect(
            acquireFileLock(testFile, { timeoutMs: 80, retryIntervalMs: 20 }),
          ).rejects.toThrow(McpLockError);
        } finally {
          releaseFileLock(activeLock);
        }
      });
    });

    describe("2.4 Cross-Client Conversion Extremes & Boundary Validation", () => {
      it("validates server IDs strictly and rejects blank or malicious characters", () => {
        const invalidIds = ["", "  ", "server with space", "server/slash", "server;semicolon", "server&and", "server<tag>"];
        for (const id of invalidIds) {
          expect(() => validateServerDefinition({ id, command: "node", transport: "stdio" })).toThrow(
            McpValidationError,
          );
        }

        const validIds = ["my-server", "my_server", "server.1", "SERVER-v2.0_test"];
        for (const id of validIds) {
          expect(() => validateServerDefinition({ id, command: "node", transport: "stdio" })).not.toThrow();
        }
      });

      it("rejects stdio servers with missing/empty command and remote servers with invalid URL", () => {
        expect(() => validateServerDefinition({ id: "s1", transport: "stdio", command: "" })).toThrow(
          /must specify a non-empty 'command'/,
        );
        expect(() => validateServerDefinition({ id: "s1", transport: "stdio", command: "   " })).toThrow(
          /must specify a non-empty 'command'/,
        );

        expect(() => validateServerDefinition({ id: "s2", transport: "sse", url: "" })).toThrow(
          /must specify a non-empty 'url'/,
        );
        expect(() => validateServerDefinition({ id: "s2", transport: "sse", url: "not-a-valid-url" })).toThrow(
          /specifies invalid URL/,
        );
      });

      it("correctly handles extreme multiline strings, PEM keys, and unicode environment variables across all clients", async () => {
        const pemKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3w1234567890abcdef
+multiline+key/with/special/chars==
-----END RSA PRIVATE KEY-----`;

        const complexServer: UnifiedMcpServer = {
          id: "extreme-server-key",
          client: "claude_desktop",
          scope: "global",
          transport: "stdio",
          command: "python3",
          args: ["-u", "-c", "import sys; print('hello world')"],
          env: {
            PRIVATE_KEY: pemKey,
            UNICODE_MSG: "こんにちは世界 🌍 🚀",
            COMPLEX_JSON: JSON.stringify({ nested: { array: [1, 2, 3], flag: true } }),
          },
          enabled: true,
        };

        // Add to Claude Desktop
        await mcpManager.addServer(complexServer, { customPaths: mcpCustomPaths });

        // Clone to Codex
        const clonedCodex = await mcpManager.cloneServer({
          fromClient: "claude_desktop",
          toClient: "codex",
          serverId: "extreme-server-key",
          customPaths: mcpCustomPaths,
        });

        expect(clonedCodex.client).toBe("codex");
        expect(clonedCodex.env.PRIVATE_KEY).toBe(pemKey);
        expect(clonedCodex.env.UNICODE_MSG).toBe("こんにちは世界 🌍 🚀");

        // Clone to Claude Code
        const clonedClaudeCode = await mcpManager.cloneServer({
          fromClient: "codex",
          toClient: "claude_code",
          serverId: "extreme-server-key",
          newId: "extreme-claude-code",
          customPaths: mcpCustomPaths,
        });
        expect(clonedClaudeCode.id).toBe("extreme-claude-code");
        expect(clonedClaudeCode.env.PRIVATE_KEY).toBe(pemKey);

        // Clone to Antigravity
        const clonedAntigravity = await mcpManager.cloneServer({
          fromClient: "claude_code",
          toClient: "antigravity",
          serverId: "extreme-claude-code",
          newId: "extreme-antigravity",
          customPaths: mcpCustomPaths,
        });
        expect(clonedAntigravity.id).toBe("extreme-antigravity");
        expect(clonedAntigravity.env.UNICODE_MSG).toBe("こんにちは世界 🌍 🚀");
      });

      it("enforces conflict detection on cloning unless overwrite: true is explicitly provided", async () => {
        const sourceServer: UnifiedMcpServer = {
          id: "clone-source",
          client: "claude_desktop",
          scope: "global",
          transport: "stdio",
          command: "node",
          args: ["./cli.js"],
          env: {},
          enabled: true,
        };
        await mcpManager.addServer(sourceServer, { customPaths: mcpCustomPaths });

        // First clone to codex succeeds
        await mcpManager.cloneServer({
          fromClient: "claude_desktop",
          toClient: "codex",
          serverId: "clone-source",
          customPaths: mcpCustomPaths,
        });

        // Second clone with same target ID fails with McpConflictError
        await expect(
          mcpManager.cloneServer({
            fromClient: "claude_desktop",
            toClient: "codex",
            serverId: "clone-source",
            customPaths: mcpCustomPaths,
          }),
        ).rejects.toThrow(McpConflictError);

        // With overwrite: true -> succeeds
        const overwritten = await mcpManager.cloneServer({
          fromClient: "claude_desktop",
          toClient: "codex",
          serverId: "clone-source",
          overwrite: true,
          customPaths: mcpCustomPaths,
        });
        expect(overwritten.id).toBe("clone-source");
      });
    });
  });
});

function codexLinkOrPath(p: string): string {
  return p;
}
