import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ModifiedFileInfo, SessionTokenUsage, SessionTurn, UnifiedSession, UnifiedSessionDetail } from "../types";
import { extractProjectName } from "../utils";

export function defaultGrokHome(): string {
  if (process.env.GROK_HOME) return process.env.GROK_HOME;
  return join(homedir(), ".grok");
}

/**
 * Grok Build records sessions as `_x.ai/session/update` JSONL streams:
 * `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl`, one line per
 * streaming update (message chunks, tool calls, per-turn usage, session recap).
 * Message chunks for one message arrive as consecutive same-kind events, interleaved
 * with thought chunks — consecutive same-kind chunks are accumulated into one turn.
 */
export function parseGrokSessionFile(filePath: string): UnifiedSessionDetail | null {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;

    let sessionId = "";
    let recapSummary = "";
    let createdAt = stats.birthtimeMs || stats.mtimeMs;
    let updatedAt = stats.mtimeMs;
    let firstEventTs: number | undefined;
    let lastEventTs: number | undefined;
    const turns: SessionTurn[] = [];
    const modifiedFilesMap = new Map<string, ModifiedFileInfo>();
    const tokens: SessionTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    let pendingUser = "";
    let pendingAssistant = "";

    const flushUser = () => {
      const text = pendingUser.trim();
      pendingUser = "";
      if (!text) return;
      turns.push({
        turnId: `turn-${turns.length}`,
        role: "user",
        timestamp: lastEventTs,
        content: text,
      });
    };
    const flushAssistant = () => {
      const text = pendingAssistant.trim();
      pendingAssistant = "";
      if (!text) return;
      turns.push({
        turnId: `turn-${turns.length}`,
        role: "assistant",
        timestamp: lastEventTs,
        content: text,
      });
    };

    for (const line of lines) {
      let parsed: { timestamp?: number; params?: { sessionId?: unknown; update?: unknown } };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed.timestamp === "number") {
        const ms = parsed.timestamp * 1000;
        if (firstEventTs === undefined) firstEventTs = ms;
        lastEventTs = ms;
      }

      const params = parsed.params && typeof parsed.params === "object" ? parsed.params : undefined;
      if (!sessionId && params && typeof params.sessionId === "string") {
        sessionId = params.sessionId;
      }
      const update = params && typeof params.update === "object" && params.update !== null
        ? (params.update as Record<string, unknown>)
        : undefined;
      if (!update) continue;
      const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

      if (kind === "user_message_chunk") {
        flushAssistant();
        pendingUser += grokChunkText(update);
        continue;
      }
      if (kind === "agent_message_chunk") {
        flushUser();
        pendingAssistant += grokChunkText(update);
        continue;
      }
      // Thought chunks interleave with one assistant message's chunks — accumulate through.
      if (kind === "agent_thought_chunk") {
        continue;
      }
      if (kind === "tool_call") {
        flushUser();
        flushAssistant();
        const toolName = typeof update.title === "string" ? update.title : "";
        const args = update.rawInput && typeof update.rawInput === "object" ? (update.rawInput as Record<string, unknown>) : undefined;
        const toolMeta = readToolMeta(update);
        if (args) {
          const changed = grokModifiedFile(args, toolMeta);
          if (changed) modifiedFilesMap.set(changed.path, changed);
        }
        if (toolName) {
          turns.push({
            turnId: `turn-${turns.length}`,
            role: "tool",
            timestamp: lastEventTs,
            content: `Tool Call: ${toolName}`,
            toolCalls: [{ toolName, args }],
          });
        }
        continue;
      }
      if (kind === "turn_completed") {
        flushUser();
        flushAssistant();
        const usage = update.usage && typeof update.usage === "object" ? (update.usage as Record<string, unknown>) : null;
        if (usage) {
          // Per-turn usage; a session total is the sum over its turns.
          if (typeof usage.inputTokens === "number") tokens.promptTokens += usage.inputTokens;
          if (typeof usage.outputTokens === "number") tokens.completionTokens += usage.outputTokens;
          if (typeof usage.totalTokens === "number") tokens.totalTokens += usage.totalTokens;
          else tokens.totalTokens = tokens.promptTokens + tokens.completionTokens;
        }
        continue;
      }
      if (kind === "session_recap" && typeof update.summary === "string") {
        recapSummary = update.summary;
        continue;
      }
    }
    flushUser();
    flushAssistant();

    if (firstEventTs !== undefined) createdAt = firstEventTs;
    if (lastEventTs !== undefined) updatedAt = lastEventTs;

    if (!sessionId) {
      sessionId = basename(dirname(filePath));
    }

    // The parent-of-parent directory name is the URL-encoded workspace path.
    let cwd = "";
    const encodedCwd = basename(dirname(dirname(filePath)));
    try {
      cwd = decodeURIComponent(encodedCwd);
    } catch {
      cwd = encodedCwd;
    }
    const project = extractProjectName(cwd);

    const firstUserTurn = turns.find(t => t.role === "user");
    let title = firstUserTurn?.content.split("\n")[0].trim().slice(0, 120) || "";
    if (!title && project) title = `Project: ${project}`;
    if (!title) title = `Grok Session ${sessionId.slice(0, 8)}`;

    const summary = recapSummary || (firstUserTurn?.content ? firstUserTurn.content.slice(0, 200) : undefined);
    const modifiedFiles = Array.from(modifiedFilesMap.keys());
    const modifiedFileDetails = Array.from(modifiedFilesMap.values());

    return {
      id: sessionId,
      agent: "grok",
      title,
      summary,
      project,
      projectPath: cwd || undefined,
      status: "active",
      createdAt,
      updatedAt,
      turnCount: turns.length,
      modifiedFiles,
      modifiedFileDetails,
      tokens,
      sourcePath: filePath,
      turns,
    };
  } catch {
    return null;
  }
}

function grokChunkText(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function readToolMeta(update: Record<string, unknown>): { kind: string } {
  const meta = update._meta && typeof update._meta === "object" ? (update._meta as Record<string, unknown>) : undefined;
  const tool = meta?.["x.ai/tool"];
  if (tool && typeof tool === "object") {
    const kind = (tool as Record<string, unknown>).kind;
    if (typeof kind === "string") return { kind };
  }
  return { kind: "" };
}

function grokModifiedFile(args: Record<string, unknown>, toolMeta: { kind: string }): ModifiedFileInfo | null {
  for (const key of ["file_path", "target_file", "path", "absolute_path", "AbsolutePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const kind = toolMeta.kind;
      const changeType: ModifiedFileInfo["changeType"] =
        /delete|remove/i.test(kind) ? "delete"
        : /write|create/i.test(kind) ? "create"
        : "modify";
      return { path: value, changeType };
    }
  }
  return null;
}

export function scanGrokSessions(grokHome?: string, limit = 50): UnifiedSession[] {
  const home = grokHome || defaultGrokHome();
  const sessionsRoot = join(home, "sessions");
  if (!existsSync(sessionsRoot)) return [];

  const list: UnifiedSession[] = [];
  let cwdDirs;
  try {
    cwdDirs = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory() || cwdDir.name.startsWith(".")) continue;
    const cwdPath = join(sessionsRoot, cwdDir.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory() || sessionDir.name.startsWith(".")) continue;
      const detail = parseGrokSessionFile(join(cwdPath, sessionDir.name, "updates.jsonl"));
      if (detail) {
        const { turns: _t, modifiedFileDetails: _m, ...item } = detail;
        list.push(item);
      }
    }
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, limit);
}
