import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  listTrash,
  restoreSkill,
  toggleSkill,
  updateSkill,
} from "../src/skills/manager";
import { readSkillFromDir } from "../src/skills/parser";
import { resolveSkillsDirectories } from "../src/skills/scanner";
import { isSymlink } from "../src/skills/symlinks";
import type { SkillsDirectoryConfig } from "../src/skills/types";

describe("Skills Lifecycle Suite (Create -> Edit -> Toggle -> Delete -> Restore)", () => {
  let tempBase: string;
  let config: SkillsDirectoryConfig;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-lifecycle-test-"));
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

  test("full end-to-end lifecycle of a skill", async () => {
    const { centralDir, claudeDir, codexDir } = resolveSkillsDirectories(config);

    // 1. Create skill
    const created = await createSkill(
      {
        name: "e2e-workflow",
        description: "Initial description",
        tags: ["ci", "workflow"],
        version: "1.0.0",
        author: "Tester",
        content: "# Workflow Guide\n\nRun tasks automatically.",
        linkAgents: ["claude", "codex"],
      },
      config
    );

    expect(created.name).toBe("e2e-workflow");
    expect(existsSync(join(centralDir, "e2e-workflow"))).toBe(true);
    expect(isSymlink(join(claudeDir, "e2e-workflow"))).toBe(true);
    expect(isSymlink(join(codexDir, "e2e-workflow"))).toBe(true);

    // 2. Read back
    const fetched = await getSkill("e2e-workflow", config);
    expect(fetched).not.toBeNull();
    expect(fetched?.metadata.description).toBe("Initial description");
    expect(fetched?.linkedAgents.sort()).toEqual(["claude", "codex"].sort());

    // 3. Edit metadata & content
    const updated = await updateSkill(
      "e2e-workflow",
      {
        description: "Updated description v2",
        tags: ["ci", "workflow", "v2"],
        content: "# Workflow Guide v2\n\nUpdated instructions.",
      },
      config
    );

    expect(updated.metadata.description).toBe("Updated description v2");
    expect(updated.metadata.tags).toEqual(["ci", "workflow", "v2"]);
    expect(updated.content).toContain("Workflow Guide v2");

    // Check physical file updated
    const physicalData = readSkillFromDir(join(centralDir, "e2e-workflow"));
    expect(physicalData?.metadata.description).toBe("Updated description v2");
    expect(physicalData?.content).toContain("Workflow Guide v2");

    // 4. Toggle disabled
    const toggleRes1 = await toggleSkill("e2e-workflow", false, { config });
    expect(toggleRes1.enabled).toBe(false);

    const activeList = await listSkills({ status: "active", config });
    expect(activeList.some((s) => s.name === "e2e-workflow")).toBe(false);

    const disabledList = await listSkills({ status: "disabled", config });
    expect(disabledList.some((s) => s.name === "e2e-workflow")).toBe(true);

    // Toggle enabled again
    const toggleRes2 = await toggleSkill("e2e-workflow", true, { config });
    expect(toggleRes2.enabled).toBe(true);

    // 5. Delete skill (moves to trash)
    const delRes = await deleteSkill("e2e-workflow", { config });
    expect(delRes.ok).toBe(true);
    expect(delRes.trashId).toBeDefined();

    // Physical folder and symlinks should be removed from active directories
    expect(existsSync(join(centralDir, "e2e-workflow"))).toBe(false);
    expect(existsSync(join(claudeDir, "e2e-workflow"))).toBe(false);
    expect(existsSync(join(codexDir, "e2e-workflow"))).toBe(false);

    // Check in trash list
    const trashItems = await listTrash(config);
    expect(trashItems.length).toBe(1);
    expect(trashItems[0]?.skillName).toBe("e2e-workflow");

    // 6. Restore from trash
    const restoreRes = await restoreSkill(delRes.trashId!, config);
    expect(restoreRes.ok).toBe(true);
    expect(restoreRes.restored).toBe("e2e-workflow");

    // Physical folder and symlinks restored
    expect(existsSync(join(centralDir, "e2e-workflow"))).toBe(true);
    expect(isSymlink(join(claudeDir, "e2e-workflow"))).toBe(true);
    expect(isSymlink(join(codexDir, "e2e-workflow"))).toBe(true);

    const restoredData = readSkillFromDir(join(centralDir, "e2e-workflow"));
    expect(restoredData?.metadata.description).toBe("Updated description v2");
    expect(restoredData?.content).toContain("Workflow Guide v2");
  });
});
