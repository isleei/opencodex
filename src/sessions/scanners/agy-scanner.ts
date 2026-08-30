import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModifiedFileInfo, SessionTokenUsage, SessionTurn, UnifiedSession, UnifiedSessionDetail } from "../types";
import { cleanAgyUserPrompt, extractProjectName } from "../utils";

export function defaultAgyBrainDir(): string {
  if (process.env.ANTIGRAVITY_HOME) {
    return join(process.env.ANTIGRAVITY_HOME, "brain");
  }
  if (process.env.GEMINI_HOME) {
    return join(process.env.GEMINI_HOME, "antigravity-ide", "brain");
  }
  return join(homedir(), ".gemini", "antigravity-ide", "brain");
}

/**
 * The transcript file backing one AGY conversation directory. Shared by the parser and
 * the index collector so both always read the same bytes for the same conversation.
 */
export function resolveAgyTranscriptPath(convDir: string): string | null {
  const transcriptPath = join(convDir, ".system_generated", "logs", "transcript.jsonl");
  const fullTranscriptPath = join(convDir, ".system_generated", "logs", "transcript_full.jsonl");
  if (existsSync(transcriptPath)) return transcriptPath;
  if (existsSync(fullTranscriptPath)) return fullTranscriptPath;
  return null;
}

export function parseAgyConversationDir(convDir: string, convId: string): UnifiedSessionDetail | null {
  try {
    const targetFile = resolveAgyTranscriptPath(convDir);
    if (!targetFile) return null;

    const stats = statSync(targetFile);
    const content = readFileSync(targetFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;

    let title = "";
    let cwd = "";
    let createdAt = stats.birthtimeMs || stats.mtimeMs;
    let updatedAt = stats.mtimeMs;
    const turns: SessionTurn[] = [];
    const modifiedFilesMap = new Map<string, ModifiedFileInfo>();
    const tokens: SessionTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let i = 0; i < lines.length; i++) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.created_at && typeof parsed.created_at === "string") {
        const ts = new Date(parsed.created_at).getTime();
        if (!isNaN(ts)) {
          if (i === 0) createdAt = ts;
          updatedAt = ts;
        }
      }

      // Check cwd in raw content
      if (!cwd && parsed.content && typeof parsed.content === "string") {
        const m = parsed.content.match(/\[(\/[^\]\n]+)\]\s*->/);
        if (m) cwd = m[1];
      }

      // User Input
      if (parsed.type === "USER_INPUT" || parsed.source === "USER_EXPLICIT") {
        const rawContent = String(parsed.content || "");
        const cleanContent = cleanAgyUserPrompt(rawContent);
        if (cleanContent) {
          if (!title) {
            title = cleanContent.split("\n")[0].slice(0, 120);
          }
          turns.push({
            turnId: `turn-${turns.length}`,
            role: "user",
            timestamp: parsed.created_at ? new Date(String(parsed.created_at)).getTime() : undefined,
            content: cleanContent,
          });
        }
      }

      // Planner / Model Response
      if (parsed.type === "PLANNER_RESPONSE" || parsed.source === "MODEL") {
        const text = String(parsed.content || "");
        const toolCallsList: Array<{ toolName: string; args?: Record<string, unknown> | string; result?: string }> = [];

        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls as Array<Record<string, unknown>>) {
            const func = tc.function && typeof tc.function === "object" ? (tc.function as Record<string, unknown>) : undefined;
            const toolName = String(tc.name || func?.name || "");
            const args = (tc.args || tc.arguments || tc.parameters) as Record<string, unknown> | string | undefined;

            // detect file modification and cwd in tools
            if (args && typeof args === "object") {
              const argObj = args as Record<string, unknown>;
              if (!cwd) {
                if (typeof argObj.Cwd === "string") cwd = argObj.Cwd;
                else if (typeof argObj.DirectoryPath === "string") cwd = argObj.DirectoryPath;
              }
              const pathArg = argObj.TargetFile || argObj.target_file || argObj.AbsolutePath || argObj.path;
              if (pathArg && typeof pathArg === "string") {
                if (!cwd && pathArg.startsWith("/")) cwd = pathArg;
                if (toolName.includes("write") || toolName.includes("create")) {
                  modifiedFilesMap.set(pathArg, { path: pathArg, changeType: "create" });
                } else if (toolName.includes("replace") || toolName.includes("edit") || toolName.includes("patch")) {
                  modifiedFilesMap.set(pathArg, { path: pathArg, changeType: "modify" });
                } else if (toolName.includes("delete") || toolName.includes("remove")) {
                  modifiedFilesMap.set(pathArg, { path: pathArg, changeType: "delete" });
                }
              }
            }

            if (toolName) {
              toolCallsList.push({
                toolName,
                args,
              });
            }
          }
        }

        if (text || toolCallsList.length > 0) {
          turns.push({
            turnId: `turn-${turns.length}`,
            role: "assistant",
            timestamp: parsed.created_at ? new Date(String(parsed.created_at)).getTime() : undefined,
            content: text || (toolCallsList.length > 0 ? `Executed tools: ${toolCallsList.map((t) => t.toolName).join(", ")}` : ""),
            toolCalls: toolCallsList.length > 0 ? toolCallsList : undefined,
          });
        }
      }
    }

    const project = extractProjectName(cwd);

    if (!title && project) {
      title = `Project: ${project}`;
    }

    if (!title) {
      title = `AGY Session ${convId.slice(0, 8)}`;
    }

    const modifiedFiles = Array.from(modifiedFilesMap.keys());
    const modifiedFileDetails = Array.from(modifiedFilesMap.values());

    return {
      id: convId,
      agent: "agy",
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
      sourcePath: targetFile,
      turns,
    };
  } catch {
    return null;
  }
}

export function scanAgySessions(brainDir?: string, limit = 50): UnifiedSession[] {
  const dir = brainDir || defaultAgyBrainDir();
  if (!existsSync(dir)) return [];

  const list: UnifiedSession[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const convDir = join(dir, entry.name);
        const detail = parseAgyConversationDir(convDir, entry.name);
        if (detail) {
          const { turns: _t, modifiedFileDetails: _m, ...item } = detail;
          list.push(item);
        }
      }
    }
  } catch {
    // ignore read error
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, limit);
}
