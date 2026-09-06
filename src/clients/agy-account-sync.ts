/**
 * Centralized Google Antigravity (AGY) CLI credential sync.
 *
 * Single owner for writing the selected OpenCodex AGY account into the local
 * native credential store plus the legacy `~/.gemini/` files
 * (`oauth_creds.json` + `google_accounts.json`) so the management API and
 * `ocx agy` share one write path with one result shape.
 *
 * Compatibility evidence (macOS, verified without reading token material):
 * - The installed native `agy` binary references
 *   `codeassistclient.KeyringTokenStorage` and `keyring.macOSXKeychain`
 *   (zalando/go-keyring) with a file fallback. A metadata-only
 *   `security find-generic-password -s gemini -a antigravity` lookup
 *   succeeds, so the service/account identifiers ARE `gemini` /
 *   `antigravity` (the earlier "not recoverable" claim is withdrawn).
 * - The stored value is `go-keyring-base64:` + base64(JSON) of
 *   `{ token: { access_token, token_type, refresh_token, expiry },
 *     auth_method: "consumer" }` with expiry rendered as
 *   `new Date(ts*1000).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')`.
 *   This matches the reference author's documented format and is validated
 *   by write + read-back + parse on every switch; tokens never appear in
 *   results, logs, or process arguments (writes go through
 *   `@napi-rs/keyring`, never `security -w <token>`).
 * - On macOS the keyring write is REQUIRED: a file-only write is reported
 *   as failure, never as synced, so a bare `agy` process cannot silently
 *   keep using another account. Unverified non-macOS platforms without an
 *   injected keyring keep the legacy file sync and report
 *   `nativeKeyring: "unsupported"` explicitly.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { maskEmail } from "../lib/privacy";
import { refreshAntigravityToken } from "../oauth/google-antigravity";
import { getAccountCredential, listAccounts, saveAccountCredential } from "../oauth/store";
import type { OAuthCredentials } from "../oauth/types";
import {
  syncAntigravityIdeAccount,
  type AgyIdeSyncDeps,
  type AgyIdeSyncResult,
} from "./antigravity-ide-account-sync";

export const AGY_PROVIDER = "google-antigravity";

/** Native OS-keychain identifiers for the `agy` CLI (verified metadata-only). */
export const AGY_KEYRING_SERVICE_DEFAULT = "gemini";
export const AGY_KEYRING_ACCOUNT_DEFAULT = "antigravity";
const AGY_KEYRING_PREFIX = "go-keyring-base64:";

export function resolveAgyKeyringService(deps: AgyCliSyncDeps = {}): string {
  return (
    deps.keyringServiceImpl?.() ||
    (typeof process.env.AGY_KEYRING_SERVICE === "string" && process.env.AGY_KEYRING_SERVICE) ||
    AGY_KEYRING_SERVICE_DEFAULT
  );
}

export function resolveAgyKeyringAccount(deps: AgyCliSyncDeps = {}): string {
  return (
    deps.keyringAccountImpl?.() ||
    (typeof process.env.AGY_KEYRING_ACCOUNT === "string" && process.env.AGY_KEYRING_ACCOUNT) ||
    AGY_KEYRING_ACCOUNT_DEFAULT
  );
}

export interface AgyKeyringEntry {
  getPassword(): string | null | Promise<string | null>;
  setPassword(password: string): void | Promise<void>;
  deletePassword(): boolean | Promise<boolean>;
}

export type AgyKeyringEntryFactory = (service: string, account: string) => AgyKeyringEntry;

/** Fully async keyring backend (production AsyncEntry or an injected test double). */
export interface AgyKeyringAsyncBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

function defaultAgyKeyringEntryFactory(service: string, account: string): AgyKeyringEntry {
  const nodeRequire = createRequire(import.meta.url);
  const { Entry } = nodeRequire("@napi-rs/keyring") as {
    Entry: new (s: string, a: string) => AgyKeyringEntry;
  };
  return new Entry(service, account);
}

/**
 * Bounded keyring access. Every production read/write/rollback/snapshot goes
 * through here with a timeout, so a locked keychain or a native permission
 * prompt cannot block the proxy event loop (including an accounts-page GET).
 *
 * There is deliberately NO synchronous fallback after an asynchronous
 * denial/timeout: falling back would reintroduce the unbounded block this
 * timeout exists to prevent. Production requires AsyncEntry; older installs
 * without it fail closed with AGY_CLI_KEYRING_UNAVAILABLE instead of
 * blocking on a synchronous Entry.
 *
 * Late completion: a native write that outlives its timeout keeps running
 * (there is no cancel). It stays in `pendingKeyringWrites` until it settles.
 * The next mutation drains prior writes with a bounded grace first and
 * REFUSES with AGY_CLI_KEYRING_PENDING when anything is still unresolved,
 * so a stale late write can never silently overwrite a reported success.
 * Every switch that does write still ends in a read-back verification.
 */
const AGY_KEYRING_TIMEOUT_MS = 8000;

function armKeyringTimer(ms: number, op: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`keychain ${op} timed out after ${ms}ms`)), ms);
    if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function withKeyringBound<T>(work: Promise<T>, ms: number, op: string): Promise<T> {
  const timer = armKeyringTimer(ms, op);
  try {
    return await Promise.race([work, timer.promise]);
  } finally {
    timer.cancel();
  }
}

/** Native mutations that outlived their timeout but may still complete late. */
const pendingKeyringWrites = new Set<Promise<unknown>>();

function trackKeyringWrite(native: Promise<unknown>): { settled: Promise<unknown> } {
  const tracked = native.then(
    value => {
      pendingKeyringWrites.delete(tracked);
      return value;
    },
    error => {
      pendingKeyringWrites.delete(tracked);
      throw error;
    },
  );
  pendingKeyringWrites.add(tracked);
  // Avoid unhandled rejection noise for writes the caller already timed out on.
  tracked.catch(() => {});
  return { settled: tracked };
}

/**
 * Drain prior late writes with a bounded grace before the next mutation.
 * Returns true when nothing is outstanding; false when the grace expired
 * with writes still unresolved — the caller must then refuse the mutation
 * (fail closed) rather than proceed and risk a stale overwrite.
 */
async function settlePriorKeyringWrites(graceMs: number): Promise<boolean> {
  if (pendingKeyringWrites.size === 0) return true;
  const pending = [...pendingKeyringWrites];
  const grace = armKeyringTimer(Math.max(0, graceMs), "settle");
  try {
    await Promise.race([Promise.allSettled(pending), grace.promise]);
    return pendingKeyringWrites.size === 0;
  } catch {
    // Grace expired: report unresolved so the caller refuses. A read-back
    // after proceeding could still pass before the old write lands.
    return false;
  } finally {
    grace.cancel();
  }
}

interface KeyringHandle {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

function productionKeyringHandle(
  service: string,
  account: string,
  ms: number,
): KeyringHandle | null {
  let asyncEntry: {
    getPassword(): Promise<string | null>;
    setPassword(pw: string): Promise<void>;
    deletePassword(): Promise<boolean>;
  } | null = null;
  try {
    const nodeRequire = createRequire(import.meta.url);
    const mod = nodeRequire("@napi-rs/keyring") as {
      AsyncEntry?: new (s: string, a: string) => {
        getPassword(): Promise<string | null>;
        setPassword(pw: string): Promise<void>;
        deletePassword(): Promise<boolean>;
      };
    };
    if (mod.AsyncEntry) asyncEntry = new mod.AsyncEntry(service, account);
  } catch {
    asyncEntry = null;
  }
  if (asyncEntry) {
    const backend = asyncEntry;
    const trackDelete = (native: Promise<boolean>): Promise<boolean> => {
      const { settled } = trackKeyringWrite(native);
      return settled as Promise<boolean>;
    };
    return {
      getPassword: () => withKeyringBound(backend.getPassword(), ms, "read"),
      setPassword: async (password: string) => {
        const native = backend.setPassword(password);
        const { settled } = trackKeyringWrite(native);
        const gate = armKeyringTimer(ms, "write");
        try {
          await Promise.race([settled, gate.promise]);
        } finally {
          gate.cancel();
        }
      },
      deletePassword: async () => {
        const native = backend.deletePassword();
        const tracked = trackDelete(native);
        const gate = armKeyringTimer(ms, "delete");
        try {
          return await Promise.race([tracked, gate.promise]);
        } finally {
          gate.cancel();
        }
      },
    };
  }
  return null;
}

function injectedKeyringHandle(entry: AgyKeyringEntry, ms: number): KeyringHandle {
  return {
    getPassword: () => withKeyringBound(Promise.resolve().then(() => entry.getPassword()), ms, "read"),
    setPassword: async (password: string) => {
      const native = Promise.resolve().then(() => entry.setPassword(password));
      const { settled } = trackKeyringWrite(native);
      const gate = armKeyringTimer(ms, "write");
      try {
        await Promise.race([settled, gate.promise]);
      } finally {
        gate.cancel();
      }
    },
    deletePassword: async () => {
      const native = Promise.resolve().then(() => entry.deletePassword());
      const { settled } = trackKeyringWrite(native);
      const gate = armKeyringTimer(ms, "delete");
      try {
        return (await Promise.race([settled, gate.promise])) as boolean;
      } finally {
        gate.cancel();
      }
    },
  };
}

let agyKeyringEntryFactory: AgyKeyringEntryFactory = defaultAgyKeyringEntryFactory;
let agyKeyringFactoryOverridden = false;

/** Test seam: swap the OS keyring entry for an in-memory one. Server and CLI share it. */
export function setAgyKeyringEntryFactoryForTests(factory: AgyKeyringEntryFactory | null): void {
  agyKeyringEntryFactory = factory ?? defaultAgyKeyringEntryFactory;
  agyKeyringFactoryOverridden = factory !== null;
}

export type AgyCliSyncStatus = "synced" | "failed" | "unsupported" | "unknown";

export type AgyNativeKeyringState = "synced" | "failed" | "unsupported";

export interface AgyCliSyncDeps {
  geminiDirImpl?: () => string;
  getCredentialImpl?: (provider: string, accountId: string) => OAuthCredentials | null;
  refreshImpl?: (refreshToken: string) => Promise<OAuthCredentials>;
  saveCredentialImpl?: (provider: string, accountId: string, cred: OAuthCredentials) => Promise<void>;
  listAccountsImpl?: (provider: string) => Array<{ credential?: { email?: string } }>;
  writeFileImpl?: (path: string, content: string) => void;
  readFileImpl?: (path: string) => string;
  platformImpl?: () => NodeJS.Platform;
  keyringServiceImpl?: () => string;
  keyringAccountImpl?: () => string;
  keyringEntryFactoryImpl?: AgyKeyringEntryFactory;
  /** Fully async keyring backend (bounded in production; injected delay doubles in tests). */
  keyringAsyncImpl?: AgyKeyringAsyncBackend;
  /** Override the keychain operation timeout (tests only; default 8000ms). */
  keyringTimeoutMsImpl?: number;
  /** Environment lookup for auth-mode detection (tests inject; default process.env). */
  envImpl?: (name: string) => string | undefined;
}

export type AgyCliAuthModeKind = "consumer" | "api-key" | "adc" | "unknown";

export interface AgyCliAuthMode {
  kind: AgyCliAuthModeKind;
  detail: string;
}

/**
 * Effective CLI auth-mode preflight. Native agy selects API-key mode via
 * `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json`
 * plus `GEMINI_API_KEY` — that mode has no account session, so switching
 * must refuse without touching the keychain or files. ADC/enterprise
 * markers are likewise reported as not-applicable. Absence of any marker
 * means the default consumer-OAuth mode (the only supported switch target);
 * an unreadable settings file never blocks the switch.
 */
export function detectAgyCliAuthMode(deps: AgyCliSyncDeps = {}): AgyCliAuthMode {
  const env = deps.envImpl ?? ((name: string) => process.env[name]);
  const adcMarker = env("GOOGLE_APPLICATION_CREDENTIALS");
  if (typeof adcMarker === "string" && adcMarker.trim()) {
    return {
      kind: "adc",
      detail:
        "Application Default Credentials are configured (GOOGLE_APPLICATION_CREDENTIALS); account switching does not apply. The native store was left untouched.",
    };
  }
  let modelProvider: unknown;
  try {
    const geminiDir = resolveAgyGeminiDir(deps);
    const settingsPath = join(geminiDir, "antigravity-cli", "settings.json");
    let raw: string | undefined;
    if (deps.readFileImpl) {
      try {
        raw = deps.readFileImpl(settingsPath);
      } catch {
        raw = undefined;
      }
    } else {
      if (!existsSync(settingsPath)) {
        return { kind: "consumer", detail: "Default consumer OAuth mode." };
      }
      raw = readFileSync(settingsPath, "utf8");
    }
    if (raw === undefined) return { kind: "consumer", detail: "Default consumer OAuth mode." };
    modelProvider = (JSON.parse(raw) as { modelProvider?: unknown }).modelProvider;
  } catch {
    return { kind: "unknown", detail: "CLI settings could not be read; assuming default consumer OAuth mode." };
  }
  if (modelProvider === "gemini") {
    return {
      kind: "api-key",
      detail:
        "Native agy is configured for API-key mode (modelProvider gemini with GEMINI_API_KEY); there is no OAuth account session to switch. The native store was left untouched.",
    };
  }
  return { kind: "consumer", detail: "Default consumer OAuth mode." };
}

export interface AgyCliSyncResult {
  target: "cli";
  status: AgyCliSyncStatus;
  /** Stable machine-readable code (AGY_CLI_*). Never carries token material. */
  code: string;
  /** Human-readable, token-free explanation. */
  message: string;
  retryable: boolean;
  /** Masked email of the synced account, when known. */
  email?: string;
  /**
   * Native `agy` OS-keychain sub-state. `"synced"` on macOS (or with an
   * injected keyring) once the entry is written and read back; `"failed"`
   * when the keyring write/verify failed; `"unsupported"` on unverified
   * platforms where only the legacy files were synced.
   */
  nativeKeyring: AgyNativeKeyringState;
  nativeKeyringDetail: string;
}

const NATIVE_KEYRING_DETAIL_SYNCED =
  "Native agy keychain entry (gemini/antigravity) written and read back. " +
  "Applies to agy processes started after the switch on this proxy host.";
const NATIVE_KEYRING_DETAIL_UNSUPPORTED =
  "Native agy keychain sync is verified on macOS only; on this platform " +
  "OpenCodex synced the ~/.gemini/ files and left the keychain untouched. " +
  "If a bare agy process still uses another account, switch it with its native login.";

function fail(
  code: string,
  message: string,
  retryable: boolean,
  email?: string,
  nativeKeyring: AgyNativeKeyringState = "failed",
  nativeKeyringDetail = "",
): AgyCliSyncResult {
  return {
    target: "cli",
    status: "failed",
    code,
    message,
    retryable,
    ...(email ? { email } : {}),
    nativeKeyring,
    nativeKeyringDetail: nativeKeyringDetail || message,
  };
}

function ok(email: string | undefined, nativeKeyring: AgyNativeKeyringState, detail: string): AgyCliSyncResult {
  return {
    target: "cli",
    status: "synced",
    code: "AGY_CLI_SYNCED",
    message: email
      ? `CLI credentials verified for ${email}. Applies to agy processes started after the switch on this proxy host.`
      : "CLI credentials written and verified. Applies to agy processes started after the switch on this proxy host.",
    retryable: false,
    ...(email ? { email } : {}),
    nativeKeyring,
    nativeKeyringDetail: detail,
  };
}

/** Build the native keychain stored value (prefix + base64 JSON). No I/O. */
export function buildAgyKeyringStoredValue(
  access: string,
  refresh: string,
  expiresMs: number | undefined,
  tokenType = "Bearer",
): { stored: string; expirySeconds: number } {
  const expirySeconds =
    typeof expiresMs === "number" && Number.isFinite(expiresMs) && expiresMs > 0
      ? Math.floor(expiresMs / 1000)
      : Math.floor(Date.now() / 1000) + 3600;
  const expiry = new Date(expirySeconds * 1000).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  const payload = JSON.stringify({
    token: {
      access_token: access,
      token_type: tokenType || "Bearer",
      refresh_token: refresh,
      expiry,
    },
    auth_method: "consumer",
  });
  return { stored: AGY_KEYRING_PREFIX + Buffer.from(payload, "utf8").toString("base64"), expirySeconds };
}

export interface ParsedAgyKeyringPayload {
  access: string;
  refresh: string;
  tokenType: string;
  expirySeconds: number;
  authMethod?: string;
}

/** Extract only the auth_method marker without requiring token fields. */
export function parseAgyKeyringAuthMethod(stored: string): string | null {
  try {
    const trimmed = stored.trim();
    let jsonText: string;
    if (trimmed.startsWith(AGY_KEYRING_PREFIX)) {
      jsonText = Buffer.from(trimmed.slice(AGY_KEYRING_PREFIX.length), "base64").toString("utf8");
    } else if (trimmed.startsWith("{")) {
      jsonText = trimmed;
    } else {
      return null;
    }
    const body = JSON.parse(jsonText) as { auth_method?: unknown };
    return typeof body.auth_method === "string" ? body.auth_method : null;
  } catch {
    return null;
  }
}

/** Redact token-like material from human-readable messages (defense in depth). */
export function sanitizeAgyMessage(message: string): string {
  return message
    .replace(/go-keyring-base64:[A-Za-z0-9+/=]+/g, "go-keyring-base64:[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/ya29\.[A-Za-z0-9_-]+/g, "ya29.[redacted]")
    .slice(0, 500);
}

/** Parse a stored keychain value back into token fields (throws on malformed). */
export function parseAgyKeyringStoredValue(stored: string): ParsedAgyKeyringPayload {
  const trimmed = stored.trim();
  let jsonText: string;
  if (trimmed.startsWith(AGY_KEYRING_PREFIX)) {
    jsonText = Buffer.from(trimmed.slice(AGY_KEYRING_PREFIX.length), "base64").toString("utf8");
  } else if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else {
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      if (decoded.trim().startsWith("{")) jsonText = decoded;
      else jsonText = trimmed;
    } catch {
      jsonText = trimmed;
    }
  }
  const body = JSON.parse(jsonText) as {
    token?: { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; expiry?: unknown };
    auth_method?: unknown;
  };
  const access = body.token?.access_token;
  const refresh = body.token?.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    throw new Error("credential payload missing tokens");
  }
  const tokenType = typeof body.token?.token_type === "string" && body.token.token_type ? body.token.token_type : "Bearer";
  let expirySeconds = 0;
  if (typeof body.token?.expiry === "string" && body.token.expiry) {
    const raw = body.token.expiry;
    for (const parse of [
      () => Date.parse(raw),
      () => Date.parse(raw.replace(/\.(\d{3})000Z$/, ".$1Z")),
    ]) {
      try {
        const ms = parse();
        if (Number.isFinite(ms) && ms > 0) {
          expirySeconds = Math.floor(ms / 1000);
          break;
        }
      } catch { /* try next */ }
    }
  }
  if (!expirySeconds) expirySeconds = Math.floor(Date.now() / 1000) + 3600;
  const authMethod = typeof body.auth_method === "string" ? body.auth_method : undefined;
  return { access, refresh, tokenType, expirySeconds, ...(authMethod ? { authMethod } : {}) };
}

export function resolveAgyGeminiDir(deps: AgyCliSyncDeps = {}): string {
  return (
    deps.geminiDirImpl?.() ||
    process.env.ANTIGRAVITY_HOME ||
    process.env.GEMINI_HOME ||
    join(homedir(), ".gemini")
  );
}

/** Serialize CLI file writes so concurrent switches cannot interleave into mixed credentials. */
let agyCliSyncTail: Promise<void> = Promise.resolve();
export function runAgyCliSyncSerialized<T>(work: () => Promise<T>): Promise<T> {
  const next = agyCliSyncTail.then(work);
  agyCliSyncTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function syncAgyCliAccount(
  accountId: string,
  deps: AgyCliSyncDeps = {},
): Promise<AgyCliSyncResult> {
  return runAgyCliSyncSerialized(async () => syncAgyCliAccountInner(accountId, deps));
}

async function syncAgyCliAccountInner(
  accountId: string,
  deps: AgyCliSyncDeps,
): Promise<AgyCliSyncResult> {
  if (!accountId || typeof accountId !== "string") {
    return fail("AGY_CLI_INVALID_ACCOUNT", "Missing account id.", false);
  }
  const getCred = deps.getCredentialImpl ?? getAccountCredential;
  const cred = getCred(AGY_PROVIDER, accountId);
  if (!cred) {
    return fail("AGY_CLI_CREDENTIAL_MISSING", "No stored OpenCodex credentials for this account.", false);
  }
  const masked = maskEmail(cred.email) ?? undefined;

  let effectiveCred = cred;
  if (cred.refresh && (!cred.access || !cred.expires || cred.expires < Date.now() + 5 * 60 * 1000)) {
    const refresh = deps.refreshImpl ?? refreshAntigravityToken;
    try {
      const refreshed = await refresh(cred.refresh);
      effectiveCred = { ...cred, ...refreshed };
      const save = deps.saveCredentialImpl ?? saveAccountCredential;
      await save(AGY_PROVIDER, accountId, effectiveCred);
    } catch {
      return fail(
        "AGY_CLI_REFRESH_FAILED",
        "Stored credentials are expired and the refresh attempt failed. Re-login is required; nothing was written.",
        true,
        masked,
      );
    }
  }
  if (!effectiveCred.access || !effectiveCred.refresh) {
    return fail(
      "AGY_CLI_CREDENTIAL_INCOMPLETE",
      "Stored credentials are missing token material and cannot be synced.",
      false,
      masked,
    );
  }

  const geminiDir = resolveAgyGeminiDir(deps);
  // Effective auth-mode preflight (finding 6): the keychain payload's
  // auth_method alone cannot prove consumer mode — an API-key configured
  // CLI keeps a stale consumer entry while ignoring it. Refuse before ANY
  // mutation (keychain or files) when the effective configuration is not
  // consumer OAuth.
  const cliAuthMode = detectAgyCliAuthMode({ ...deps, geminiDirImpl: () => geminiDir });
  if (cliAuthMode.kind === "api-key" || cliAuthMode.kind === "adc") {
    return {
      target: "cli",
      status: "unsupported",
      code: "AGY_CLI_AUTH_MODE_UNSUPPORTED",
      message: sanitizeAgyMessage(`${cliAuthMode.detail} Account switching does not apply; nothing was written.`),
      retryable: false,
      ...(masked ? { email: masked } : {}),
      nativeKeyring: "unsupported",
      nativeKeyringDetail: sanitizeAgyMessage(cliAuthMode.detail),
    };
  }

  const platform = deps.platformImpl?.() ?? process.platform;
  const hasInjectedKeyring =
    deps.keyringEntryFactoryImpl !== undefined || deps.keyringAsyncImpl !== undefined || agyKeyringFactoryOverridden;
  // macOS is the verified native target: the keyring write is mandatory.
  // Injected keyring factories (tests) exercise the same path on any platform.
  // Unverified platforms without an injected keyring keep the legacy file
  // sync and honestly report nativeKeyring unsupported.
  const useKeyring = platform === "darwin" || hasInjectedKeyring;

  const writeFile = deps.writeFileImpl;
  const readFile = deps.readFileImpl;
  // Fully injected filesystem (tests): the injected writers own existence
  // semantics, so the real directory must never be created or probed.
  const injectedFs = writeFile !== undefined && readFile !== undefined;
  const pathExists = (path: string): boolean => {
    if (injectedFs) {
      try {
        readFile(path);
        return true;
      } catch {
        return false;
      }
    }
    return existsSync(path);
  };

  const oauthCredsPath = join(geminiDir, "oauth_creds.json");
  const accountsPath = join(geminiDir, "google_accounts.json");
  let oauthBackup: string | undefined;
  let accountsBackup: string | undefined;
  let oauthExisted = false;
  let accountsExisted = false;
  // Preflight BEFORE any native mutation: the keyring is switched below, so
  // a backup read failure here must surface while the keychain is still on
  // the previous account. (A read error after the keyring write would leave
  // native credentials on B while reporting failure.)
  try {
    if (pathExists(oauthCredsPath)) {
      oauthExisted = true;
      oauthBackup = readFile ? readFile(oauthCredsPath) : readFileSync(oauthCredsPath, "utf8");
    }
    if (pathExists(accountsPath)) {
      accountsExisted = true;
      accountsBackup = readFile ? readFile(accountsPath) : readFileSync(accountsPath, "utf8");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail("AGY_CLI_READ_FAILED", `Could not back up existing CLI credentials: ${reason}`, true, masked);
  }

  if (!injectedFs) {
    try {
      if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail("AGY_CLI_WRITE_FAILED", `Could not prepare the CLI credential directory: ${reason}`, true, masked);
    }
  }

  // --- Native keyring stage (before touching files) ---
  // All access is bounded (finding 3): reads, writes, rollback and
  // snapshots share the timeout below, and a denied/timed-out async call is
  // never retried through a synchronous fallback.
  const keyringService = resolveAgyKeyringService(deps);
  const keyringAccount = resolveAgyKeyringAccount(deps);
  const keyringMs = deps.keyringTimeoutMsImpl ?? AGY_KEYRING_TIMEOUT_MS;
  let keyringPrev: string | null = null;
  let keyringHadPrev = false;
  let keyringWrote = false;
  let keyringStored = "";
  let restoreKeyringFn: (() => Promise<boolean>) | undefined;
  if (useKeyring) {
    // Fail closed when a prior native write is still unresolved after a
    // bounded grace: proceeding could report success and then be silently
    // overwritten by the late write landing afterwards.
    const priorSettled = await settlePriorKeyringWrites(keyringMs);
    if (!priorSettled) {
      return fail(
        "AGY_CLI_KEYRING_PENDING",
        "A previous keychain write is still pending; the switch was refused so a late write cannot overwrite a reported success. Retry once it settles.",
        true,
        masked,
        "failed",
        "Prior keychain write still pending; mutation refused.",
      );
    }
    let handle: KeyringHandle;
    try {
      if (deps.keyringAsyncImpl) {
        const backend = deps.keyringAsyncImpl;
        handle = {
          getPassword: () => withKeyringBound(backend.getPassword(keyringService, keyringAccount), keyringMs, "read"),
          setPassword: async (password: string) => {
            const native = backend.setPassword(keyringService, keyringAccount, password);
            const { settled } = trackKeyringWrite(native);
            const gate = armKeyringTimer(keyringMs, "write");
            try {
              await Promise.race([settled, gate.promise]);
            } finally {
              gate.cancel();
            }
          },
          deletePassword: async () => {
            const native = backend.deletePassword(keyringService, keyringAccount);
            const { settled } = trackKeyringWrite(native);
            const gate = armKeyringTimer(keyringMs, "delete");
            try {
              return (await Promise.race([settled, gate.promise])) as boolean;
            } finally {
              gate.cancel();
            }
          },
        };
      } else {
        const factory = deps.keyringEntryFactoryImpl ?? agyKeyringEntryFactory;
        const injected = deps.keyringEntryFactoryImpl !== undefined || agyKeyringFactoryOverridden;
        if (injected) {
          handle = injectedKeyringHandle(factory(keyringService, keyringAccount), keyringMs);
        } else {
          // Production path: AsyncEntry with a hard timeout. No sync
          // fallback after denial/timeout (that would block the event loop
          // exactly when the keychain is refusing to answer). A sync-Entry
          // wrapped in a microtask still blocks the JS thread, so an
          // AsyncEntry-missing install fails closed instead.
          const production = productionKeyringHandle(keyringService, keyringAccount, keyringMs);
          if (!production) {
            return fail(
              "AGY_CLI_KEYRING_UNAVAILABLE",
              "OS keychain async access is unavailable on this install; nothing was written. Retry after unlocking the keychain.",
              true,
              masked,
              "failed",
              "Async keychain entry unavailable; refusing to block on synchronous access.",
            );
          }
          handle = production;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(
        "AGY_CLI_KEYRING_UNAVAILABLE",
        `OS keychain is unavailable (${reason}); nothing was written.`,
        true,
        masked,
        "failed",
        `OS keychain unavailable: ${reason}`,
      );
    }
    try {
      keyringPrev = await handle.getPassword();
      keyringHadPrev = keyringPrev !== null && keyringPrev !== undefined;
      // Auth-mode guard: if the existing native entry uses a non-consumer
      // mode (API key / ADC / enterprise), never overwrite it as consumer.
      if (typeof keyringPrev === "string" && keyringPrev.trim()) {
        const existingMode = parseAgyKeyringAuthMethod(keyringPrev);
        if (existingMode !== null && existingMode !== "consumer") {
          return {
            target: "cli",
            status: "unsupported",
            code: "AGY_CLI_AUTH_MODE_UNSUPPORTED",
            message: `Native agy entry uses '${sanitizeAgyMessage(existingMode)}' auth mode, not consumer OAuth. Account switching does not apply; left untouched.`,
            retryable: false,
            ...(masked ? { email: masked } : {}),
            nativeKeyring: "unsupported",
            nativeKeyringDetail: `Existing keychain auth_method is '${sanitizeAgyMessage(existingMode)}'; consumer sync refused.`,
          };
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(
        "AGY_CLI_KEYRING_READ_FAILED",
        `Could not read the native keychain entry (${reason}); nothing was written.`,
        true,
        masked,
        "failed",
        `Keychain read failed: ${reason}`,
      );
    }
    try {
      keyringStored = buildAgyKeyringStoredValue(
        effectiveCred.access,
        effectiveCred.refresh,
        effectiveCred.expires,
      ).stored;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail("AGY_CLI_KEYRING_BUILD_FAILED", `Could not encode native credentials (${reason}).`, false, masked, "failed", reason);
    }
    const restoreKeyring = async (): Promise<boolean> => {
      try {
        if (keyringHadPrev && keyringPrev !== null) {
          await handle.setPassword(keyringPrev);
          return (await handle.getPassword()) === keyringPrev;
        }
        try {
          await handle.deletePassword();
        } catch { /* brand-new entry may have nothing to delete */ }
        const after = await handle.getPassword();
        return after === null || after === undefined || after === "";
      } catch {
        return false;
      }
    };
    try {
      // Single set + read-back verify. Never deletes unrelated items and
      // never passes token material through shell arguments.
      await handle.setPassword(keyringStored);
      keyringWrote = true;
      const back = await handle.getPassword();
      if (typeof back !== "string" || !back) {
        throw new Error("keychain read-back was empty");
      }
      const parsed = parseAgyKeyringStoredValue(back);
      if (parsed.refresh !== effectiveCred.refresh || parsed.access !== effectiveCred.access) {
        throw new Error("keychain read-back did not match the selected account");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const restored = keyringWrote ? await restoreKeyring() : true;
      if (!restored) {
        return {
          target: "cli",
          status: "failed",
          code: "AGY_CLI_INCONSISTENT",
          message: `Native keychain write failed (${reason}) and restoring the previous entry also failed. CLI credentials may be inconsistent; retry before starting agy.`,
          retryable: true,
          ...(masked ? { email: masked } : {}),
          nativeKeyring: "failed",
          nativeKeyringDetail: `Keychain write failed (${reason}); restore also failed.`,
        };
      }
      return fail(
        "AGY_CLI_KEYRING_FAILED",
        `Native keychain sync failed (${reason}); previous credentials were restored.`,
        true,
        masked,
        "failed",
        `Keychain write failed: ${reason}`,
      );
    }
    // Stash the restorer for the file stage below.
    restoreKeyringFn = restoreKeyring;
  }

  const restore = (): { restored: boolean; reason?: string } => {
    try {
      const restoreOne = (path: string, backup: string | undefined, existed: boolean): void => {
        if (backup !== undefined) {
          if (writeFile) writeFile(path, backup);
          else atomicWriteFile(path, backup);
          return;
        }
        if (!existed) {
          // Nothing to restore to — remove the partial new file, if any.
          if (writeFile) {
            try {
              writeFile(path, "");
            } catch { /* injected writers may not support removal; verification will catch it */ }
          } else {
            try {
              unlinkSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
            }
          }
        }
      };
      restoreOne(oauthCredsPath, oauthBackup, oauthExisted);
      restoreOne(accountsPath, accountsBackup, accountsExisted);
      return { restored: true };
    } catch (error) {
      return { restored: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  try {
    const oauthData = {
      access_token: effectiveCred.access,
      scope:
        "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid",
      token_type: "Bearer",
      id_token: ((effectiveCred as Record<string, unknown>).idToken as string) || "",
      expiry_date: effectiveCred.expires || Date.now() + 3600 * 1000,
      refresh_token: effectiveCred.refresh,
    };
    const oauthPayload = JSON.stringify(oauthData, null, 2);
    if (writeFile) writeFile(oauthCredsPath, oauthPayload);
    else {
      atomicWriteFile(oauthCredsPath, oauthPayload);
      try {
        chmodSync(oauthCredsPath, 0o600);
      } catch { /* best-effort hardening */ }
    }

    const existingOld: string[] = [];
    try {
      if (accountsBackup) {
        const oldJson = JSON.parse(accountsBackup) as { active?: unknown; old?: unknown };
        if (typeof oldJson.active === "string" && oldJson.active !== effectiveCred.email) {
          existingOld.push(oldJson.active);
        }
        if (Array.isArray(oldJson.old)) {
          for (const entry of oldJson.old) {
            if (typeof entry === "string") existingOld.push(entry);
          }
        }
      }
    } catch { /* a corrupt previous file must not block the switch */ }

    const list = deps.listAccountsImpl ?? listAccounts;
    for (const account of list(AGY_PROVIDER)) {
      if (account.credential?.email && account.credential.email !== effectiveCred.email) {
        existingOld.push(account.credential.email);
      }
    }
    const uniqueOld = [...new Set(existingOld)].filter(e => e && e !== effectiveCred.email);
    const accountsPayload = JSON.stringify({ active: effectiveCred.email || "", old: uniqueOld }, null, 2);
    if (writeFile) writeFile(accountsPath, accountsPayload);
    else {
      atomicWriteFile(accountsPath, accountsPayload);
      try {
        chmodSync(accountsPath, 0o600);
      } catch { /* best-effort hardening */ }
    }

    // Read-back verification: the files must reflect the requested account.
    // On the keyring path the keyring entry was already verified above, so a
    // file mismatch restores BOTH stages (files + keyring) before reporting.
    const verifyRaw = readFile ? readFile(accountsPath) : readFileSync(accountsPath, "utf8");
    const verifyOauth = readFile ? readFile(oauthCredsPath) : readFileSync(oauthCredsPath, "utf8");
    const verifyAccounts = JSON.parse(verifyRaw) as { active?: unknown };
    const verifyOauthJson = JSON.parse(verifyOauth) as { refresh_token?: unknown };
    if (verifyAccounts.active !== (effectiveCred.email || "") || verifyOauthJson.refresh_token !== effectiveCred.refresh) {
      const recovery = restore();
      const keyringRestored = restoreKeyringFn ? await restoreKeyringFn() : true;
      if (!recovery.restored || !keyringRestored) {
        return {
          target: "cli",
          status: "failed",
          code: "AGY_CLI_INCONSISTENT",
          message: `Sync verification failed and restoring the previous credentials also failed. CLI credentials may be inconsistent; retry before starting agy.`,
          retryable: true,
          ...(masked ? { email: masked } : {}),
          nativeKeyring: useKeyring ? "failed" : "unsupported",
          nativeKeyringDetail: useKeyring
            ? "File verification failed and keychain/file restore did not complete."
            : NATIVE_KEYRING_DETAIL_UNSUPPORTED,
        };
      }
      return fail(
        "AGY_CLI_VERIFY_FAILED",
        "Sync verification failed; previous CLI credentials were restored. Retry the switch.",
        true,
        masked,
        useKeyring ? "failed" : "unsupported",
        useKeyring ? "File verification failed; keychain entry was rolled back." : NATIVE_KEYRING_DETAIL_UNSUPPORTED,
      );
    }
    if (useKeyring) {
      return ok(masked, "synced", NATIVE_KEYRING_DETAIL_SYNCED);
    }
    // Unverified platform without a keyring: legacy files were written, but
    // the native binary was NOT verified — report unsupported, never synced,
    // so callers cannot mistake this for a complete native switch.
    return {
      target: "cli",
      status: "unsupported",
      code: "AGY_CLI_UNSUPPORTED_PLATFORM",
      message: `CLI files written, but native keychain sync is verified on macOS only (current platform: ${platform}). Bare agy may still use another account; use its native login.`,
      retryable: false,
      ...(masked ? { email: masked } : {}),
      nativeKeyring: "unsupported",
      nativeKeyringDetail: NATIVE_KEYRING_DETAIL_UNSUPPORTED,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const recovery = restore();
    const keyringRestored = restoreKeyringFn ? restoreKeyringFn() : true;
    if (!recovery.restored || !keyringRestored) {
      return {
        target: "cli",
        status: "failed",
        code: "AGY_CLI_INCONSISTENT",
        message: `CLI credential write failed (${reason}) and restoring the previous credentials also failed. CLI credentials may be inconsistent; retry before starting agy.`,
        retryable: true,
        ...(masked ? { email: masked } : {}),
        nativeKeyring: useKeyring ? "failed" : "unsupported",
        nativeKeyringDetail: useKeyring
          ? `Write failed (${reason}); restore also failed.`
          : NATIVE_KEYRING_DETAIL_UNSUPPORTED,
      };
    }
    return fail(
      "AGY_CLI_WRITE_FAILED",
      `CLI credential write failed (${reason}); previous credentials were restored.`,
      true,
      masked,
      useKeyring ? "failed" : "unsupported",
      useKeyring ? `Write failed: ${reason}` : NATIVE_KEYRING_DETAIL_UNSUPPORTED,
    );
  }
}

/** Desensitized read-back: does the CLI file currently point at the given email? No tokens involved. */
export function readAgyCliFileSnapshot(
  expectedEmail: string | undefined,
  deps: AgyCliSyncDeps = {},
): { present: boolean; matchesActive: boolean | null } {
  try {
    const geminiDir = resolveAgyGeminiDir(deps);
    const accountsPath = join(geminiDir, "google_accounts.json");
    let raw: string;
    if (deps.readFileImpl) {
      try {
        raw = deps.readFileImpl(accountsPath);
      } catch {
        return { present: false, matchesActive: null };
      }
    } else {
      if (!existsSync(accountsPath)) return { present: false, matchesActive: null };
      raw = readFileSync(accountsPath, "utf8");
    }
    const parsed = JSON.parse(raw) as { active?: unknown };
    if (typeof parsed.active !== "string") return { present: true, matchesActive: null };
    if (!expectedEmail) return { present: true, matchesActive: null };
    return { present: true, matchesActive: parsed.active === expectedEmail };
  } catch {
    return { present: false, matchesActive: null };
  }
}

/** Desensitized keyring read-back: is there an entry, and does its refresh match the active credential? */
export function readAgyKeyringSnapshot(
  activeAccountId: string | null | undefined,
  deps: AgyCliSyncDeps = {},
): { present: boolean; matchesActive: boolean | null } {
  try {
    const platform = deps.platformImpl?.() ?? process.platform;
    const hasMock = deps.keyringEntryFactoryImpl !== undefined || deps.keyringAsyncImpl !== undefined || agyKeyringFactoryOverridden;
    if (platform !== "darwin" && !hasMock) return { present: false, matchesActive: null };
    if (!activeAccountId) {
      try {
        const factory = deps.keyringEntryFactoryImpl ?? agyKeyringEntryFactory;
        const cur = factory(resolveAgyKeyringService(deps), resolveAgyKeyringAccount(deps)).getPassword();
        if (cur instanceof Promise) return { present: false, matchesActive: null };
        return { present: typeof cur === "string" && cur.length > 0, matchesActive: null };
      } catch {
        return { present: false, matchesActive: null };
      }
    }
    const getCred = deps.getCredentialImpl ?? getAccountCredential;
    const cred = getCred(AGY_PROVIDER, activeAccountId);
    if (!cred?.refresh) return { present: false, matchesActive: null };
    const factory = deps.keyringEntryFactoryImpl ?? agyKeyringEntryFactory;
    let stored: string | null;
    try {
      const cur = factory(resolveAgyKeyringService(deps), resolveAgyKeyringAccount(deps)).getPassword();
      if (cur instanceof Promise) return { present: false, matchesActive: null };
      stored = cur;
    } catch {
      return { present: false, matchesActive: null };
    }
    if (typeof stored !== "string" || !stored) return { present: false, matchesActive: null };
    try {
      const parsed = parseAgyKeyringStoredValue(stored);
      return { present: true, matchesActive: parsed.refresh === cred.refresh };
    } catch {
      return { present: true, matchesActive: null };
    }
  } catch {
    return { present: false, matchesActive: null };
  }
}

/**
 * Bounded async keyring snapshot for request paths (notably the accounts-page
 * GET): the same desensitized booleans as readAgyKeyringSnapshot, but the
 * native read goes through the timeout so a locked keychain degrades to
 * `matchesActive: null` instead of stalling the response.
 */
export async function readAgyKeyringSnapshotAsync(
  activeAccountId: string | null | undefined,
  deps: AgyCliSyncDeps = {},
): Promise<{ present: boolean; matchesActive: boolean | null }> {
  try {
    const platform = deps.platformImpl?.() ?? process.platform;
    const hasMock =
      deps.keyringEntryFactoryImpl !== undefined || deps.keyringAsyncImpl !== undefined || agyKeyringFactoryOverridden;
    if (platform !== "darwin" && !hasMock) return { present: false, matchesActive: null };
    const ms = deps.keyringTimeoutMsImpl ?? AGY_KEYRING_TIMEOUT_MS;
    const service = resolveAgyKeyringService(deps);
    const account = resolveAgyKeyringAccount(deps);
    let stored: string | null;
    try {
      if (deps.keyringAsyncImpl) {
        stored = await withKeyringBound(deps.keyringAsyncImpl.getPassword(service, account), ms, "read");
      } else if (hasMock) {
        const factory = deps.keyringEntryFactoryImpl ?? agyKeyringEntryFactory;
        stored = await withKeyringBound(
          Promise.resolve().then(() => factory(service, account).getPassword()),
          ms,
          "read",
        );
      } else {
        const handle = productionKeyringHandle(service, account, ms);
        if (!handle) {
          // No AsyncEntry: degrade to unknown instead of blocking the event
          // loop on a synchronous Entry.
          return { present: false, matchesActive: null };
        }
        stored = await handle.getPassword();
      }
    } catch {
      return { present: false, matchesActive: null };
    }
    if (typeof stored !== "string" || !stored) return { present: false, matchesActive: null };
    if (!activeAccountId) return { present: true, matchesActive: null };
    const getCred = deps.getCredentialImpl ?? getAccountCredential;
    const cred = getCred(AGY_PROVIDER, activeAccountId);
    if (!cred?.refresh) return { present: true, matchesActive: null };
    try {
      const parsed = parseAgyKeyringStoredValue(stored);
      return { present: true, matchesActive: parsed.refresh === cred.refresh };
    } catch {
      return { present: true, matchesActive: null };
    }
  } catch {
    return { present: false, matchesActive: null };
  }
}
// ---------------------------------------------------------------------------
// Shared switch orchestrator (management API entry point).
// ---------------------------------------------------------------------------

export type AgySyncTarget = "cli" | "ide";

export interface AgySwitchSyncOptions {
  targets?: AgySyncTarget[];
  cliDeps?: AgyCliSyncDeps;
  ideDeps?: AgyIdeSyncDeps;
}

export interface AgySwitchSyncResult {
  provider: typeof AGY_PROVIDER;
  activeAccountId: string;
  requestedTargets: AgySyncTarget[];
  cli?: AgyCliSyncResult;
  ide?: AgyIdeSyncResult;
  /** Full success: every requested target synced (a requested IDE that is
   *  not installed counts as satisfied-with-note, never as synced). */
  ok: boolean;
  code: string;
  message: string;
}

function ideSatisfied(result: AgyIdeSyncResult | undefined, requested: boolean): boolean {
  if (!requested || !result) return true;
  return result.status === "synced" || result.status === "not_installed";
}

/** Serialize whole switches so two concurrent page/CLI requests cannot interleave targets. */
let agySwitchTail: Promise<void> = Promise.resolve();
export function runAgySwitchSerialized<T>(work: () => Promise<T>): Promise<T> {
  const next = agySwitchTail.then(work);
  agySwitchTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function syncAgyTargetsInner(
  accountId: string,
  opts: AgySwitchSyncOptions = {},
): Promise<AgySwitchSyncResult> {
  const requested = opts.targets ?? ["cli", "ide"];
  const wantCli = requested.includes("cli");
  const wantIde = requested.includes("ide");
  const cli = wantCli ? await syncAgyCliAccountInner(accountId, opts.cliDeps ?? {}) : undefined;
  const ide = wantIde ? await syncAntigravityIdeAccount(accountId, opts.ideDeps ?? {}) : undefined;
  const cliOk = !wantCli || cli?.status === "synced";
  const ok = cliOk && ideSatisfied(ide, wantIde);
  let code: string;
  let message: string;
  if (ok) {
    if (wantIde && ide?.status === "not_installed") {
      code = "AGY_SWITCH_CLI_ONLY_NO_IDE";
      message = "Proxy account switched and CLI credentials verified. Antigravity IDE is not installed on this proxy host, so no IDE sync was performed.";
    } else {
      code = "AGY_SWITCH_OK";
      message = "Proxy account switched and all requested targets synced.";
    }
  } else if (!cliOk && wantIde && ide && !ideSatisfied(ide, true)) {
    code = "AGY_SWITCH_PARTIAL";
    message = sanitizeAgyMessage(`Proxy account switched, but sync needs attention — CLI: ${cli?.code ?? "skipped"}; IDE: ${ide.code}. Retry the failed target; the proxy active account is already ${accountId}.`);
  } else if (!cliOk) {
    code = "AGY_SWITCH_CLI_FAILED";
    message = sanitizeAgyMessage(`Proxy account switched, but CLI sync failed (${cli?.code ?? "unknown"}): ${cli?.message ?? "no detail"}. Retry before starting agy.`);
  } else {
    code = "AGY_SWITCH_IDE_ATTENTION";
    message = sanitizeAgyMessage(`Proxy account switched and CLI credentials verified, but IDE needs attention (${ide?.code ?? "unknown"}): ${ide?.message ?? "no detail"}.`);
  }
  return {
    provider: AGY_PROVIDER,
    activeAccountId: accountId,
    requestedTargets: requested,
    ...(cli ? { cli } : {}),
    ...(ide ? { ide } : {}),
    ok,
    code,
    message,
  };
}

export async function syncAgyAccountTargets(
  accountId: string,
  opts: AgySwitchSyncOptions = {},
): Promise<AgySwitchSyncResult> {
  return runAgySwitchSerialized(() => syncAgyTargetsInner(accountId, opts));
}

/**
 * Atomic proxy switch: provider selection + target syncs in ONE serialized
 * operation. Reports the actual account so concurrent B/C requests cannot
 * leave B returning a stale activeAccountId.
 */
export async function switchAgyActiveAccountWithSync(
  accountId: string,
  opts: AgySwitchSyncOptions & {
    setActiveImpl: (provider: string, accountId: string) => Promise<boolean>;
    getActiveImpl?: () => Promise<string | null | undefined> | string | null | undefined;
  },
): Promise<AgySwitchSyncResult & { switched: boolean }> {
  return runAgySwitchSerialized(async () => {
    const switched = await opts.setActiveImpl(AGY_PROVIDER, accountId);
    if (!switched) {
      return {
        provider: AGY_PROVIDER,
        activeAccountId: accountId,
        requestedTargets: opts.targets ?? ["cli", "ide"],
        ok: false,
        code: "AGY_SWITCH_ACCOUNT_NOT_FOUND",
        message: "Account not found; nothing was switched.",
        switched: false,
      };
    }
    const inner = await syncAgyTargetsInner(accountId, opts);
    const actual = (await opts.getActiveImpl?.()) ?? accountId;
    return { ...inner, activeAccountId: typeof actual === "string" ? actual : accountId, switched: true };
  });
}
