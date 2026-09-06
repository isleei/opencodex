import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_IDE_OAUTH_KEY,
  createIdeTopicValueForTests,
  decodeIdeTopicValueForTests,
  defaultIdeDataDir,
  defaultLegacyIdeDataDir,
  probeAntigravityIde,
  syncAntigravityIdeAccount,
  verifyAntigravityIdeActivation,
} from "../src/clients/antigravity-ide-account-sync";
import type { OAuthCredentials } from "../src/oauth/types";

const ACCESS_A = "access-fictitious-ide-aaa-111";
const REFRESH_A = "refresh-fictitious-ide-aaa-111";
const ACCESS_B = "access-fictitious-ide-bbb-222";
const REFRESH_B = "refresh-fictitious-ide-bbb-222";

const AUTH_STATE_JSON = JSON.stringify({
  state: "signedIn",
  context: { project: "", showProjectError: false, errorMessage: "" },
});

function cred(email: string, access: string, refresh: string, expires = Date.now() + 3600 * 1000): OAuthCredentials {
  return { access, refresh, expires, email };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeVscdb(path: string, oauthB64: string, extraRows: Array<[string, string]> = []): void {
  const db = new Database(path);
  db.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);");
  const insert = db.query("INSERT INTO ItemTable(key, value) VALUES (?, ?)");
  const txn = db.transaction(() => {
    insert.run(AGY_IDE_OAUTH_KEY, oauthB64);
    for (const [k, v] of extraRows) insert.run(k, v);
  });
  txn();
  db.close();
}

function readRow(path: string, key: string): string | null {
  const db = new Database(path, true);
  try {
    const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value?: unknown } | null;
    return typeof row?.value === "string" ? row.value : null;
  } finally {
    db.close();
  }
}

function fixtureB64(
  access: string,
  refresh: string,
  extra: Array<{ key: string; value: string }> = [{ key: "authStateWithContextSentinelKey", value: AUTH_STATE_JSON }],
): string {
  return createIdeTopicValueForTests(
    { access, refresh, tokenType: "Bearer", expirySeconds: 1_700_000_000 },
    extra,
  );
}

describe("antigravity IDE account sync", () => {
  test("non-macOS probes as not installed, never synced", async () => {
    const probe = probeAntigravityIde({ platformImpl: () => "linux" });
    expect(probe.installed).toBe(false);
    const result = await syncAntigravityIdeAccount("any", {
      platformImpl: () => "linux",
      getCredentialImpl: () => cred("a@example.com", ACCESS_A, REFRESH_A),
    });
    expect(result.target).toBe("ide");
    expect(result.status).toBe("not_installed");
    expect(result.retryable).toBe(false);
    expect(JSON.stringify(result).includes("refresh_token")).toBe(false);
  });

  test("default data dir disambiguates the IDE product from the legacy directory", () => {
    expect(defaultIdeDataDir().endsWith("Antigravity IDE")).toBe(true);
    expect(defaultLegacyIdeDataDir().endsWith("Antigravity IDE")).toBe(false);
    expect(defaultIdeDataDir()).not.toBe(defaultLegacyIdeDataDir());
  });

  test("production write swaps the token, preserves siblings, backs up, and verifies", async () => {
    const dir = tempDir("ocx-agy-ide-write-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A), [
        ["workbench.settings", JSON.stringify({ theme: "dark" })],
        ["chat.history", JSON.stringify([{ id: 1, text: "hello" }])],
      ]);
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("pending_restart");
      expect(result.code).toBe("AGY_IDE_PENDING_RESTART");
      expect(result.retryable).toBe(true);

      const decoded = decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!);
      expect(decoded.token.access).toBe(ACCESS_B);
      expect(decoded.token.refresh).toBe(REFRESH_B);
      // Sibling auth state preserved byte-identically; unrelated rows intact.
      expect(decoded.entries["authStateWithContextSentinelKey"]).toBe(AUTH_STATE_JSON);
      expect(readRow(dbPath, "workbench.settings")).toBe(JSON.stringify({ theme: "dark" }));
      expect(readRow(dbPath, "chat.history")).toBe(JSON.stringify([{ id: 1, text: "hello" }]));
      // Backup holds the previous account.
      expect(existsSync(`${dbPath}.ocx-bak`)).toBe(true);
      const backup = decodeIdeTopicValueForTests(readRow(`${dbPath}.ocx-bak`, AGY_IDE_OAUTH_KEY)!);
      expect(backup.token.refresh).toBe(REFRESH_A);
      expect(JSON.stringify(result).includes(REFRESH_B)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retrying the same account after divergence restores the selected token", async () => {
    const dir = tempDir("ocx-agy-ide-retry-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_B, REFRESH_B));
      const deps = {
        vscdbPath: dbPath,
        platformImpl: () => "darwin" as NodeJS.Platform,
        isRunningImpl: () => false as boolean | null,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      };
      expect((await syncAntigravityIdeAccount("account-b", deps)).status).toBe("pending_restart");
      // Diverge behind the sync's back, then re-request the same account.
      makeVscdb(join(dir, "diverged.vscdb"), fixtureB64("other-access", "other-refresh"));
      const diverged = readRow(join(dir, "diverged.vscdb"), AGY_IDE_OAUTH_KEY)!;
      const db = new Database(dbPath);
      db.query("UPDATE ItemTable SET value = ? WHERE key = ?").run(diverged, AGY_IDE_OAUTH_KEY);
      db.close();
      expect(decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!).token.refresh).toBe("other-refresh");
      expect((await syncAntigravityIdeAccount("account-b", deps)).status).toBe("pending_restart");
      expect(decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!).token.refresh).toBe(REFRESH_B);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("running IDE yields pending_restart and leaves files untouched", async () => {
    const dir = tempDir("ocx-agy-ide-running-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A));
      const before = readFileSync(dbPath);
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => true,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("pending_restart");
      expect(result.code).toBe("AGY_IDE_PENDING_RESTART");
      expect(result.retryable).toBe(true);
      expect(readFileSync(dbPath).equals(before)).toBe(true);
      expect(decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!).token.refresh).toBe(REFRESH_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy product database is never touched", async () => {
    const dir = tempDir("ocx-agy-ide-legacy-");
    try {
      const legacyDb = join(dir, "state.vscdb");
      makeVscdb(legacyDb, fixtureB64(ACCESS_A, REFRESH_A));
      const before = statSync(legacyDb).mtimeMs;
      const result = await syncAntigravityIdeAccount("account-b", {
        platformImpl: () => "darwin",
        appPathImpl: () => join(dir, "NoSuchApp.app"),
        dataDirImpl: () => dir,
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      // state.vscdb is not at <dataDir>/User/globalStorage/state.vscdb, so
      // this reads as installed-without-database; either way it must never
      // report synced from the legacy file.
      expect(["unsupported", "unknown", "not_installed"]).toContain(result.status);
      expect(result.status).not.toBe("synced");
      expect(statSync(legacyDb).mtimeMs).toBe(before);
      expect(decodeIdeTopicValueForTests(readRow(legacyDb, AGY_IDE_OAUTH_KEY)!).token.refresh).toBe(REFRESH_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt existing token state refuses the write instead of guessing", async () => {
    const dir = tempDir("ocx-agy-ide-corrupt-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, "!!!not-base64!!!");
      const before = readFileSync(dbPath);
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_IDE_STATE_CORRUPT");
      expect(readFileSync(dbPath).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing credential and failed refresh never touch the database", async () => {
    const dir = tempDir("ocx-agy-ide-nocred-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A));
      const before = readFileSync(dbPath);
      expect(
        (
          await syncAntigravityIdeAccount("missing", {
            vscdbPath: dbPath,
            platformImpl: () => "darwin",
            isRunningImpl: () => false,
            getCredentialImpl: () => null,
          })
        ).code,
      ).toBe("AGY_IDE_CREDENTIAL_MISSING");
      expect(
        (
          await syncAntigravityIdeAccount("account-a", {
            vscdbPath: dbPath,
            platformImpl: () => "darwin",
            isRunningImpl: () => false,
            getCredentialImpl: () => cred("a@example.com", "stale", "bad-refresh", Date.now() - 1000),
            refreshImpl: async () => {
              throw new Error("upstream rejected");
            },
          })
        ).code,
      ).toBe("AGY_IDE_REFRESH_FAILED");
      expect(readFileSync(dbPath).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("database without ItemTable is rejected", async () => {
    const dir = tempDir("ocx-agy-ide-schema-");
    try {
      const dbPath = join(dir, "state.vscdb");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE OtherTable(key TEXT PRIMARY KEY, value TEXT);");
      db.close();
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_IDE_DB_UNEXPECTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing database file reports failure", async () => {
    const result = await syncAntigravityIdeAccount("account-b", {
      vscdbPath: join(tempDir("ocx-agy-ide-missing-"), "state.vscdb"),
      platformImpl: () => "darwin",
      isRunningImpl: () => false,
      getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("AGY_IDE_DB_MISSING");
  });

  test("unknown liveness without confirmation never writes", async () => {
    const dir = tempDir("ocx-agy-ide-unknown-");
    try {
      const userDir = join(dir, "User", "globalStorage");
      mkdirSync(userDir, { recursive: true });
      const dbPath = join(userDir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A));
      writeFileSync(join(dir, "placeholder.txt"), "x");
      const before = readFileSync(dbPath);
      const result = await syncAntigravityIdeAccount("account-b", {
        platformImpl: () => "darwin",
        appPathImpl: () => join(dir, "Antigravity IDE.app"),
        dataDirImpl: () => dir,
        isRunningImpl: () => null,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("unknown");
      expect(result.retryable).toBe(true);
      expect(readFileSync(dbPath).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entry order does not matter: production-style auth-first topics sync too", async () => {
    const dir = tempDir("ocx-agy-ide-order-");
    try {
      // Production databases store the auth entry BEFORE the oauth entry;
      // the reader must not stop at the first oauth hit.
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(
        dbPath,
        createIdeTopicValueForTests(
          { access: ACCESS_A, refresh: REFRESH_A, tokenType: "Bearer", expirySeconds: 1_700_000_000 },
          [{ key: "authStateWithContextSentinelKey", value: AUTH_STATE_JSON }],
          { authFirst: true },
        ),
        [["workbench.settings", JSON.stringify({ theme: "dark" })]],
      );
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("pending_restart");
      const decoded = decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!);
      expect(decoded.token.refresh).toBe(REFRESH_B);
      expect(decoded.entries["authStateWithContextSentinelKey"]).toBe(AUTH_STATE_JSON);
      expect(readRow(dbPath, "workbench.settings")).toBe(JSON.stringify({ theme: "dark" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing oauth row is created from scratch without touching siblings", async () => {
    const dir = tempDir("ocx-agy-ide-norow-");
    try {
      const dbPath = join(dir, "state.vscdb");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);");
      db.query("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run("workbench.settings", "{}");
      db.close();
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("pending_restart");
      expect(decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!).token.refresh).toBe(REFRESH_B);
      expect(readRow(dbPath, "workbench.settings")).toBe("{}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent switches serialize to one consistent token", async () => {
    const dir = tempDir("ocx-agy-ide-race-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A), [
        ["workbench.settings", JSON.stringify({ theme: "dark" })],
      ]);
      const mk = (access: string, refresh: string, email: string) => ({
        vscdbPath: dbPath,
        platformImpl: () => "darwin" as NodeJS.Platform,
        isRunningImpl: () => false as boolean | null,
        getCredentialImpl: () => cred(email, access, refresh),
      });
      const [ra, rb] = await Promise.all([
        syncAntigravityIdeAccount("a", mk(ACCESS_A, REFRESH_A, "a@example.com")),
        syncAntigravityIdeAccount("b", mk(ACCESS_B, REFRESH_B, "b@example.com")),
      ]);
      expect(ra.status).toBe("pending_restart");
      expect(rb.status).toBe("pending_restart");
      const decoded = decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!);
      const pair =
        (decoded.token.refresh === REFRESH_A && decoded.token.access === ACCESS_A) ||
        (decoded.token.refresh === REFRESH_B && decoded.token.access === ACCESS_B);
      expect(pair).toBe(true);
      expect(readRow(dbPath, "workbench.settings")).toBe(JSON.stringify({ theme: "dark" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transaction failure keeps committed WAL history and never restores a stale copy", async () => {
    // Finding 1: a trigger-aborted write must roll back via the transaction.
    // Copying a main-file-only backup back would discard history committed
    // in WAL before the switch.
    const dir = tempDir("ocx-agy-ide-wal-");
    try {
      const dbPath = join(dir, "state.vscdb");
      const holder = new Database(dbPath);
      holder.exec("PRAGMA journal_mode=WAL;");
      holder.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);");
      holder.query("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run(AGY_IDE_OAUTH_KEY, fixtureB64(ACCESS_A, REFRESH_A));
      holder.exec("PRAGMA wal_autocheckpoint=0;");
      holder.query("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run("chat.history.latest", "committed-user-history");
      holder.exec(
        "CREATE TRIGGER simulate_write_failure BEFORE INSERT ON ItemTable BEGIN SELECT RAISE(ABORT,'simulated write failure'); END",
      );
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("AGY_IDE_DB_ERROR");
      expect(result.message).not.toMatch(/restored/i);
      const history = holder.query("SELECT value FROM ItemTable WHERE key = 'chat.history.latest'").get() as {
        value?: unknown;
      } | null;
      expect(history?.value).toBe("committed-user-history");
      holder.close();
      // After every connection closes, the history survives in the live DB
      // and the oauth row still holds A (rollback, no restore-overwrite).
      expect(readRow(dbPath, "chat.history.latest")).toBe("committed-user-history");
      expect(decodeIdeTopicValueForTests(readRow(dbPath, AGY_IDE_OAUTH_KEY)!).token.refresh).toBe(REFRESH_A);
      expect(JSON.stringify(result).includes(REFRESH_B)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enterprise/business mode flags refuse the write and stay untouched", async () => {
    // Cockpit/native finding: field 6 is_gcp_tos / field 7
    // enable_business_login describe the PREVIOUS account. A cross-account
    // write must not carry them over; an enterprise-stored account refuses.
    const dir = tempDir("ocx-agy-ide-enterprise-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(
        dbPath,
        createIdeTopicValueForTests(
          { access: ACCESS_A, refresh: REFRESH_A, tokenType: "Bearer", expirySeconds: 1_700_000_000 },
          [{ key: "authStateWithContextSentinelKey", value: AUTH_STATE_JSON }],
          { tokenFlags: { isGcpTos: true } },
        ),
        [["chat.history", "keep-me"]],
      );
      const before = readFileSync(dbPath);
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin",
        isRunningImpl: () => false,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("unsupported");
      expect(result.code).toBe("AGY_IDE_ENTERPRISE_UNSUPPORTED");
      expect(result.retryable).toBe(false);
      expect(readFileSync(dbPath).equals(before)).toBe(true);
      expect(readRow(dbPath, "chat.history")).toBe("keep-me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("activation stays pending until restart plus confirmation, fails on mismatch", async () => {
    // Finding 4: a disk write is persisted, not activated. States: pending
    // before restart, synced only after the IDE is quiet AND the operator
    // confirms the IDE shows the account, failed when the store diverges.
    const dir = tempDir("ocx-agy-ide-activation-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A));
      const deps = {
        vscdbPath: dbPath,
        platformImpl: () => "darwin" as NodeJS.Platform,
        isRunningImpl: () => false as boolean | null,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      };
      const written = await syncAntigravityIdeAccount("account-b", deps);
      expect(written.status).toBe("pending_restart");
      expect(written.code).toBe("AGY_IDE_PENDING_RESTART");

      // Disk matches but no manual confirmation yet: still pending.
      const unconfirmed = verifyAntigravityIdeActivation("account-b", deps);
      expect(unconfirmed.status).toBe("pending_restart");

      // IDE running (stale in-memory state): pending even with confirmation.
      const whileRunning = verifyAntigravityIdeActivation("account-b", {
        ...deps,
        isRunningImpl: () => true,
        activationConfirmedImpl: () => true,
      });
      expect(whileRunning.status).toBe("pending_restart");

      // Quiet IDE + operator-confirmed account UI: activated.
      const activated = verifyAntigravityIdeActivation("account-b", {
        ...deps,
        activationConfirmedImpl: () => true,
      });
      expect(activated.status).toBe("synced");
      expect(activated.code).toBe("AGY_IDE_ACTIVATED");

      // Store diverged behind the check: failed with retry.
      const diverged = new Database(dbPath);
      diverged.query("UPDATE ItemTable SET value = ? WHERE key = ?").run(fixtureB64("other-access", "other-refresh"), AGY_IDE_OAUTH_KEY);
      diverged.close();
      const mismatch = verifyAntigravityIdeActivation("account-b", {
        ...deps,
        activationConfirmedImpl: () => true,
      });
      expect(mismatch.status).toBe("failed");
      expect(mismatch.code).toBe("AGY_IDE_ACTIVATION_MISMATCH");
      expect(mismatch.retryable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovery snapshot is owner-only, WAL-aware, and leaves no staging file", async () => {
    // Rework follow-up item 2: the credential-bearing backup must be
    // owner-only from creation (umask 077, not chmod-after-world-readable)
    // and the prior snapshot must survive until the new one succeeds.
    const dir = tempDir("ocx-agy-ide-backup-perms-");
    try {
      const dbPath = join(dir, "state.vscdb");
      makeVscdb(dbPath, fixtureB64(ACCESS_A, REFRESH_A), [["chat.history", "keep-me"]]);
      const result = await syncAntigravityIdeAccount("account-b", {
        vscdbPath: dbPath,
        platformImpl: () => "darwin" as NodeJS.Platform,
        isRunningImpl: () => false as boolean | null,
        getCredentialImpl: () => cred("b@example.com", ACCESS_B, REFRESH_B),
      });
      expect(result.status).toBe("pending_restart");
      const backupPath = `${dbPath}.ocx-bak`;
      expect(existsSync(backupPath)).toBe(true);
      const mode = statSync(backupPath).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(existsSync(`${dbPath}.ocx-bak.new`)).toBe(false);
      // Prior snapshot decodes and still holds the previous account.
      const backup = decodeIdeTopicValueForTests(readRow(backupPath, AGY_IDE_OAUTH_KEY)!);
      expect(backup.token.refresh).toBe(REFRESH_A);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
