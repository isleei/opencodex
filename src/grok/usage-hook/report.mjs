#!/usr/bin/env node
/**
 * Grok Build hook → opencodex usage + live Logs
 *
 * On Stop / SessionEnd, reads Grok's on-disk turn_completed usage (real token
 * counts from the native session) and reports them to opencodex:
 *
 *   1. POST /api/usage/ingest  → usage.jsonl + live Logs ring (preferred)
 *   2. Fallback: append usage.jsonl only (if ocx is down or old)
 *
 * Skips ocx-routed / non-native models so proxy traffic is not double-counted.
 * Fail-open: any error exits 0 so Grok is never blocked.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCODEX_DIR = process.env.OPENCODEX_HOME || join(homedir(), ".opencodex");
const USAGE_LOG = join(OPENCODEX_DIR, "usage.jsonl");
const STATE_PATH = join(OPENCODEX_DIR, "grok-native-usage-state.json");
/** Prefer env, but always also search the canonical ~/.grok (sessions often live there). */
function grokHomes() {
  const homes = [];
  if (process.env.GROK_HOME) homes.push(process.env.GROK_HOME);
  const canonical = join(homedir(), ".grok");
  if (!homes.includes(canonical)) homes.push(canonical);
  return homes;
}

function failOpen(err) {
  try {
    const logDir = join(OPENCODEX_DIR, "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, "grok-usage-hook.log"),
      `${new Date().toISOString()} ${err?.stack || err?.message || String(err)}\n`,
    );
  } catch {
    /* ignore */
  }
  process.exit(0);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { seen: {} };
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { seen: {} };
    if (!parsed.seen || typeof parsed.seen !== "object") return { seen: {} };
    return parsed;
  } catch {
    return { seen: {} };
  }
}

function saveState(state) {
  mkdirSync(OPENCODEX_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_PATH, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Native xAI Grok models only — anything with a provider slash is routed elsewhere. */
function isNativeGrokModel(modelId) {
  if (typeof modelId !== "string" || !modelId) return false;
  if (modelId.includes("/")) return false;
  if (modelId.startsWith("ocx-")) return false;
  return /^(grok\b|grok[-_])/i.test(modelId);
}

function encodeSessionCwd(cwd) {
  // Grok stores sessions under encodeURIComponent(cwd) (slashes → %2F).
  return encodeURIComponent(cwd);
}

function findSessionDir(sessionId, cwd, workspaceRoot) {
  if (!sessionId) return null;
  const candidates = [];
  for (const home of grokHomes()) {
    const sessionsRoot = join(home, "sessions");
    for (const base of [cwd, workspaceRoot]) {
      if (typeof base === "string" && base) {
        candidates.push(join(sessionsRoot, encodeSessionCwd(base), sessionId));
      }
    }
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, "updates.jsonl"))) return dir;
  }
  // Fallback: scan session groups (encoded cwd dirs) for this session id.
  for (const home of grokHomes()) {
    const sessionsRoot = join(home, "sessions");
    try {
      for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!group.isDirectory()) continue;
        const dir = join(sessionsRoot, group.name, sessionId);
        if (existsSync(join(dir, "updates.jsonl"))) return dir;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readSummaryModel(sessionDir) {
  try {
    const summary = JSON.parse(readFileSync(join(sessionDir, "summary.json"), "utf8"));
    return summary?.current_model_id || summary?.info?.model || null;
  } catch {
    return null;
  }
}

function parseTurnCompleted(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const update = obj?.params?.update ?? obj?.update ?? obj;
  if (!update || update.sessionUpdate !== "turn_completed") return null;
  const usage = update.usage;
  if (!usage || typeof usage !== "object") return null;
  const promptId = update.prompt_id || update.promptId || obj?.params?.prompt_id;
  if (!promptId) return null;
  return {
    promptId: String(promptId),
    stopReason: update.stop_reason || update.stopReason || "",
    usage,
    timestampMs: typeof obj.timestamp === "number"
      ? (obj.timestamp > 1e12 ? obj.timestamp : obj.timestamp * 1000)
      : Date.now(),
  };
}

function primaryModelFromUsage(usage, fallback) {
  const modelUsage = usage?.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    const keys = Object.keys(modelUsage);
    if (keys.length === 1) return keys[0];
    // Prefer a native grok key when multiple are present.
    const native = keys.find(isNativeGrokModel);
    if (native) return native;
    if (keys[0]) return keys[0];
  }
  return fallback || "grok-build";
}

function toOcxUsage(usage) {
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  const totalTokens = Number(usage.totalTokens) || inputTokens + outputTokens;
  const cached = Number(usage.cachedReadTokens ?? usage.cachedInputTokens) || 0;
  const reasoning = Number(usage.reasoningTokens ?? usage.reasoningOutputTokens) || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: cached,
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: reasoning,
  };
}

function conversationId(sessionId) {
  // Match opencodex's non-PII correlation style: short hash, not the raw id if sensitive.
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
}

function appendUsageEntry(entry) {
  mkdirSync(OPENCODEX_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(USAGE_LOG, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

function resolveOpencodexBaseUrl() {
  if (process.env.OPENCODEX_URL?.trim()) {
    return process.env.OPENCODEX_URL.trim().replace(/\/$/, "");
  }
  let port = 10100;
  try {
    const runtime = JSON.parse(readFileSync(join(OPENCODEX_DIR, "runtime-port.json"), "utf8"));
    if (typeof runtime?.port === "number" && runtime.port > 0) port = runtime.port;
  } catch {
    /* default */
  }
  return `http://127.0.0.1:${port}`;
}

function readAdminToken() {
  if (process.env.OPENCODEX_ADMIN_TOKEN?.trim()) return process.env.OPENCODEX_ADMIN_TOKEN.trim();
  try {
    return readFileSync(join(OPENCODEX_DIR, "admin-api-token"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Push entries into the running opencodex process (usage.jsonl + live Logs).
 * Returns true on success (including all-skipped duplicates), false to fall back.
 */
async function ingestViaApi(entries) {
  const token = readAdminToken();
  if (!token) return false;
  const base = resolveOpencodexBaseUrl();
  const url = `${base}/api/usage/ingest`;

  const BATCH_SIZE = 40;
  let anySuccess = false;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencodex-api-key": token,
        },
        body: JSON.stringify({ entries: batch }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return false;
      if (res.ok || res.status === 207) {
        anySuccess = true;
      }
    } catch {
      /* continue */
    }
  }

  return anySuccess;
}

function toIngestEntry(turn, conv) {
  const reasoningTokens = turn.usage?.reasoningOutputTokens || 0;
  const requestedEffort = turn.requestedEffort ||
    (reasoningTokens > 0 ? (reasoningTokens >= 600 ? "high" : "medium") : undefined);

  return {
    requestId: `grok-native-${turn.promptId}`,
    timestamp: turn.timestamp,
    provider: "xai-native",
    model: turn.model,
    surface: "grok",
    conversationId: conv,
    requestedModel: turn.model,
    resolvedModel: turn.model,
    ...(requestedEffort ? { requestedEffort, effectiveEffort: requestedEffort } : {}),
    firstOutputMs: Math.min(1000, Math.max(300, Math.round((turn.durationMs || 1000) * 0.3))),
    status: 200,
    durationMs: turn.durationMs,
    usageStatus: "reported",
    usage: turn.usage,
    totalTokens: turn.usage.totalTokens,
  };
}

function collectNewTurns(sessionDir, sessionId, state) {
  const updatesPath = join(sessionDir, "updates.jsonl");
  if (!existsSync(updatesPath)) return [];

  const seenKey = sessionId;
  const seen = new Set(
    Array.isArray(state.seen[seenKey]) ? state.seen[seenKey] : [],
  );
  const summaryModel = readSummaryModel(sessionDir);
  const fresh = [];

  const text = readFileSync(updatesPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes("turn_completed")) continue;
    const turn = parseTurnCompleted(line);
    if (!turn) continue;
    if (seen.has(turn.promptId)) continue;

    const model = primaryModelFromUsage(turn.usage, summaryModel);
    if (!isNativeGrokModel(model)) {
      // Still mark seen so we don't re-scan forever on ocx turns.
      seen.add(turn.promptId);
      continue;
    }

    const ocxUsage = toOcxUsage(turn.usage);
    if (ocxUsage.totalTokens <= 0 && ocxUsage.inputTokens <= 0 && ocxUsage.outputTokens <= 0) {
      seen.add(turn.promptId);
      continue;
    }

    const reasoningTokens = ocxUsage.reasoningOutputTokens || 0;
    const requestedEffort = reasoningTokens > 0 ? (reasoningTokens >= 600 ? "high" : "medium") : undefined;

    let durationMs = Number(turn.usage.apiDurationMs || turn.usage.durationMs || 0);
    if (!durationMs || durationMs <= 0) {
      const outTok = ocxUsage.outputTokens || 50;
      durationMs = Math.max(500, Math.round((outTok / 65) * 1000));
    }

    fresh.push({
      promptId: turn.promptId,
      model,
      timestamp: turn.timestampMs,
      durationMs,
      requestedEffort,
      usage: ocxUsage,
    });
    seen.add(turn.promptId);
  }

  // Cap seen set growth per session.
  const seenList = [...seen];
  state.seen[seenKey] = seenList.length > 500 ? seenList.slice(-500) : seenList;
  return fresh;
}

async function main() {
  const input = await readStdinJson();
  if (!input || typeof input !== "object") process.exit(0);

  const event = String(input.hookEventName || input.hook_event_name || "").toLowerCase();
  // Accept stop / session_end (and camelCase variants already lowercased).
  if (event && event !== "stop" && event !== "sessionend" && event !== "session_end") {
    process.exit(0);
  }

  const sessionId = input.sessionId || input.session_id;
  if (!sessionId) process.exit(0);

  const sessionDir = findSessionDir(
    sessionId,
    input.cwd,
    input.workspaceRoot || input.workspace_root,
  );
  if (!sessionDir) process.exit(0);

  const state = loadState();
  const turns = collectNewTurns(sessionDir, sessionId, state);
  if (turns.length === 0) {
    saveState(state);
    process.exit(0);
  }

  const conv = conversationId(sessionId);
  const entries = turns.map(turn => toIngestEntry(turn, conv));

  // Prefer live ingest so Dashboard Logs updates immediately; fall back to file-only.
  const viaApi = await ingestViaApi(entries);
  if (!viaApi) {
    for (const entry of entries) appendUsageEntry(entry);
  }

  saveState(state);
  process.exit(0);
}

main().catch(failOpen);
