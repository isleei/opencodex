import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgyKeyringStoredValue,
  detectAgyCliAuthMode,
  parseAgyKeyringStoredValue,
  readAgyCliFileSnapshot,
  readAgyKeyringSnapshot,
  readAgyKeyringSnapshotAsync,
  syncAgyAccountTargets,
  syncAgyCliAccount,
  type AgyKeyringAsyncBackend,
  type AgyKeyringEntryFactory,
} from "../src/clients/agy-account-sync";
import type { OAuthCredentials } from "../src/oauth/types";

const ACCESS_A = "access-fictitious-aaa-111";
const REFRESH_A = "refresh-fictitious-aaa-111";
const ACCESS_B = "access-fictitious-bbb-222";
const REFRESH_B = "refresh-fictitious-bbb-222";

function cred(email: string, access: string, refresh: string, expires = Date.now() + 3600 * 1000): OAuthCredentials {
  return { access, refresh, expires, email };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** In-memory OS-keychain double. Keeps real keychain untouched on any platform. */
function memoryKeyring(initial: string | null = null): {
  factory: AgyKeyringEntryFactory;
  get: () => string | null;
  set: (v: string | null) => void;
  failWrites: (reason: string) => void;
  allowWrites: () => void;
} {
  let value = initial;
  let failure: string | null = null;
  return {
    factory: () => ({
      getPassword: () => value,
      setPassword: (pw: string) => {
        if (failure) throw new Error(failure);
        value = pw;
      },
      deletePassword: () => {
        const had = value !== null;
        value = null;
        return had;
      },
    }),
    get: () => value,
    set: v => {
      value = v;
    },
    failWrites: reason => {
      failure = reason;
    },
    allowWrites: () => {
      failure = null;
    },
  };
}

describe("agy CLI credential sync", () => {
  test("success writes keychain + both files, masks email, leaks no tokens", async () => {
    const dir = tempDir("ocx-agy-sync-ok-");
    const keyring = memoryKeyring();
    try {
      const result = await syncAgyCliAccount("account-a", {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        listAccountsImpl: () => [{ credential: { email: "bob@example.com" } }],
        keyringEntryFactoryImpl: keyring.factory,
      });
      expect(result.status).toBe("synced");
      expect(result.code).toBe("AGY_CLI_SYNCED");
      expect(result.retryable).toBe(false);
      expect(result.nativeKeyring).toBe("synced");
      expect(result.email).not.toContain("alice@");

      // Native keychain entry holds the selected account (prefix + base64 JSON).
      const stored = keyring.get();
      expect(typeof stored).toBe("string");
      expect(stored!.startsWith("go-keyring-base64:")).toBe(true);
      const parsed = parseAgyKeyringStoredValue(stored!);
      expect(parsed.access).toBe(ACCESS_A);
      expect(parsed.refresh).toBe(REFRESH_A);
      expect(parsed.tokenType).toBe("Bearer");

      const oauth = JSON.parse(readFileSync(join(dir, "oauth_creds.json"), "utf8"));
      expect(oauth.access_token).toBe(ACCESS_A);
      expect(oauth.refresh_token).toBe(REFRESH_A);
      const accounts = JSON.parse(readFileSync(join(dir, "google_accounts.json"), "utf8"));
      expect(accounts.active).toBe("alice@example.com");
      expect(accounts.old).toContain("bob@example.com");

      const leaked = JSON.stringify(result);
      expect(leaked.includes(ACCESS_A)).toBe(false);
      expect(leaked.includes(REFRESH_A)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keyring payload uses the documented expiry shape", () => {
    const { stored } = buildAgyKeyringStoredValue("a", "r", new Date("2026-03-04T05:06:07.000Z").getTime());
    const payload = JSON.parse(Buffer.from(stored.replace("go-keyring-base64:", ""), "base64").toString("utf8"));
    expect(payload.auth_method).toBe("consumer");
    expect(payload.token.expiry).toBe("2026-03-04T05:06:07.000000Z");
    expect(parseAgyKeyringStoredValue(stored).refresh).toBe("r");
  });

  test("missing credentials fail without writing", async () => {
    const dir = tempDir("ocx-agy-sync-missing-");
    const keyring = memoryKeyring();
    try {
      const result = await syncAgyCliAccount("nope", {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => null,
        keyringEntryFactoryImpl: keyring.factory,
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_CLI_CREDENTIAL_MISSING");
      expect(result.retryable).toBe(false);
      expect(keyring.get()).toBeNull();
      const leaked = JSON.stringify(result);
      expect(leaked.includes("refresh")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expired credentials with failed refresh are not written stale", async () => {
    const dir = tempDir("ocx-agy-sync-refresh-fail-");
    const keyring = memoryKeyring();
    try {
      const result = await syncAgyCliAccount("account-a", {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("alice@example.com", "stale-access", "bad-refresh", Date.now() - 1000),
        refreshImpl: async () => {
          throw new Error("upstream rejected");
        },
        keyringEntryFactoryImpl: keyring.factory,
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_CLI_REFRESH_FAILED");
      expect(result.retryable).toBe(true);
      expect(keyring.get()).toBeNull();
      expect(() => readFileSync(join(dir, "oauth_creds.json"), "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expired credentials with successful refresh persist the refresh", async () => {
    const dir = tempDir("ocx-agy-sync-refresh-ok-");
    const keyring = memoryKeyring();
    let saved: OAuthCredentials | null = null;
    try {
      const result = await syncAgyCliAccount("account-a", {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("alice@example.com", "stale-access", REFRESH_A, Date.now() - 1000),
        refreshImpl: async () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        saveCredentialImpl: async (_p, _id, c) => {
          saved = c;
        },
        listAccountsImpl: () => [],
        keyringEntryFactoryImpl: keyring.factory,
      });
      expect(result.status).toBe("synced");
      expect(saved).not.toBeNull();
      const oauth = JSON.parse(readFileSync(join(dir, "oauth_creds.json"), "utf8"));
      expect(oauth.access_token).toBe(ACCESS_A);
      expect(parseAgyKeyringStoredValue(keyring.get()!).access).toBe(ACCESS_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("partial file write restores files + keychain and reports failure", async () => {
    const files = new Map<string, string>([
      ["/fake/oauth_creds.json", JSON.stringify({ access_token: "old" })],
      ["/fake/google_accounts.json", JSON.stringify({ active: "old@example.com", old: [] })],
    ]);
    const keyring = memoryKeyring(buildAgyKeyringStoredValue("old-access", "old-refresh", Date.now() + 3600 * 1000).stored);
    let restored = false;
    const result = await syncAgyCliAccount("account-a", {
      geminiDirImpl: () => "/fake",
      getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
      listAccountsImpl: () => [],
      keyringEntryFactoryImpl: keyring.factory,
      readFileImpl: path => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      },
      writeFileImpl: (path, content) => {
        if (path.endsWith("google_accounts.json") && !restored) {
          restored = true;
          throw new Error("disk full");
        }
        files.set(path, content);
      },
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("AGY_CLI_WRITE_FAILED");
    expect(result.retryable).toBe(true);
    expect(files.get("/fake/oauth_creds.json")).toBe(JSON.stringify({ access_token: "old" }));
    // Keychain rolled back to the previous entry.
    expect(parseAgyKeyringStoredValue(keyring.get()!).refresh).toBe("old-refresh");
    expect(JSON.stringify(result).includes(ACCESS_A)).toBe(false);
  });

  test("keyring write failure writes no files and reports retryable failure", async () => {
    const dir = tempDir("ocx-agy-sync-keyring-fail-");
    const keyring = memoryKeyring(buildAgyKeyringStoredValue("old-access", "old-refresh", Date.now() + 3600 * 1000).stored);
    keyring.failWrites("access denied");
    try {
      const result = await syncAgyCliAccount("account-a", {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        listAccountsImpl: () => [],
        keyringEntryFactoryImpl: keyring.factory,
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_CLI_KEYRING_FAILED");
      expect(result.retryable).toBe(true);
      expect(result.nativeKeyring).toBe("failed");
      expect(parseAgyKeyringStoredValue(keyring.get()!).refresh).toBe("old-refresh");
      expect(() => readFileSync(join(dir, "oauth_creds.json"), "utf8")).toThrow();
      expect(JSON.stringify(result).includes(ACCESS_A)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unverified platform without a keyring keeps the legacy file sync explicitly", async () => {
    const dir = tempDir("ocx-agy-sync-legacy-");
    try {
      const result = await syncAgyCliAccount("account-a", {
        geminiDirImpl: () => dir,
        platformImpl: () => "linux",
        getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        listAccountsImpl: () => [],
      });
      // Honest contract: legacy files are written but the native binary was
      // NOT verified — status is unsupported, never synced.
      expect(result.status).toBe("unsupported");
      expect(result.code).toBe("AGY_CLI_UNSUPPORTED_PLATFORM");
      expect(result.nativeKeyring).toBe("unsupported");
      const accounts = JSON.parse(readFileSync(join(dir, "google_accounts.json"), "utf8"));
      expect(accounts.active).toBe("alice@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unrestorable partial write reports inconsistency instead of success", async () => {
    const files = new Map<string, string>([
      ["/fake/oauth_creds.json", JSON.stringify({ access_token: "old" })],
      ["/fake/google_accounts.json", JSON.stringify({ active: "old@example.com", old: [] })],
    ]);
    const keyring = memoryKeyring();
    const result = await syncAgyCliAccount("account-a", {
      geminiDirImpl: () => "/fake",
      getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
      listAccountsImpl: () => [],
      keyringEntryFactoryImpl: keyring.factory,
      readFileImpl: path => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      },
      writeFileImpl: (path, content) => {
        if (path.endsWith("google_accounts.json")) throw new Error("disk full");
        files.set(path, content);
      },
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("AGY_CLI_INCONSISTENT");
    expect(result.retryable).toBe(true);
  });

  test("verification mismatch restores backups instead of reporting success", async () => {
    const files = new Map<string, string>();
    const keyring = memoryKeyring();
    const result = await syncAgyCliAccount("account-a", {
      geminiDirImpl: () => "/fake",
      getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
      listAccountsImpl: () => [],
      keyringEntryFactoryImpl: keyring.factory,
      readFileImpl: path => {
        if (path.endsWith("google_accounts.json")) {
          const stored = files.get(path);
          if (!stored) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          // Tamper only the verification read: backup reads of a missing
          // file throw above; post-write reads diverge.
          const parsed = JSON.parse(stored);
          return JSON.stringify({ ...parsed, active: "mallory@example.com" });
        }
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      },
      writeFileImpl: (path, content) => {
        files.set(path, content);
      },
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("AGY_CLI_VERIFY_FAILED");
    expect(result.retryable).toBe(true);
  });

  test("concurrent switches serialize to one consistent account", async () => {
    const dir = tempDir("ocx-agy-sync-race-");
    const keyring = memoryKeyring();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const refreshing = async (token: string): Promise<OAuthCredentials> => {
        await gate;
        return token === REFRESH_A
          ? cred("alice@example.com", ACCESS_A, REFRESH_A)
          : cred("bob@example.com", ACCESS_B, REFRESH_B);
      };
      const creds: Record<string, OAuthCredentials> = {
        a: cred("alice@example.com", "stale-a", REFRESH_A, Date.now() - 1000),
        b: cred("bob@example.com", "stale-b", REFRESH_B, Date.now() - 1000),
      };
      const both = Promise.all([
        syncAgyCliAccount("a", {
          geminiDirImpl: () => dir,
          getCredentialImpl: (_p, id) => creds[id] ?? null,
          refreshImpl: refreshing,
          saveCredentialImpl: async () => {},
          listAccountsImpl: () => [],
          keyringEntryFactoryImpl: keyring.factory,
        }),
        syncAgyCliAccount("b", {
          geminiDirImpl: () => dir,
          getCredentialImpl: (_p, id) => creds[id] ?? null,
          refreshImpl: refreshing,
          saveCredentialImpl: async () => {},
          listAccountsImpl: () => [],
          keyringEntryFactoryImpl: keyring.factory,
        }),
      ]);
      release();
      const [ra, rb] = await both;
      expect(ra.status).toBe("synced");
      expect(rb.status).toBe("synced");
      const oauth = JSON.parse(readFileSync(join(dir, "oauth_creds.json"), "utf8"));
      const accounts = JSON.parse(readFileSync(join(dir, "google_accounts.json"), "utf8"));
      const pair =
        (oauth.refresh_token === REFRESH_A && accounts.active === "alice@example.com") ||
        (oauth.refresh_token === REFRESH_B && accounts.active === "bob@example.com");
      expect(pair).toBe(true);
      // Keychain agrees with the winning file write — never a mixed pair.
      const stored = parseAgyKeyringStoredValue(keyring.get()!);
      expect(
        (stored.refresh === REFRESH_A && accounts.active === "alice@example.com") ||
          (stored.refresh === REFRESH_B && accounts.active === "bob@example.com"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readAgyCliFileSnapshot compares without secrets", async () => {
    const dir = tempDir("ocx-agy-sync-snap-");
    try {
      expect(readAgyCliFileSnapshot("alice@example.com", { geminiDirImpl: () => dir }).present).toBe(false);
      writeFileSync(join(dir, "google_accounts.json"), JSON.stringify({ active: "alice@example.com", old: [] }));
      expect(readAgyCliFileSnapshot("alice@example.com", { geminiDirImpl: () => dir })).toEqual({
        present: true,
        matchesActive: true,
      });
      expect(readAgyCliFileSnapshot("bob@example.com", { geminiDirImpl: () => dir }).matchesActive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readAgyKeyringSnapshot matches by refresh without exposing tokens", async () => {
    const keyring = memoryKeyring(buildAgyKeyringStoredValue(ACCESS_A, REFRESH_A, Date.now() + 3600 * 1000).stored);
    const deps = {
      getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
      keyringEntryFactoryImpl: keyring.factory,
    };
    expect(readAgyKeyringSnapshot("account-a", deps)).toEqual({ present: true, matchesActive: true });
    expect(
      readAgyKeyringSnapshot("account-a", {
        ...deps,
        getCredentialImpl: () => cred("alice@example.com", ACCESS_A, "other-refresh"),
      }).matchesActive,
    ).toBe(false);
    keyring.set(null);
    expect(readAgyKeyringSnapshot("account-a", deps).present).toBe(false);
  });

  test("orchestrator reports CLI-only success when IDE is not installed", async () => {
    const dir = tempDir("ocx-agy-sync-orch-");
    const keyring = memoryKeyring();
    try {
      const result = await syncAgyAccountTargets("account-a", {
        cliDeps: {
          geminiDirImpl: () => dir,
          getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
          listAccountsImpl: () => [],
          keyringEntryFactoryImpl: keyring.factory,
        },
        ideDeps: {
          platformImpl: () => "linux",
          getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        },
      });
      expect(result.ok).toBe(true);
      expect(result.code).toBe("AGY_SWITCH_CLI_ONLY_NO_IDE");
      expect(result.cli?.status).toBe("synced");
      expect(result.ide?.status).toBe("not_installed");
      expect(JSON.stringify(result).includes(ACCESS_A)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("orchestrator reports CLI failure honestly when CLI sync fails", async () => {
    const keyring = memoryKeyring();
    const result = await syncAgyAccountTargets("missing", {
      cliDeps: { getCredentialImpl: () => null, keyringEntryFactoryImpl: keyring.factory },
      ideDeps: {
        platformImpl: () => "linux",
        getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
      },
    });
    expect(result.ok).toBe(false);
    // IDE not-installed counts as satisfied-with-note, so a lone CLI
    // failure surfaces as CLI_FAILED (not partial): the proxy account is
    // already switched and only the CLI target needs a retry.
    expect(result.code).toBe("AGY_SWITCH_CLI_FAILED");
    expect(result.cli?.status).toBe("failed");
    expect(result.cli?.retryable).toBe(false);
    expect(result.ide?.status).toBe("not_installed");
    expect(result.message).toContain("Proxy account switched");
  });

  test("orchestrator reports partial failure when CLI fails and IDE is pending", async () => {
    const dir = tempDir("ocx-agy-sync-partial-");
    const keyring = memoryKeyring();
    try {
      const app = join(dir, "Antigravity IDE.app");
      writeFileSync(app, "marker");
      const userDir = join(dir, "User", "globalStorage");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "state.vscdb"), "marker");
      const result = await syncAgyAccountTargets("missing", {
        cliDeps: { getCredentialImpl: () => null, keyringEntryFactoryImpl: keyring.factory },
        ideDeps: {
          platformImpl: () => "darwin",
          appPathImpl: () => app,
          dataDirImpl: () => dir,
          isRunningImpl: () => true,
          getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        },
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("AGY_SWITCH_PARTIAL");
      expect(result.cli?.status).toBe("failed");
      expect(result.ide?.status).toBe("pending_restart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy backup read failure leaves the keychain on the previous account", async () => {
    // Finding 2: the backup preflight runs BEFORE the keyring mutation, so a
    // read error reports AGY_CLI_READ_FAILED with native credentials untouched.
    const dir = tempDir("ocx-agy-sync-backup-read-");
    const keyring = memoryKeyring(buildAgyKeyringStoredValue("old-access", "old-refresh", Date.now() + 3600 * 1000).stored);
    try {
      mkdirSync(join(dir, "oauth_creds.json"), { recursive: true });
      const result = await syncAgyCliAccount("account-b", {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("bob@example.com", ACCESS_B, REFRESH_B),
        listAccountsImpl: () => [],
        keyringEntryFactoryImpl: keyring.factory,
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_CLI_READ_FAILED");
      expect(result.retryable).toBe(true);
      expect(parseAgyKeyringStoredValue(keyring.get()!).refresh).toBe("old-refresh");
      expect(JSON.stringify(result).includes(REFRESH_B)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("slow keychain fails fast and a later switch settles on the newest account", async () => {
    // Finding 3: production keyring access is bounded. The first switch hangs
    // in the native store past the timeout and must return quickly; after the
    // late write lands, the next serialized switch wins and verifies.
    const dir = tempDir("ocx-agy-sync-slow-keyring-");
    try {
      let value: string | null = buildAgyKeyringStoredValue("old-access", "old-refresh", Date.now() + 3600 * 1000).stored;
      let delayMs = 0;
      const backend: AgyKeyringAsyncBackend = {
        getPassword: async () => value,
        setPassword: async (_s, _a, pw) => {
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          value = pw;
        },
        deletePassword: async () => {
          value = null;
          return true;
        },
      };
      const creds: Record<string, { access: string; refresh: string; email: string }> = {
        b: { access: ACCESS_B, refresh: REFRESH_B, email: "bob@example.com" },
        a: { access: ACCESS_A, refresh: REFRESH_A, email: "alice@example.com" },
      };
      delayMs = 250;
      const started = Date.now();
      const slow = await syncAgyCliAccount("b", {
        geminiDirImpl: () => dir,
        getCredentialImpl: (_p, id) => cred(creds[id]!.email, creds[id]!.access, creds[id]!.refresh),
        listAccountsImpl: () => [],
        keyringAsyncImpl: backend,
        keyringTimeoutMsImpl: 40,
      });
      const elapsed = Date.now() - started;
      expect(slow.status).toBe("failed");
      expect(slow.code).toBe("AGY_CLI_KEYRING_FAILED");
      expect(elapsed).toBeLessThan(250);

      // Let the late native write land, then switch to A: the newest request
      // must be the verified final state (no stale overwrite, no mixed pair).
      await new Promise(resolve => setTimeout(resolve, 300));
      delayMs = 0;
      const fast = await syncAgyCliAccount("a", {
        geminiDirImpl: () => dir,
        getCredentialImpl: (_p, id) => cred(creds[id]!.email, creds[id]!.access, creds[id]!.refresh),
        listAccountsImpl: () => [],
        keyringAsyncImpl: backend,
        keyringTimeoutMsImpl: 2000,
      });
      expect(fast.status).toBe("synced");
      expect(parseAgyKeyringStoredValue(value!).refresh).toBe(REFRESH_A);
      const accounts = JSON.parse(readFileSync(join(dir, "google_accounts.json"), "utf8"));
      expect(accounts.active).toBe("alice@example.com");
      const snap = await readAgyKeyringSnapshotAsync("a", {
        getCredentialImpl: () => cred("alice@example.com", ACCESS_A, REFRESH_A),
        keyringAsyncImpl: backend,
        keyringTimeoutMsImpl: 2000,
      });
      expect(snap).toEqual({ present: true, matchesActive: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("api-key configured CLI refuses without touching keychain or files", async () => {
    // Finding 6: modelProvider gemini + GEMINI_API_KEY means no OAuth account
    // session — a stale consumer keychain entry must not be overwritten.
    const dir = tempDir("ocx-agy-sync-apikey-");
    const keyring = memoryKeyring(buildAgyKeyringStoredValue("old-access", "old-refresh", Date.now() + 3600 * 1000).stored);
    try {
      mkdirSync(join(dir, "antigravity-cli"), { recursive: true });
      writeFileSync(join(dir, "antigravity-cli", "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
      const deps = {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("bob@example.com", ACCESS_B, REFRESH_B),
        listAccountsImpl: () => [],
        keyringEntryFactoryImpl: keyring.factory,
        envImpl: (name: string) => (name === "GEMINI_API_KEY" ? "fake-api-key" : undefined),
      };
      expect(detectAgyCliAuthMode(deps).kind).toBe("api-key");
      const result = await syncAgyCliAccount("account-b", deps);
      expect(result.status).toBe("unsupported");
      expect(result.code).toBe("AGY_CLI_AUTH_MODE_UNSUPPORTED");
      expect(parseAgyKeyringStoredValue(keyring.get()!).refresh).toBe("old-refresh");
      expect(() => readFileSync(join(dir, "oauth_creds.json"), "utf8")).toThrow();
      expect(JSON.stringify(result).includes(REFRESH_B)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ADC marker refuses without touching keychain or files", async () => {
    const dir = tempDir("ocx-agy-sync-adc-");
    const keyring = memoryKeyring();
    try {
      const deps = {
        geminiDirImpl: () => dir,
        getCredentialImpl: () => cred("bob@example.com", ACCESS_B, REFRESH_B),
        listAccountsImpl: () => [],
        keyringEntryFactoryImpl: keyring.factory,
        envImpl: (name: string) => (name === "GOOGLE_APPLICATION_CREDENTIALS" ? "/fake/adc.json" : undefined),
      };
      expect(detectAgyCliAuthMode(deps).kind).toBe("adc");
      const result = await syncAgyCliAccount("account-b", deps);
      expect(result.status).toBe("unsupported");
      expect(result.code).toBe("AGY_CLI_AUTH_MODE_UNSUPPORTED");
      expect(keyring.get()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("late prior keychain write refuses the next switch instead of reporting false success", async () => {
    // Rework follow-up item 1: B's native set is held past the timeout; C
    // must NOT report synced while B can still land afterwards and
    // overwrite it. C fails closed with AGY_CLI_KEYRING_PENDING; after B
    // settles, retrying C verifies and ends on C.
    const dir = tempDir("ocx-agy-sync-late-write-");
    try {
      let stored = buildAgyKeyringStoredValue("old-access", "old-refresh", Date.now() + 3600 * 1000).stored;
      let releaseB: (() => void) | null = null;
      const backend: AgyKeyringAsyncBackend = {
        getPassword: async () => stored,
        setPassword: async (_s, _a, pw) => {
          if (parseAgyKeyringStoredValue(pw).refresh === REFRESH_B) {
            await new Promise<void>(resolve => {
              releaseB = resolve;
            });
          }
          stored = pw;
        },
        deletePassword: async () => {
          stored = "";
          return true;
        },
      };
      const getCred = (_p: string, id: string) =>
        id === "b"
          ? cred("b@example.com", ACCESS_B, REFRESH_B)
          : cred("c@example.com", "access-fictitious-ccc-333", "refresh-fictitious-ccc-333");
      const first = await syncAgyCliAccount("b", {
        geminiDirImpl: () => dir,
        getCredentialImpl: getCred,
        listAccountsImpl: () => [],
        keyringAsyncImpl: backend,
        keyringTimeoutMsImpl: 20,
      });
      expect(first.status).toBe("failed");
      const second = await syncAgyCliAccount("c", {
        geminiDirImpl: () => dir,
        getCredentialImpl: getCred,
        listAccountsImpl: () => [],
        keyringAsyncImpl: backend,
        keyringTimeoutMsImpl: 20,
      });
      // Fail closed: never a false synced while B is still outstanding.
      expect(second.status).toBe("failed");
      expect(second.code).toBe("AGY_CLI_KEYRING_PENDING");
      expect(second.retryable).toBe(true);
      // Release the stale B write, let it land, then retry C for real.
      releaseB?.();
      await new Promise(resolve => setTimeout(resolve, 50));
      const retry = await syncAgyCliAccount("c", {
        geminiDirImpl: () => dir,
        getCredentialImpl: getCred,
        listAccountsImpl: () => [],
        keyringAsyncImpl: backend,
        keyringTimeoutMsImpl: 2000,
      });
      expect(retry.status).toBe("synced");
      expect(retry.code).toBe("AGY_CLI_SYNCED");
      expect(parseAgyKeyringStoredValue(stored).refresh).toBe("refresh-fictitious-ccc-333");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
