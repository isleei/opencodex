/**
 * Pi coding agent management page: models inject, curated settings, packages, extensions.
 * Writes only providers.opencodex in models.json; package ops shell out through the proxy.
 */
import { useCallback, useState } from "react";
import { EmptyState, Notice, Switch } from "../ui";
import { useT, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";

interface PiModelRow {
  id: string;
  name?: string;
  contextWindow?: number;
}

interface PiStatus {
  piRoot: string;
  agentDir: string;
  agentDirPresent: boolean;
  piBinary: string | null;
  modelsPath: string;
  settingsPath: string;
  hint?: string | null;
  port?: number;
  models: {
    modelsPath: string;
    present: boolean;
    baseUrl: string | null;
    modelCount: number;
    models: PiModelRow[];
  };
  settings: {
    settingsPath: string;
    present: boolean;
    settings: {
      defaultProvider?: string;
      defaultModel?: string;
      defaultThinkingLevel?: string;
      hideThinkingBlock?: boolean;
      theme?: string;
      quietStartup?: boolean;
      defaultProjectTrust?: string;
      enabledModels?: string[];
      compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
      retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
    };
    otherKeyCount: number;
  };
  packages: {
    packages: Array<{ source: string }>;
    listOutput: string | null;
    piBinary: string | null;
  };
  extensions: {
    autoDir: string;
    entries: Array<{ name: string; path: string; origin: string; kind: string }>;
  };
}

type Pending =
  | "apply"
  | "remove"
  | "settings"
  | "install"
  | "pkg-remove"
  | null;

const THINKING_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TRUST_OPTIONS = ["ask", "always", "never"] as const;

export default function Pi({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.pi.status.v1:${apiBase}`;
  const cached = readSessionListCache<PiStatus>(cacheKey);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [packageSource, setPackageSource] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<{
    defaultProvider: string;
    defaultModel: string;
    defaultThinkingLevel: string;
    theme: string;
    defaultProjectTrust: string;
    hideThinkingBlock: boolean;
    quietStartup: boolean;
  } | null>(null);

  const fetchStatus = useCallback(async (): Promise<PiStatus> => {
    const response = await fetch(`${apiBase}/api/pi`);
    const payload = await readJsonOrThrow<PiStatus & { error?: string }>(response, t("pi.loadFail"));
    if (!payload) throw new Error(t("pi.loadFail"));
    writeSessionListCache(cacheKey, payload);
    // Seed settings draft only when empty so an in-progress edit is not clobbered by refresh.
    setSettingsDraft(current => {
      if (current) return current;
      const s = payload.settings?.settings ?? {};
      return {
        defaultProvider: s.defaultProvider ?? "",
        defaultModel: s.defaultModel ?? "",
        defaultThinkingLevel: s.defaultThinkingLevel ?? "",
        theme: s.theme ?? "",
        defaultProjectTrust: s.defaultProjectTrust ?? "",
        hideThinkingBlock: s.hideThinkingBlock ?? false,
        quietStartup: s.quietStartup ?? false,
      };
    });
    return payload;
  }, [apiBase, cacheKey, t]);

  const resourceKey = `pi-status:${apiBase}`;
  const resource = useDataSurface<PiStatus>(
    resourceKey,
    [apiBase],
    fetchStatus,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const load = resource.refresh;
  const status = state.data ?? cached;

  const runAction = async (
    kind: Pending,
    url: string,
    init?: RequestInit,
    okKey: TKey = "pi.actionOk",
  ) => {
    if (pending) return;
    setPending(kind);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}${url}`, init);
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        message?: string;
        error?: string;
        skippedReason?: string;
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message ?? payload.error ?? t("pi.actionFail"));
      }
      const text = payload.skippedReason
        ? (payload.message ?? t("pi.applySkipped"))
        : (payload.message ?? t(okKey));
      setMessage({ tone: payload.skippedReason ? "err" : "ok", text });
      setAnnouncement(text);
      setSettingsDraft(null);
      await load();
    } catch (err) {
      const text = err instanceof Error ? err.message : t("pi.actionFail");
      setMessage({ tone: "err", text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  const saveSettings = async () => {
    if (!settingsDraft || pending) return;
    const body: Record<string, unknown> = {
      defaultProvider: settingsDraft.defaultProvider.trim() || null,
      defaultModel: settingsDraft.defaultModel.trim() || null,
      defaultThinkingLevel: settingsDraft.defaultThinkingLevel.trim() || null,
      theme: settingsDraft.theme.trim() || null,
      defaultProjectTrust: settingsDraft.defaultProjectTrust.trim() || null,
      hideThinkingBlock: settingsDraft.hideThinkingBlock,
      quietStartup: settingsDraft.quietStartup,
    };
    await runAction(
      "settings",
      "/api/pi/settings",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      "pi.settingsSaved",
    );
  };

  if (state.showSkeleton && !status) {
    return (
      <section className="pi-page">
        <DataSurfaceSkeleton label={t("pi.loading")} rows={5} />
      </section>
    );
  }

  if (state.kind === "failed-cold") {
    const reason = state.error instanceof Error ? state.error.message : t("pi.loadFail");
    return (
      <section className="pi-page">
        <div className="alert alert-err" role="alert">{reason}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()}>{t("common.retry")}</button>
      </section>
    );
  }

  const draft = settingsDraft;

  return (
    <section className="pi-page" aria-busy={state.refreshing || undefined}>
      <h2 className="page-title">{t("pi.title")}</h2>
      <p className="page-sub">{t("pi.subtitle")}</p>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {state.showError && <Notice tone="err">{t("pi.loadFail")}</Notice>}
      {status?.hint && <Notice tone="err">{status.hint}</Notice>}

      {/* Status */}
      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t("pi.statusTitle")}</h3>
        <dl className="awi-kv">
          <div className="awi-kv-row">
            <dt>{t("pi.binary")}</dt>
            <dd><code>{status?.piBinary ?? t("pi.missing")}</code></dd>
          </div>
          <div className="awi-kv-row">
            <dt>{t("pi.agentDir")}</dt>
            <dd><code>{status?.agentDir ?? "—"}</code></dd>
          </div>
          <div className="awi-kv-row">
            <dt>{t("pi.modelsFile")}</dt>
            <dd><code>{status?.modelsPath ?? "—"}</code></dd>
          </div>
        </dl>
      </div>

      {/* Models */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <h3 className="panel-title" style={{ margin: 0 }}>{t("pi.modelsTitle")}</h3>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending !== null || !status?.agentDirPresent}
              onClick={() => void runAction("apply", "/api/pi/apply", { method: "POST" }, "pi.applied")}
            >
              {pending === "apply" ? t("pi.applying") : t("pi.apply")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending !== null || !status?.models.present}
              onClick={() => void runAction("remove", "/api/pi/remove", { method: "POST" }, "pi.removed")}
            >
              {pending === "remove" ? t("pi.removing") : t("pi.remove")}
            </button>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>{t("pi.modelsHint")}</p>
        {!status?.models.present ? (
          <EmptyState title={t("pi.modelsNotPresentTitle")}>
            {t("pi.modelsNotPresentHint")}
          </EmptyState>
        ) : (
          <>
            <div className="grok-endpoint" style={{ marginTop: 8 }}>
              <span>{t("pi.endpoint")}</span>
              <code>{status.models.baseUrl ?? "—"}</code>
            </div>
            <p className="muted small">{t("pi.modelCount", { count: status.models.modelCount })}</p>
            {status.models.models.length > 0 && (
              <ul className="muted small" style={{ maxHeight: 180, overflow: "auto", margin: "8px 0 0", paddingLeft: 18 }}>
                {status.models.models.slice(0, 40).map(model => (
                  <li key={model.id}>
                    <code>{model.id}</code>
                    {model.name && model.name !== model.id ? ` — ${model.name}` : ""}
                  </li>
                ))}
                {status.models.models.length > 40 && (
                  <li>{t("pi.moreModels", { n: status.models.models.length - 40 })}</li>
                )}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Settings */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <h3 className="panel-title" style={{ margin: 0 }}>{t("pi.settingsTitle")}</h3>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending !== null || !draft || !status?.agentDirPresent}
            onClick={() => void saveSettings()}
          >
            {pending === "settings" ? t("pi.savingSettings") : t("pi.saveSettings")}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>{t("pi.settingsHint")}</p>
        {draft && (
          <div className="form-grid" style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            <label className="field">
              <span className="text-label">{t("pi.defaultProvider")}</span>
              <input
                className="input"
                value={draft.defaultProvider}
                onChange={e => setSettingsDraft({ ...draft, defaultProvider: e.target.value })}
                placeholder="opencodex"
              />
            </label>
            <label className="field">
              <span className="text-label">{t("pi.defaultModel")}</span>
              <input
                className="input"
                value={draft.defaultModel}
                onChange={e => setSettingsDraft({ ...draft, defaultModel: e.target.value })}
                placeholder="provider/model"
              />
            </label>
            <label className="field">
              <span className="text-label">{t("pi.thinking")}</span>
              <select
                className="input"
                value={draft.defaultThinkingLevel}
                onChange={e => setSettingsDraft({ ...draft, defaultThinkingLevel: e.target.value })}
              >
                <option value="">{t("pi.unset")}</option>
                {THINKING_OPTIONS.map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="text-label">{t("pi.theme")}</span>
              <input
                className="input"
                value={draft.theme}
                onChange={e => setSettingsDraft({ ...draft, theme: e.target.value })}
                placeholder="dark"
              />
            </label>
            <label className="field">
              <span className="text-label">{t("pi.projectTrust")}</span>
              <select
                className="input"
                value={draft.defaultProjectTrust}
                onChange={e => setSettingsDraft({ ...draft, defaultProjectTrust: e.target.value })}
              >
                <option value="">{t("pi.unset")}</option>
                {TRUST_OPTIONS.map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
            <div className="field" style={{ display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
              <label className="row" style={{ gap: 8, alignItems: "center" }}>
                <Switch
                  on={draft.hideThinkingBlock}
                  onClick={() => setSettingsDraft({ ...draft, hideThinkingBlock: !draft.hideThinkingBlock })}
                  label={t("pi.hideThinking")}
                />
                <span>{t("pi.hideThinking")}</span>
              </label>
              <label className="row" style={{ gap: 8, alignItems: "center" }}>
                <Switch
                  on={draft.quietStartup}
                  onClick={() => setSettingsDraft({ ...draft, quietStartup: !draft.quietStartup })}
                  label={t("pi.quietStartup")}
                />
                <span>{t("pi.quietStartup")}</span>
              </label>
            </div>
          </div>
        )}
        {status?.settings.otherKeyCount ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            {t("pi.otherKeys", { count: status.settings.otherKeyCount })}
          </p>
        ) : null}
        <p className="muted small"><code>{status?.settingsPath}</code></p>
      </div>

      {/* Packages */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h3 className="panel-title">{t("pi.packagesTitle")}</h3>
        <p className="muted small">{t("pi.packagesHint")}</p>
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 220px" }}
            value={packageSource}
            onChange={e => setPackageSource(e.target.value)}
            placeholder="npm:@scope/pkg or git:github.com/user/repo"
            disabled={pending !== null || !status?.piBinary}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending !== null || !packageSource.trim() || !status?.piBinary}
            onClick={() => {
              const source = packageSource.trim();
              void runAction(
                "install",
                "/api/pi/packages/install",
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) },
                "pi.packageInstalled",
              ).then(() => setPackageSource(""));
            }}
          >
            {pending === "install" ? t("pi.installing") : t("pi.install")}
          </button>
        </div>
        {(status?.packages.packages.length ?? 0) === 0 ? (
          <p className="muted small" style={{ marginTop: 10 }}>{t("pi.noPackages")}</p>
        ) : (
          <ul style={{ marginTop: 12, paddingLeft: 0, listStyle: "none" }}>
            {status!.packages.packages.map(pkg => (
              <li key={pkg.source} className="row" style={{ justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                <code style={{ wordBreak: "break-all" }}>{pkg.source}</code>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending !== null || !status?.piBinary}
                  onClick={() => void runAction(
                    "pkg-remove",
                    "/api/pi/packages/remove",
                    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: pkg.source }) },
                    "pi.packageRemoved",
                  )}
                >
                  {t("pi.removePackage")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {status?.packages.listOutput && (
          <pre className="api-example-pre" style={{ marginTop: 10, maxHeight: 140, overflow: "auto" }}>
            {status.packages.listOutput}
          </pre>
        )}
      </div>

      {/* Extensions */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h3 className="panel-title">{t("pi.extensionsTitle")}</h3>
        <p className="muted small">{t("pi.extensionsHint")}</p>
        <p className="muted small"><code>{status?.extensions.autoDir}</code></p>
        {(status?.extensions.entries.length ?? 0) === 0 ? (
          <p className="muted small">{t("pi.noExtensions")}</p>
        ) : (
          <ul style={{ marginTop: 8, paddingLeft: 18 }}>
            {status!.extensions.entries.map(entry => (
              <li key={`${entry.origin}:${entry.path}`}>
                <code>{entry.name}</code>
                {" "}
                <span className="muted small">({entry.origin} · {entry.kind})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 16 }}>{t("pi.cliHint")}</p>
    </section>
  );
}
