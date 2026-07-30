import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import {
  clearRequestLogsForTests,
  getRequestLogEntries,
} from "../src/server/request-log";
import { resetUsageReadCacheForTests, usageLogPath } from "../src/usage/log";
import { readFileSync, existsSync } from "node:fs";
import type { OcxConfig } from "../src/types";

const config = { providers: [] } as unknown as OcxConfig;

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-ingest-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  clearRequestLogsForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  clearRequestLogsForTests();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

async function ingest(body: unknown): Promise<Response> {
  const url = new URL("http://localhost/api/usage/ingest");
  const req = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Management origin check requires a loopback Host (see isAllowedManagementOrigin).
      host: "localhost",
    },
    body: JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, url, config);
  expect(response).not.toBeNull();
  return response!;
}

describe("POST /api/usage/ingest", () => {
  test("accepts a batch, persists usage.jsonl, and fills live Logs", async () => {
    const res = await ingest({
      entries: [
        {
          requestId: "grok-native-test-1",
          timestamp: 1_700_000_000_000,
          provider: "xai-native",
          model: "grok-4.5-build",
          surface: "grok",
          status: 200,
          durationMs: 1200,
          usageStatus: "reported",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 50,
            cacheReadInputTokens: 50,
            reasoningOutputTokens: 5,
          },
          totalTokens: 120,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      accepted: number;
      requestIds: string[];
    };
    expect(body.accepted).toBe(1);
    expect(body.requestIds).toEqual(["grok-native-test-1"]);

    const logs = getRequestLogEntries();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.requestId).toBe("grok-native-test-1");
    expect(logs[0]!.surface).toBe("grok");
    expect(logs[0]!.totalTokens).toBe(120);

    expect(existsSync(usageLogPath())).toBe(true);
    const line = readFileSync(usageLogPath(), "utf8").trim().split("\n").at(-1)!;
    const persisted = JSON.parse(line) as { requestId: string; surface?: string };
    expect(persisted.requestId).toBe("grok-native-test-1");
    expect(persisted.surface).toBe("grok");
  });

  test("skips duplicate requestIds already in the live Logs buffer", async () => {
    const entry = {
      requestId: "grok-native-dup",
      provider: "xai-native",
      model: "grok-4.5-build",
      surface: "grok",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      totalTokens: 2,
    };
    expect((await ingest({ entries: [entry] })).status).toBe(200);
    const second = await ingest({ entries: [entry] });
    expect(second.status).toBe(200);
    const body = await second.json() as { accepted: number; skipped: number; skippedIds: string[] };
    expect(body.accepted).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.skippedIds).toEqual(["grok-native-dup"]);
    expect(getRequestLogEntries()).toHaveLength(1);
  });

  test("rejects invalid usage payloads", async () => {
    const res = await ingest({
      entries: [{ requestId: "x", provider: "p", model: "m", usage: { inputTokens: -1, outputTokens: 1 } }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { accepted: number; rejected: number };
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
  });
});
