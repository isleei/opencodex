import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

describe("Management Sessions REST API (/api/sessions/*)", () => {
  let tempBase: string;
  let baseConfig: OcxConfig;
  let codexHome: string;
  let agyHome: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-mgmt-sessions-test-"));
    codexHome = join(tempBase, "codex");
    agyHome = join(tempBase, "agy");

    // set up mock codex sessions
    const codexSessionsDir = join(codexHome, "sessions", "2026", "08", "30");
    mkdirSync(codexSessionsDir, { recursive: true });
    const codexSessionFile = join(codexSessionsDir, "rollout-2026-08-30T10-00-00-mock-codex-1.jsonl");
    writeFileSync(
      codexSessionFile,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "mock-codex-1", timestamp: "2026-08-30T10:00:00Z" } }),
        JSON.stringify({ type: "user_message", message: "<USER_REQUEST>Refactor API client</USER_REQUEST>" }),
        JSON.stringify({ type: "agent_message", text: "Refactored HTTP client." }),
      ].join("\n"),
    );

    // set up mock agy session
    const agyBrainDir = join(agyHome, "brain", "mock-agy-2", ".system_generated", "logs");
    mkdirSync(agyBrainDir, { recursive: true });
    const agyTranscriptFile = join(agyBrainDir, "transcript.jsonl");
    writeFileSync(
      agyTranscriptFile,
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          source: "USER_EXPLICIT",
          content: "<USER_REQUEST>Implement WebSocket reconnect</USER_REQUEST>",
          created_at: "2026-08-30T10:30:00Z",
        }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          content: "Implemented exponential backoff reconnection.",
          created_at: "2026-08-30T10:31:00Z",
        }),
      ].join("\n"),
    );

    // set up mock grok session
    const grokSessionDir = join(tempBase, "grok", "sessions", "%2Fwork%2Fjs%2Fmock-grok", "mock-grok-3");
    mkdirSync(grokSessionDir, { recursive: true });
    const grokUpdate = (sessionUpdate: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        timestamp: 1756500000,
        method: "_x.ai/session/update",
        params: { sessionId: "mock-grok-3", update: { sessionUpdate, ...extra } },
      });
    writeFileSync(
      join(grokSessionDir, "updates.jsonl"),
      [
        grokUpdate("user_message_chunk", { content: { type: "text", text: "<USER_REQUEST>Wire the retry queue</USER_REQUEST>" } }),
        grokUpdate("turn_completed", { usage: { inputTokens: 900, outputTokens: 150, totalTokens: 1050 } }),
      ].join("\n"),
    );

    baseConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };

    process.env.CODEX_HOME = codexHome;
    process.env.ANTIGRAVITY_HOME = agyHome;
    process.env.GROK_HOME = join(tempBase, "grok");
    process.env.CLAUDE_HOME = join(tempBase, "claude");
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    delete process.env.ANTIGRAVITY_HOME;
    delete process.env.GROK_HOME;
    delete process.env.CLAUDE_HOME;
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

    const deps: ManagementApiDeps = {};

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

  test("GET /api/sessions returns list of discovered sessions", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);

    const ids = body.sessions.map((s: any) => s.id);
    expect(ids).toContain("mock-codex-1");
    expect(ids).toContain("mock-agy-2");
    expect(ids).toContain("mock-grok-3");
  });

  test("GET /api/sessions?agent=agy filters sessions by agent", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/sessions", undefined, { agent: "agy" });
    expect(status).toBe(200);
    expect(body.sessions.every((s: any) => s.agent === "agy")).toBe(true);
  });

  test("GET /api/sessions/:agent/:id returns full session detail", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/sessions/codex/mock-codex-1");
    expect(status).toBe(200);
    expect(body.session).toBeDefined();
    expect(body.session.id).toBe("mock-codex-1");
    expect(body.session.agent).toBe("codex");
    expect(body.session.turns.length).toBe(2);
  });

  test("GET /api/sessions/:agent/:id returns 404 for unknown session", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/sessions/codex/non-existent-session-id");
    expect(status).toBe(404);
    expect(body.code).toBe("session_not_found");
  });

  test("POST /api/sessions/:agent/:id/handoff generates target prompt", async () => {
    const { status, body } = await dispatchRequest(
      "POST",
      "/api/sessions/codex/mock-codex-1/handoff",
      {
        targetAgent: "agy",
        customInstructions: "Follow clean code principles",
      },
    );

    expect(status).toBe(200);
    expect(body.handoff).toBeDefined();
    expect(body.handoff.sourceAgent).toBe("codex");
    expect(body.handoff.targetAgent).toBe("agy");
    expect(body.handoff.renderedPrompt).toContain("Refactor API client");
    expect(body.handoff.renderedPrompt).toContain("Follow clean code principles");
  });

  test("POST /api/sessions/:agent/:id/dispatch prepares dispatch result", async () => {
    const { status, body } = await dispatchRequest(
      "POST",
      "/api/sessions/codex/mock-codex-1/dispatch",
      {
        targetAgent: "agy",
        autoExecute: false,
      },
    );

    expect(status).toBe(200);
    expect(body.result).toBeDefined();
    expect(body.result.targetAgent).toBe("agy");
    expect(body.result.executed).toBe(false);
    expect(body.result.command).toContain("agy");
  });
});
