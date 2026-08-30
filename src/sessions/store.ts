/**
 * SQLite-backed index for cross-agent sessions.
 *
 * The agents' own files (Codex rollouts, Claude Code transcripts, AGY brain logs) stay
 * the single source of truth. This index is a derived cache: one row per session file,
 * keyed by (agent, session id), carrying the source file's mtime+size so a refresh only
 * re-parses what changed. Deleting the index file loses nothing — the next refresh
 * rebuilds it from disk.
 *
 * The index exists because a full parse of every rollout is seconds of synchronous
 * work on a real machine (~1GB of JSONL and growing); a stat-only walk plus a diff
 * against this index keeps every dashboard request at walk cost, and the search now
 * covers the whole library instead of the newest N files.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import type { SessionFilterOptions, SessionScannerConfig, UnifiedSession } from "./types";
import { defaultCodexHome, parseCodexSessionFile } from "./scanners/codex-scanner";
import { defaultAgyBrainDir, parseAgyConversationDir, resolveAgyTranscriptPath } from "./scanners/agy-scanner";
import { defaultClaudeHome, parseClaudeSessionFile } from "./scanners/claude-scanner";
import { defaultGrokHome, parseGrokSessionFile } from "./scanners/grok-scanner";
import type { UnifiedSessionDetail } from "./types";

const SCHEMA_VERSION = "1";
/** Files parsed per event-loop yield during (re)indexing, so the proxy stays responsive. */
const PARSE_CHUNK = 8;

interface ResolvedSessionHomes {
  codexHome: string;
  agyBrainDir: string;
  claudeHome: string;
  grokHome: string;
}

interface SourceFile {
  agent: "codex" | "agy" | "claude_code" | "grok";
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  status: "active" | "archived";
  /** For AGY: the conversation directory name (the parser is dir-based, not file-based). */
  parseId?: string;
}

interface SessionRow {
  agent: string;
  id: string;
  source_path: string;
  title: string;
  summary: string | null;
  project: string | null;
  project_path: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  turn_count: number;
  modified_files: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  file_mtime_ms: number;
  file_size_bytes: number;
}

export function resolveSessionHomes(config: SessionScannerConfig = {}): ResolvedSessionHomes {
  return {
    codexHome: config.codexHome || defaultCodexHome(),
    agyBrainDir: config.antigravityHome || defaultAgyBrainDir(),
    claudeHome: config.claudeHome || defaultClaudeHome(),
    grokHome: config.grokHome || defaultGrokHome(),
  };
}

function walkSessionFiles(root: string, agent: SourceFile["agent"], status: SourceFile["status"], sink: SourceFile[]): void {
  if (!existsSync(root)) return;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
        try {
          const stats = statSync(fullPath);
          sink.push({ agent, path: fullPath, mtimeMs: stats.mtimeMs, sizeBytes: stats.size, status });
        } catch {
          // File vanished between readdir and stat; the next refresh will not miss it.
        }
      }
    }
  };
  walk(root);
}

function collectSourceFiles(homes: ResolvedSessionHomes): SourceFile[] {
  const files: SourceFile[] = [];
  walkSessionFiles(join(homes.codexHome, "sessions"), "codex", "active", files);
  walkSessionFiles(join(homes.codexHome, "archived_sessions"), "codex", "archived", files);
  walkSessionFiles(join(homes.claudeHome, "projects"), "claude_code", "active", files);
  collectGrokSessionFiles(homes.grokHome, files);

  if (existsSync(homes.agyBrainDir)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(homes.agyBrainDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const convDir = join(homes.agyBrainDir, entry.name);
      const transcript = resolveAgyTranscriptPath(convDir);
      if (!transcript) continue;
      try {
        const stats = statSync(transcript);
        files.push({
          agent: "agy",
          path: transcript,
          mtimeMs: stats.mtimeMs,
          sizeBytes: stats.size,
          status: "active",
          parseId: entry.name,
        });
      } catch {
        // Transcript vanished mid-walk; picked up on the next refresh.
      }
    }
  }
  return files;
}

/**
 * Grok session files are exactly `<grokHome>/sessions/<encoded-cwd>/<id>/updates.jsonl`;
 * walk that fixed shape instead of a generic JSONL walk so unrelated files under
 * ~/.grok can never enter the index.
 */
function collectGrokSessionFiles(grokHome: string, sink: SourceFile[]): void {
  const root = join(grokHome, "sessions");
  if (!existsSync(root)) return;
  let cwdDirs: Dirent[];
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory() || cwdDir.name.startsWith(".")) continue;
    const cwdPath = join(root, cwdDir.name);
    let sessionDirs: Dirent[];
    try {
      sessionDirs = readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory() || sessionDir.name.startsWith(".")) continue;
      const file = join(cwdPath, sessionDir.name, "updates.jsonl");
      if (!existsSync(file)) continue;
      try {
        const stats = statSync(file);
        sink.push({ agent: "grok", path: file, mtimeMs: stats.mtimeMs, sizeBytes: stats.size, status: "active" });
      } catch {
        // File vanished mid-walk; picked up on the next refresh.
      }
    }
  }
}

function parseSourceFile(file: SourceFile, homes: ResolvedSessionHomes): UnifiedSessionDetail | null {
  try {
    if (file.agent === "codex") return parseCodexSessionFile(file.path, file.status === "archived");
    if (file.agent === "claude_code") return parseClaudeSessionFile(file.path);
    if (file.agent === "grok") return parseGrokSessionFile(file.path);
    if (file.agent === "agy" && file.parseId) return parseAgyConversationDir(join(homes.agyBrainDir, file.parseId), file.parseId);
    return null;
  } catch {
    return null;
  }
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function rowToSession(row: SessionRow): UnifiedSession {
  let modifiedFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.modified_files) as unknown;
    if (Array.isArray(parsed)) modifiedFiles = parsed.filter((f): f is string => typeof f === "string");
  } catch {
    // A corrupt JSON blob must not hide the whole session row.
  }
  return {
    id: row.id,
    agent: row.agent as UnifiedSession["agent"],
    title: row.title,
    summary: row.summary ?? undefined,
    project: row.project ?? undefined,
    projectPath: row.project_path ?? undefined,
    status: row.status as UnifiedSession["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turnCount: row.turn_count,
    modifiedFiles,
    tokens: {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
    },
    sourcePath: row.source_path,
  };
}

const COLUMNS = `agent, id, source_path, title, summary, project, project_path, status,
  created_at, updated_at, turn_count, modified_files,
  prompt_tokens, completion_tokens, total_tokens, file_mtime_ms, file_size_bytes`;

export class SessionIndexStore {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly homes: ResolvedSessionHomes;
  private refreshPromise: Promise<void> | null = null;

  constructor(dbPath: string, homes: ResolvedSessionHomes) {
    this.dbPath = dbPath;
    this.homes = homes;
    this.db = this.openDatabase(dbPath);
  }

  private openDatabase(dbPath: string): Database {
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      return this.openAndMigrate(dbPath);
    } catch {
      // A corrupt index must not brick the Sessions page forever: drop and rebuild.
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // Fall through and surface the original open error.
      }
      return this.openAndMigrate(dbPath);
    }
  }

  private openAndMigrate(dbPath: string): Database {
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | null;
    if (version && version.value !== SCHEMA_VERSION) {
      db.run("DROP TABLE IF EXISTS sessions");
      db.run("DELETE FROM meta");
    }
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      agent TEXT NOT NULL,
      id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT,
      project TEXT,
      project_path TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      modified_files TEXT NOT NULL DEFAULT '[]',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      file_mtime_ms INTEGER NOT NULL DEFAULT 0,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent, id)
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)");
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_path ON sessions(source_path)");
    db.run(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [SCHEMA_VERSION],
    );
    return db;
  }

  /**
   * Re-parse only sources whose (mtime, size) changed since they were indexed, prune
   * rows whose source file is gone, and yield to the event loop between parse chunks —
   * a cold index means seconds of JSONL parsing and the proxy must keep serving while
   * it happens. Concurrent callers share one in-flight refresh.
   */
  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    const homes = this.homes;
    const files = collectSourceFiles(homes);

    const knownRows = this.db.query("SELECT agent, source_path, file_mtime_ms, file_size_bytes FROM sessions").all() as Array<{
      agent: string;
      source_path: string;
      file_mtime_ms: number;
      file_size_bytes: number;
    }>;
    const known = new Map(knownRows.map(r => [`${r.agent}\u0000${r.source_path}`, r]));

    const current = new Set(files.map(f => `${f.agent}\u0000${f.path}`));
    const stale = [...known.keys()].filter(key => !current.has(key));
    if (stale.length > 0) {
      const remove = this.db.transaction((keys: string[]) => {
        for (const key of keys) {
          const [agent, path] = key.split("\u0000");
          this.db.run("DELETE FROM sessions WHERE agent = ? AND source_path = ?", [agent, path]);
        }
      });
      remove(stale);
    }

    const toParse = files.filter(f => {
      const prev = known.get(`${f.agent}\u0000${f.path}`);
      return !prev || prev.file_mtime_ms !== f.mtimeMs || prev.file_size_bytes !== f.sizeBytes;
    });

    const upsert = this.db.transaction((rows: SessionRow[]) => {
      for (const row of rows) {
        this.db.run(
          `INSERT INTO sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent, id) DO UPDATE SET
             source_path = excluded.source_path, title = excluded.title, summary = excluded.summary,
             project = excluded.project, project_path = excluded.project_path, status = excluded.status,
             created_at = excluded.created_at, updated_at = excluded.updated_at, turn_count = excluded.turn_count,
             modified_files = excluded.modified_files, prompt_tokens = excluded.prompt_tokens,
             completion_tokens = excluded.completion_tokens, total_tokens = excluded.total_tokens,
             file_mtime_ms = excluded.file_mtime_ms, file_size_bytes = excluded.file_size_bytes
           WHERE excluded.updated_at >= sessions.updated_at`,
          [
            row.agent, row.id, row.source_path, row.title, row.summary, row.project, row.project_path,
            row.status, row.created_at, row.updated_at, row.turn_count, row.modified_files,
            row.prompt_tokens, row.completion_tokens, row.total_tokens, row.file_mtime_ms, row.file_size_bytes,
          ],
        );
      }
    });

    for (let i = 0; i < toParse.length; i += PARSE_CHUNK) {
      const rows: SessionRow[] = [];
      for (const file of toParse.slice(i, i + PARSE_CHUNK)) {
        const detail = parseSourceFile(file, homes);
        if (!detail) continue;
        rows.push({
          agent: detail.agent,
          id: detail.id,
          source_path: file.path,
          title: detail.title,
          summary: detail.summary ?? null,
          project: detail.project ?? null,
          project_path: detail.projectPath ?? null,
          status: file.status,
          created_at: detail.createdAt,
          updated_at: detail.updatedAt,
          turn_count: detail.turnCount,
          modified_files: JSON.stringify(detail.modifiedFiles),
          prompt_tokens: detail.tokens.promptTokens,
          completion_tokens: detail.tokens.completionTokens,
          total_tokens: detail.tokens.totalTokens,
          file_mtime_ms: file.mtimeMs,
          file_size_bytes: file.sizeBytes,
        });
      }
      if (rows.length > 0) upsert(rows);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  list(options: SessionFilterOptions = {}): UnifiedSession[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (options.agent && options.agent !== "all") {
      where.push("agent = ?");
      params.push(options.agent);
    }
    if (options.status && options.status !== "all") {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.project) {
      where.push("project = ? COLLATE NOCASE");
      params.push(options.project);
    }
    if (options.search) {
      const pattern = `%${escapeLike(options.search.toLowerCase())}%`;
      where.push(
        `(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(summary, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(project, '')) LIKE ? ESCAPE '\\' OR LOWER(modified_files) LIKE ? ESCAPE '\\'
          OR LOWER(id) LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    const limit = Math.max(1, options.limit ?? 200);
    const sql = `SELECT ${COLUMNS} FROM sessions
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC LIMIT ?`;
    const rows = this.db.query(sql).all(...params, limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  stats(): { total: number; codex: number; agy: number; claude_code: number; grok: number } {
    const rows = this.db.query("SELECT agent, COUNT(*) AS count FROM sessions GROUP BY agent").all() as Array<{
      agent: string;
      count: number;
    }>;
    const counts = new Map(rows.map(r => [r.agent, r.count]));
    const codex = counts.get("codex") ?? 0;
    const agy = counts.get("agy") ?? 0;
    const claude = counts.get("claude_code") ?? 0;
    const grok = counts.get("grok") ?? 0;
    return { total: codex + agy + claude + grok, codex, agy, claude_code: claude, grok };
  }

  /** Where a session's source file lives, so detail views read one file instead of scanning. */
  locate(agent: string, id: string): { path: string; status: string } | null {
    const row = this.db
      .query("SELECT source_path, status FROM sessions WHERE agent = ? AND id = ?")
      .get(agent, id) as { source_path: string; status: string } | null;
    return row ? { path: row.source_path, status: row.status } : null;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * One store per resolved home triple. The homes are part of the key (and the DB file
 * name) because two fixtures with different sandboxed agent homes must never share an
 * index — the stale-row pruning in a refresh would otherwise delete the other
 * fixture's rows mid-test under parallel file execution.
 */
const stores = new Map<string, SessionIndexStore>();

export function getSessionStore(config: SessionScannerConfig = {}): SessionIndexStore {
  const homes = resolveSessionHomes(config);
  const hash = createHash("sha1")
    .update(JSON.stringify([homes.codexHome, homes.agyBrainDir, homes.claudeHome, homes.grokHome]))
    .digest("hex")
    .slice(0, 12);
  const dbPath = join(getConfigDir(), `sessions-index-${hash}.sqlite`);
  const key = dbPath;
  let store = stores.get(key);
  if (!store) {
    store = new SessionIndexStore(dbPath, homes);
    stores.set(key, store);
  }
  return store;
}

/** Test hook: drop cached stores so a later call re-resolves homes and reopens the DB. */
export function closeAllSessionStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}
