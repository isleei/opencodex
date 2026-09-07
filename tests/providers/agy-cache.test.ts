import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { clearAccountQuotaCache, fetchProviderAccountQuotas, readAgyAccountQuotas, sweepExpiredProviderAccountQuotaRows, setAntigravityAccountQuotaTransportForTests } from "../../src/providers/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const priorHome = process.env.OPENCODEX_HOME;
let home: string;
let accountId: string;
const summary = { groups: ["gemini", "3p"].map(id => ({ buckets: ["weekly", "5h"].map(window => ({ bucketId: `${id}-${window}`, window, remainingFraction: 0.75 })) })) };
const savedQuota = (updatedAt: number) => ({ updatedAt, agyQuotaGroups: ["gemini", "claude-gpt"].map(id => ({ id, windows: ["weekly", "5h"].map(window => ({ window, percent: 25 })) })) });
function transport(post: () => Promise<Response>) {
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: post,
  });
}
function disk(updatedAt: number) {
  writeFileSync(join(home, "provider-account-quota-cache.json"), JSON.stringify({ version: 1, rows: { [`google-antigravity\0${accountId}`]: savedQuota(updatedAt) } }));
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agy-cache-")); process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  await saveCredential("google-antigravity", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000, projectId: "fixture-project", email: "fixture@example.com" });
  accountId = getAccountSet("google-antigravity")!.activeAccountId;
});
afterEach(() => {
  clearAccountQuotaCache(); setAntigravityAccountQuotaTransportForTests(null);
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});

test("successful AGY probes persist and a new process reuses the snapshot without network", async () => {
  transport(async () => Response.json(summary));
  await fetchProviderAccountQuotas("google-antigravity");
  await Bun.sleep(350);
  const raw = readFileSync(join(home, "provider-account-quota-cache.json"), "utf8");
  expect(raw).not.toContain("fixture-access"); expect(raw).not.toContain("fixture@example.com");
  const module = new URL("../../src/providers/quota.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `import {readAgyAccountQuotas} from ${JSON.stringify(module)}; globalThis.fetch = async()=>{throw new Error('network forbidden')}; console.log(JSON.stringify(readAgyAccountQuotas()));`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(result[0].quota.agyQuotaGroups[0].windows[0].percent).toBe(25);
  expect(result[0].stale).toBeUndefined(); expect(result[0].refreshing).toBeUndefined();
});

test("stale snapshot returns immediately, shares one refresh, and preserves time on failure", async () => {
  const observed = Date.now() - 11 * 60000; disk(observed);
  let finish!: (r: Response) => void; let calls = 0;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  transport(async () => { calls++; return pending; });
  const first = readAgyAccountQuotas()[0]!;
  expect(first.quota?.updatedAt).toBe(observed); expect(first.stale).toBe(true); expect(first.refreshing).toBe(true);
  expect(sweepExpiredProviderAccountQuotaRows()).toBe(0);
  readAgyAccountQuotas();
  const refresh = fetchProviderAccountQuotas("google-antigravity");
  await Bun.sleep(0); expect(calls).toBe(1);
  finish(Response.json({}, { status: 503 })); await refresh;
  const failed = readAgyAccountQuotas()[0]!;
  expect(failed.quota?.updatedAt).toBe(observed); expect(failed.unavailable).toBe(true); expect(failed.stale).toBe(true); expect(failed.refreshing).toBeUndefined();
});

test("cold cache returns loading without invented quota and publishes success", async () => {
  transport(async () => Response.json(summary));
  const first = readAgyAccountQuotas()[0]!;
  expect(first.quota).toBeNull(); expect(first.refreshing).toBe(true);
  await fetchProviderAccountQuotas("google-antigravity");
  expect(readAgyAccountQuotas()[0]!.quota?.agyQuotaGroups).toHaveLength(2);
});


test("invalidating an in-flight probe prevents it from resurrecting memory or disk", async () => {
  let finish!: (r: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  transport(async () => pending);
  const flight = fetchProviderAccountQuotas("google-antigravity");
  await Bun.sleep(0);
  clearAccountQuotaCache("google-antigravity");
  finish(Response.json(summary)); await flight;
  await Bun.sleep(350);
  const persisted = JSON.parse(readFileSync(join(home, "provider-account-quota-cache.json"), "utf8"));
  expect(persisted.rows).toEqual({});
});
