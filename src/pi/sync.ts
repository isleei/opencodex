/**
 * Gather the visible catalog and inject providers.opencodex into Pi models.json.
 * Mirrors grok/sync.ts: used by management apply route and CLI.
 */
import {
  filterCatalogVisibleModels,
  nativeOpenAiContextWindow,
  visibleNativeSlugs,
  type CatalogModel,
} from "../codex/catalog";
import type { OcxConfig } from "../types";
import { injectPiModels, type PiInjectModel, type PiInjectResult } from "./models";

export interface PiSyncDeps {
  fetchAllModels: (config: OcxConfig) => Promise<CatalogModel[]>;
  injectPiModels: typeof injectPiModels;
}

async function defaultFetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { fetchAllModels } = await import("../server/management-api");
  return fetchAllModels(config);
}

function catalogToPiModels(config: OcxConfig, routed: CatalogModel[]): PiInjectModel[] {
  const native: PiInjectModel[] = visibleNativeSlugs(config).map(id => {
    const contextWindow = nativeOpenAiContextWindow(id);
    return {
      namespaced: id,
      provider: "openai",
      id,
      native: true,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      inputModalities: ["text", "image"],
    };
  });
  const fromRouted: PiInjectModel[] = routed.map(m => {
    const namespaced = m.alias ?? `${m.provider}/${m.id}`;
    return {
      namespaced,
      provider: m.provider,
      id: m.id,
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      inputModalities: m.inputModalities && m.inputModalities.length > 0
        ? [...m.inputModalities]
        : ["text"],
    };
  });
  return [...native, ...fromRouted];
}

export async function syncPiConfig(
  port: number,
  config: OcxConfig,
  opts: { hostname?: string; piHome?: string } = {},
  deps: PiSyncDeps = { fetchAllModels: defaultFetchAllModels, injectPiModels },
): Promise<PiInjectResult> {
  let models: PiInjectModel[];
  try {
    const routed = filterCatalogVisibleModels(await deps.fetchAllModels(config), config);
    models = catalogToPiModels(config, routed);
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: `Pi config sync skipped: model catalog unavailable (${err instanceof Error ? err.message : String(err)})`,
      modelsPath: "",
      modelCount: 0,
    };
  }
  return deps.injectPiModels(port, models, {
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    ...(opts.piHome !== undefined ? { piHome: opts.piHome } : {}),
  });
}
