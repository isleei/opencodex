import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillsCommand } from "../src/cli/skills";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import type { SkillsDirectoryConfig } from "../src/skills/types";

describe("ocx skills CLI", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let tempBase: string;
  let skillsConfig: SkillsDirectoryConfig;
  let baseConfig: OcxConfig;

  let logs: string[] = [];
  let errors: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const deps: ManagementApiDeps = {
          skillsConfig,
        };
        const res = await handleManagementAPI(req, url, baseConfig, deps);
        if (res) return res;
        return new Response("Not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-cli-skills-test-"));
    skillsConfig = {
      centralDir: join(tempBase, "agents", "skills"),
      claudeDir: join(tempBase, "claude", "skills"),
      codexDir: join(tempBase, "codex", "skills"),
      projectDir: join(tempBase, "project", ".agents", "skills"),
      trashDir: join(tempBase, "agents", ".trash", "skills"),
      systemSkillsDir: join(tempBase, "codex", "skills", ".system"),
    };
    baseConfig = {
      port: server.port,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };

    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function runSkills(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    logs = [];
    errors = [];
    const code = await handleSkillsCommand(args, { baseUrl });
    return {
      code,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  }

  test("1: skills list on empty directory", async () => {
    const human = await runSkills(["list"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("No skills found.");

    const json = await runSkills(["list", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ skills: [] });
  });

  test("2: skills create creates skill and formats table on list", async () => {
    const create = await runSkills([
      "create",
      "git-helper",
      "--description",
      "Git assistance skill",
      "--tags",
      "git,vcs",
      "--content",
      "# Git Helper\nHelps with git operations.",
      "--link",
      "claude,codex",
    ]);

    expect(create.code).toBe(0);
    expect(create.stdout).toContain('Created skill "git-helper" in central store.');

    const list = await runSkills(["list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("NAME");
    expect(list.stdout).toContain("git-helper");
    expect(list.stdout).toContain("active");
    expect(list.stdout).toContain("claude,codex");
    expect(list.stdout).toContain("Git assistance skill");

    const jsonList = await runSkills(["list", "--json"]);
    expect(jsonList.code).toBe(0);
    const parsed = JSON.parse(jsonList.stdout);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].name).toBe("git-helper");
  });

  test("3: skills view shows details and handles --raw and --json", async () => {
    await runSkills([
      "create",
      "test-view",
      "--description",
      "Testing view output",
      "--content",
      "# Markdown Content",
    ]);

    const viewHuman = await runSkills(["view", "test-view"]);
    expect(viewHuman.code).toBe(0);
    expect(viewHuman.stdout).toContain("Name:        test-view");
    expect(viewHuman.stdout).toContain("Description: Testing view output");
    expect(viewHuman.stdout).toContain("--- Content ---");
    expect(viewHuman.stdout).toContain("# Markdown Content");

    const viewRaw = await runSkills(["view", "test-view", "--raw"]);
    expect(viewRaw.code).toBe(0);
    expect(viewRaw.stdout).toContain("---");
    expect(viewRaw.stdout).toContain("name: test-view");
    expect(viewRaw.stdout).toContain("# Markdown Content");

    const viewJson = await runSkills(["view", "test-view", "--json"]);
    expect(viewJson.code).toBe(0);
    const parsed = JSON.parse(viewJson.stdout);
    expect(parsed.skill.name).toBe("test-view");
  });

  test("4: skills edit modifies description and tags", async () => {
    await runSkills([
      "create",
      "editable",
      "--description",
      "Initial description",
    ]);

    const editRes = await runSkills([
      "edit",
      "editable",
      "--description",
      "Updated description",
      "--tags",
      "updated,qa",
    ]);
    expect(editRes.code).toBe(0);
    expect(editRes.stdout).toContain('Updated skill "editable".');

    const viewRes = await runSkills(["view", "editable", "--json"]);
    const parsed = JSON.parse(viewRes.stdout);
    expect(parsed.skill.metadata.description).toBe("Updated description");
    expect(parsed.skill.metadata.tags).toEqual(["updated", "qa"]);
  });

  test("5: skills toggle enables and disables", async () => {
    await runSkills([
      "create",
      "toggleable",
      "--description",
      "Toggle test",
    ]);

    const disable = await runSkills(["toggle", "toggleable", "--disable"]);
    expect(disable.code).toBe(0);
    expect(disable.stdout).toContain('Skill "toggleable" is now disabled.');

    const enable = await runSkills(["toggle", "toggleable", "--enable"]);
    expect(enable.code).toBe(0);
    expect(enable.stdout).toContain('Skill "toggleable" is now enabled.');
  });

  test("6: skills delete requires --yes and moves to trash, then restore brings it back", async () => {
    await runSkills([
      "create",
      "deletable",
      "--description",
      "Delete test",
    ]);

    // Fails without --yes
    const noYes = await runSkills(["delete", "deletable"]);
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain("delete requires --yes");

    // Succeeds with --yes
    const del = await runSkills(["delete", "deletable", "--yes"]);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain('Deleted skill "deletable" (moved to trash');

    // Check trash
    const trashRes = await runSkills(["trash", "--json"]);
    expect(trashRes.code).toBe(0);
    const trashParsed = JSON.parse(trashRes.stdout);
    expect(trashParsed.items).toHaveLength(1);
    const trashId = trashParsed.items[0].trashId;

    // Restore
    const restoreRes = await runSkills(["restore", trashId]);
    expect(restoreRes.code).toBe(0);
    expect(restoreRes.stdout).toContain('Restored skill "deletable"');

    // Confirm it's back in list
    const listRes = await runSkills(["list"]);
    expect(listRes.stdout).toContain("deletable");
  });

  test("7: skills sync reports synchronization results", async () => {
    const syncRes = await runSkills(["sync", "--dry-run", "--json"]);
    expect(syncRes.code).toBe(0);
    const parsed = JSON.parse(syncRes.stdout);
    expect(parsed).toHaveProperty("synced");
    expect(parsed).toHaveProperty("migrated");
    expect(parsed).toHaveProperty("deduped");
  });

  test("8: error handling for missing skill names and unknown subcommands", async () => {
    const unknown = await runSkills(["unknown-sub"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown skills subcommand");

    const noName = await runSkills(["view"]);
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain("Skill name is required");
  });
});
