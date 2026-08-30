import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionsCommand } from "../src/cli/sessions";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

describe("ocx sessions CLI", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let tempBase: string;
  let codexHome: string;
  let agyHome: string;
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
        const deps: ManagementApiDeps = {};
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
    tempBase = mkdtempSync(join(tmpdir(), "ocx-cli-sessions-test-"));
    codexHome = join(tempBase, "codex");
    agyHome = join(tempBase, "agy");

    // set up mock codex sessions
    const codexSessionsDir = join(codexHome, "sessions", "2026", "08", "30");
    mkdirSync(codexSessionsDir, { recursive: true });
    const codexSessionFile = join(codexSessionsDir, "rollout-2026-08-30T10-00-00-cli-codex-1.jsonl");
    writeFileSync(
      codexSessionFile,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "cli-codex-1", timestamp: "2026-08-30T10:00:00Z" } }),
        JSON.stringify({ type: "user_message", message: "<USER_REQUEST>Add dark mode support</USER_REQUEST>" }),
        JSON.stringify({ type: "agent_message", text: "Added CSS dark mode variables." }),
      ].join("\n"),
    );

    baseConfig = {
      port: server.port,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };

    process.env.CODEX_HOME = codexHome;
    process.env.ANTIGRAVITY_HOME = agyHome;

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
    delete process.env.CODEX_HOME;
    delete process.env.ANTIGRAVITY_HOME;
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function runSessions(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    logs = [];
    errors = [];
    const code = await handleSessionsCommand(args, { baseUrl });
    return {
      code,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  }

  test("1: sessions list displays table and supports --json", async () => {
    const human = await runSessions(["list"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("cli-codex-1");
    expect(human.stdout).toContain("Add dark mode support");

    const json = await runSessions(["list", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions[0].id).toBe("cli-codex-1");
  });

  test("2: sessions view displays session details and timeline", async () => {
    const human = await runSessions(["view", "codex", "cli-codex-1"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Session: cli-codex-1");
    expect(human.stdout).toContain("Add dark mode support");

    const json = await runSessions(["view", "codex", "cli-codex-1", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.session.id).toBe("cli-codex-1");
  });

  test("3: sessions handoff generates preview prompt for target agent", async () => {
    const human = await runSessions([
      "handoff",
      "codex",
      "cli-codex-1",
      "--to",
      "agy",
      "--instructions",
      "Test all components thoroughly",
    ]);

    expect(human.code).toBe(0);
    expect(human.stdout).toContain("=== Session Handoff Preview ===");
    expect(human.stdout).toContain("Target Agent:   agy");
    expect(human.stdout).toContain("Add dark mode support");
    expect(human.stdout).toContain("Test all components thoroughly");

    const json = await runSessions([
      "handoff",
      "codex",
      "cli-codex-1",
      "--to",
      "agy",
      "--json",
    ]);

    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.handoff.targetAgent).toBe("agy");
    expect(parsed.handoff.renderedPrompt).toContain("Antigravity (AGY)");
  });
});
