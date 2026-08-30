import type { AgentType, HandoffContext, HandoffOptions, ModifiedFileInfo, UnifiedSessionDetail } from "../types";

export function extractHandoffContext(
  session: UnifiedSessionDetail,
  options: HandoffOptions,
): HandoffContext {
  const { targetAgent, customInstructions, strategy = "smart_handoff" } = options;

  // 1. Extract primary goal
  const firstUserTurn = session.turns.find((t) => t.role === "user");
  const goal = firstUserTurn ? firstUserTurn.content.trim() : session.title;

  // 2. Extract completed milestones & actions
  const completedMilestones: string[] = [];
  const assistantTurns = session.turns.filter((t) => t.role === "assistant" || t.role === "tool");

  for (const turn of assistantTurns) {
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      for (const tc of turn.toolCalls) {
        if (tc.toolName.includes("write") || tc.toolName.includes("replace") || tc.toolName.includes("patch") || tc.toolName.includes("edit")) {
          completedMilestones.push(`Updated code via tool: ${tc.toolName}`);
        } else if (tc.toolName.includes("run") || tc.toolName.includes("exec") || tc.toolName.includes("bash")) {
          completedMilestones.push(`Executed command: ${tc.toolName}`);
        }
      }
    } else if (turn.content && turn.content.length > 20 && turn.content.length < 500) {
      const firstLine = turn.content.split("\n")[0].trim();
      if (firstLine.length > 10 && !completedMilestones.includes(firstLine)) {
        completedMilestones.push(firstLine);
      }
    }
  }

  // Deduplicate and cap milestones
  const uniqueMilestones = Array.from(new Set(completedMilestones)).slice(0, 10);

  // 3. Extract unresolved issues / errors
  const unresolvedIssues: string[] = [];
  for (const turn of session.turns) {
    if (
      turn.content.includes("Error:") ||
      turn.content.includes("failed with exit code") ||
      turn.content.includes("TypeError:") ||
      turn.content.includes("SyntaxError:") ||
      turn.content.includes("Unhandled exception")
    ) {
      const match = turn.content.match(/(?:Error|Exception|failed):?[^\n]+/i);
      if (match && !unresolvedIssues.includes(match[0].trim())) {
        unresolvedIssues.push(match[0].trim().slice(0, 120));
      }
    }
  }

  // 4. Pending Tasks
  const pendingTasks: string[] = [];
  const lastAssistantTurn = [...session.turns].reverse().find((t) => t.role === "assistant");
  if (lastAssistantTurn && lastAssistantTurn.content) {
    const lines = lastAssistantTurn.content.split("\n");
    for (const l of lines) {
      if (/^\s*[-*]\s*\[\s*\]/i.test(l) || /^\s*\d+\.\s*(?:Next|TODO|Pending|Remaining)/i.test(l)) {
        pendingTasks.push(l.trim());
      }
    }
  }

  if (pendingTasks.length === 0 && unresolvedIssues.length > 0) {
    pendingTasks.push(`Resolve reported issue: ${unresolvedIssues[0]}`);
  }
  if (pendingTasks.length === 0) {
    pendingTasks.push("Continue and verify the remaining implementation requirements.");
  }

  // 5. Render target-specific prompt
  const renderedPrompt = renderTargetAgentPrompt(
    session.agent,
    targetAgent,
    session.id,
    goal,
    uniqueMilestones,
    session.modifiedFileDetails,
    unresolvedIssues,
    pendingTasks,
    customInstructions,
  );

  return {
    sourceAgent: session.agent,
    targetAgent,
    sourceSessionId: session.id,
    generatedAt: Date.now(),
    strategy,
    goal,
    completedMilestones: uniqueMilestones,
    modifiedFiles: session.modifiedFileDetails,
    unresolvedIssues,
    pendingTasks,
    customInstructions,
    renderedPrompt,
  };
}

function renderTargetAgentPrompt(
  sourceAgent: AgentType,
  targetAgent: AgentType,
  sourceSessionId: string,
  goal: string,
  milestones: string[],
  modifiedFiles: ModifiedFileInfo[],
  errors: string[],
  pendingTasks: string[],
  customInstructions?: string,
): string {
  const sourceName =
    sourceAgent === "codex" ? "OpenAI Codex"
    : sourceAgent === "agy" ? "Google Antigravity (AGY)"
    : sourceAgent === "grok" ? "Grok Build"
    : "Claude Code";
  const targetName =
    targetAgent === "codex" ? "Codex"
    : targetAgent === "agy" ? "Antigravity (AGY)"
    : targetAgent === "grok" ? "Grok Build"
    : "Claude Code";

  const sections: string[] = [];

  sections.push(`# Session Handoff: Continuing task from ${sourceName}`);
  sections.push(`> Handed off from ${sourceName} session \`${sourceSessionId}\` to ${targetName}.`);

  sections.push(`\n## 🎯 Primary Goal\n${goal}`);

  if (milestones.length > 0) {
    sections.push(`\n## ✅ Completed Progress & Milestones\n${milestones.map((m) => `- ${m}`).join("\n")}`);
  }

  if (modifiedFiles.length > 0) {
    sections.push(`\n## 📂 Modified / Created Files\n${modifiedFiles.map((f) => `- \`${f.path}\` (${f.changeType})`).join("\n")}`);
  }

  if (errors.length > 0) {
    sections.push(`\n## ⚠️ Known Issues / Blockers to Resolve\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }

  if (pendingTasks.length > 0) {
    sections.push(`\n## 📋 Next Action Items\n${pendingTasks.map((t) => `- ${t}`).join("\n")}`);
  }

  if (customInstructions && customInstructions.trim()) {
    sections.push(`\n## 💡 Specific User Instructions\n${customInstructions.trim()}`);
  }

  sections.push(`\n## 🚀 Execution Directives\nPlease continue directly from this current workspace state, verify modified files, address any remaining tasks, and run necessary tests to ensure complete verification.`);

  return sections.join("\n");
}
