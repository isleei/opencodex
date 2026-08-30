import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSkillContentHash, deduplicateAndMigrateSkills } from "../src/skills/dedup";
import { writeSkillToDir } from "../src/skills/parser";
import { resolveSkillsDirectories } from "../src/skills/scanner";
import { createDirectorySymlink, getSymlinkTarget, isSymlink } from "../src/skills/symlinks";
import type { SkillsDirectoryConfig } from "../src/skills/types";

describe("Skills Deduplication & Migration Suite", () => {
  let tempBase: string;
  let config: SkillsDirectoryConfig;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-dedup-test-"));
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

  test("calculates identical content hash for identical directory trees", () => {
    const dirA = join(tempBase, "skill-a");
    const dirB = join(tempBase, "skill-b");

    writeSkillToDir(dirA, { name: "test-skill", description: "identical" }, "Identical body");
    writeSkillToDir(dirB, { name: "test-skill", description: "identical" }, "Identical body");

    mkdirSync(join(dirA, "scripts"), { recursive: true });
    mkdirSync(join(dirB, "scripts"), { recursive: true });
    writeFileSync(join(dirA, "scripts", "run.sh"), "#!/bin/bash\necho 1");
    writeFileSync(join(dirB, "scripts", "run.sh"), "#!/bin/bash\necho 1");

    const hashA = computeSkillContentHash(dirA);
    const hashB = computeSkillContentHash(dirB);

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe("");
  });

  test("calculates different content hash when files differ", () => {
    const dirA = join(tempBase, "skill-a");
    const dirB = join(tempBase, "skill-b");

    writeSkillToDir(dirA, { name: "test-skill", description: "identical" }, "Content Version 1");
    writeSkillToDir(dirB, { name: "test-skill", description: "identical" }, "Content Version 2");

    const hashA = computeSkillContentHash(dirA);
    const hashB = computeSkillContentHash(dirB);

    expect(hashA).not.toBe(hashB);
  });

  test("migrates unique skills from both claude and codex to central store", async () => {
    const { centralDir, claudeDir, codexDir } = resolveSkillsDirectories(config);

    // claude has skill-1
    writeSkillToDir(
      join(claudeDir, "skill-1"),
      { name: "skill-1", description: "from claude" },
      "Claude skill body"
    );

    // codex has skill-2
    writeSkillToDir(
      join(codexDir, "skill-2"),
      { name: "skill-2", description: "from codex" },
      "Codex skill body"
    );

    const result = await deduplicateAndMigrateSkills({ config });

    expect(result.migrated.sort()).toEqual(["skill-1", "skill-2"].sort());

    // Both should now be physical in central
    expect(existsSync(join(centralDir, "skill-1"))).toBe(true);
    expect(isSymlink(join(centralDir, "skill-1"))).toBe(false);

    expect(existsSync(join(centralDir, "skill-2"))).toBe(true);
    expect(isSymlink(join(centralDir, "skill-2"))).toBe(false);

    // Both should be symlinked in claude and codex
    expect(isSymlink(join(claudeDir, "skill-1"))).toBe(true);
    expect(isSymlink(join(codexDir, "skill-1"))).toBe(true);

    expect(isSymlink(join(claudeDir, "skill-2"))).toBe(true);
    expect(isSymlink(join(codexDir, "skill-2"))).toBe(true);
  });

  test("deduplicates identical physical folders without data loss", async () => {
    const { centralDir, claudeDir, codexDir } = resolveSkillsDirectories(config);

    const content = "Exact duplicate markdown content across all agents.";
    writeSkillToDir(join(centralDir, "common-skill"), { name: "common-skill", description: "Common" }, content);
    writeSkillToDir(join(claudeDir, "common-skill"), { name: "common-skill", description: "Common" }, content);
    writeSkillToDir(join(codexDir, "common-skill"), { name: "common-skill", description: "Common" }, content);

    const result = await deduplicateAndMigrateSkills({ config });

    expect(result.deduped).toContain("claude:common-skill");
    expect(result.deduped).toContain("codex:common-skill");

    expect(isSymlink(join(claudeDir, "common-skill"))).toBe(true);
    expect(isSymlink(join(codexDir, "common-skill"))).toBe(true);
    expect(readFileSync(join(claudeDir, "common-skill", "SKILL.md"), "utf8")).toContain(content);
  });

  test("repairs dangling symlinks during sync", async () => {
    const { centralDir, claudeDir } = resolveSkillsDirectories(config);

    // Create central skill
    const centralSkill = join(centralDir, "valid-skill");
    writeSkillToDir(centralSkill, { name: "valid-skill", description: "Valid" }, "Body");

    // Create dangling symlink in claude pointing to a non-existent path
    const fakePath = join(tempBase, "fake-skill-path");
    createDirectorySymlink(fakePath, join(claudeDir, "valid-skill"));

    const result = await deduplicateAndMigrateSkills({ config });

    expect(result.broken).toContain("claude:valid-skill");
    // Repaired to point to central skill
    expect(isSymlink(join(claudeDir, "valid-skill"))).toBe(true);
    expect(getSymlinkTarget(join(claudeDir, "valid-skill"))).toBe(centralSkill);
  });
});
