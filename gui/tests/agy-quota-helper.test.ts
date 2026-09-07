import { expect, test } from "bun:test";
import { agyRemaining, formatAgyObservedAt, formatAgyResetAt, resolveAgyQuota } from "../src/lib/agy-quota";

function groups() {
  return ["gemini", "claude-gpt"].map(id => ({ id, windows: [
    { window: "weekly", percent: 5.25939 }, { window: "5h", percent: 0 },
  ] }));
}
test("only complete subscription groups prove remaining quota", () => {
  const state = resolveAgyQuota({ quota: { agyQuotaGroups: groups(), updatedAt: 1788619380000 } });
  expect(state.status).toBe("ok");
  expect(state.buckets).toHaveLength(4);
  expect(agyRemaining(state.buckets[0]!.percent)).toBeCloseTo(94.74061, 5);
  expect(agyRemaining(state.buckets[1]!.percent)).toBe(100);
});
test("legacy full catalog cache never becomes a full subscription", () => {
  expect(resolveAgyQuota({ quota: { agyModels: [{ modelId: "gemini-a", percent: 0 }] } }).status).toBe("unknown");
  expect(resolveAgyQuota({ quota: { customWindows: [{ label: "Gem", percent: 0 }] } }).status).toBe("unknown");
});
test("failed, missing, partial, duplicate or malformed groups show no bars", () => {
  expect(resolveAgyQuota({}).buckets).toEqual([]);
  const failed = resolveAgyQuota({ quotaUnavailable: true, quota: { agyQuotaGroups: groups() } });
  expect(failed.status).toBe("stale"); expect(failed.buckets).toHaveLength(4);
  const partial = groups().slice(0, 1);
  const duplicate = [groups()[0], groups()[0]];
  const malformed = groups(); malformed[0]!.windows[0]!.percent = NaN;
  for (const g of [partial, duplicate, malformed]) expect(resolveAgyQuota({ quota: { agyQuotaGroups: g } }).status).toBe("unknown");
});
test("real 0/100 and unknown dates remain distinct", () => {
  expect(agyRemaining(0)).toBe(100); expect(agyRemaining(100)).toBe(0);
  for (const value of [undefined, null, NaN, -1, 101]) expect(agyRemaining(value)).toBeNull();
  expect(formatAgyObservedAt(undefined)).toBeNull();
  expect(formatAgyResetAt(undefined)).toBeNull();
  expect(formatAgyResetAt(Date.parse("2020-01-01"))).toContain("2020");
});
