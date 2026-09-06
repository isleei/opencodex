import { afterEach, expect, test } from "bun:test";
import { fetchAntigravityUsageQuota, setAntigravityAccountQuotaTransportForTests } from "../src/providers/quota";

function summary(fraction: unknown = 1) {
  return { groups: ["gemini", "3p"].map(id => ({ buckets: ["weekly", "5h"].map(window => ({
    bucketId: `${id}-${window}`, window, remainingFraction: fraction,
  })) })) };
}
function install(body: unknown, status = 200) {
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async () => Response.json(body, { status }),
  });
}
afterEach(() => setAntigravityAccountQuotaTransportForTests(null));

test("genuine summary full and exhausted values are preserved", async () => {
  for (const fraction of [0, 1]) {
    install(summary(fraction));
    const quota = await fetchAntigravityUsageQuota("fixture-token", "fixture-project");
    expect(quota?.agyQuotaGroups?.flatMap(g => g.windows.map(w => w.percent))).toEqual(Array(4).fill((1 - fraction) * 100));
  }
});
test("model catalog, partial summary, malformed and conflicting buckets never prove a full subscription", async () => {
  const partial = summary(); partial.groups.pop();
  const duplicate = summary(); duplicate.groups.push(duplicate.groups[0]!);
  const missing = summary(); missing.groups[0]!.buckets[0]!.remainingFraction = undefined;
  const mismatch = summary(); mismatch.groups[0]!.buckets[0]!.window = "5h";
  for (const body of [null, {}, { models: { "gemini-a": { quotaInfo: { remainingFraction: 1 } } } }, partial, duplicate, mismatch, missing,
    ...[null, true, "bad", -0.1, 1.1].map(summary)]) {
    install(body);
    expect(await fetchAntigravityUsageQuota("fixture-token", "fixture-project")).toBeNull();
  }
});
test("a failed summary cannot fall back to catalog availability", async () => {
  install({ error: "unavailable" }, 503);
  expect(await fetchAntigravityUsageQuota("fixture-token", "fixture-project")).toBeNull();
});
test("routing respects the most consumed subscription window and its actual reset", async () => {
  const body = summary(1);
  Object.assign(body.groups[0]!.buckets[0]!, { remainingFraction: 0, resetTime: "2026-09-11T03:57:29Z" });
  install(body);
  const quota = await fetchAntigravityUsageQuota("fixture-token", "fixture-project");
  expect(quota?.customWindows?.[0]).toEqual({ label: "Gem", percent: 100, resetAt: Date.parse("2026-09-11T03:57:29Z") });
  expect(quota?.agyQuotaGroups?.[0]?.windows[1]?.resetAt).toBeUndefined();
});
