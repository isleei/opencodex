import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listUnifiedSessions,
  listUnifiedSessionsWithStats,
  getUnifiedSession,
} from "../src/sessions/manager";
import { getSessionStore, closeAllSessionStores } from "../src/sessions/store";

/**
 * Index store tests run against real fixture directories under a per-run tmpdir; the
 * SQLite files live in the sandboxed OPENCODEX_HOME (see tests/preload.ts), keyed by
 * the fixture home triple, so parallel test files never share an index.
 */
describe("Sessions SQLite index store", () => {
  const testRoot = join(tmpdir(), `ocx-sessions-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const codexHome = join(testRoot, "codex");
  const claudeHome = join(testRoot, "claude");
  const agyBrain = join(testRoot, "agy-brain");
  const grokHome = join(testRoot, "grok");
  const config = { codexHome, claudeHome, antigravityHome: agyBrain, grokHome };

  function writeGrokSession(id: string, prompt: string): void {
    const sessionDir = join(grokHome, "sessions", "%2Fwork%2Fjs%2Fgrokproj", id);
    mkdirSync(sessionDir, { recursive: true });
    const update = (sessionUpdate: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        timestamp: 1756500000,
        method: "_x.ai/session/update",
        params: { sessionId: id, update: { sessionUpdate, ...extra } },
      });
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [
        update("user_message_chunk", { content: { type: "text", text: prompt } }),
        update("turn_completed", { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
      ].join("\n"),
    );
  }

  function writeCodexSession(id: string, prompt: string, extraLines: string[] = [], dir?: string): string {
    const sessionsDir = dir || join(codexHome, "sessions", "2026", "08", "30");
    mkdirSync(sessionsDir, { recursive: true });
    const file = join(sessionsDir, `rollout-2026-08-30T10-00-00-${id}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2026-08-30T10:00:00Z" } }),
        JSON.stringify({ type: "user_message", message: `<USER_REQUEST>${prompt}</USER_REQUEST>` }),
        ...extraLines,
      ].join("\n"),
    );
    return file;
  }

  afterEach(() => {
    closeAllSessionStores();
  });

  afterAll(() => {
    closeAllSessionStores();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("indexes codex, claude, agy, and grok sessions and answers stats from the index", async () => {
    writeCodexSession("idx-codex-1", "Build the ingestion pipeline");
    const claudeDir = join(claudeHome, "projects", "proj-one");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "idx-claude-2.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Tune the k8s probes" }, cwd: "/work/js/proj-one" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Adjusted probes." } }),
      ].join("\n"),
    );
    const agyLogs = join(agyBrain, "idx-agy-3", ".system_generated", "logs");
    mkdirSync(agyLogs, { recursive: true });
    writeFileSync(
      join(agyLogs, "transcript.jsonl"),
      [
        JSON.stringify({ type: "USER_INPUT", source: "USER_EXPLICIT", content: "Profile the startup path", created_at: "2026-08-30T10:30:00Z" }),
      ].join("\n"),
    );
    writeGrokSession("idx-grok-4", "Migrate the config loader");

    const { sessions, stats } = await listUnifiedSessionsWithStats({ agent: "all", limit: 200 }, config);
    const ids = sessions.map(s => s.id);
    expect(ids).toContain("idx-codex-1");
    expect(ids).toContain("idx-claude-2");
    expect(ids).toContain("idx-agy-3");
    expect(ids).toContain("idx-grok-4");
    expect(stats.codex).toBe(1);
    expect(stats.claude_code).toBe(1);
    expect(stats.agy).toBe(1);
    expect(stats.grok).toBe(1);
    expect(stats.total).toBe(4);

    const grokOnly = await listUnifiedSessions({ agent: "grok" }, config);
    expect(grokOnly.map(s => s.id)).toContain("idx-grok-4");
    expect(grokOnly.every(s => s.agent === "grok")).toBe(true);
  });

  test("refresh is incremental: new, modified, and deleted files are reconciled", async () => {
    const file = writeCodexSession("incr-codex-1", "First version of the plan");

    const before = await listUnifiedSessions({ agent: "codex", search: "First version of the plan" }, config);
    expect(before.length).toBe(1);

    // Modified source (size changes) must be re-parsed, not served from the stale row.
    // (The second user prompt only lives in turns — list-level search covers metadata.)
    appendFileSync(file, `\n${JSON.stringify({ type: "user_message", message: "<USER_REQUEST>Revised the plan</USER_REQUEST>" })}`);
    const afterAppend = await listUnifiedSessions({ agent: "codex", search: "First version of the plan" }, config);
    expect(afterAppend.length).toBe(1);
    expect(afterAppend[0].id).toBe("incr-codex-1");
    expect(afterAppend[0].turnCount).toBe(2);

    // Deleted source must prune its row.
    rmSync(file);
    const afterDelete = await listUnifiedSessions({ agent: "codex", search: "First version of the plan" }, config);
    expect(afterDelete.length).toBe(0);
  });

  test("filters by agent, status, and project; search covers the whole library", async () => {
    writeCodexSession("filt-active-1", "Ship the exporter");
    const archivedDir = join(codexHome, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(
      join(archivedDir, "rollout-2026-01-01T00-00-00-filt-archived-2.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "filt-archived-2", timestamp: "2026-01-01T00:00:00Z" } }),
        JSON.stringify({ type: "user_message", message: "<USER_REQUEST>Rename the exporter flags</USER_REQUEST>" }),
      ].join("\n"),
    );

    const active = await listUnifiedSessions({ agent: "codex", status: "active", search: "exporter" }, config);
    expect(active.map(s => s.id)).toContain("filt-active-1");
    expect(active.map(s => s.id)).not.toContain("filt-archived-2");

    const archived = await listUnifiedSessions({ agent: "codex", status: "archived" }, config);
    expect(archived.map(s => s.id)).toContain("filt-archived-2");
    expect(archived.every(s => s.status === "archived")).toBe(true);

    // limit=1 must not hide matching rows: search applies over the full index.
    const limited = await listUnifiedSessions({ agent: "codex", search: "exporter", limit: 1 }, config);
    expect(limited.length).toBe(1);
    expect(limited[0].title.toLowerCase()).toContain("exporter");
  });

  test("detail lookup reads one file via the index, including sessions beyond a small list limit", async () => {
    for (let i = 0; i < 4; i++) {
      writeCodexSession(`detail-codex-${i}`, `Detail probe session ${i}`);
    }
    const listed = await listUnifiedSessions({ agent: "codex", limit: 1 }, config);
    expect(listed.length).toBe(1);

    // detail-codex-0 may not be in the newest file set, but the index knows its path.
    const detail = await getUnifiedSession("codex", "detail-codex-0", config);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("detail-codex-0");
    expect(detail?.turns.length).toBeGreaterThan(0);
    expect(existsSync(detail?.sourcePath ?? "")).toBe(true);

    const missing = await getUnifiedSession("codex", "no-such-session", config);
    expect(missing).toBeNull();
  });

  test("cumulative Codex token usage is not double counted", async () => {
    writeCodexSession("tokens-codex-1", "Count my tokens", [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 26258, output_tokens: 309, total_tokens: 26567 },
            last_token_usage: { input_tokens: 26258, output_tokens: 309, total_tokens: 26567 },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 57306, output_tokens: 727, total_tokens: 58033 },
            last_token_usage: { input_tokens: 31048, output_tokens: 418, total_tokens: 31466 },
          },
        },
      }),
    ]);

    const sessions = await listUnifiedSessions({ agent: "codex", search: "Count my tokens" }, config);
    expect(sessions.length).toBe(1);
    expect(sessions[0].tokens.promptTokens).toBe(57306);
    expect(sessions[0].tokens.completionTokens).toBe(727);
    expect(sessions[0].tokens.totalTokens).toBe(58033);
  });

  test("concurrent list calls share one refresh and stay consistent", async () => {
    writeCodexSession("race-codex-1", "Concurrent refresh probe");
    const [a, b, c] = await Promise.all([
      listUnifiedSessions({ agent: "codex", search: "Concurrent refresh probe" }, config),
      listUnifiedSessions({ agent: "codex", search: "Concurrent refresh probe" }, config),
      listUnifiedSessions({ agent: "codex", search: "Concurrent refresh probe" }, config),
    ]);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(c.length).toBe(1);
  });

  test("each fixture home triple gets its own isolated index file", async () => {
    const otherHome = join(testRoot, "codex-alt");
    const otherConfig = { ...config, codexHome: otherHome };
    writeCodexSession("iso-codex-1", "Only in the alternate home", [], join(otherHome, "sessions", "2026", "08", "30"));

    const alt = await listUnifiedSessions({ agent: "codex", search: "Only in the alternate home" }, otherConfig);
    expect(alt.length).toBe(1);

    // The primary home's index must not know this session.
    const primary = await listUnifiedSessions({ agent: "codex", search: "Only in the alternate home" }, config);
    expect(primary.length).toBe(0);

    const store = getSessionStore(config);
    expect(store.dbPath).not.toBe(getSessionStore(otherConfig).dbPath);
  });
});
