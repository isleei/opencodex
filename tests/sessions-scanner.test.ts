import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCodexSessionFile,
  scanCodexSessions,
} from "../src/sessions/scanners/codex-scanner";
import {
  parseAgyConversationDir,
  scanAgySessions,
} from "../src/sessions/scanners/agy-scanner";
import {
  parseClaudeSessionFile,
  scanClaudeSessions,
} from "../src/sessions/scanners/claude-scanner";
import { scanAllSessions } from "../src/sessions/scanners";
import { getUnifiedSession } from "../src/sessions/manager";
import {
  parseGrokSessionFile,
  scanGrokSessions,
} from "../src/sessions/scanners/grok-scanner";

describe("Cross-Agent Session Scanners", () => {
  const testRoot = join(tmpdir(), `ocx-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

  test("Codex scanner: parses rollout jsonl with metadata, turns, and tools", () => {
    const codexHome = join(testRoot, "codex");
    const sessionsDir = join(codexHome, "sessions", "2026", "08", "30");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionFile = join(sessionsDir, "rollout-2026-08-30T10-00-00-test-codex-12345.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "test-codex-12345", timestamp: "2026-08-30T10:00:00Z", model_provider: "opencodex" },
      }),
      JSON.stringify({
        type: "user_message",
        message: "<USER_REQUEST>Implement user authentication service</USER_REQUEST>",
      }),
      JSON.stringify({
        type: "agent_message",
        text: "I will implement authentication using JWT.",
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          arguments: { target_file: "src/auth/jwt.ts" },
        },
      }),
      JSON.stringify({
        type: "event",
        payload: {
          type: "token_count",
          payload: { input_tokens: 1500, output_tokens: 350 },
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join("\n"));

    const detail = parseCodexSessionFile(sessionFile, false);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("test-codex-12345");
    expect(detail?.agent).toBe("codex");
    expect(detail?.title).toContain("Implement user authentication service");
    expect(detail?.turnCount).toBe(3);
    expect(detail?.modifiedFiles).toContain("src/auth/jwt.ts");
    expect(detail?.tokens.promptTokens).toBe(1500);
    expect(detail?.tokens.completionTokens).toBe(350);

    const scanned = scanCodexSessions(codexHome);
    expect(scanned.length).toBe(1);
    expect(scanned[0].id).toBe("test-codex-12345");
  });

  test("AGY scanner: parses transcript.jsonl with steps and tools", () => {
    const brainDir = join(testRoot, "agy-brain");
    const convId = "agy-test-conv-98765";
    const convDir = join(brainDir, convId, ".system_generated", "logs");
    mkdirSync(convDir, { recursive: true });

    const transcriptFile = join(convDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-08-30T10:15:00Z",
        content: "<USER_REQUEST>Fix memory leak in database pool</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-08-30T10:15:10Z",
        content: "Investigating database pool connection leak.",
        tool_calls: [
          {
            name: "replace_file_content",
            args: { TargetFile: "/path/to/db/pool.ts" },
          },
        ],
      }),
    ];
    writeFileSync(transcriptFile, lines.join("\n"));

    const detail = parseAgyConversationDir(join(brainDir, convId), convId);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(convId);
    expect(detail?.agent).toBe("agy");
    expect(detail?.title).toContain("Fix memory leak in database pool");
    expect(detail?.modifiedFiles).toContain("/path/to/db/pool.ts");

    const scanned = scanAgySessions(brainDir);
    expect(scanned.length).toBe(1);
    expect(scanned[0].id).toBe(convId);
  });

  test("Claude Code scanner: parses json session", () => {
    const claudeHome = join(testRoot, "claude");
    const projectsDir = join(claudeHome, "projects", "proj1");
    mkdirSync(projectsDir, { recursive: true });

    const sessionFile = join(projectsDir, "session-claude-456.json");
    const sessionData = {
      id: "claude-session-456",
      messages: [
        { role: "user", content: "Optimize SQL index queries" },
        { role: "assistant", content: "Added composite indexes." },
      ],
    };
    writeFileSync(sessionFile, JSON.stringify(sessionData));

    const detail = parseClaudeSessionFile(sessionFile);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("claude-session-456");
    expect(detail?.agent).toBe("claude_code");
    expect(detail?.title).toBe("Optimize SQL index queries");

    const scanned = scanClaudeSessions(claudeHome);
    expect(scanned.length).toBe(1);
    expect(scanned[0].id).toBe("claude-session-456");
  });

  test("Grok scanner: parses updates.jsonl chunks, tools, usage, and recap", () => {
    const grokHome = join(testRoot, "grok");
    const encodedCwd = "%2Fwork%2Fjs%2Fgrokproj";
    const sessionDir = join(grokHome, "sessions", encodedCwd, "grok-test-session-1111");
    mkdirSync(sessionDir, { recursive: true });

    const update = (sessionUpdate: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        timestamp: 1756500000 + Object.keys(extra).length,
        method: "_x.ai/session/update",
        params: { sessionId: "grok-test-session-1111", update: { sessionUpdate, ...extra } },
      });
    const sessionFile = join(sessionDir, "updates.jsonl");
    writeFileSync(
      sessionFile,
      [
        update("user_message_chunk", { content: { type: "text", text: "Fix the login redirect loop" } }),
        update("agent_thought_chunk", { content: { type: "text", text: "thinking about the router..." } }),
        update("agent_message_chunk", { content: { type: "text", text: "I'll patch the " } }),
        update("agent_message_chunk", { content: { type: "text", text: "router guard." } }),
        update("tool_call", {
          toolCallId: "call-1",
          title: "edit_file",
          rawInput: { target_file: "/work/js/grokproj/src/router.ts" },
          _meta: { "x.ai/tool": { kind: "edit" } },
        }),
        update("turn_completed", { usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } }),
        update("session_recap", { summary: "Fixed the redirect loop." }),
      ].join("\n"),
    );

    const detail = parseGrokSessionFile(sessionFile);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("grok-test-session-1111");
    expect(detail?.agent).toBe("grok");
    expect(detail?.title).toBe("Fix the login redirect loop");
    expect(detail?.project).toBe("grokproj");
    expect(detail?.projectPath).toBe("/work/js/grokproj");
    // user + assistant (two chunks concatenated through the interleaved thought) + tool
    expect(detail?.turnCount).toBe(3);
    expect(detail?.turns[1].content).toBe("I'll patch the router guard.");
    expect(detail?.modifiedFiles).toContain("/work/js/grokproj/src/router.ts");
    expect(detail?.modifiedFileDetails[0].changeType).toBe("modify");
    expect(detail?.tokens).toEqual({ promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });
    expect(detail?.summary).toBe("Fixed the redirect loop.");

    const scanned = scanGrokSessions(grokHome);
    expect(scanned.length).toBe(1);
    expect(scanned[0].id).toBe("grok-test-session-1111");
  });

  test("Aggregated scanner: filters by agent, search query, and finds session detail", async () => {
    const config = {
      codexHome: join(testRoot, "codex"),
      antigravityHome: join(testRoot, "agy-brain"),
      claudeHome: join(testRoot, "claude"),
      grokHome: join(testRoot, "grok"),
    };

    const allSessions = scanAllSessions(config, { agent: "all" });
    expect(allSessions.length).toBe(4);

    const agyOnly = scanAllSessions(config, { agent: "agy" });
    expect(agyOnly.length).toBe(1);
    expect(agyOnly[0].agent).toBe("agy");

    const grokOnly = scanAllSessions(config, { agent: "grok" });
    expect(grokOnly.length).toBe(1);
    expect(grokOnly[0].agent).toBe("grok");

    const searchResult = scanAllSessions(config, { search: "memory leak" });
    expect(searchResult.length).toBe(1);
    expect(searchResult[0].id).toBe("agy-test-conv-98765");

    const foundDetail = await getUnifiedSession("codex", "test-codex-12345", config);
    expect(foundDetail).not.toBeNull();
    expect(foundDetail?.id).toBe("test-codex-12345");
  });

  // Cleanup temp dir
  afterAll(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
