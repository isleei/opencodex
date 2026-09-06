/**
 * Antigravity IDE account-sync adapter.
 *
 * Writes the selected OpenCodex AGY account's OAuth token into the
 * independently installed Antigravity IDE's (`applicationName
 * "antigravity-ide"`, NOT the legacy `Antigravity` product) user database at
 * `<dataDir>/User/globalStorage/state.vscdb`, `ItemTable` key
 * `antigravityUnifiedStateSync.oauthToken`.
 *
 * Verified on-disk format (read-only inspection of the local IDE install and
 * its bundled JS; token values were never read):
 * - The `ItemTable` value is base64(protobuf Topic) with repeated field 1 =
 *   map entries `{ key: 1 string, value: 2 Row }`.
 * - The `oauthTokenInfoSentinelKey` entry's Row holds `value: 1 string` =
 *   base64(protobuf OAuthTokenInfo) with `access_token = 1`, `token_type = 2`,
 *   `refresh_token = 3`, `expiry = 4` (google.protobuf.Timestamp,
 *   `seconds = 1` varint), plus optional `is_gcp_tos = 6` and future fields.
 * - The sibling `authStateWithContextSentinelKey` entry holds a JSON auth
 *   state and MUST be preserved verbatim, as must every unrelated
 *   `ItemTable` row (settings, extensions, projects, chat history) and every
 *   unknown protobuf field.
 *
 * Safety rules:
 * - Never write while the IDE may be running: report `pending_restart` and
 *   ask the user to quit normally (unsaved work must not be force-closed).
 * - Unknown liveness without an explicit store override reports `unknown`,
 *   never "synced".
 * - Writes run in a single SQLite transaction that touches only the oauth
 *   row, with a WAL-aware snapshot kept for manual disaster recovery only
 *   and a read-back verification of the decoded token before commit.
 *   Failures roll back; a backup is never copied back over the live
 *   database, so committed history (settings, chat data) cannot be
 *   discarded by recovery.
 * - A successful disk write reports `pending_restart`, never `synced`:
 *   activation is confirmed separately by verifyAntigravityIdeActivation
 *   (quiet IDE + operator-confirmed account UI).
 * - WAL files are never deleted and processes are never killed.
 * - Token material never enters results, logs, or error strings.
 */
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { maskEmail } from "../lib/privacy";
import { refreshAntigravityToken } from "../oauth/google-antigravity";
import { getAccountCredential, saveAccountCredential } from "../oauth/store";
import type { OAuthCredentials } from "../oauth/types";

export type AgyIdeSyncStatus =
  | "synced"
  | "pending_restart"
  | "failed"
  | "unsupported"
  | "not_installed"
  | "unknown";

export interface AgyIdeProbe {
  installed: boolean;
  /** Resolved IDE user-data dir (the `Antigravity IDE` product only). */
  dataDir?: string;
  vscdbPath?: string;
  running?: boolean;
  reason?: string;
}

export interface AgyIdeSyncDeps {
  platformImpl?: () => NodeJS.Platform;
  appPathImpl?: () => string;
  dataDirImpl?: () => string;
  legacyDataDirImpl?: () => string;
  isRunningImpl?: (dataDir: string) => boolean | null;
  /**
   * Store override for tests and managed hosts: an explicit database path
   * that goes through the SAME production encode/write/verify path. This is
   * not a fake writer — the caller must also supply the account credential
   * (via `getCredentialImpl`) and a non-running lifecycle
   * (`isRunningImpl: () => false`).
   */
  vscdbPath?: string;
  getCredentialImpl?: (provider: string, accountId: string) => OAuthCredentials | null;
  refreshImpl?: (refreshToken: string) => Promise<OAuthCredentials>;
  saveCredentialImpl?: (provider: string, accountId: string, cred: OAuthCredentials) => Promise<void>;
}

export interface AgyIdeSyncResult {
  target: "ide";
  status: AgyIdeSyncStatus;
  /** Stable machine-readable code (AGY_IDE_*). Never carries token material. */
  code: string;
  /** Human-readable, token-free explanation. */
  message: string;
  retryable: boolean;
}

export const AGY_IDE_OAUTH_KEY = "antigravityUnifiedStateSync.oauthToken";
const AGY_IDE_PROVIDER = "google-antigravity";
const OAUTH_SENTINEL = "oauthTokenInfoSentinelKey";

export function defaultIdeAppPath(): string {
  if (typeof process.env.AGY_IDE_APP_PATH === "string" && process.env.AGY_IDE_APP_PATH) {
    return process.env.AGY_IDE_APP_PATH;
  }
  return "/Applications/Antigravity IDE.app";
}

export function defaultIdeDataDir(): string {
  if (typeof process.env.AGY_IDE_DATA_DIR === "string" && process.env.AGY_IDE_DATA_DIR) {
    return process.env.AGY_IDE_DATA_DIR;
  }
  return join(homedir(), "Library", "Application Support", "Antigravity IDE");
}

export function defaultLegacyIdeDataDir(): string {
  return join(homedir(), "Library", "Application Support", "Antigravity");
}

/**
 * Default "is the IDE running" check. Conservative on purpose: when the
 * answer cannot be determined, it returns null (unknown) instead of
 * guessing "not running" and risking a write under a live IDE.
 */
export function defaultIdeIsRunning(dataDir: string): boolean | null {
  try {
    const probe = Bun.spawnSync(["pgrep", "-f", "Antigravity IDE"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.exitCode === 0) return true;
    if (probe.exitCode === 1) {
      void dataDir;
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

export function probeAntigravityIde(deps: AgyIdeSyncDeps = {}): AgyIdeProbe {
  const platform = deps.platformImpl?.() ?? process.platform;
  if (platform !== "darwin") {
    return {
      installed: false,
      reason: `Antigravity IDE sync is only probed on macOS (current platform: ${platform}).`,
    };
  }
  const appPath = deps.appPathImpl?.() ?? defaultIdeAppPath();
  const dataDir = deps.dataDirImpl?.() ?? defaultIdeDataDir();
  const vscdbPath = join(dataDir, "User", "globalStorage", "state.vscdb");
  const appExists = existsSync(appPath);
  const dbExists = existsSync(vscdbPath);
  if (!appExists && !dbExists) {
    return { installed: false, reason: "Antigravity IDE is not installed on this proxy host." };
  }
  const isRunning = deps.isRunningImpl ? deps.isRunningImpl(dataDir) : defaultIdeIsRunning(dataDir);
  return {
    installed: true,
    dataDir,
    vscdbPath: dbExists ? vscdbPath : undefined,
    ...(isRunning === null || isRunning === undefined ? {} : { running: isRunning }),
  };
}

/** Serialize IDE operations so concurrent switches cannot interleave. */
let agyIdeTail: Promise<void> = Promise.resolve();
export function runAgyIdeSerialized<T>(work: () => Promise<T>): Promise<T> {
  const next = agyIdeTail.then(work);
  agyIdeTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------------------------------------------------------------------------
// Minimal protobuf codec (dependency-free, unknown-field preserving).
//
// Only the wire types this adapter meets are supported: varint (0),
// 64-bit (1), length-delimited (2), 32-bit (5). Unknown fields of any
// supported wire type round-trip as opaque raw bytes.
// ---------------------------------------------------------------------------

interface RawField {
  no: number;
  wire: number;
  /** Complete raw field bytes (tag + value), preserved verbatim. */
  raw: Uint8Array;
  /** Value bytes: varint payload, fixed bytes, or LD content. */
  content: Uint8Array;
}

function encodeVarint(value: number | bigint): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) v = (1n << 64n) + v;
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Uint8Array.from(out);
}

function encodeTag(no: number, wire: number): Uint8Array {
  return encodeVarint((no << 3) | wire);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeLD(no: number, content: Uint8Array): Uint8Array {
  return concat(encodeTag(no, 2), encodeVarint(content.length), content);
}

function encodeStringField(no: number, value: string): Uint8Array {
  return encodeLD(no, new TextEncoder().encode(value));
}

function parseMessage(buf: Uint8Array): RawField[] {
  const fields: RawField[] = [];
  let pos = 0;
  const readVarint = (): { value: bigint; raw: Uint8Array } => {
    const start = pos;
    let shift = 0n;
    let value = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error("truncated varint");
      const b = buf[pos++]!;
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) break;
      if (shift > 70n) throw new Error("varint too long");
    }
    return { value, raw: buf.slice(start, pos) };
  };
  while (pos < buf.length) {
    const tagStart = pos;
    const tag = readVarint();
    const tagRaw = buf.slice(tagStart, pos);
    const no = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (no <= 0) throw new Error("invalid field number");
    if (wire === 0) {
      const v = readVarint();
      fields.push({ no, wire, raw: concat(tagRaw, v.raw), content: v.raw });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error("truncated fixed64");
      const content = buf.slice(pos, pos + 8);
      pos += 8;
      fields.push({ no, wire, raw: concat(tagRaw, content), content: content.slice() });
    } else if (wire === 2) {
      const len = readVarint();
      if (len.value > BigInt(buf.length)) throw new Error("length exceeds buffer");
      const n = Number(len.value);
      if (pos + n > buf.length) throw new Error("truncated length-delimited");
      const content = buf.slice(pos, pos + n);
      pos += n;
      fields.push({ no, wire, raw: concat(tagRaw, len.raw, content), content: content.slice() });
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error("truncated fixed32");
      const content = buf.slice(pos, pos + 4);
      pos += 4;
      fields.push({ no, wire, raw: concat(tagRaw, content), content: content.slice() });
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

function decodeVarintContent(content: Uint8Array): bigint {
  let shift = 0n;
  let value = 0n;
  for (const b of content) {
    value |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  }
  return value;
}

function stringField(fields: RawField[], no: number): string | undefined {
  const f = fields.find(candidate => candidate.no === no && candidate.wire === 2);
  if (!f) return undefined;
  return new TextDecoder().decode(f.content);
}

function encodeTimestampSeconds(seconds: number): Uint8Array {
  return concat(encodeTag(1, 0), encodeVarint(Math.max(0, Math.floor(seconds))));
}

function decodeTimestampSeconds(content: Uint8Array): number {
  const inner = parseMessage(content);
  const sec = inner.find(f => f.no === 1 && f.wire === 0);
  if (!sec) return 0;
  const v = decodeVarintContent(sec.content);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(v);
}

export interface IdeTokenFields {
  access: string;
  refresh: string;
  tokenType: string;
  expirySeconds: number;
}

/** Decode an OAuthTokenInfo message; account-specific fields (5–7) are
 *  reported as mode flags and never carried across accounts. Only truly
 *  unknown fields round-trip as raw. */
function decodeIdeToken(bytes: Uint8Array): {
  fields: IdeTokenFields;
  preserved: Uint8Array[];
  flags: { hasIdToken: boolean; isGcpTos: boolean; enableBusinessLogin: boolean };
} {
  const parsed = parseMessage(bytes);
  const access = stringField(parsed, 1);
  const tokenType = stringField(parsed, 2);
  const refresh = stringField(parsed, 3);
  if (!access || !refresh) throw new Error("token message missing required fields");
  const expiryField = parsed.find(f => f.no === 4 && f.wire === 2);
  // Account-specific mode fields (native descriptors: 6 is_gcp_tos, 7
  // enable_business_login; Cockpit additionally writes string field 5
  // id_token). These describe the PREVIOUS account and must never be
  // preserved into the next account's token.
  const hasIdToken = parsed.some(f => f.no === 5 && f.wire === 2);
  const isGcpTos = parsed.some(f => f.no === 6 && f.wire === 0 && decodeVarintContent(f.content) !== 0n);
  const enableBusinessLogin = parsed.some(f => f.no === 7 && f.wire === 0 && decodeVarintContent(f.content) !== 0n);
  const preserved = parsed
    .filter(f => f.no !== 1 && f.no !== 2 && f.no !== 3 && f.no !== 4 && f.no !== 5 && f.no !== 6 && f.no !== 7)
    .map(f => f.raw);
  return {
    fields: {
      access,
      refresh,
      tokenType: tokenType || "Bearer",
      expirySeconds: expiryField ? decodeTimestampSeconds(expiryField.content) : 0,
    },
    preserved,
    flags: { hasIdToken, isGcpTos, enableBusinessLogin },
  };
}

function encodeIdeToken(fields: IdeTokenFields, preserved: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [
    encodeStringField(1, fields.access),
    encodeStringField(2, fields.tokenType || "Bearer"),
    encodeStringField(3, fields.refresh),
    encodeLD(4, encodeTimestampSeconds(fields.expirySeconds)),
    ...preserved,
  ];
  return concat(...parts);
}

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

interface TopicEntry {
  key: string;
  rowBytes: Uint8Array | null;
  entryRaw: Uint8Array;
}

/** Split an outer Topic message into its map entries + untouched raw fields. */
function splitTopic(outer: Uint8Array): { entries: TopicEntry[]; otherRaws: Uint8Array[] } {
  const entries: TopicEntry[] = [];
  const otherRaws: Uint8Array[] = [];
  for (const f of parseMessage(outer)) {
    if (f.no !== 1 || f.wire !== 2) {
      otherRaws.push(f.raw);
      continue;
    }
    try {
      const inner = parseMessage(f.content);
      const key = stringField(inner, 1);
      const rowField = inner.find(c => c.no === 2 && c.wire === 2);
      if (typeof key !== "string") {
        otherRaws.push(f.raw);
        continue;
      }
      entries.push({ key, rowBytes: rowField ? rowField.content.slice() : null, entryRaw: f.raw });
    } catch {
      otherRaws.push(f.raw);
    }
  }
  return { entries, otherRaws };
}

function encodeTopicEntry(key: string, rowBytes: Uint8Array): Uint8Array {
  const entryContent = concat(encodeStringField(1, key), encodeLD(2, rowBytes));
  return concat(encodeTag(1, 2), encodeVarint(entryContent.length), entryContent);
}

/**
 * Build the new outer Topic bytes: replace (or append) the oauth entry's
 * Row.value with the new inner token, preserving the Row's other fields,
 * all sibling entries (e.g. the JSON auth state), and all unknown fields.
 */
function buildUpdatedTopic(
  oldOuter: Uint8Array | null,
  newInnerB64: string,
): { outer: Uint8Array; previousAuthRow: Uint8Array | null } {
  let previousAuthRow: Uint8Array | null = null;
  if (!oldOuter || oldOuter.length === 0) {
    const row = encodeStringField(1, newInnerB64);
    return { outer: encodeTopicEntry(OAUTH_SENTINEL, row), previousAuthRow };
  }
  const { entries, otherRaws } = splitTopic(oldOuter);
  const parts: Uint8Array[] = [...otherRaws];
  let replaced = false;
  for (const entry of entries) {
    if (entry.key === "authStateWithContextSentinelKey") {
      previousAuthRow = entry.rowBytes ? entry.rowBytes.slice() : null;
    }
    if (entry.key !== OAUTH_SENTINEL) {
      parts.push(entry.entryRaw);
      continue;
    }
    // Rebuild this Row: new value + preserved non-value fields.
    let preservedRow: Uint8Array[] = [];
    if (entry.rowBytes) {
      try {
        preservedRow = parseMessage(entry.rowBytes)
          .filter(f => !(f.no === 1 && f.wire === 2))
          .map(f => f.raw);
      } catch {
        preservedRow = [];
      }
    }
    const newRow = concat(encodeStringField(1, newInnerB64), ...preservedRow);
    parts.push(encodeTopicEntry(entry.key, newRow));
    replaced = true;
  }
  if (!replaced) {
    parts.push(encodeTopicEntry(OAUTH_SENTINEL, encodeStringField(1, newInnerB64)));
  }
  // Preserve original field order as much as possible: unknown top-level
  // fields were captured first; entries keep their relative order.
  return { outer: concat(...parts), previousAuthRow };
}

/** Read and decode the oauth entry from outer bytes (throws when absent). */
function readTopicOAuthInner(outer: Uint8Array): { innerB64: string; authRow: Uint8Array | null } {
  // Scan every entry: the sibling auth state may precede OR follow the oauth
  // entry, so an early return on the first oauth hit would miss it.
  const { entries } = splitTopic(outer);
  let authRow: Uint8Array | null = null;
  let innerB64: string | null = null;
  for (const entry of entries) {
    if (entry.key === "authStateWithContextSentinelKey" && entry.rowBytes) authRow = entry.rowBytes;
    if (entry.key !== OAUTH_SENTINEL || !entry.rowBytes) continue;
    try {
      const value = stringField(parseMessage(entry.rowBytes), 1);
      if (typeof value === "string" && innerB64 === null) innerB64 = value;
    } catch { /* keep scanning for a decodable oauth entry */ }
  }
  if (innerB64 === null) throw new Error("oauth entry not found");
  return { innerB64, authRow };
}

/**
 * Test/fixture helper: build an outer Topic value with an oauth entry for the
 * given token plus optional extra string entries (e.g. a JSON auth state),
 * using the production encoder. Fixtures built this way exercise the real
 * decode path instead of a parallel fake.
 *
 * `tokenFlags` injects account-specific mode fields (Cockpit string field 5
 * id_token; native varint fields 6 is_gcp_tos / 7 enable_business_login) so
 * cross-account enterprise fixtures use the same codec the adapter verifies.
 */
export function createIdeTopicValueForTests(
  token: IdeTokenFields,
  extraEntries: Array<{ key: string; value: string }> = [],
  opts: { authFirst?: boolean; tokenFlags?: { idToken?: string; isGcpTos?: boolean; enableBusinessLogin?: boolean } } = {},
): string {
  let tokenBytes = encodeIdeToken(token, []);
  const flags = opts.tokenFlags;
  if (flags && (flags.idToken || flags.isGcpTos || flags.enableBusinessLogin)) {
    const extra: Uint8Array[] = [];
    if (flags.idToken) extra.push(encodeStringField(5, flags.idToken));
    if (flags.isGcpTos) extra.push(concat(encodeTag(6, 0), encodeVarint(1)));
    if (flags.enableBusinessLogin) extra.push(concat(encodeTag(7, 0), encodeVarint(1)));
    tokenBytes = concat(tokenBytes, ...extra);
  }
  let outer = buildUpdatedTopic(null, b64encode(tokenBytes)).outer;
  for (const extra of extraEntries) {
    const entryContent = concat(encodeStringField(1, extra.key), encodeLD(2, encodeStringField(1, extra.value)));
    const entry = concat(encodeTag(1, 2), encodeVarint(entryContent.length), entryContent);
    outer = opts.authFirst ? concat(entry, outer) : concat(outer, entry);
  }
  return b64encode(outer);
}

/** Test helper: decode an outer Topic value back into its token + entry map. */
export function decodeIdeTopicValueForTests(outerB64: string): {
  token: IdeTokenFields;
  entries: Record<string, string>;
} {
  const outer = b64decode(outerB64);
  const { innerB64 } = readTopicOAuthInner(outer);
  const { fields } = decodeIdeToken(b64decode(innerB64));
  const entries: Record<string, string> = {};
  const { entries: split } = splitTopic(outer);
  for (const entry of split) {
    if (!entry.rowBytes) continue;
    try {
      const value = stringField(parseMessage(entry.rowBytes), 1);
      if (typeof value === "string") entries[entry.key] = value;
    } catch { /* skip undecodable rows in test introspection */ }
  }
  return { token: fields, entries };
}

/** Desensitized IDE read-back: does the stored token refresh match the active credential?
 *  No tokens leave this function — only present/matches booleans. A running IDE
 *  is NOT treated as synced: only a decoded credential match counts. */
export function readAgyIdeSnapshot(
  activeAccountId: string | null | undefined,
  deps: AgyIdeSyncDeps = {},
): { present: boolean; matchesActive: boolean | null } {
  try {
    const explicitPath = deps.vscdbPath;
    let vscdbPath: string | undefined;
    if (explicitPath) {
      vscdbPath = explicitPath;
    } else {
      const probe = probeAntigravityIde(deps);
      if (!probe.installed || !probe.vscdbPath) return { present: false, matchesActive: null };
      vscdbPath = probe.vscdbPath;
    }
    if (!vscdbPath || !existsSync(vscdbPath)) return { present: false, matchesActive: null };
    if (!activeAccountId) {
      try {
        const db = new Database(vscdbPath, { readonly: true });
        try {
          const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(AGY_IDE_OAUTH_KEY) as {
            value?: unknown;
          } | null;
          return { present: typeof row?.value === "string", matchesActive: null };
        } finally {
          try { db.close(); } catch { /* ignore */ }
        }
      } catch {
        return { present: false, matchesActive: null };
      }
    }
    const getCred = deps.getCredentialImpl ?? getAccountCredential;
    const cred = getCred(AGY_IDE_PROVIDER, activeAccountId);
    if (!cred?.refresh) return { present: false, matchesActive: null };
    try {
      const db = new Database(vscdbPath, { readonly: true });
      try {
        const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(AGY_IDE_OAUTH_KEY) as {
          value?: unknown;
        } | null;
        if (typeof row?.value !== "string") return { present: false, matchesActive: null };
        const { innerB64 } = readTopicOAuthInner(b64decode(row.value));
        const decoded = decodeIdeToken(b64decode(innerB64));
        return { present: true, matchesActive: decoded.fields.refresh === cred.refresh };
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    } catch {
      return { present: true, matchesActive: null };
    }
  } catch {
    return { present: false, matchesActive: null };
  }
}

export interface AgyIdeActivationDeps extends AgyIdeSyncDeps {
  /**
   * Manual acceptance signal: the operator confirmed the restarted IDE shows
   * the requested account (IDE account UI). There is no programmatic
   * runtime-identity API, so without this signal verification stays pending
   * — a disk match alone is never reported as activated.
   */
  activationConfirmedImpl?: () => boolean;
}

/**
 * Post-restart activation check for a previously persisted IDE switch.
 * States: disk mismatch → failed (retryable); IDE running or no manual
 * confirmation yet → pending_restart; disk match + IDE quiet + operator
 * confirmation → synced. Production callers omit `activationConfirmedImpl`,
 * so real activation stays honestly pending until manually accepted.
 */
export function verifyAntigravityIdeActivation(
  accountId: string,
  deps: AgyIdeActivationDeps = {},
): AgyIdeSyncResult {
  const failed = (code: string, message: string, retryable: boolean): AgyIdeSyncResult => ({
    target: "ide",
    status: "failed",
    code,
    message,
    retryable,
  });
  if (!accountId || typeof accountId !== "string") {
    return failed("AGY_IDE_INVALID_ACCOUNT", "Missing account id.", false);
  }
  const explicitPath = deps.vscdbPath;
  let vscdbPath: string | undefined;
  let running: boolean | null | undefined;
  if (explicitPath) {
    vscdbPath = explicitPath;
    running = deps.isRunningImpl
      ? deps.isRunningImpl(deps.dataDirImpl?.() ?? defaultIdeDataDir())
      : defaultIdeIsRunning(deps.dataDirImpl?.() ?? defaultIdeDataDir());
  } else {
    const probe = probeAntigravityIde(deps);
    if (!probe.installed) {
      return {
        target: "ide",
        status: "not_installed",
        code: "AGY_IDE_NOT_INSTALLED",
        message: probe.reason ?? "Antigravity IDE is not installed on this proxy host.",
        retryable: false,
      };
    }
    vscdbPath = probe.vscdbPath;
    running = probe.running;
  }
  if (!vscdbPath || !existsSync(vscdbPath)) {
    return failed("AGY_IDE_DB_MISSING", "IDE state database does not exist on this proxy host.", false);
  }
  const snapshot = readAgyIdeSnapshot(accountId, deps);
  if (snapshot.matchesActive !== true) {
    return failed(
      "AGY_IDE_ACTIVATION_MISMATCH",
      "The IDE store does not hold the requested account. Re-run the switch after quitting the IDE normally, then verify again.",
      true,
    );
  }
  if (running !== false) {
    return {
      target: "ide",
      status: "pending_restart",
      code: "AGY_IDE_PENDING_RESTART",
      message:
        "IDE credentials match on disk but activation is unconfirmed. Quit the IDE normally, start it again, confirm the account in the IDE, then verify again.",
      retryable: true,
    };
  }
  let confirmed = false;
  try {
    confirmed = deps.activationConfirmedImpl?.() === true;
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    return {
      target: "ide",
      status: "pending_restart",
      code: "AGY_IDE_PENDING_RESTART",
      message:
        "IDE credentials match on disk and the IDE is quiet, but runtime activation is not yet confirmed. Start the IDE, confirm the account in the IDE, then verify again.",
      retryable: true,
    };
  }
  return {
    target: "ide",
    status: "synced",
    code: "AGY_IDE_ACTIVATED",
    message: "IDE activation confirmed for the selected account.",
    retryable: false,
  };
}

export async function syncAntigravityIdeAccount(  accountId: string,
  deps: AgyIdeSyncDeps = {},
): Promise<AgyIdeSyncResult> {
  return runAgyIdeSerialized(async () => {
    const failed = (code: string, message: string, retryable: boolean): AgyIdeSyncResult => ({
      target: "ide",
      status: "failed",
      code,
      message,
      retryable,
    });
    if (!accountId || typeof accountId !== "string") {
      return failed("AGY_IDE_INVALID_ACCOUNT", "Missing account id.", false);
    }
    const getCred = deps.getCredentialImpl ?? getAccountCredential;
    const cred = getCred(AGY_IDE_PROVIDER, accountId);
    if (!cred) {
      return failed("AGY_IDE_CREDENTIAL_MISSING", "No stored OpenCodex credentials for this account.", false);
    }
    const masked = maskEmail(cred.email) ?? undefined;

    let effectiveCred = cred;
    if (cred.refresh && (!cred.access || !cred.expires || cred.expires < Date.now() + 5 * 60 * 1000)) {
      const refresh = deps.refreshImpl ?? refreshAntigravityToken;
      try {
        const refreshed = await refresh(cred.refresh);
        effectiveCred = { ...cred, ...refreshed };
        const save = deps.saveCredentialImpl ?? saveAccountCredential;
        await save(AGY_IDE_PROVIDER, accountId, effectiveCred);
      } catch {
        return failed(
          "AGY_IDE_REFRESH_FAILED",
          "Stored credentials are expired and the refresh attempt failed. Re-login is required; nothing was written.",
          true,
        );
      }
    }
    if (!effectiveCred.access || !effectiveCred.refresh) {
      return failed("AGY_IDE_CREDENTIAL_INCOMPLETE", "Stored credentials are missing token material and cannot be synced.", false);
    }
    const expirySeconds =
      typeof effectiveCred.expires === "number" && Number.isFinite(effectiveCred.expires) && effectiveCred.expires > 0
        ? Math.floor(effectiveCred.expires / 1000)
        : Math.floor(Date.now() / 1000) + 3600;

    // Resolve the store. An explicit vscdbPath uses the same production
    // path with injected credentials; otherwise probe the real install.
    const explicitPath = deps.vscdbPath;
    let vscdbPath: string;
    let effectiveDataDir: string;
    if (explicitPath) {
      vscdbPath = explicitPath;
      effectiveDataDir = deps.dataDirImpl?.() ?? defaultIdeDataDir();
    } else {
      const probe = probeAntigravityIde(deps);
      if (!probe.installed) {
        return {
          target: "ide",
          status: "not_installed",
          code: "AGY_IDE_NOT_INSTALLED",
          message: probe.reason ?? "Antigravity IDE is not installed on this proxy host. Install it to enable IDE sync.",
          retryable: false,
        };
      }
      if (probe.running === true) {
        return {
          target: "ide",
          status: "pending_restart",
          code: "AGY_IDE_PENDING_RESTART",
          message:
            "Antigravity IDE is running, so its account store was left untouched to protect unsaved work. Quit the IDE normally (keep your work), then retry — do not force-quit.",
          retryable: true,
        };
      }
      if (probe.running === null || probe.running === undefined) {
        if (!probe.vscdbPath) {
          return {
            target: "ide",
            status: "unknown",
            code: "AGY_IDE_STATE_UNKNOWN",
            message:
              "IDE install detected but its state database was not found and liveness could not be confirmed. Open or quit the IDE normally, then retry the probe.",
            retryable: true,
          };
        }
        return {
          target: "ide",
          status: "unknown",
          code: "AGY_IDE_STATE_UNKNOWN",
          message:
            "Could not confirm whether the IDE is running, so the database was left untouched. Quit the IDE normally, then retry.",
          retryable: true,
        };
      }
      if (!probe.vscdbPath) {
        return {
          target: "ide",
          status: "unknown",
          code: "AGY_IDE_STATE_UNKNOWN",
          message: "IDE install detected but its state database was not found. Open or quit the IDE normally, then retry.",
          retryable: true,
        };
      }
      vscdbPath = probe.vscdbPath;
      effectiveDataDir = probe.dataDir ?? defaultIdeDataDir();
      void effectiveDataDir;
    }

    // Explicit-store lifecycle gate: never write under a live IDE.
    if (explicitPath) {
      const running = deps.isRunningImpl
        ? deps.isRunningImpl(deps.dataDirImpl?.() ?? defaultIdeDataDir())
        : defaultIdeIsRunning(deps.dataDirImpl?.() ?? defaultIdeDataDir());
      if (running === true) {
        return {
          target: "ide",
          status: "pending_restart",
          code: "AGY_IDE_PENDING_RESTART",
          message:
            "Antigravity IDE is running, so its account store was left untouched to protect unsaved work. Quit the IDE normally (keep your work), then retry — do not force-quit.",
          retryable: true,
        };
      }
      if (running === null || running === undefined) {
        const platform = deps.platformImpl?.() ?? process.platform;
        if (platform !== "darwin") {
          return {
            target: "ide",
            status: "unsupported",
            code: "AGY_IDE_UNSUPPORTED_PLATFORM",
            message: `IDE sync is verified on macOS only (current platform: ${platform}). The database was left untouched.`,
            retryable: false,
          };
        }
        return {
          target: "ide",
          status: "unknown",
          code: "AGY_IDE_STATE_UNKNOWN",
          message: "Could not confirm whether the IDE is running, so the database was left untouched. Quit the IDE normally, then retry.",
          retryable: true,
        };
      }
    }

    if (!existsSync(vscdbPath)) {
      return failed("AGY_IDE_DB_MISSING", "IDE state database does not exist on this proxy host.", false);
    }

    // WAL-aware recovery snapshot, taken AFTER opening (never before): a
    // main-file copy taken while WAL content is uncheckpointed excludes
    // committed history, so restoring it after a transaction that SQLite
    // already rolled back would DISCARD unrelated user data (settings,
    // history). `VACUUM INTO` produces a consistent snapshot including WAL
    // content. The snapshot is for manual disaster recovery only — the
    // primary safety mechanism is the transaction rollback below, and this
    // adapter never copies a backup back over the live database.
    //
    // Permissions: the snapshot contains credentials, so it must be
    // owner-only from creation. VACUUM INTO creates the file itself, so the
    // umask is narrowed to 077 around the call (plus a chmod afterwards as
    // defense in depth) instead of chmod-after-world-readable-creation.
    // The new snapshot goes to `<path>.ocx-bak.new` and is renamed over the
    // prior snapshot only after success, so a failed VACUUM never destroys
    // the previous recovery copy. A VACUUM failure refuses the switch
    // (AGY_IDE_BACKUP_FAILED) rather than proceeding silently.
    const backupPath = `${vscdbPath}.ocx-bak`;
    const backupNewPath = `${vscdbPath}.ocx-bak.new`;
    let db: Database | undefined;
    try {
      db = new Database(vscdbPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/locked|busy/i.test(reason)) {
        return failed("AGY_IDE_DB_LOCKED", `IDE database is locked (${reason}); nothing was written.`, true);
      }
      return failed("AGY_IDE_DB_ERROR", `Could not open the IDE database: ${reason}`, true);
    }
    const closeDb = (): void => {
      try {
        db?.close();
      } catch { /* ignore */ }
      db = undefined;
    };
    try {
      const dir = dirname(backupPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const { unlinkSync, renameSync } = await import("node:fs");
      try {
        unlinkSync(backupNewPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      }
      try {
        const prevUmask = process.umask(0o077);
        try {
          db.query(`VACUUM INTO '${backupNewPath.replace(/'/g, "''")}'`).run();
        } finally {
          process.umask(prevUmask);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        closeDb();
        return failed("AGY_IDE_BACKUP_FAILED", `Could not back up the IDE database: ${reason}`, true);
      }
      try {
        chmodSync(backupNewPath, 0o600);
      } catch { /* umask already enforced owner-only; defense in depth */ }
      try {
        renameSync(backupNewPath, backupPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        closeDb();
        return failed("AGY_IDE_BACKUP_FAILED", `Could not back up the IDE database: ${reason}`, true);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      closeDb();
      return failed("AGY_IDE_BACKUP_FAILED", `Could not back up the IDE database: ${reason}`, true);
    }
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'").all();
      if (tables.length === 0) {
        return failed("AGY_IDE_DB_UNEXPECTED", "IDE database has no ItemTable; refusing to guess the schema.", false);
      }
      const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(AGY_IDE_OAUTH_KEY) as
        | { value?: unknown }
        | null;
      const currentB64 = typeof row?.value === "string" ? row.value : null;

      let preservedTokenFields: Uint8Array[] = [];
      let oldOuter: Uint8Array | null = null;
      if (currentB64 !== null) {
        try {
          oldOuter = b64decode(currentB64);
          const { innerB64 } = readTopicOAuthInner(oldOuter);
          const decodedOld = decodeIdeToken(b64decode(innerB64));
          preservedTokenFields = decodedOld.preserved;
          // Enterprise/business mode is not a compatible switch target: the
          // stored token carries account-specific mode flags whose meaning
          // for the requested account is unverified. Refuse without writing
          // rather than silently converting or carrying the flag over.
          if (decodedOld.flags.isGcpTos || decodedOld.flags.enableBusinessLogin) {
            return {
              target: "ide",
              status: "unsupported",
              code: "AGY_IDE_ENTERPRISE_UNSUPPORTED",
              message:
                "The IDE's stored account uses enterprise/business login mode, which account switching does not support. The database was left untouched; switch accounts inside the IDE itself.",
              retryable: false,
            };
          }
        } catch {
          return failed(
            "AGY_IDE_STATE_CORRUPT",
            "Existing IDE token state could not be decoded, so nothing was written. Repair the IDE login manually, then retry.",
            false,
          );
        }
      }

      const newToken = encodeIdeToken(
        {
          access: effectiveCred.access,
          refresh: effectiveCred.refresh,
          tokenType: "Bearer",
          expirySeconds,
        },
        preservedTokenFields,
      );
      const { outer: newOuter, previousAuthRow } = buildUpdatedTopic(oldOuter, b64encode(newToken));
      const newB64 = b64encode(newOuter);

      // Snapshot unrelated rows so verification can prove they survived.
      const unrelatedBefore = (
        db.query("SELECT key, length(value) AS len FROM ItemTable WHERE key != ?").all(AGY_IDE_OAUTH_KEY) as Array<{
          key: unknown;
          len: unknown;
        }>
      ).map(r => `${String(r.key)}:${String(r.len)}`);

      // Single narrow transaction: write the ONE oauth row, then verify the
      // decoded token + sibling auth row + unrelated rows BEFORE commit. Any
      // mismatch throws, rolling back — no whole-database overwrite, no WAL
      // deletion, unknown protobuf fields preserved by the codec.
      try {
        const txn = db.transaction(() => {
          db!.query("INSERT OR REPLACE INTO ItemTable(key, value) VALUES (?, ?)").run(AGY_IDE_OAUTH_KEY, newB64);
          const check = db!.query("SELECT value FROM ItemTable WHERE key = ?").get(AGY_IDE_OAUTH_KEY) as {
            value?: unknown;
          } | null;
          if (typeof check?.value !== "string") throw new Error("oauth row missing after write");
          const checkOuter = b64decode(check.value);
          const { innerB64: checkInnerB64, authRow: checkAuthRow } = readTopicOAuthInner(checkOuter);
          const decoded = decodeIdeToken(b64decode(checkInnerB64));
          const sameAuth =
            (previousAuthRow === null && checkAuthRow === null) ||
            (previousAuthRow !== null &&
              checkAuthRow !== null &&
              Buffer.from(previousAuthRow).equals(Buffer.from(checkAuthRow)));
          const unrelatedAfter = (
            db!.query("SELECT key, length(value) AS len FROM ItemTable WHERE key != ?").all(AGY_IDE_OAUTH_KEY) as Array<{
              key: unknown;
              len: unknown;
            }>
          ).map(r => `${String(r.key)}:${String(r.len)}`);
          const sameUnrelated =
            unrelatedBefore.length === unrelatedAfter.length &&
            unrelatedBefore.every((entry, index) => entry === unrelatedAfter[index]);
          if (
            decoded.fields.access !== effectiveCred.access ||
            decoded.fields.refresh !== effectiveCred.refresh ||
            !sameAuth ||
            !sameUnrelated
          ) {
            throw new Error("read-back mismatch");
          }
        });
        txn();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (/locked|busy/i.test(reason)) {
          return failed("AGY_IDE_DB_LOCKED", `IDE database is locked (${reason}); nothing was written.`, true);
        }
        if (/read-back mismatch|oauth row missing/i.test(reason)) {
          // Transaction rolled back automatically; previous state intact.
          return failed("AGY_IDE_VERIFY_FAILED", "IDE sync verification failed before commit; no changes were kept. Retry after quitting the IDE normally.", true);
        }
        // Never restore a backup over the live database: SQLite already
        // rolled the failed transaction back, and a main-file copy would
        // discard committed WAL history (settings, chat data). The
        // WAL-aware snapshot above is retained for manual recovery only.
        return failed(
          "AGY_IDE_DB_ERROR",
          `IDE database write failed (${reason}); the transaction was rolled back and no changes were kept.`,
          true,
        );
      }

      void masked;
      // Persisted and read-back verified on disk — but a SQLite write is
      // NOT runtime activation. OAuth-client compatibility or a startup
      // rejection could still prevent the account from taking effect, so
      // this stays pending until verifyAntigravityIdeActivation confirms it
      // (normal restart + identity check, manual acceptance for now).
      return {
        target: "ide",
        status: "pending_restart",
        code: "AGY_IDE_PENDING_RESTART",
        message:
          "IDE credentials for the selected account are written and verified on disk. Quit the IDE normally (unsaved work is never force-closed), start it again, confirm the account in the IDE, then re-run verification — activation is not confirmed yet.",
        retryable: true,
      };
    } finally {
      closeDb();
    }
  });
}
