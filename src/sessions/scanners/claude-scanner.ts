import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModifiedFileInfo, SessionTokenUsage, SessionTurn, UnifiedSession, UnifiedSessionDetail } from "../types";
import { cleanClaudeText, extractProjectName } from "../utils";

export function defaultClaudeHome(): string {
  // Like CODEX_HOME/GROK_HOME: overridable so sandboxed runs (and multi-home setups)
  // never depend on where the OS says the profile lives — Bun's homedir() ignores $HOME.
  if (process.env.CLAUDE_HOME) return process.env.CLAUDE_HOME;
  return join(homedir(), ".claude");
}

function findClaudeSessionFiles(dir: string, maxFiles = 50): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(current: string) {
    if (results.length >= maxFiles) return;
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          walk(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) {
          results.push(fullPath);
        }
      }
    } catch {
      // ignore
    }
  }

  walk(dir);
  return results;
}

export function parseClaudeSessionFile(filePath: string): UnifiedSessionDetail | null {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath, "utf8");
    if (!content.trim()) return null;

    let sessionId = filePath.split("/").pop()?.replace(/\.jsonl?$/, "") || "claude-session";
    let title = "";
    let cwd = "";
    const createdAt = stats.birthtimeMs || stats.mtimeMs;
    const updatedAt = stats.mtimeMs;
    const turns: SessionTurn[] = [];
    const modifiedFilesMap = new Map<string, ModifiedFileInfo>();
    const tokens: SessionTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (filePath.endsWith(".jsonl")) {
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.sessionId && typeof parsed.sessionId === "string") {
            sessionId = parsed.sessionId;
          }
          if (parsed.cwd && typeof parsed.cwd === "string") {
            cwd = parsed.cwd;
          }

          const msgObj = (parsed.message && typeof parsed.message === "object" ? parsed.message : parsed) as Record<string, unknown>;
          const role = parsed.type === "user" || msgObj.role === "user" ? "user" : parsed.type === "assistant" || msgObj.role === "assistant" ? "assistant" : null;

          if (role === "user") {
            let userText = "";
            if (typeof msgObj.content === "string") {
              userText = cleanClaudeText(msgObj.content);
            } else if (Array.isArray(msgObj.content)) {
              for (const part of msgObj.content as Array<Record<string, unknown>>) {
                if (part.type === "text" && typeof part.text === "string") {
                  userText += cleanClaudeText(part.text) + " ";
                }
              }
            }
            userText = userText.trim();
            if (userText) {
              if (!title) {
                title = userText.split("\n")[0].trim().slice(0, 120);
              }
              turns.push({
                turnId: `turn-${turns.length}`,
                role: "user",
                timestamp: parsed.timestamp ? new Date(String(parsed.timestamp)).getTime() : undefined,
                content: userText,
              });
            }
          } else if (role === "assistant") {
            let asstText = "";
            if (typeof msgObj.content === "string") {
              asstText = msgObj.content;
            } else if (Array.isArray(msgObj.content)) {
              for (const part of msgObj.content as Array<Record<string, unknown>>) {
                if (part.type === "text" && typeof part.text === "string") {
                  asstText += part.text + " ";
                } else if (part.type === "tool_use" && typeof part.name === "string") {
                  const toolName = part.name;
                  const input = part.input as Record<string, unknown> | undefined;
                  if (input && typeof input === "object") {
                    if (input.file_path || input.path || input.target_file) {
                      const p = String(input.file_path || input.path || input.target_file);
                      modifiedFilesMap.set(p, { path: p, changeType: "modify" });
                    }
                  }
                  turns.push({
                    turnId: `turn-${turns.length}`,
                    role: "tool",
                    timestamp: parsed.timestamp ? new Date(String(parsed.timestamp)).getTime() : undefined,
                    content: `Tool Call: ${toolName}`,
                    toolCalls: [{ toolName, args: input }],
                  });
                }
              }
            }
            asstText = asstText.trim();
            if (asstText) {
              turns.push({
                turnId: `turn-${turns.length}`,
                role: "assistant",
                timestamp: parsed.timestamp ? new Date(String(parsed.timestamp)).getTime() : undefined,
                content: asstText,
              });
            }
          }
        } catch {
          // ignore
        }
      }
    } else {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.id && typeof parsed.id === "string") sessionId = parsed.id;
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages as Array<Record<string, unknown>>) {
          const role = msg.role === "user" ? "user" : "assistant";
          const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          if (text) {
            if (role === "user" && !title) title = text.split("\n")[0].slice(0, 120);
            turns.push({ turnId: `turn-${turns.length}`, role, content: text });
          }
        }
      }
    }

    const project = extractProjectName(cwd || filePath);

    if (!title && project) {
      title = `Project: ${project}`;
    }

    if (!title) title = `Claude Session ${sessionId.slice(0, 8)}`;
    const modifiedFiles = Array.from(modifiedFilesMap.keys());
    const modifiedFileDetails = Array.from(modifiedFilesMap.values());

    return {
      id: sessionId,
      agent: "claude_code",
      title,
      summary: turns[0]?.content ? turns[0].content.slice(0, 200) : undefined,
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

export function scanClaudeSessions(claudeHome?: string, limit = 50): UnifiedSession[] {
  const home = claudeHome || defaultClaudeHome();
  const projectsDir = join(home, "projects");
  if (!existsSync(projectsDir)) return [];

  const files = findClaudeSessionFiles(projectsDir, limit);
  const list: UnifiedSession[] = [];

  for (const f of files) {
    const detail = parseClaudeSessionFile(f);
    if (detail) {
      const { turns: _t, modifiedFileDetails: _m, ...item } = detail;
      list.push(item);
    }
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, limit);
}
