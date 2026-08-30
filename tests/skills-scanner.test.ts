import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillsDirectories, scanSingleSkill, scanSkillsSync } from "../src/skills/scanner";
import { createDirectorySymlink } from "../src/skills/symlinks";
import { writeSkillToDir } from "../src/skills/parser";
import type { SkillsDirectoryConfig } from "../src/skills/types";

describe("Skills Scanner & Multi-Agent Discovery Suite", () => {
  let tempBase: string;
  let config: SkillsDirectoryConfig;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-scanner-test-"));
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
      // Ignore
    }
  });

  test("handles empty and non-existent directories gracefully", () => {
    const skills = scanSkillsSync(config);
    expect(skills).toEqual([]);
  });

  test("discovers central skills and correctly maps client symlinks", () => {
    const { centralDir, claudeDir, codexDir } = resolveSkillsDirectories(config);

    const skillPath = join(centralDir, "git-helper");
    writeSkillToDir(
      skillPath,
      {
        name: "git-helper",
        description: "Git automation workflow",
        tags: ["git", "vcs"],
        version: "1.0.0",
      },
      "# Git Helper Body"
    );

    // Symlink to claude and codex
    createDirectorySymlink(skillPath, join(claudeDir, "git-helper"));
    createDirectorySymlink(skillPath, join(codexDir, "git-helper"));

    const skills = scanSkillsSync(config);
    expect(skills.length).toBe(1);

    const skill = skills[0]!;
    expect(skill.name).toBe("git-helper");
    expect(skill.metadata.tags).toEqual(["git", "vcs"]);
    expect(skill.linkedAgents.sort()).toEqual(["claude", "codex"].sort());
    expect(skill.isSymlink).toBe(false);
  });

  test("isolates and tags Codex .system skills with isSystem: true", () => {
    const { systemSkillsDir, centralDir } = resolveSkillsDirectories(config);

    // 1 regular skill in central
    writeSkillToDir(
      join(centralDir, "user-skill"),
      { name: "user-skill", description: "User custom skill" },
      "User content"
    );

    // 3 system skills in .system
    const systemNames = ["imagegen", "openai-docs", "review-agent"];
    for (const name of systemNames) {
      writeSkillToDir(
        join(systemSkillsDir, name),
        { name, description: `System runtime for ${name}` },
        `System content for ${name}`
      );
    }

    const skills = scanSkillsSync(config);
    expect(skills.length).toBe(4);

    const userSkill = skills.find((s) => s.name === "user-skill");
    expect(userSkill).toBeDefined();
    expect(userSkill?.isSystem).toBe(false);

    for (const name of systemNames) {
      const sysSkill = skills.find((s) => s.name === `system:${name}`);
      expect(sysSkill).toBeDefined();
      expect(sysSkill?.isSystem).toBe(true);
      expect(sysSkill?.linkedAgents).toEqual(["codex"]);
    }
  });

  test("scans project-scoped skills and merges them", () => {
    const { projectDir } = resolveSkillsDirectories(config);

    writeSkillToDir(
      join(projectDir, "project-local-skill"),
      { name: "project-local-skill", description: "Scoped to project repo" },
      "Project only"
    );

    const skills = scanSkillsSync(config);
    expect(skills.length).toBe(1);
    expect(skills[0]?.name).toBe("project-local-skill");
    expect(skills[0]?.linkedAgents).toEqual(["project"]);
  });

  test("scanSingleSkill finds exact skill by name", () => {
    const { centralDir } = resolveSkillsDirectories(config);
    writeSkillToDir(
      join(centralDir, "targeted-skill"),
      { name: "targeted-skill", description: "Target" },
      "Target content"
    );

    const found = scanSingleSkill("targeted-skill", config);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("targeted-skill");

    const notFound = scanSingleSkill("non-existent", config);
    expect(notFound).toBeNull();
  });
});
