/**
 * Provider quota shapes, split out of `quota.ts` so a provider-specific quota module can
 * describe its result without importing the aggregator that will consume it.
 *
 * `quota.ts` imports the Kiro usage module for its fetcher; if that module reached back
 * into `quota.ts` for these types the two would depend on each other. Types have no
 * runtime edge, but a cycle that exists only in the type graph is still a cycle, and it
 * blocks any later attempt to load one side without the other.
 */

export interface ProviderQuotaWindow {
  label: string;
  percent: number;
  resetAt?: number;
  /**
   * Sampled upstream model id that produced this window. A family window is a
   * single-model sample kept for routing compatibility, never a measured
   * family aggregate.
   */
  modelId?: string;
}

/** One parsed upstream model quota reading, with identity. Display-only:
 * routing/headroom consumers read only the canonical family windows. */
export interface AgyModelQuota {
  modelId: string;
  displayName?: string;
  family: "Gem" | "Cla" | "OSS" | "other";
  /** Upstream tier/window identity when the payload reports one model across
   * multiple quotaInfo entries (e.g. quotaInfoByTier). Preserved so rows stay
   * distinguishable; never inferred when absent. */
  tier?: string;
  percent: number;
  resetAt?: number;
}

/** Subscription limits from retrieveUserQuotaSummary, shared within each group. */
export interface AgyQuotaGroup {
  id: "gemini" | "claude-gpt";
  windows: { window: "weekly" | "5h"; percent: number; resetAt?: number }[];
}

export interface ProviderQuotaCreditsUsd {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  expiresAt?: number;
  unlimited?: boolean;
}

export interface ProviderQuota {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindow[];
  creditsUsd?: ProviderQuotaCreditsUsd;
  /** Legacy catalog cache only; does not establish subscription allowance. */
  agyModels?: AgyModelQuota[];
  agyQuotaGroups?: AgyQuotaGroup[];
  updatedAt: number;
}
