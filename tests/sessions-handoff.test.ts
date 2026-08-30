import { describe, expect, test } from "bun:test";
import { extractHandoffContext } from "../src/sessions/handoff/extractor";
import { convertToAgyTranscript, convertToCodexRollout } from "../src/sessions/handoff/converter";
import type { UnifiedSessionDetail } from "../src/sessions/types";

describe("Cross-Agent Session Handoff & Conversion", () => {
  const sampleCodexSession: UnifiedSessionDetail = {
    id: "codex-test-session-001",
    agent: "codex",
    title: "Build Centralized Skills System",
    status: "active",
    createdAt: 1725000000000,
    updatedAt: 1725001000000,
    turnCount: 4,
    modifiedFiles: ["src/skills/manager.ts", "src/skills/types.ts"],
    modifiedFileDetails: [
      { path: "src/skills/manager.ts", changeType: "create" },
      { path: "src/skills/types.ts", changeType: "modify" },
    ],
    tokens: { promptTokens: 3000, completionTokens: 800, totalTokens: 3800 },
    sourcePath: "/tmp/sample-codex.jsonl",
    turns: [
      {
        turnId: "turn-0",
        role: "user",
        content: "Please build the Centralized Skills System with symlink synchronization.",
      },
      {
        turnId: "turn-1",
        role: "assistant",
        content: "I will implement the central skills store and parser.",
        toolCalls: [
          { toolName: "write_to_file", args: { TargetFile: "src/skills/manager.ts" } },
        ],
      },
      {
        turnId: "turn-2",
        role: "user",
        content: "There is an unresolved TypeError: cannot read property 'disabled' of undefined in tests.",
      },
      {
        turnId: "turn-3",
        role: "assistant",
        content: "Investigating the TypeError.\n- [ ] Fix disabled property check\n- [ ] Run full test suite",
      },
    ],
  };

  test("Handoff Extractor: synthesizes structured context for AGY", () => {
    const handoff = extractHandoffContext(sampleCodexSession, {
      targetAgent: "agy",
      strategy: "smart_handoff",
      customInstructions: "Make sure to run unit tests after fixing.",
    });

    expect(handoff.sourceAgent).toBe("codex");
    expect(handoff.targetAgent).toBe("agy");
    expect(handoff.sourceSessionId).toBe("codex-test-session-001");
    expect(handoff.goal).toContain("Please build the Centralized Skills System");
    expect(handoff.modifiedFiles.length).toBe(2);
    expect(handoff.unresolvedIssues.length).toBeGreaterThan(0);
    expect(handoff.pendingTasks.length).toBeGreaterThan(0);

    // Prompt content checks
    expect(handoff.renderedPrompt).toContain("# Session Handoff: Continuing task from OpenAI Codex");
    expect(handoff.renderedPrompt).toContain("src/skills/manager.ts");
    expect(handoff.renderedPrompt).toContain("Make sure to run unit tests after fixing");
  });

  test("Handoff Extractor: synthesizes structured context for Codex", () => {
    const sampleAgySession: UnifiedSessionDetail = {
      ...sampleCodexSession,
      id: "agy-session-002",
      agent: "agy",
    };

    const handoff = extractHandoffContext(sampleAgySession, {
      targetAgent: "codex",
    });

    expect(handoff.sourceAgent).toBe("agy");
    expect(handoff.targetAgent).toBe("codex");
    expect(handoff.renderedPrompt).toContain("Continuing task from Google Antigravity (AGY)");
  });

  test("Transcript Converter: converts session to AGY transcript JSONL", () => {
    const agyJsonl = convertToAgyTranscript(sampleCodexSession);
    const lines = agyJsonl.split("\n").filter((l) => l.trim().length > 0);

    expect(lines.length).toBe(4);
    const firstStep = JSON.parse(lines[0]);
    expect(firstStep.type).toBe("USER_INPUT");
    expect(firstStep.content).toContain("<USER_REQUEST>");

    const secondStep = JSON.parse(lines[1]);
    expect(secondStep.type).toBe("PLANNER_RESPONSE");
  });

  test("Transcript Converter: converts session to Codex rollout JSONL", () => {
    const codexJsonl = convertToCodexRollout(sampleCodexSession);
    const lines = codexJsonl.split("\n").filter((l) => l.trim().length > 0);

    expect(lines.length).toBe(5); // session_meta + 4 turns
    const meta = JSON.parse(lines[0]);
    expect(meta.type).toBe("session_meta");
    expect(meta.payload.id).toBe("codex-test-session-001");

    const userTurn = JSON.parse(lines[1]);
    expect(userTurn.type).toBe("event");
    expect(userTurn.payload.type).toBe("user_message");
  });
});
