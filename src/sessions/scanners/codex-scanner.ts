import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModifiedFileInfo, SessionTokenUsage, SessionTurn, UnifiedSession, UnifiedSessionDetail } from "../types";
import { cleanCodexUserPrompt, extractProjectName } from "../utils";

export function defaultCodexHome(): string {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return join(homedir(), ".codex");
}

function findJsonlFiles(dir: string, maxFiles = 500): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(current: string) {
    if (results.length >= maxFiles) return;
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      // Sort descending by name so newer years/months/days/rollouts come first
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
          results.push(fullPath);
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  walk(dir);
  return results;
}

export function parseCodexSessionFile(filePath: string, isArchived = false): UnifiedSessionDetail | null {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;

    let sessionId = "";
    let title = "";
    let cwd = "";
    let createdAt = stats.birthtimeMs || stats.mtimeMs;
    let updatedAt = stats.mtimeMs;
    const turns: SessionTurn[] = [];
    const modifiedFilesMap = new Map<string, ModifiedFileInfo>();
    const tokens: SessionTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let rawMeta: Record<string, unknown> | undefined;

    for (let i = 0; i < lines.length; i++) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      } catch {
        continue;
      }

      // 1. session_meta line
      if (parsed.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
        const payload = parsed.payload as Record<string, unknown>;
        rawMeta = payload;
        if (payload.id && typeof payload.id === "string") {
          sessionId = payload.id;
        }
        if (payload.cwd && typeof payload.cwd === "string") {
          cwd = payload.cwd;
        }
        if (payload.timestamp && typeof payload.timestamp === "string") {
          const ts = new Date(payload.timestamp).getTime();
          if (!isNaN(ts)) createdAt = ts;
        }
      }

      // 1b. turn_context line
      if (parsed.type === "turn_context" && parsed.payload && typeof parsed.payload === "object") {
        const payload = parsed.payload as Record<string, unknown>;
        if (!cwd && payload.cwd && typeof payload.cwd === "string") {
          cwd = payload.cwd;
        }
      }

      // 2. user message
      const payload = (parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed) as Record<string, unknown>;
      const isUserMsg =
        (parsed.type === "event_msg" && payload.type === "user_message") ||
        (parsed.type === "event" && payload.type === "user_message") ||
        (parsed.type === "user_message") ||
        (parsed.type === "response_item" && payload.type === "message" && payload.role === "user");

      if (isUserMsg) {
        let msg = "";
        if (Array.isArray(payload.content)) {
          for (const part of payload.content as Array<Record<string, unknown>>) {
            if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
              msg += part.text;
            }
          }
        } else if (typeof payload.content === "string") {
          msg = payload.content;
        } else if (typeof payload.message === "string") {
          msg = payload.message;
        } else if (typeof payload.text === "string") {
          msg = payload.text;
        }

        const cleaned = cleanCodexUserPrompt(msg);
        if (cleaned) {
          if (!title) {
            title = cleaned.split("\n")[0].trim().slice(0, 120);
          }
          turns.push({
            turnId: `turn-${turns.length}`,
            role: "user",
            timestamp: parsed.timestamp ? new Date(String(parsed.timestamp)).getTime() : undefined,
            content: cleaned,
          });
        }
        continue;
      }

      // 3. assistant message / response_item
      const isAssistantMsg =
        (parsed.type === "event_msg" && payload.type === "agent_message") ||
        (parsed.type === "agent_message") ||
        (parsed.type === "response_item" && payload.type === "message" && payload.role === "assistant");

      if (isAssistantMsg) {
        let text = "";
        if (Array.isArray(payload.content)) {
          for (const part of payload.content as Array<Record<string, unknown>>) {
            if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") {
              text += part.text;
            }
          }
        } else if (typeof payload.text === "string" || (typeof payload.content === "string" && payload.type !== "function_call") || typeof payload.message === "string") {
          text = String(payload.text || payload.content || payload.message || "");
        }

        if (text) {
          turns.push({
            turnId: `turn-${turns.length}`,
            role: "assistant",
            timestamp: parsed.timestamp ? new Date(String(parsed.timestamp)).getTime() : undefined,
            content: text,
          });
        }
        continue;
      }

      // 4. function / tool calls
      if (
        (parsed.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) ||
        parsed.type === "function_call" ||
        payload.type === "function_call"
      ) {
        const toolName = String(payload.name || "");
        const args = payload.arguments;
        let parsedArgs: Record<string, unknown> | string | undefined;
        if (typeof args === "string") {
          try {
            parsedArgs = JSON.parse(args) as Record<string, unknown>;
          } catch {
            parsedArgs = args;
          }
        } else if (typeof args === "object" && args !== null) {
          parsedArgs = args as Record<string, unknown>;
        }

        // detect modified files
        if (parsedArgs && typeof parsedArgs === "object") {
          const argObj = parsedArgs as Record<string, unknown>;
          if (argObj.file_path || argObj.path || argObj.target_file) {
            const p = String(argObj.file_path || argObj.path || argObj.target_file);
            modifiedFilesMap.set(p, { path: p, changeType: "modify" });
          }
        }

        turns.push({
          turnId: `turn-${turns.length}`,
          role: "tool",
          timestamp: parsed.timestamp ? new Date(String(parsed.timestamp)).getTime() : undefined,
          content: `Tool Call: ${toolName}`,
          toolCalls: [{
            toolName,
            args: parsedArgs,
          }],
        });
        continue;
      }

      // 5. token usage. Current Codex emits `event_msg` lines whose payload carries
      // cumulative `info.total_token_usage` — the last one wins, because summing a
      // cumulative counter double counts — plus per-turn `info.last_token_usage`.
      // Older formats exposed flat per-event deltas under payload.payload, which ARE
      // summed. All three shapes must keep working.
      const tokenOuter =
        (parsed.type === "event_msg" || parsed.type === "event") && parsed.payload && typeof parsed.payload === "object"
          ? (parsed.payload as Record<string, unknown>)
          : null;
      if (tokenOuter?.type === "token_count") {
        const info = tokenOuter.info && typeof tokenOuter.info === "object" ? (tokenOuter.info as Record<string, unknown>) : null;
        const totals =
          info?.total_token_usage && typeof info.total_token_usage === "object"
            ? (info.total_token_usage as Record<string, unknown>)
            : null;
        if (totals) {
          if (typeof totals.input_tokens === "number") tokens.promptTokens = totals.input_tokens;
          if (typeof totals.output_tokens === "number") tokens.completionTokens = totals.output_tokens;
          tokens.totalTokens =
            typeof totals.total_tokens === "number" ? totals.total_tokens : tokens.promptTokens + tokens.completionTokens;
        } else if (info?.last_token_usage && typeof info.last_token_usage === "object") {
          const delta = info.last_token_usage as Record<string, unknown>;
          if (typeof delta.input_tokens === "number") tokens.promptTokens += delta.input_tokens;
          if (typeof delta.output_tokens === "number") tokens.completionTokens += delta.output_tokens;
          tokens.totalTokens = tokens.promptTokens + tokens.completionTokens;
        } else if (tokenOuter.payload && typeof tokenOuter.payload === "object") {
          const tp = tokenOuter.payload as Record<string, unknown>;
          if (typeof tp.input_tokens === "number") tokens.promptTokens += tp.input_tokens;
          if (typeof tp.output_tokens === "number") tokens.completionTokens += tp.output_tokens;
          tokens.totalTokens = tokens.promptTokens + tokens.completionTokens;
        }
      }
    }

    if (!sessionId) {
      const base = filePath.split("/").pop() || "session";
      sessionId = base.replace(/\.jsonl?$/, "").replace(/^rollout-/, "");
    }

    const project = extractProjectName(cwd);

    if (!title && project) {
      title = `Project: ${project}`;
    }

    if (!title) {
      title = `Codex Session ${sessionId.slice(0, 8)}`;
    }

    const modifiedFiles = Array.from(modifiedFilesMap.keys());
    const modifiedFileDetails = Array.from(modifiedFilesMap.values());

    return {
      id: sessionId,
      agent: "codex",
      title,
      summary: turns[0]?.content ? turns[0].content.slice(0, 200) : undefined,
      project,
      projectPath: cwd || undefined,
      status: isArchived ? "archived" : "active",
      createdAt,
      updatedAt,
      turnCount: turns.length,
      modifiedFiles,
      modifiedFileDetails,
      tokens,
      sourcePath: filePath,
      turns,
      rawMetadata: rawMeta,
    };
  } catch {
    return null;
  }
}

export function scanCodexSessions(codexHome?: string, limit = 50): UnifiedSession[] {
  const home = codexHome || defaultCodexHome();
  const sessionsDir = join(home, "sessions");
  const archivedDir = join(home, "archived_sessions");

  const sessionFiles = findJsonlFiles(sessionsDir, limit * 2).map((p) => ({ path: p, archived: false }));
  const archivedFiles = findJsonlFiles(archivedDir, limit).map((p) => ({ path: p, archived: true }));

  const allFiles = [...sessionFiles, ...archivedFiles];
  const list: UnifiedSession[] = [];
  const seen = new Set<string>();

  for (const { path, archived } of allFiles) {
    const detail = parseCodexSessionFile(path, archived);
    if (detail) {
      if (seen.has(detail.id)) continue;
      seen.add(detail.id);
      const { turns: _t, modifiedFileDetails: _m, rawMetadata: _r, ...item } = detail;
      list.push(item);
    }
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, limit);
}
