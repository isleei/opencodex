import type { SessionFilterOptions, SessionScannerConfig, UnifiedSession } from "../types";
import { parseCodexSessionFile, scanCodexSessions } from "./codex-scanner";
import { parseAgyConversationDir, scanAgySessions } from "./agy-scanner";
import { parseClaudeSessionFile, scanClaudeSessions } from "./claude-scanner";
import { parseGrokSessionFile, scanGrokSessions } from "./grok-scanner";

export { scanCodexSessions, parseCodexSessionFile } from "./codex-scanner";
export { scanAgySessions, parseAgyConversationDir } from "./agy-scanner";
export { scanClaudeSessions, parseClaudeSessionFile } from "./claude-scanner";
export { scanGrokSessions, parseGrokSessionFile } from "./grok-scanner";

export function extractProjectName(cwdOrPath?: string): string | undefined {
  if (!cwdOrPath) return undefined;
  const clean = cwdOrPath.replace(/^["']|["']$/g, "").trim();
  if (!clean) return undefined;

  const langMatch = clean.match(/\/work\/(?:js|ts|php|python|golang|go|java|rust|cpp|c|frontend|backend|apps|packages)\/([^/]+)/i);
  if (langMatch) return langMatch[1];

  const workMatch = clean.match(/\/work\/([^/]+)/i);
  if (workMatch) return workMatch[1];

  const projMatch = clean.match(/\/projects\/([^/]+)/i);
  if (projMatch) {
    const raw = projMatch[1];
    const subMatch = raw.match(/-(?:js|ts|php|python|golang|go|java|rust|cpp|c|frontend|backend|apps|packages)-([^-]+)$/i);
    if (subMatch) return subMatch[1];
    const generalSub = raw.split("-").filter(Boolean).pop();
    if (generalSub) return generalSub;
    return raw;
  }

  const base = clean.split("/").filter(Boolean).pop();
  return base || undefined;
}

/**
 * Direct-disk scan with no index. Kept for one-off inspections and tests; the
 * management API goes through src/sessions/store.ts instead, which caches parsed
 * metadata in SQLite and re-parses only changed files.
 */
export function scanAllSessions(config: SessionScannerConfig = {}, options: SessionFilterOptions = {}): UnifiedSession[] {
  const agentFilter = options.agent ?? "all";
  const projectFilter = options.project ?? "all";
  const limit = options.limit ?? 200;
  const search = options.search ? options.search.toLowerCase() : "";
  const statusFilter = options.status ?? "all";

  let results: UnifiedSession[] = [];

  if (agentFilter === "all" || agentFilter === "codex") {
    results.push(...scanCodexSessions(config.codexHome, limit));
  }
  if (agentFilter === "all" || agentFilter === "agy") {
    results.push(...scanAgySessions(config.antigravityHome, limit));
  }
  if (agentFilter === "all" || agentFilter === "claude_code") {
    results.push(...scanClaudeSessions(config.claudeHome, limit));
  }
  if (agentFilter === "all" || agentFilter === "grok") {
    results.push(...scanGrokSessions(config.grokHome, limit));
  }

  // Filter by project
  if (projectFilter !== "all") {
    results = results.filter((s) => s.project?.toLowerCase() === projectFilter.toLowerCase());
  }

  // Filter by search query
  if (search) {
    results = results.filter((s) => {
      const matchTitle = s.title.toLowerCase().includes(search);
      const matchId = s.id.toLowerCase().includes(search);
      const matchProject = s.project ? s.project.toLowerCase().includes(search) : false;
      const matchSummary = s.summary ? s.summary.toLowerCase().includes(search) : false;
      const matchFiles = s.modifiedFiles.some((f) => f.toLowerCase().includes(search));
      return matchTitle || matchId || matchProject || matchSummary || matchFiles;
    });
  }

  // Filter by status
  if (statusFilter !== "all") {
    results = results.filter((s) => s.status === statusFilter);
  }

  // Sort descending by updatedAt
  results.sort((a, b) => b.updatedAt - a.updatedAt);

  return results.slice(0, limit);
}

export function getSessionStats(config: SessionScannerConfig = {}): { total: number; codex: number; agy: number; claude_code: number; grok: number } {
  const codex = scanCodexSessions(config.codexHome, 300).length;
  const agy = scanAgySessions(config.antigravityHome, 300).length;
  const claude = scanClaudeSessions(config.claudeHome, 300).length;
  const grok = scanGrokSessions(config.grokHome, 300).length;
  return {
    total: codex + agy + claude + grok,
    codex,
    agy,
    claude_code: claude,
    grok,
  };
}
