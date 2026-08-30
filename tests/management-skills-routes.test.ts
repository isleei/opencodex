import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import type { SkillsDirectoryConfig } from "../src/skills/types";

describe("Management Skills REST API (/api/skills/*)", () => {
  let tempBase: string;
  let skillsConfig: SkillsDirectoryConfig;
  let baseConfig: OcxConfig;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-mgmt-skills-test-"));
    skillsConfig = {
      centralDir: join(tempBase, "agents", "skills"),
      claudeDir: join(tempBase, "claude", "skills"),
      codexDir: join(tempBase, "codex", "skills"),
      projectDir: join(tempBase, "project", ".agents", "skills"),
      trashDir: join(tempBase, "agents", ".trash", "skills"),
      systemSkillsDir: join(tempBase, "codex", "skills", ".system"),
    };
    baseConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function dispatchRequest(
    method: string,
    pathname: string,
    body?: unknown,
    searchParams?: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    if (searchParams) {
      for (const [k, v] of Object.entries(searchParams)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      host: "127.0.0.1:10100",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const req = new Request(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const deps: ManagementApiDeps = {
      skillsConfig,
    };

    const res = await handleManagementAPI(req, url, baseConfig, deps);
    if (!res) {
      throw new Error(`Route not handled: ${method} ${pathname}`);
    }

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    return { status: res.status, body: parsed };
  }

  test("GET /api/skills returns empty list on clean directory", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/skills");
    expect(status).toBe(200);
    expect(body).toEqual({ skills: [] });
  });

  test("POST /api/skills creates skill in central store and links to agents", async () => {
    const createRes = await dispatchRequest("POST", "/api/skills", {
      name: "git-master",
      description: "Advanced Git workflows and rebase helpers",
      tags: ["git", "vcs"],
      version: "1.2.0",
      author: "OpenCodex Team",
      content: "# Git Master\n\nInstructions for git.",
    });

    expect(createRes.status).toBe(200);
    expect(createRes.body.ok).toBe(true);
    expect(createRes.body.skill.name).toBe("git-master");
    expect(createRes.body.skill.metadata.tags).toEqual(["git", "vcs"]);
    expect(createRes.body.skill.linkedAgents).toContain("claude");
    expect(createRes.body.skill.linkedAgents).toContain("codex");

    // Verify physical file creation
    const centralSkillPath = join(skillsConfig.centralDir!, "git-master", "SKILL.md");
    expect(existsSync(centralSkillPath)).toBe(true);

    // Verify symlink creation in client dirs
    expect(existsSync(join(skillsConfig.claudeDir!, "git-master"))).toBe(true);
    expect(existsSync(join(skillsConfig.codexDir!, "git-master"))).toBe(true);

    // List skills to confirm
    const listRes = await dispatchRequest("GET", "/api/skills");
    expect(listRes.status).toBe(200);
    expect(listRes.body.skills).toHaveLength(1);
    expect(listRes.body.skills[0].name).toBe("git-master");
  });

  test("POST /api/skills returns 400 for invalid name and 409 for duplicate", async () => {
    const invalidNameRes = await dispatchRequest("POST", "/api/skills", {
      name: "INVALID/NAME@!",
      description: "Invalid",
    });
    expect(invalidNameRes.status).toBe(400);

    // Create first skill
    await dispatchRequest("POST", "/api/skills", {
      name: "test-skill",
      description: "First",
    });

    // Try creating duplicate
    const duplicateRes = await dispatchRequest("POST", "/api/skills", {
      name: "test-skill",
      description: "Duplicate",
    });
    expect(duplicateRes.status).toBe(409);
  });

  test("GET /api/skills/:name retrieves skill detail and markdown", async () => {
    await dispatchRequest("POST", "/api/skills", {
      name: "debug-helper",
      description: "Debugging tools",
      content: "# Debugging\nStep 1: Inspect logs",
    });

    const getRes = await dispatchRequest("GET", "/api/skills/debug-helper");
    expect(getRes.status).toBe(200);
    expect(getRes.body.skill.name).toBe("debug-helper");
    expect(getRes.body.skill.content).toContain("Step 1: Inspect logs");

    // 404 for non-existent
    const notFoundRes = await dispatchRequest("GET", "/api/skills/non-existent");
    expect(notFoundRes.status).toBe(404);
  });

  test("PUT /api/skills/:name updates frontmatter and content", async () => {
    await dispatchRequest("POST", "/api/skills", {
      name: "code-review",
      description: "Initial description",
      tags: ["review"],
      content: "Initial body",
    });

    const updateRes = await dispatchRequest("PUT", "/api/skills/code-review", {
      description: "Updated description",
      tags: ["review", "qa"],
      content: "Updated body with new instructions",
      version: "2.0.0",
    });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.ok).toBe(true);
    expect(updateRes.body.skill.metadata.description).toBe("Updated description");
    expect(updateRes.body.skill.metadata.tags).toEqual(["review", "qa"]);
    expect(updateRes.body.skill.content).toBe("Updated body with new instructions");

    // Verify on-disk persistence
    const reGet = await dispatchRequest("GET", "/api/skills/code-review");
    expect(reGet.body.skill.metadata.version).toBe("2.0.0");
  });

  test("POST /api/skills/:name/toggle toggles active status", async () => {
    await dispatchRequest("POST", "/api/skills", {
      name: "toggle-me",
      description: "Toggle test",
    });

    // Disable
    const disableRes = await dispatchRequest("POST", "/api/skills/toggle-me/toggle", {
      enabled: false,
    });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.ok).toBe(true);
    expect(disableRes.body.enabled).toBe(false);

    let getRes = await dispatchRequest("GET", "/api/skills/toggle-me");
    expect(getRes.body.skill.metadata.disabled).toBe(true);

    // Re-enable
    const enableRes = await dispatchRequest("POST", "/api/skills/toggle-me/toggle", {
      enabled: true,
    });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.enabled).toBe(true);

    getRes = await dispatchRequest("GET", "/api/skills/toggle-me");
    expect(getRes.body.skill.metadata.disabled).toBe(false);
  });

  test("DELETE /api/skills/:name moves to trash and unlinks symlinks", async () => {
    await dispatchRequest("POST", "/api/skills", {
      name: "trash-me",
      description: "Trash candidate",
    });

    expect(existsSync(join(skillsConfig.centralDir!, "trash-me"))).toBe(true);
    expect(existsSync(join(skillsConfig.claudeDir!, "trash-me"))).toBe(true);

    // Delete
    const deleteRes = await dispatchRequest("DELETE", "/api/skills/trash-me");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
    expect(deleteRes.body.trashId).toBeTruthy();

    // Central folder and symlinks should be removed
    expect(existsSync(join(skillsConfig.centralDir!, "trash-me"))).toBe(false);
    expect(existsSync(join(skillsConfig.claudeDir!, "trash-me"))).toBe(false);

    // GET /api/skills/trash lists the trashed skill
    const trashListRes = await dispatchRequest("GET", "/api/skills/trash");
    expect(trashListRes.status).toBe(200);
    expect(trashListRes.body.items).toHaveLength(1);
    expect(trashListRes.body.items[0].skillName).toBe("trash-me");

    // POST /api/skills/trash/restore restores it
    const restoreRes = await dispatchRequest("POST", "/api/skills/trash/restore", {
      trashId: deleteRes.body.trashId,
    });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.ok).toBe(true);
    expect(restoreRes.body.restored).toBe("trash-me");

    // Re-linked in central and client dirs
    expect(existsSync(join(skillsConfig.centralDir!, "trash-me"))).toBe(true);
    expect(existsSync(join(skillsConfig.claudeDir!, "trash-me"))).toBe(true);
  });

  test("POST /api/skills/sync executes deduplication and migration", async () => {
    // Manually place an unlinked physical skill in Claude directory
    const unlinkedDir = join(skillsConfig.claudeDir!, "unlinked-skill");
    require("node:fs").mkdirSync(unlinkedDir, { recursive: true });
    writeFileSync(join(unlinkedDir, "SKILL.md"), "---\nname: unlinked-skill\ndescription: Unlinked\n---\n# Unlinked", "utf8");

    const syncRes = await dispatchRequest("POST", "/api/skills/sync", {
      migrate: true,
    });

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.migrated).toContain("unlinked-skill");
    expect(existsSync(join(skillsConfig.centralDir!, "unlinked-skill"))).toBe(true);
  });

  test("GET /api/skills query filtering by status, search, and tags", async () => {
    await dispatchRequest("POST", "/api/skills", {
      name: "react-tool",
      description: "Frontend tools for React",
      tags: ["frontend", "react"],
    });

    await dispatchRequest("POST", "/api/skills", {
      name: "node-backend",
      description: "Backend tools for Node",
      tags: ["backend", "node"],
    });

    // Disable node-backend
    await dispatchRequest("POST", "/api/skills/node-backend/toggle", { enabled: false });

    // Status filter
    const activeRes = await dispatchRequest("GET", "/api/skills", undefined, { status: "active" });
    expect(activeRes.body.skills).toHaveLength(1);
    expect(activeRes.body.skills[0].name).toBe("react-tool");

    const disabledRes = await dispatchRequest("GET", "/api/skills", undefined, { status: "disabled" });
    expect(disabledRes.body.skills).toHaveLength(1);
    expect(disabledRes.body.skills[0].name).toBe("node-backend");

    // Search filter
    const searchRes = await dispatchRequest("GET", "/api/skills", undefined, { search: "frontend" });
    expect(searchRes.body.skills).toHaveLength(1);
    expect(searchRes.body.skills[0].name).toBe("react-tool");

    // Tags filter
    const tagRes = await dispatchRequest("GET", "/api/skills", undefined, { tags: "backend" });
    expect(tagRes.body.skills).toHaveLength(1);
    expect(tagRes.body.skills[0].name).toBe("node-backend");
  });
});
