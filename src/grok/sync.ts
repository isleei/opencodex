/**
 * Shared Grok Build config sync: gather the visible model catalog and (re)inject the
 * managed block into ~/.grok/config.toml. Used by `ocx start` (server process) and by
 * `ocx ensure` / `ocx restart` (parent process, after live discovery or child readiness)
 * so the fence exists deterministically once the proxy reports healthy.
 *
 * Deps are injectable (mirrors src/codex/sync.ts) so tests can run without a live proxy.
 */
import { visibleNativeSlugs, filterCatalogVisibleModels, nativeContextLimits, nativeOpenAiContextWindow, type CatalogModel } from "../codex/catalog";
import type { OcxConfig } from "../types";
import { injectGrokConfig, type GrokInjectModel, type GrokInjectResult } from "./inject";
import { installGrokUsageHooks, type GrokUsageHookResult } from "./usage-hook";

export interface GrokSyncDeps {
  fetchAllModels: (config: OcxConfig) => Promise<CatalogModel[]>;
  injectGrokConfig: typeof injectGrokConfig;
  installGrokUsageHooks?: (opts?: { grokHome?: string }) => GrokUsageHookResult;
}

async function defaultFetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { fetchAllModels } = await import("../server/management-api");
  return fetchAllModels(config);
}

/**
 * Build the model list and inject the fenced block. `hostname` should be the hostname the
 * RUNNING proxy actually bound (live.hostname from proxy-liveness for ensure's live branch;
 * config.hostname for a freshly spawned start) — a stale config.hostname could otherwise
 * name a host the process never bound.
 */
export async function syncGrokConfig(
  port: number,
  config: OcxConfig,
  opts: { hostname?: string; grokHome?: string } = {},
  deps: GrokSyncDeps = { fetchAllModels: defaultFetchAllModels, injectGrokConfig },
): Promise<GrokInjectResult> {
  let models: GrokInjectModel[];
  try {
    const routed = filterCatalogVisibleModels(await deps.fetchAllModels(config), config);
    models = [
      // Native slugs carry their context window too. Without it Grok falls back to its own
      // default (200k) and understates models like gpt-5.6-sol, which is 372k. This is the same
      // accessor the dashboard's native rows use, so the two cannot disagree.
      ...visibleNativeSlugs(config).map(id => {
        const contextWindow = nativeOpenAiContextWindow(id, nativeContextLimits(config));
        return { id, ...(contextWindow !== undefined ? { contextWindow } : {}) };
      }),
      ...routed.map(m => ({
        id: m.alias ?? `${m.provider}/${m.id}`,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      })),
    ];
  } catch (err) {
    // Still try to install the usage hook — native-session reporting does not need the catalog.
    const hookResult = runInstallHooks(deps, opts);
    return {
      ok: false,
      changed: hookResult.changed,
      message: [
        `Grok config sync skipped: model catalog unavailable (${err instanceof Error ? err.message : String(err)})`,
        hookResult.message,
      ].filter(Boolean).join(" "),
    };
  }
  // Pass the FULL list plus the exclusion set: the writer allocates aliases over
  // everything and emits only what is switched on, so a model's alias never depends on
  // its neighbours' switches. Absent/empty selection keeps today's behaviour exactly.
  const injectResult = deps.injectGrokConfig(port, models, {
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    ...(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {}),
    excluded: new Set(config.grokExcludedModels ?? []),
  });

  // Always (re)install the native-usage hook when a Grok home exists — independent of the
  // model fence (which is skipped on non-loopback binds). Best-effort; never fails the fence.
  const hookResult = runInstallHooks(deps, opts);

  if (!hookResult.changed && hookResult.ok) return injectResult;
  const parts = [injectResult.message, hookResult.message].filter(Boolean);
  return {
    ok: injectResult.ok && hookResult.ok,
    changed: injectResult.changed || hookResult.changed,
    message: parts.join(" "),
    ...(injectResult.skippedReason ? { skippedReason: injectResult.skippedReason } : {}),
  };
}

function runInstallHooks(
  deps: GrokSyncDeps,
  opts: { grokHome?: string },
): GrokUsageHookResult {
  const installHooks = deps.installGrokUsageHooks ?? installGrokUsageHooks;
  try {
    return installHooks(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {});
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: `Grok usage hook install failed: ${err instanceof Error ? err.message : String(err)}`,
      homes: [],
    };
  }
}
