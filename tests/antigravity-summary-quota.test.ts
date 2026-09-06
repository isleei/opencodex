import { afterEach, expect, test } from "bun:test";
import { fetchAntigravityUsageQuota, setAntigravityAccountQuotaTransportForTests } from "../src/providers/quota";

afterEach(() => setAntigravityAccountQuotaTransportForTests(null));

test("subscription summary overrides the all-full model catalog", async () => {
  const urls: string[] = [];
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async url => {
      urls.push(url);
      return Response.json(url.endsWith(":retrieveUserQuotaSummary") ? {
        groups: [{ buckets: [
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9474061, resetTime: "2026-09-11T03:57:29Z" },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 1 },
        ] }, { buckets: [
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.3 },
          { bucketId: "3p-5h", window: "5h", remainingFraction: 0.8 },
        ] }],
      } : { models: { "gemini-a": { quotaInfo: { remainingFraction: 1 } } } });
    },
  });
  const quota = await fetchAntigravityUsageQuota("fixture-token", "fixture-project");
  expect(urls).toEqual(["https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"]);
  expect(quota?.agyQuotaGroups?.[0]?.windows?.[0]?.percent).toBeCloseTo(5.25939, 5);
  expect(quota?.agyQuotaGroups?.[1]?.windows?.[0]?.percent).toBe(70);
});
