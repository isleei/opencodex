import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  restoreSkill,
  syncSkills,
  toggleSkill,
  updateSkill,
  SkillsManager,
} from "../src/skills/manager";
import {
  parseSkillFrontmatter,
  readSkillFromDir,
  serializeSkill,
  writeSkillToDir,
} from "../src/skills/parser";
import { resolveSkillsDirectories, scanSkillsSync } from "../src/skills/scanner";
import {
  createDirectorySymlink,
  getSymlinkTarget,
  isDanglingSymlink,
  isSymlink,
  removeSymlink,
  repairDanglingSymlink,
} from "../src/skills/symlinks";
import { computeSkillContentHash, deduplicateAndMigrateSkills } from "../src/skills/dedup";
import { listTrashRecords, restoreSkillFromTrash, toggleSkillState, trashSkill } from "../src/skills/trash";
import type { SkillsDirectoryConfig } from "../src/skills/types";

describe("Skills Engine - Unit & Integration Test Suite", () => {
  let tempBase: string;
  let config: SkillsDirectoryConfig;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-skills-test-"));
    config = {
      centralDir: join(tempBase, ".agents", "skills"),
      claudeDir: join(tempBase, ".claude", "skills"),
      codexDir: join(tempBase, ".codex", "skills"),
      projectDir: join(tempBase, "workspace", ".agents", "skills"),
      trashDir: join(tempBase, ".agents", ".trash", "skills"),
      systemSkillsDir: join(tempBase, ".codex", "skills", ".system"),
    };
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // -------------------------------------------------------------
  // 1. Frontmatter Parser & Serializer
  // -------------------------------------------------------------
  describe("Parser & Serializer", () => {
    test("parses standard frontmatter with all fields correctly", () => {
      const markdown = `---
name: code-reviewer
description: Automated code review guidelines
tags:
  - review
  - quality
version: 2.1.0
author: OpenCodex Team
source: https://github.com/opencodex/skills
disabled: false
---

# Code Reviewer Instructions

Always review carefully for edge cases.`;

      const parsed = parseSkillFrontmatter(markdown, "default-name");
      expect(parsed.metadata.name).toBe("code-reviewer");
      expect(parsed.metadata.description).toBe("Automated code review guidelines");
      expect(parsed.metadata.tags).toEqual(["review", "quality"]);
      expect(parsed.metadata.version).toBe("2.1.0");
      expect(parsed.metadata.author).toBe("OpenCodex Team");
      expect(parsed.metadata.source).toBe("https://github.com/opencodex/skills");
      expect(parsed.metadata.disabled).toBe(false);
      expect(parsed.content).toContain("# Code Reviewer Instructions");
      expect(parsed.content).toContain("Always review carefully for edge cases.");
    });

    test("handles missing frontmatter gracefully and falls back to provided name", () => {
      const plainMarkdown = "# Just Markdown\n\nNo frontmatter here.";
      const parsed = parseSkillFrontmatter(plainMarkdown, "fallback-skill");
      expect(parsed.metadata.name).toBe("fallback-skill");
      expect(parsed.metadata.description).toBe("");
      expect(parsed.metadata.disabled).toBe(false);
      expect(parsed.content).toBe(plainMarkdown);
    });

    test("handles comma-separated tags in frontmatter", () => {
      const markdown = `---
name: tag-test
description: Testing tags
tags: a, b, c
---
Body text`;
      const parsed = parseSkillFrontmatter(markdown);
      expect(parsed.metadata.tags).toEqual(["a", "b", "c"]);
    });

    test("round-trips serialization and parsing losslessly", () => {
      const metadata = {
        name: "round-trip-skill",
        description: "Testing round-trip serialization",
        tags: ["tool", "ci"],
        version: "1.0.0",
        author: "Dev",
        source: "https://example.com",
        disabled: true,
        customProp: "preserved",
      };
      const body = "## Step 1\nRun the command.\n\n## Step 2\nVerify.";

      const serialized = serializeSkill(metadata, body);
      expect(serialized.startsWith("---\n")).toBe(true);
      expect(serialized).toContain("disabled: true");

      const reparsed = parseSkillFrontmatter(serialized);
      expect(reparsed.metadata.name).toBe("round-trip-skill");
      expect(reparsed.metadata.description).toBe("Testing round-trip serialization");
      expect(reparsed.metadata.tags).toEqual(["tool", "ci"]);
      expect(reparsed.metadata.disabled).toBe(true);
      expect(reparsed.metadata.customProp).toBe("preserved");
      expect(reparsed.content.trim()).toBe(body);
    });

    test("reads and writes SKILL.md to physical directory", () => {
      const skillDir = join(tempBase, "skill-io-test");
      const metadata = {
        name: "io-test",
        description: "Testing file write",
        tags: ["io"],
      };
      const content = "Test body content";

      writeSkillToDir(skillDir, metadata, content);
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

      const loaded = readSkillFromDir(skillDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.metadata.name).toBe("io-test");
      expect(loaded?.content.trim()).toBe("Test body content");
    });
  });

  // -------------------------------------------------------------
  // 2. Symlinks & Cross-Platform Conventions
  // -------------------------------------------------------------
  describe("Symlink Management", () => {
    test("creates directory symlink and detects symlink properties", () => {
      const targetDir = join(tempBase, "real-skill");
      const linkPath = join(tempBase, "linked-skill");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "SKILL.md"), "# Skill");

      createDirectorySymlink(targetDir, linkPath);

      expect(isSymlink(linkPath)).toBe(true);
      expect(isSymlink(targetDir)).toBe(false);
      expect(existsSync(join(linkPath, "SKILL.md"))).toBe(true);
      expect(getSymlinkTarget(linkPath)).toBe(targetDir);
    });

    test("detects dangling symlink and repairs it", () => {
      const targetDir = join(tempBase, "temporary-target");
      const newTargetDir = join(tempBase, "new-valid-target");
      const linkPath = join(tempBase, "dangling-link");

      mkdirSync(targetDir, { recursive: true });
      mkdirSync(newTargetDir, { recursive: true });

      createDirectorySymlink(targetDir, linkPath);
      expect(isDanglingSymlink(linkPath)).toBe(false);

      // Remove target to make symlink dangling
      rmSync(targetDir, { recursive: true, force: true });
      expect(isDanglingSymlink(linkPath)).toBe(true);

      // Repair
      const repaired = repairDanglingSymlink(linkPath, newTargetDir);
      expect(repaired).toBe(true);
      expect(isDanglingSymlink(linkPath)).toBe(false);
      expect(getSymlinkTarget(linkPath)).toBe(newTargetDir);
    });

    test("safely removes symlink without affecting target folder", () => {
      const targetDir = join(tempBase, "protected-target");
      const linkPath = join(tempBase, "removable-link");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "important.txt"), "keep this");

      createDirectorySymlink(targetDir, linkPath);
      const removed = removeSymlink(linkPath);

      expect(removed).toBe(true);
      expect(existsSync(linkPath)).toBe(false);
      expect(existsSync(targetDir)).toBe(true);
      expect(readFileSync(join(targetDir, "important.txt"), "utf8")).toBe("keep this");
    });
  });

  // -------------------------------------------------------------
  // 3. Multi-Agent Scanner & Isolation
  // -------------------------------------------------------------
  describe("Scanner & System Skill Guard", () => {
    test("gracefully returns empty list when directories do not exist", () => {
      const emptyConfig: SkillsDirectoryConfig = {
        centralDir: join(tempBase, "nonexistent-central"),
        claudeDir: join(tempBase, "nonexistent-claude"),
        codexDir: join(tempBase, "nonexistent-codex"),
      };
      const skills = scanSkillsSync(emptyConfig);
      expect(skills).toEqual([]);
    });

    test("scans central skills, links, and isolates codex system skills", () => {
      const { centralDir, claudeDir, codexDir, systemSkillsDir } = resolveSkillsDirectories(config);

      // 1. Create central skill
      const centralSkillDir = join(centralDir, "general-helper");
      writeSkillToDir(
        centralSkillDir,
        { name: "general-helper", description: "A general helper skill" },
        "Helper instructions"
      );

      // 2. Link central skill to Claude and Codex
      createDirectorySymlink(centralSkillDir, join(claudeDir, "general-helper"));
      createDirectorySymlink(centralSkillDir, join(codexDir, "general-helper"));

      // 3. Create system skill in .system directory
      const sysSkillDir = join(systemSkillsDir, "imagegen");
      writeSkillToDir(
        sysSkillDir,
        { name: "imagegen", description: "Internal OpenAI imagegen skill" },
        "System prompt"
      );

      const skills = scanSkillsSync(config);

      // Should find 2 skills
      expect(skills.length).toBe(2);

      const helperSkill = skills.find((s) => s.name === "general-helper");
      expect(helperSkill).toBeDefined();
      expect(helperSkill?.isSystem).toBe(false);
      expect(helperSkill?.linkedAgents).toContain("claude");
      expect(helperSkill?.linkedAgents).toContain("codex");

      const systemSkill = skills.find((s) => s.name === "system:imagegen");
      expect(systemSkill).toBeDefined();
      expect(systemSkill?.isSystem).toBe(true);
      expect(systemSkill?.linkedAgents).toEqual(["codex"]);
    });
  });

  // -------------------------------------------------------------
  // 4. Deduplication & Migration
  // -------------------------------------------------------------
  describe("Deduplication & Migration Algorithm", () => {
    test("computes deterministic content hash across files", () => {
      const skillDir1 = join(tempBase, "hash-test-1");
      const skillDir2 = join(tempBase, "hash-test-2");

      writeSkillToDir(skillDir1, { name: "test", description: "desc" }, "Body");
      writeSkillToDir(skillDir2, { name: "test", description: "desc" }, "Body");

      const hash1 = computeSkillContentHash(skillDir1);
      const hash2 = computeSkillContentHash(skillDir2);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA256 hex length
    });

    test("migrates unlinked physical skill from Claude directory to Central and symlinks it", async () => {
      const { centralDir, claudeDir } = resolveSkillsDirectories(config);

      // Physical skill only in ~/.claude/skills/claude-special
      const clientSkillDir = join(claudeDir, "claude-special");
      writeSkillToDir(
        clientSkillDir,
        { name: "claude-special", description: "Unique to Claude" },
        "Claude specific instructions"
      );

      const result = await deduplicateAndMigrateSkills({ config });

      expect(result.migrated).toContain("claude-special");

      // Physical folder should now be in central
      const centralSkillDir = join(centralDir, "claude-special");
      expect(existsSync(centralSkillDir)).toBe(true);
      expect(isSymlink(centralSkillDir)).toBe(false);

      // Client folder should now be a symlink
      expect(isSymlink(clientSkillDir)).toBe(true);
      expect(getSymlinkTarget(clientSkillDir)).toBe(centralSkillDir);
    });

    test("deduplicates identical physical folder in client and replaces with symlink", async () => {
      const { centralDir, claudeDir, codexDir } = resolveSkillsDirectories(config);

      // Same skill in Central and Codex physically
      const centralSkillDir = join(centralDir, "shared-tool");
      writeSkillToDir(centralSkillDir, { name: "shared-tool", description: "Shared" }, "Shared body");

      const codexSkillDir = join(codexDir, "shared-tool");
      writeSkillToDir(codexSkillDir, { name: "shared-tool", description: "Shared" }, "Shared body");

      const result = await deduplicateAndMigrateSkills({ config });

      expect(result.deduped).toContain("codex:shared-tool");
      expect(isSymlink(codexSkillDir)).toBe(true);
      expect(getSymlinkTarget(codexSkillDir)).toBe(centralSkillDir);
    });

    test("handles conflict by creating backup in trash and establishing link", async () => {
      const { centralDir, claudeDir, trashDir } = resolveSkillsDirectories(config);

      const centralSkillDir = join(centralDir, "conflicting-tool");
      writeSkillToDir(centralSkillDir, { name: "conflicting-tool", description: "v1 in central" }, "Central content");

      const claudeSkillDir = join(claudeDir, "conflicting-tool");
      writeSkillToDir(claudeSkillDir, { name: "conflicting-tool", description: "v2 in claude" }, "Claude variant content");

      const result = await deduplicateAndMigrateSkills({ config });

      expect(result.conflicts).toContain("claude:conflicting-tool");
      expect(isSymlink(claudeSkillDir)).toBe(true);
      expect(existsSync(trashDir)).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // 5. Trash, Safety & Restore
  // -------------------------------------------------------------
  describe("Trash & Safe Operations", () => {
    test("rejects deletion of protected system skills", async () => {
      await expect(trashSkill("system:imagegen", config)).rejects.toThrow("Cannot delete protected system skill");
    });

    test("moves deleted skill to trash, unlinks client symlinks, and records manifest", async () => {
      const { centralDir, claudeDir, codexDir, trashDir } = resolveSkillsDirectories(config);

      const skillDir = join(centralDir, "to-delete");
      writeSkillToDir(skillDir, { name: "to-delete", description: "Will be deleted" }, "Content");

      const claudeLink = join(claudeDir, "to-delete");
      const codexLink = join(codexDir, "to-delete");
      createDirectorySymlink(skillDir, claudeLink);
      createDirectorySymlink(skillDir, codexLink);

      const record = await trashSkill("to-delete", config);

      expect(record.skillName).toBe("to-delete");
      expect(existsSync(skillDir)).toBe(false);
      expect(existsSync(claudeLink)).toBe(false);
      expect(existsSync(codexLink)).toBe(false);

      const trashList = await listTrashRecords(config);
      expect(trashList.some((t) => t.skillName === "to-delete")).toBe(true);
    });

    test("restores deleted skill from trash and recreates client symlinks", async () => {
      const { centralDir, claudeDir } = resolveSkillsDirectories(config);

      const skillDir = join(centralDir, "to-restore");
      writeSkillToDir(skillDir, { name: "to-restore", description: "Restorable" }, "Restorable content");

      const claudeLink = join(claudeDir, "to-restore");
      createDirectorySymlink(skillDir, claudeLink);

      const record = await trashSkill("to-restore", config);
      expect(existsSync(skillDir)).toBe(false);

      const restoreResult = await restoreSkillFromTrash(record.trashId, config);
      expect(restoreResult.ok).toBe(true);
      expect(restoreResult.restored).toBe("to-restore");

      // Check physical folder restored
      expect(existsSync(skillDir)).toBe(true);
      const readBack = readSkillFromDir(skillDir);
      expect(readBack?.content.trim()).toBe("Restorable content");

      // Check client symlink restored
      expect(isSymlink(claudeLink)).toBe(true);
    });

    test("safe toggle changes frontmatter disabled state without moving files", async () => {
      const { centralDir } = resolveSkillsDirectories(config);
      const skillDir = join(centralDir, "toggle-me");
      writeSkillToDir(skillDir, { name: "toggle-me", description: "Toggle test", disabled: false }, "Body");

      const res1 = await toggleSkillState("toggle-me", false, { config });
      expect(res1.enabled).toBe(false);

      const check1 = readSkillFromDir(skillDir);
      expect(check1?.metadata.disabled).toBe(true);

      const res2 = await toggleSkillState("toggle-me", true, { config });
      expect(res2.enabled).toBe(true);

      const check2 = readSkillFromDir(skillDir);
      expect(check2?.metadata.disabled).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // 6. High-Level Manager Facade & CRUD Operations
  // -------------------------------------------------------------
  describe("Manager Facade", () => {
    test("creates, reads, updates, filters, and deletes skills via Manager", async () => {
      const manager = new SkillsManager(config);

      // 1. Create skill
      const created = await manager.create({
        name: "facade-skill",
        description: "Tested via facade",
        tags: ["facade", "test"],
        content: "# Facade Content",
      });
      expect(created.name).toBe("facade-skill");
      expect(created.metadata.description).toBe("Tested via facade");

      // 2. Read single skill
      const fetched = await manager.get("facade-skill");
      expect(fetched).not.toBeNull();
      expect(fetched?.metadata.tags).toEqual(["facade", "test"]);

      // 3. Update skill
      const updated = await manager.update("facade-skill", {
        description: "Updated description",
        tags: ["facade", "updated"],
      });
      expect(updated.metadata.description).toBe("Updated description");
      expect(updated.metadata.tags).toEqual(["facade", "updated"]);

      // 4. Filter list by tags
      const filtered = await manager.list({ tags: ["updated"] });
      expect(filtered.length).toBe(1);
      expect(filtered[0]?.name).toBe("facade-skill");

      // 5. Toggle skill
      await manager.toggle("facade-skill", false);
      const activeList = await manager.list({ status: "active" });
      expect(activeList.length).toBe(0);

      const disabledList = await manager.list({ status: "disabled" });
      expect(disabledList.length).toBe(1);

      // 6. Delete skill
      const delRes = await manager.delete("facade-skill");
      expect(delRes.ok).toBe(true);
      expect(delRes.trashId).toBeDefined();

      const listAfterDelete = await manager.list();
      expect(listAfterDelete.length).toBe(0);

      // 7. Restore skill
      if (delRes.trashId) {
        const restRes = await manager.restore(delRes.trashId);
        expect(restRes.ok).toBe(true);
        const restored = await manager.get("facade-skill");
        expect(restored).not.toBeNull();
      }
    });

    test("validates skill name on creation and rejects invalid characters", async () => {
      const manager = new SkillsManager(config);
      await expect(
        manager.create({
          name: "Invalid Skill Name with Spaces!",
          description: "Bad name",
        })
      ).rejects.toThrow("Invalid skill name");
    });

    test("searches skills by keyword in name, description, or tags", async () => {
      const manager = new SkillsManager(config);
      await manager.create({
        name: "search-alpha",
        description: "Contains unique keyword apple",
        tags: ["fruit"],
      });
      await manager.create({
        name: "search-beta",
        description: "Contains unique keyword banana",
        tags: ["fruit", "yellow"],
      });

      const appleResults = await manager.list({ search: "apple" });
      expect(appleResults.length).toBe(1);
      expect(appleResults[0]?.name).toBe("search-alpha");

      const yellowResults = await manager.list({ search: "yellow" });
      expect(yellowResults.length).toBe(1);
      expect(yellowResults[0]?.name).toBe("search-beta");
    });

    test("supports dry-run sync without mutating disk", async () => {
      const { claudeDir, centralDir } = resolveSkillsDirectories(config);
      writeSkillToDir(
        join(claudeDir, "dry-run-skill"),
        { name: "dry-run-skill", description: "Dry run test" },
        "Dry run body"
      );

      const dryRunRes = await syncSkills({ dryRun: true, config });
      expect(dryRunRes.migrated).toContain("dry-run-skill");
      // In dry-run, physical folder should NOT have been moved
      expect(existsSync(join(centralDir, "dry-run-skill"))).toBe(false);
    });

    test("permanently deletes a skill when permanent: true is passed", async () => {
      const manager = new SkillsManager(config);
      await manager.create({
        name: "perm-delete-skill",
        description: "Permanent delete test",
      });

      const delRes = await manager.delete("perm-delete-skill", { permanent: true });
      expect(delRes.ok).toBe(true);
      expect(delRes.trashId).toBe("permanent");

      const trash = await manager.listTrash();
      expect(trash.some((t) => t.skillName === "perm-delete-skill")).toBe(false);
    });
  });
});

