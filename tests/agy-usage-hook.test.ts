import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOOK_SCRIPT_PATH = join(import.meta.dir, "../../agy-opencodex-usage/report.mjs");
const INSTALLER_SCRIPT_PATH = join(import.meta.dir, "../../agy-opencodex-usage/install.sh");

let testDir = "";
let prevOpenCodexHome: string | undefined;
let prevAntigravityHome: string | undefined;

beforeEach(() => {
  prevOpenCodexHome = process.env.OPENCODEX_HOME;
  prevAntigravityHome = process.env.ANTIGRAVITY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-agy-hook-test-"));
  process.env.OPENCODEX_HOME = join(testDir, ".opencodex");
  process.env.ANTIGRAVITY_HOME = join(testDir, ".gemini");
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  mkdirSync(process.env.ANTIGRAVITY_HOME, { recursive: true });
});

afterEach(() => {
  if (prevOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevOpenCodexHome;
  if (prevAntigravityHome === undefined) delete process.env.ANTIGRAVITY_HOME;
  else process.env.ANTIGRAVITY_HOME = prevAntigravityHome;

  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function runHook(stdinData: unknown, env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
  parsedStdout: unknown;
} {
  const stdinStr = typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData);
  const proc = spawnSync("node", [HOOK_SCRIPT_PATH], {
    input: stdinStr,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });

  let parsedStdout = null;
  try {
    parsedStdout = JSON.parse(proc.stdout.trim());
  } catch {
    /* not json */
  }

  return {
    status: proc.status ?? 0,
    stdout: proc.stdout,
    stderr: proc.stderr,
    parsedStdout,
  };
}

async function runHookAsync(stdinData: unknown, env: Record<string, string> = {}): Promise<{
  status: number;
  stdout: string;
  stderr: string;
  parsedStdout: unknown;
}> {
  return new Promise((resolve) => {
    const stdinStr = typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData);
    const proc = spawn("node", [HOOK_SCRIPT_PATH], {
      env: {
        ...process.env,
        ...env,
      },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (status) => {
      let parsedStdout = null;
      try {
        parsedStdout = JSON.parse(stdout.trim());
      } catch {
        /* not json */
      }
      resolve({
        status: status ?? 0,
        stdout,
        stderr,
        parsedStdout,
      });
    });

    proc.stdin.write(stdinStr);
    proc.stdin.end();
  });
}

describe("AGY Usage Hook Protocol & Safety", () => {
  test("returns valid JSON {} on stdout and exits 0 on empty stdin", () => {
    const res = runHook("");
    expect(res.status).toBe(0);
    expect(res.parsedStdout).toEqual({});
  });

  test("returns valid JSON {} on stdout and exits 0 on invalid JSON input", () => {
    const res = runHook("not-valid-json{{{");
    expect(res.status).toBe(0);
    expect(res.parsedStdout).toEqual({});
    const logPath = join(process.env.OPENCODEX_HOME!, "logs", "agy-usage-hook.log");
    expect(existsSync(logPath)).toBe(true);
  });

  test("ignores PreInvocation events safely", () => {
    const res = runHook({
      hookEventName: "PreInvocation",
      conversationId: "conv-1",
    });
    expect(res.status).toBe(0);
    expect(res.parsedStdout).toEqual({});
  });

  test("handles Stop and PostInvocation lifecycle events", () => {
    const res = runHook({
      hookEventName: "Stop",
      conversationId: "conv-2",
      usage: { promptTokens: 10, completionTokens: 20 },
    });
    expect(res.status).toBe(0);
    expect(res.parsedStdout).toEqual({});
  });
});

describe("Transcript Parsing, Token Extraction, & Model Attribution", () => {
  test("extracts explicit token metrics from transcript.jsonl and falls back to usage.jsonl file", () => {
    const sessionDir = join(testDir, "session-1");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptFile = join(sessionDir, "transcript.jsonl");

    const turn1 = {
      stepId: "step-101",
      timestamp: 1700000000000,
      model: "gemini-3.7-flash",
      usage: {
        promptTokens: 150,
        completionTokens: 50,
        totalTokens: 200,
        cachedTokens: 20,
        thoughtTokens: 10,
      },
    };
    writeFileSync(transcriptFile, `${JSON.stringify(turn1)}\n`, "utf8");

    const res = runHook({
      hookEventName: "Stop",
      conversationId: "session-1",
      transcriptPath: transcriptFile,
      modelName: "gemini-3.7-flash",
    });

    expect(res.status).toBe(0);
    expect(res.parsedStdout).toEqual({});

    const usageLogFile = join(process.env.OPENCODEX_HOME!, "usage.jsonl");
    expect(existsSync(usageLogFile)).toBe(true);

    const lines = readFileSync(usageLogFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.requestId).toBe("agy-native-step-101");
    expect(parsed.provider).toBe("google-antigravity-native");
    expect(parsed.model).toBe("gemini-3.7-flash");
    expect(parsed.surface).toBe("agy");
    expect(parsed.status).toBe(200);
    expect(parsed.usage.inputTokens).toBe(150);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.totalTokens).toBe(200);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.reasoningOutputTokens).toBe(10);
  });

  test("parses Google CCA usageMetadata schema", () => {
    const sessionDir = join(testDir, "session-google-cca");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptFile = join(sessionDir, "transcript.jsonl");

    const turn = {
      id: "cca-step-1",
      timestamp: 1700000005000,
      model: "gemini-3.1-pro",
      response: {
        usageMetadata: {
          promptTokenCount: 500,
          candidatesTokenCount: 120,
          totalTokenCount: 620,
          cachedContentTokenCount: 100,
          thoughtsTokenCount: 30,
        },
      },
    };
    writeFileSync(transcriptFile, `${JSON.stringify(turn)}\n`, "utf8");

    runHook({
      hookEventName: "PostInvocation",
      conversationId: "session-google-cca",
      transcriptPath: transcriptFile,
    });

    const usageLogFile = join(process.env.OPENCODEX_HOME!, "usage.jsonl");
    expect(existsSync(usageLogFile)).toBe(true);
    const lines = readFileSync(usageLogFile, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[0]);

    expect(parsed.requestId).toBe("agy-native-cca-step-1");
    expect(parsed.provider).toBe("google-antigravity-native");
    expect(parsed.model).toBe("gemini-3.1-pro");
    expect(parsed.usage.inputTokens).toBe(500);
    expect(parsed.usage.outputTokens).toBe(120);
    expect(parsed.usage.totalTokens).toBe(620);
    expect(parsed.usage.cachedInputTokens).toBe(100);
    expect(parsed.usage.reasoningOutputTokens).toBe(30);
  });

  test("estimates tokens when raw text is provided without explicit usage", () => {
    const sessionDir = join(testDir, "session-est");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptFile = join(sessionDir, "transcript.jsonl");

    const turn = {
      id: "raw-text-step",
      timestamp: 1700000010000,
      model: "gemini-3.7-flash",
      text: "This is a prompt and response text with approximately sixty characters.",
    };
    writeFileSync(transcriptFile, `${JSON.stringify(turn)}\n`, "utf8");

    runHook({
      hookEventName: "Stop",
      conversationId: "session-est",
      transcriptPath: transcriptFile,
    });

    const usageLogFile = join(process.env.OPENCODEX_HOME!, "usage.jsonl");
    expect(existsSync(usageLogFile)).toBe(true);
    const lines = readFileSync(usageLogFile, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[0]);

    expect(parsed.provider).toBe("google-antigravity-native");
    expect(parsed.usageStatus).toBe("estimated");
    expect(parsed.usage.inputTokens).toBeGreaterThan(0);
    expect(parsed.usage.outputTokens).toBeGreaterThan(0);
    expect(parsed.usage.totalTokens).toBeGreaterThan(0);
  });

  test("skips ocx-routed models to prevent double-counting", () => {
    const sessionDir = join(testDir, "session-proxy");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptFile = join(sessionDir, "transcript.jsonl");

    const proxyTurn = {
      stepId: "step-proxy-1",
      model: "ocx-gemini-3.7-flash",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    writeFileSync(transcriptFile, `${JSON.stringify(proxyTurn)}\n`, "utf8");

    runHook({
      hookEventName: "Stop",
      conversationId: "session-proxy",
      transcriptPath: transcriptFile,
    });

    const usageLogFile = join(process.env.OPENCODEX_HOME!, "usage.jsonl");
    expect(existsSync(usageLogFile)).toBe(false);
  });
});

describe("Deduplication & Consecutive Turn Delta Ingestion", () => {
  test("guarantees idempotent ingestion and only processes delta turns", () => {
    const sessionDir = join(testDir, "session-dedup");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptFile = join(sessionDir, "transcript.jsonl");

    const turn1 = {
      stepId: "turn-delta-1",
      model: "gemini-3.7-flash",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const turn2 = {
      stepId: "turn-delta-2",
      model: "gemini-3.7-flash",
      usage: { inputTokens: 120, outputTokens: 30 },
    };

    // First turn execution
    writeFileSync(transcriptFile, `${JSON.stringify(turn1)}\n`, "utf8");
    runHook({
      hookEventName: "Stop",
      conversationId: "session-dedup",
      transcriptPath: transcriptFile,
    });

    const usageLogFile = join(process.env.OPENCODEX_HOME!, "usage.jsonl");
    expect(existsSync(usageLogFile)).toBe(true);
    let lines = readFileSync(usageLogFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).requestId).toBe("agy-native-turn-delta-1");

    // Second execution with SAME transcript (idempotent: 0 new entries)
    runHook({
      hookEventName: "Stop",
      conversationId: "session-dedup",
      transcriptPath: transcriptFile,
    });

    lines = readFileSync(usageLogFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);

    // Third execution after adding Turn 2 (delta ingestion: only turn 2 added)
    writeFileSync(transcriptFile, `${JSON.stringify(turn1)}\n${JSON.stringify(turn2)}\n`, "utf8");
    runHook({
      hookEventName: "Stop",
      conversationId: "session-dedup",
      transcriptPath: transcriptFile,
    });

    lines = readFileSync(usageLogFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).requestId).toBe("agy-native-turn-delta-2");

    // State file verified
    const stateFile = join(process.env.OPENCODEX_HOME!, "agy-native-usage-state.json");
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.seen["session-dedup"]).toContain("turn-delta-1");
    expect(state.seen["session-dedup"]).toContain("turn-delta-2");
  });
});

describe("Live API Dispatch & HTTP Ingestion", () => {
  test("dispatches to live HTTP mock server via POST /api/usage/ingest", async () => {
    let receivedPayload: unknown = null;
    let receivedAuth: string | null = null;

    // Start a temporary HTTP server using node:http
    const { createServer } = await import("node:http");
    let serverPort = 0;
    const server = createServer((req, res) => {
      if (req.url === "/api/usage/ingest" && req.method === "POST") {
        receivedAuth = req.headers["x-opencodex-api-key"] as string;
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            receivedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            receivedPayload = null;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ accepted: 1, skipped: 0, rejected: 0 }));
        });
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          serverPort = addr.port;
        }
        resolve();
      });
    });

    try {
      const adminTokenFile = join(process.env.OPENCODEX_HOME!, "admin-api-token");
      writeFileSync(adminTokenFile, "test-secret-admin-token\n", "utf8");

      const sessionDir = join(testDir, "session-api");
      mkdirSync(sessionDir, { recursive: true });
      const transcriptFile = join(sessionDir, "transcript.jsonl");

      const turn = {
        stepId: "step-api-1",
        model: "gemini-3.7-flash",
        usage: { inputTokens: 250, outputTokens: 80 },
      };
      writeFileSync(transcriptFile, `${JSON.stringify(turn)}\n`, "utf8");

      const res = await runHookAsync(
        {
          hookEventName: "Stop",
          conversationId: "session-api",
          transcriptPath: transcriptFile,
        },
        {
          OPENCODEX_URL: `http://127.0.0.1:${serverPort}`,
          OPENCODEX_HOME: process.env.OPENCODEX_HOME!,
        },
      );

      expect(res.status).toBe(0);
      expect(receivedAuth).toBe("test-secret-admin-token");
      expect(receivedPayload).not.toBeNull();

      const payload = receivedPayload as { entries: Array<{ requestId: string; provider: string; model: string }> };
      expect(payload.entries.length).toBe(1);
      expect(payload.entries[0].requestId).toBe("agy-native-step-api-1");
      expect(payload.entries[0].provider).toBe("google-antigravity-native");
      expect(payload.entries[0].model).toBe("gemini-3.7-flash");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Installer & Uninstaller Integration", () => {
  test("installs into target home preserving user hooks, and uninstalls cleanly", () => {
    const customHome = join(testDir, "custom-gemini");
    mkdirSync(customHome, { recursive: true });

    // Pre-populate with existing custom user hooks
    const initialHooks = {
      description: "User hooks",
      hooks: {
        PreInvocation: [
          {
            hooks: [
              {
                type: "command",
                command: "echo 'custom pre-hook'",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "echo 'custom stop-hook'",
              },
            ],
          },
        ],
      },
    };
    writeFileSync(join(customHome, "hooks.json"), JSON.stringify(initialHooks, null, 2), "utf8");

    // 1. Run installer
    const installProc = spawnSync("bash", [INSTALLER_SCRIPT_PATH, "--target", customHome], {
      encoding: "utf8",
    });
    expect(installProc.status).toBe(0);

    const installedScript = join(customHome, "hooks", "agy-opencodex-usage", "report.mjs");
    expect(existsSync(installedScript)).toBe(true);

    const mergedConfig = JSON.parse(readFileSync(join(customHome, "hooks.json"), "utf8"));
    // User hooks preserved
    expect(mergedConfig.hooks.PreInvocation[0].hooks[0].command).toBe("echo 'custom pre-hook'");
    expect(mergedConfig.hooks.Stop[0].hooks[0].command).toBe("echo 'custom stop-hook'");
    // Managed hook added under Stop and PostInvocation
    const stopHooks = mergedConfig.hooks.Stop;
    expect(stopHooks.some((g: any) => g.hooks?.some((h: any) => h.command.includes("report.mjs")))).toBe(true);
    expect(mergedConfig.hooks.PostInvocation.some((g: any) => g.hooks?.some((h: any) => h.command.includes("report.mjs")))).toBe(true);

    // 2. Run installer again (idempotent)
    const installAgain = spawnSync("bash", [INSTALLER_SCRIPT_PATH, "--target", customHome], {
      encoding: "utf8",
    });
    expect(installAgain.status).toBe(0);

    const reMerged = JSON.parse(readFileSync(join(customHome, "hooks.json"), "utf8"));
    // Stop array should still only have 2 groups (user + our managed hook, not duplicated)
    expect(reMerged.hooks.Stop.length).toBe(2);

    // 3. Run uninstaller
    const uninstallProc = spawnSync("bash", [INSTALLER_SCRIPT_PATH, "--target", customHome, "--uninstall"], {
      encoding: "utf8",
    });
    expect(uninstallProc.status).toBe(0);

    // Managed hook files removed
    expect(existsSync(installedScript)).toBe(false);

    // Custom user hooks remain preserved
    const cleanedConfig = JSON.parse(readFileSync(join(customHome, "hooks.json"), "utf8"));
    expect(cleanedConfig.hooks.PreInvocation[0].hooks[0].command).toBe("echo 'custom pre-hook'");
    expect(cleanedConfig.hooks.Stop[0].hooks[0].command).toBe("echo 'custom stop-hook'");
    expect(cleanedConfig.hooks.Stop.some((g: any) => g.hooks?.some((h: any) => h.command.includes("report.mjs")))).toBe(false);
  });
});
