/** Only explicit subscription summaries prove weekly / five-hour allowance.
 * Old model-catalog caches can be full while a subscription window is spent. */
export interface AgyQuotaBucket {
  bucketId: string;
  group: "gemini" | "claude-gpt";
  window: "weekly" | "5h";
  percent: number;
  resetAt?: number;
}

export interface AgyQuotaState {
  status: "ok" | "stale" | "unknown" | "unavailable";
  buckets: AgyQuotaBucket[];
  updatedAt?: number;
}

export function agyRemaining(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? 100 - value : null;
}

export function resolveAgyQuota(account: {
  quota?: { agyQuotaGroups?: unknown; agyModels?: unknown; customWindows?: unknown; updatedAt?: unknown } | null;
  quotaUnavailable?: boolean;
  quotaStale?: boolean;
}): AgyQuotaState {
  const observed = account.quota?.updatedAt;
  const updatedAt = typeof observed === "number" && Number.isFinite(observed) && observed > 0 ? observed : undefined;
  const empty: AgyQuotaState = { status: account.quotaUnavailable ? "unavailable" : "unknown", buckets: [], ...(updatedAt ? { updatedAt } : {}) };
  if (!Array.isArray(account.quota?.agyQuotaGroups)) return empty;
  const buckets: AgyQuotaBucket[] = [];
  for (const group of account.quota.agyQuotaGroups) {
    if (!group || (group.id !== "gemini" && group.id !== "claude-gpt") || !Array.isArray(group.windows)) return empty;
    for (const row of group.windows) {
      if (!row || (row.window !== "weekly" && row.window !== "5h") || agyRemaining(row.percent) === null) return empty;
      const bucketId = `${group.id}:${row.window}`;
      if (buckets.some(b => b.bucketId === bucketId)) return empty;
      buckets.push({ bucketId, group: group.id, window: row.window, percent: row.percent,
        ...(typeof row.resetAt === "number" && Number.isFinite(row.resetAt) && row.resetAt > 0 ? { resetAt: row.resetAt } : {}) });
    }
  }
  if (buckets.length !== 4) return empty;
  return { ...empty, status: account.quotaStale || account.quotaUnavailable ? "stale" : "ok", buckets };
}

export function formatAgyObservedAt(timestamp: unknown): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const d = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatAgyResetAt(timestamp: unknown): string | null {
  return formatAgyObservedAt(timestamp);
}
