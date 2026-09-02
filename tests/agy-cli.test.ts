import { describe, expect, test } from "bun:test";
import {
  AGY_INSTALL_HINT,
  AGY_USAGE,
  cmdAgy,
  ensureProxyForAgy,
  matchAntigravityAccount,
  promptAccountSelection,
  resolveAgyBinary,
} from "../src/cli/agy";
import type { AccountRow } from "../src/cli/account-api";
import { PassThrough } from "node:stream";

describe("Antigravity CLI (ocx agy) unit and integration tests", () => {
  const sampleAccounts: AccountRow[] = [
    {
      provider: "google-antigravity",
      type: "oauth",
      id: "e059dc2612345678",
      label: "v***0@example.com",
      email: "v***0@example.com",
      active: false,
    },
    {
      provider: "google-antigravity",
      type: "oauth",
      id: "8d76ae932b8f15dcc549dc769d3c62f2",
      label: "s***y@example.com",
      email: "s***y@example.com",
      active: false,
    },
    {
      provider: "google-antigravity",
      type: "oauth",
      id: "dfcbb3cdd8678394f8ccc93c48298594",
      label: "s***i@example.com",
      email: "s***i@example.com",
      active: false,
    },
    {
      provider: "google-antigravity",
      type: "oauth",
      id: "bcb7e633577295bad2b61345c7e24222",
      label: "s***y@example.com",
      email: "s***y@example.com",
      active: true,
    },
  ];

  test("1. matchAntigravityAccount matches accounts by index, ID, prefix, and email", () => {
    // 1-based index
    expect(matchAntigravityAccount(sampleAccounts, "1")?.id).toBe("e059dc2612345678");
    expect(matchAntigravityAccount(sampleAccounts, "4")?.id).toBe("bcb7e633577295bad2b61345c7e24222");
    expect(matchAntigravityAccount(sampleAccounts, "0")).toBeNull();
    expect(matchAntigravityAccount(sampleAccounts, "5")).toBeNull();

    // Exact ID
    expect(matchAntigravityAccount(sampleAccounts, "e059dc2612345678")?.email).toBe("v***0@example.com");

    // Prefix match (>= 4 chars)
    expect(matchAntigravityAccount(sampleAccounts, "e059")?.email).toBe("v***0@example.com");
    expect(matchAntigravityAccount(sampleAccounts, "dfcb")?.email).toBe("s***i@example.com");

    // Email match
    expect(matchAntigravityAccount(sampleAccounts, "v***0")?.id).toBe("e059dc2612345678");
    expect(matchAntigravityAccount(sampleAccounts, "s***i")?.id).toBe("dfcbb3cdd8678394f8ccc93c48298594");

    // Non-existent
    expect(matchAntigravityAccount(sampleAccounts, "nonexistent")).toBeNull();
    expect(matchAntigravityAccount([], "1")).toBeNull();
  });

  test("2. promptAccountSelection returns default active account on empty input (Enter)", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;

    // Send empty newline (Enter key)
    setTimeout(() => {
      (stdin as unknown as PassThrough).emit("data", "\n");
    }, 10);

    const chosen = await promptAccountSelection(sampleAccounts, "bcb7e633577295bad2b61345c7e24222", {
      stdinImpl: stdin,
      stdoutImpl: stdout,
    });

    expect(chosen).not.toBeNull();
    expect(chosen?.id).toBe("bcb7e633577295bad2b61345c7e24222");
  });

  test("3. promptAccountSelection returns selected account when index is typed", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;

    // Send "1\n"
    setTimeout(() => {
      (stdin as unknown as PassThrough).emit("data", "1\n");
    }, 10);

    const chosen = await promptAccountSelection(sampleAccounts, "bcb7e633577295bad2b61345c7e24222", {
      stdinImpl: stdin,
      stdoutImpl: stdout,
    });

    expect(chosen).not.toBeNull();
    expect(chosen?.id).toBe("e059dc2612345678");
  });

  test("4. promptAccountSelection handles invalid input by falling back to default active", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;

    // Send "99\n"
    setTimeout(() => {
      (stdin as unknown as PassThrough).emit("data", "99\n");
    }, 10);

    const chosen = await promptAccountSelection(sampleAccounts, "bcb7e633577295bad2b61345c7e24222", {
      stdinImpl: stdin,
      stdoutImpl: stdout,
    });

    expect(chosen?.id).toBe("bcb7e633577295bad2b61345c7e24222");
  });

  test("5. cmdAgy prints usage on --help or -h", async () => {
    let output = "";
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += msg + "\n";
    };

    try {
      const code = await cmdAgy(["--help"]);
      expect(code).toBe(0);
      expect(output).toContain("Usage:");
      expect(output).toContain("ocx agy");
    } finally {
      console.log = originalLog;
    }
  });

  test("6. cmdAgy accounts / list returns accounts list", async () => {
    let output = "";
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += msg + "\n";
    };

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/oauth/accounts")) {
        return new Response(
          JSON.stringify({
            accounts: sampleAccounts,
            activeAccountId: "bcb7e633577295bad2b61345c7e24222",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    try {
      const code = await cmdAgy(["accounts", "--json"], {
        baseUrl: "http://127.0.0.1:10100",
        fetchImpl: mockFetch as typeof fetch,
        findLiveProxyImpl: async () => ({ port: 10100, hostname: "127.0.0.1", pid: 1 }),
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(true);
      expect(parsed.accounts.length).toBe(4);
      expect(parsed.activeId).toBe("bcb7e633577295bad2b61345c7e24222");
    } finally {
      console.log = originalLog;
    }
  });

  test("7. cmdAgy use switches active account", async () => {
    let switchedTo = "";
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/oauth/accounts/active") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        switchedTo = body.accountId;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes("/api/oauth/accounts")) {
        return new Response(
          JSON.stringify({
            accounts: sampleAccounts,
            activeAccountId: "bcb7e633577295bad2b61345c7e24222",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const code = await cmdAgy(["use", "1", "--json"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: mockFetch as typeof fetch,
      findLiveProxyImpl: async () => ({ port: 10100, hostname: "127.0.0.1", pid: 1 }),
    });

    expect(code).toBe(0);
    expect(switchedTo).toBe("e059dc2612345678");
  });

  test("8. cmdAgy with --account switches account and launches binary", async () => {
    let switchedTo = "";
    let spawnedCmd = "";
    let spawnedArgs: string[] = [];

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/oauth/accounts/active") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        switchedTo = body.accountId;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes("/api/oauth/accounts")) {
        return new Response(
          JSON.stringify({
            accounts: sampleAccounts,
            activeAccountId: "bcb7e633577295bad2b61345c7e24222",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const mockSpawn = (file: string, args: readonly string[]) => {
      spawnedCmd = file;
      spawnedArgs = [...args];
      return {
        on: (event: string, cb: (code?: number) => void) => {
          if (event === "exit") cb(0);
        },
      } as any;
    };

    const code = await cmdAgy(["--account", "e059dc2612345678", "/goal", "test"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: mockFetch as typeof fetch,
      findBinaryImpl: () => "/fake/path/agy",
      spawnImpl: mockSpawn as any,
      findLiveProxyImpl: async () => ({ port: 10100, hostname: "127.0.0.1", pid: 1 }),
    });

    expect(code).toBe(0);
    expect(switchedTo).toBe("e059dc2612345678");
    expect(spawnedCmd).toBe("/fake/path/agy");
    expect(spawnedArgs).toEqual(["/goal", "test"]);
  });

  test("9. cmdAgy returns 1 with install hint when binary is missing", async () => {
    let errOutput = "";
    const originalErr = console.error;
    console.error = (msg: string) => {
      errOutput += msg + "\n";
    };

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          accounts: sampleAccounts,
          activeAccountId: "bcb7e633577295bad2b61345c7e24222",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const code = await cmdAgy(["--no-select"], {
        baseUrl: "http://127.0.0.1:10100",
        fetchImpl: mockFetch as typeof fetch,
        findBinaryImpl: () => null,
        findLiveProxyImpl: async () => ({ port: 10100, hostname: "127.0.0.1", pid: 1 }),
      });
      expect(code).toBe(1);
      expect(errOutput).toContain("`agy` CLI not found");
    } finally {
      console.error = originalErr;
    }
  });

  test("10. syncAntigravityCredentialsToGemini writes oauth_creds.json and google_accounts.json", async () => {
    const { syncAntigravityCredentialsToGemini } = await import("../src/cli/agy");
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tempGeminiDir = mkdtempSync(join(tmpdir(), "ocx-gemini-test-"));
    try {
      const res = await syncAntigravityCredentialsToGemini("e059dc26", {
        geminiDirImpl: () => tempGeminiDir,
        getCredentialImpl: () => ({
          access: "mock_access_token_123",
          refresh: "mock_refresh_token_456",
          expires: Date.now() + 3600 * 1000,
          email: "villanitaicebot0@example.com",
          idToken: "mock_id_token",
        }),
      });
      expect(res.success).toBe(true);

      const creds = JSON.parse(readFileSync(join(tempGeminiDir, "oauth_creds.json"), "utf8"));
      expect(creds.access_token).toBeDefined();
      expect(creds.token_type).toBe("Bearer");

      const accs = JSON.parse(readFileSync(join(tempGeminiDir, "google_accounts.json"), "utf8"));
      expect(accs.active).toBe("villanitaicebot0@example.com");
    } finally {
      rmSync(tempGeminiDir, { recursive: true, force: true });
    }
  });
});
