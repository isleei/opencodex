import type { SessionTurn, UnifiedSessionDetail } from "../types";

/**
 * Converts a unified session turn list into Antigravity (AGY) JSONL transcript lines.
 */
export function convertToAgyTranscript(session: UnifiedSessionDetail): string {
  const lines: string[] = [];
  let stepIndex = 0;

  for (const turn of session.turns) {
    const createdAt = new Date(turn.timestamp || Date.now()).toISOString();

    if (turn.role === "user") {
      lines.push(
        JSON.stringify({
          step_index: stepIndex++,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: createdAt,
          content: `<USER_REQUEST>\n${turn.content}\n</USER_REQUEST>`,
        }),
      );
    } else if (turn.role === "assistant" || turn.role === "tool") {
      const toolCalls = turn.toolCalls?.map((tc) => ({
        name: mapToAgyToolName(tc.toolName),
        arguments: tc.args || {},
      }));

      lines.push(
        JSON.stringify({
          step_index: stepIndex++,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: createdAt,
          content: turn.content,
          tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        }),
      );
    }
  }

  return lines.join("\n");
}

function mapToAgyToolName(name: string): string {
  if (name === "bash" || name === "exec") return "run_command";
  if (name === "apply_patch" || name === "edit_file") return "replace_file_content";
  if (name === "create_file" || name === "write_file") return "write_to_file";
  if (name === "view_file" || name === "read_file") return "view_file";
  return name;
}

/**
 * Converts a unified session turn list into Codex JSONL rollout lines.
 */
export function convertToCodexRollout(session: UnifiedSessionDetail): string {
  const lines: string[] = [];
  const nowIso = new Date(session.createdAt || Date.now()).toISOString();

  // 1. session_meta
  lines.push(
    JSON.stringify({
      timestamp: nowIso,
      type: "session_meta",
      payload: {
        id: session.id,
        timestamp: nowIso,
        model_provider: "opencodex",
        model: "gpt-5.6-luna",
        handoff_from: session.agent,
      },
    }),
  );

  // 2. Turns
  for (const turn of session.turns) {
    const turnTimestamp = new Date(turn.timestamp || Date.now()).toISOString();

    if (turn.role === "user") {
      lines.push(
        JSON.stringify({
          timestamp: turnTimestamp,
          type: "event",
          payload: {
            type: "user_message",
            message: turn.content,
          },
        }),
      );
    } else if (turn.role === "assistant") {
      lines.push(
        JSON.stringify({
          timestamp: turnTimestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: turn.content }],
          },
        }),
      );
    } else if (turn.role === "tool" && turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        lines.push(
          JSON.stringify({
            timestamp: turnTimestamp,
            type: "response_item",
            payload: {
              type: "function_call",
              name: tc.toolName,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
            },
          }),
        );
      }
    }
  }

  return lines.join("\n");
}
