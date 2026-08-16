/**
 * ProviderModels — the models tab: searchable wrapping model chips with
 * default/selected flags and full custom-model CRUD (id, display name,
 * context window, modalities). Uses a wrap layout so short lists fill
 * horizontal space instead of a tall single-column stack.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { filterModels } from "../../provider-workspace/report";
import { encodedModelIdCollides } from "../../../../src/providers/slug-codec";
import { IconRefresh } from "../../icons";
import { Notice, Select } from "../../ui";
import { CUSTOM_OPTION } from "../../pages/models-shared";

type CustomModelRow = {
  id: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
};

const CONTEXT_PRESETS = [
  { value: "100000", label: "100k" },
  { value: "128000", label: "128k" },
  { value: "200000", label: "200k" },
  { value: "256000", label: "256k" },
  { value: "272000", label: "272k" },
  { value: "352000", label: "352k" },
  { value: "500000", label: "500k" },
  { value: "1000000", label: "1M" },
] as const;

function parseCustomRows(rows: unknown, provider: string): CustomModelRow[] {
  if (!Array.isArray(rows)) throw new Error("Invalid custom model list");
  return rows.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const model = row as {
      id?: unknown;
      provider?: unknown;
      modelId?: unknown;
      displayName?: unknown;
      contextWindow?: unknown;
      inputModalities?: unknown;
    };
    if (model.provider !== provider || typeof model.modelId !== "string" || !model.modelId.trim()) {
      return [];
    }
    const inputModalities = Array.isArray(model.inputModalities)
      ? model.inputModalities.filter((m): m is string => typeof m === "string")
      : undefined;
    return [{
      id: typeof model.id === "string" && model.id ? model.id : `local-${model.modelId}`,
      modelId: model.modelId.trim(),
      ...(typeof model.displayName === "string" && model.displayName.trim()
        ? { displayName: model.displayName.trim() }
        : {}),
      ...(typeof model.contextWindow === "number" && model.contextWindow > 0
        ? { contextWindow: Math.floor(model.contextWindow) }
        : {}),
      ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
    }];
  });
}

function parseContextWindow(raw: string): number | undefined {
  const n = Number(raw.replace(/[_,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export default function ProviderModels({
  item,
  apiBase,
  availableModels,
  hasLiveModels,
  selectedModels,
  modelsLoading = false,
  modelsLoadFailed = false,
  needsReauth = false,
  onRetryModels,
  onRefreshModels,
  onOpenAccounts,
}: {
  item: WorkspaceItem;
  apiBase: string;
  availableModels: string[];
  selectedModels: string[];
  /** Server-reported: did the last successful discovery return any rows? */
  hasLiveModels: boolean;
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  /** Active OAuth account needs a fresh login before live discovery works. */
  needsReauth?: boolean;
  onRetryModels?: () => void;
  /**
   * Force-refresh this provider's live catalog (clears server cache, re-fetches upstream,
   * persists discovered ids into provider.models, then reloads the workspace model list).
   * Distinct from onRetryModels which only re-reads the cached management payload.
   */
  onRefreshModels?: (result?: {
    models: string[];
    liveModelCount?: number;
    persisted?: boolean;
  }) => void | Promise<void>;
  onOpenAccounts?: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [customModels, setCustomModels] = useState<CustomModelRow[]>([]);
  const [customModelsReady, setCustomModelsReady] = useState(false);
  const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
  const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
  const [customError, setCustomError] = useState("");
  const [customSuccess, setCustomSuccess] = useState("");
  const [customSaving, setCustomSaving] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "edit">("add");
  const [editId, setEditId] = useState("");
  const [formModelId, setFormModelId] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formContextWindow, setFormContextWindow] = useState("");
  const [formShowCustomCtx, setFormShowCustomCtx] = useState(false);
  const [formModalities, setFormModalities] = useState<string[]>(["text"]);
  const [formError, setFormError] = useState("");

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const configuredModels = useMemo(() => item.models ?? [], [item.models]);
  const customModelIds = useMemo(() => customModels.map(m => m.modelId), [customModels]);
  const customById = useMemo(
    () => new Map(customModels.map(m => [m.modelId, m] as const)),
    [customModels],
  );

  const models = useMemo(
    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels),
    [availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels],
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/custom-models`);
        if (!response.ok) throw new Error();
        const rows: unknown = await response.json();
        if (!active) return;
        setCustomModels(parseCustomRows(rows, item.name));
        setCustomModelsLoadFailed(false);
        setCustomError("");
        setCustomModelsReady(true);
      } catch {
        if (!active) return;
        setCustomModels([]);
        // Without this the component stays permanently unable to add a model: `customModelsReady`
        // never flips back and the effect has no trigger left, so a single transient GET failure
        // disabled Add until the whole panel remounted.
        setCustomModelsReady(false);
        setCustomModelsLoadFailed(true);
        setCustomError(t("models.networkError"));
      }
    };
    void load();
    return () => { active = false; };
  }, [apiBase, item.name, t, customModelsLoadEpoch]);

  const retryCustomModels = () => {
    setCustomModelsReady(false);
    setCustomModelsLoadFailed(false);
    setCustomError("");
    setCustomModelsLoadEpoch(epoch => epoch + 1);
  };

  const canFetchLive = item.liveModels !== false && item.authMode !== "forward";

  const refreshFromProvider = async () => {
    if (refreshingModels || !canFetchLive) return;
    setRefreshingModels(true);
    setRefreshNote(null);
    setCustomError("");
    setCustomSuccess("");
    try {
      const response = await fetch(
        `${apiBase}/api/providers/refresh-models?name=${encodeURIComponent(item.name)}`,
        { method: "POST" },
      );
      const body: unknown = await response.json().catch(() => null);
      const payload = body && typeof body === "object" ? body as {
        ok?: unknown;
        count?: unknown;
        error?: unknown;
        source?: unknown;
        message?: unknown;
        models?: unknown;
        liveModelCount?: unknown;
        persisted?: unknown;
      } : null;
      if (!response.ok) {
        const err = payload && typeof payload.error === "string" ? payload.error : t("pws.refreshModelsFailed");
        setRefreshNote({ ok: false, text: err });
        return;
      }
      const count = typeof payload?.count === "number" ? payload.count : 0;
      const models = Array.isArray(payload?.models)
        ? payload.models.filter((id): id is string => typeof id === "string")
        : [];
      const liveModelCount = typeof payload?.liveModelCount === "number" ? payload.liveModelCount : undefined;
      const persisted = payload?.persisted === true;
      if (payload?.ok === false) {
        const err = typeof payload.error === "string" ? payload.error : t("pws.refreshModelsFailed");
        setRefreshNote({
          ok: false,
          text: count > 0
            ? t("pws.refreshModelsPartial", { count: String(count), error: err })
            : err,
        });
      } else if (payload?.source === "static") {
        setRefreshNote({
          ok: true,
          text: typeof payload.message === "string" ? payload.message : t("pws.refreshModelsStatic"),
        });
      } else if (persisted) {
        setRefreshNote({ ok: true, text: t("pws.refreshModelsSaved", { count: String(count) }) });
      } else {
        setRefreshNote({ ok: true, text: t("pws.refreshModelsOk", { count: String(count) }) });
      }
      // Paint chips from the response, then re-read selected-models / config so the list sticks.
      await onRefreshModels?.({
        models,
        ...(liveModelCount !== undefined ? { liveModelCount } : {}),
        ...(persisted ? { persisted: true } : {}),
      });
    } catch {
      setRefreshNote({ ok: false, text: t("pws.refreshModelsFailed") });
    } finally {
      setRefreshingModels(false);
    }
  };

  useEffect(() => () => {
    if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
  }, []);

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedId(modelId);
      if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => {
        setCopiedId(prev => (prev === modelId ? null : prev));
        copyResetRef.current = null;
      }, 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const openAddModal = () => {
    setModalMode("add");
    setEditId("");
    setFormModelId("");
    setFormDisplayName("");
    setFormContextWindow("");
    setFormShowCustomCtx(false);
    setFormModalities(["text"]);
    setFormError("");
    setCustomSuccess("");
    setModalOpen(true);
  };

  const openEditModal = (row: CustomModelRow) => {
    setModalMode("edit");
    setEditId(row.id);
    setFormModelId(row.modelId);
    setFormDisplayName(row.displayName ?? "");
    setFormContextWindow(row.contextWindow ? String(row.contextWindow) : "");
    setFormShowCustomCtx(
      Boolean(row.contextWindow && !CONTEXT_PRESETS.some(p => p.value === String(row.contextWindow))),
    );
    setFormModalities(row.inputModalities?.length ? [...row.inputModalities] : ["text"]);
    setFormError("");
    setCustomSuccess("");
    setModalOpen(true);
  };

  const trimmedFormModelId = formModelId.trim();
  const editingCurrentId = modalMode === "edit"
    ? customModels.find(m => m.id === editId)?.modelId
    : undefined;
  const knownModelIds = useMemo(() => [
    ...availableModels,
    ...customModelIds,
    ...configuredModels,
    ...(item.defaultModel ? [item.defaultModel] : []),
  ], [availableModels, customModelIds, configuredModels, item.defaultModel]);

  const formModelIdTaken = (() => {
    if (!trimmedFormModelId) return false;
    // Keep the current id editable; only block collisions with *other* models.
    if (editingCurrentId && trimmedFormModelId === editingCurrentId) return false;
    if (customModels.some(m => m.modelId === trimmedFormModelId && m.id !== editId)) return true;
    if (availableModels.includes(trimmedFormModelId)) return true;
    if (configuredModels.includes(trimmedFormModelId)) return true;
    if (item.defaultModel === trimmedFormModelId) return true;
    const others = knownModelIds.filter(id => id !== editingCurrentId);
    if (encodedModelIdCollides(trimmedFormModelId, others)) return true;
    return false;
  })();

  const formInvalid = !customModelsReady
    || !trimmedFormModelId
    || formModelIdTaken
    || (modalMode === "edit" && !editId);

  const saveCustomModel = async () => {
    if (formInvalid || customSaving) return;
    setCustomSaving(true);
    setFormError("");
    setCustomError("");
    setCustomSuccess("");
    const displayName = formDisplayName.trim();
    const contextWindow = parseContextWindow(formContextWindow);
    const inputModalities = formModalities.length > 0 ? formModalities : undefined;
    try {
      if (modalMode === "add") {
        const response = await fetch(`${apiBase}/api/custom-models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: item.name,
            modelId: trimmedFormModelId,
            ...(displayName ? { displayName } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(inputModalities ? { inputModalities } : {}),
          }),
        });
        if (!response.ok) {
          setFormError(t("models.customSaveFailed"));
          return;
        }
        const created: unknown = await response.json().catch(() => null);
        const createdRow = created && typeof created === "object"
          ? parseCustomRows([{ ...created as object, provider: item.name }], item.name)[0]
          : undefined;
        setCustomModels(prev => {
          if (prev.some(m => m.modelId === trimmedFormModelId)) return prev;
          return [...prev, createdRow ?? {
            id: `local-${trimmedFormModelId}`,
            modelId: trimmedFormModelId,
            ...(displayName ? { displayName } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(inputModalities ? { inputModalities } : {}),
          }];
        });
        setModalOpen(false);
        setCustomSuccess(t("models.customAdded"));
        onRetryModels?.();
      } else {
        const response = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(editId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelId: trimmedFormModelId,
            displayName,
            contextWindow: contextWindow ?? null,
            inputModalities: formModalities,
          }),
        });
        if (!response.ok) {
          setFormError(t("models.customSaveFailed"));
          return;
        }
        const updated: unknown = await response.json().catch(() => null);
        const updatedRow = updated && typeof updated === "object"
          ? parseCustomRows([{ ...updated as object, provider: item.name }], item.name)[0]
          : undefined;
        setCustomModels(prev => prev.map(m => {
          if (m.id !== editId) return m;
          return updatedRow ?? {
            id: m.id,
            modelId: trimmedFormModelId,
            ...(displayName ? { displayName } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(inputModalities ? { inputModalities } : {}),
          };
        }));
        setModalOpen(false);
        setCustomSuccess(t("models.customUpdated"));
        onRetryModels?.();
      }
    } catch {
      setFormError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const deleteCustomModel = async (row: CustomModelRow) => {
    if (!window.confirm(t("models.customDeleteConfirm", { name: row.displayName ?? row.modelId }))) {
      return;
    }
    setCustomError("");
    setCustomSuccess("");
    try {
      const response = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setCustomError(t("models.customSaveFailed"));
        return;
      }
      setCustomModels(prev => prev.filter(m => m.id !== row.id));
      setCustomSuccess(t("models.customDeleted"));
      onRetryModels?.();
    } catch {
      setCustomError(t("models.networkError"));
    }
  };

  const emptyBase = availableModels.length === 0
    && configuredModels.length === 0
    && customModelIds.length === 0
    && !item.defaultModel;
  const showingConfiguredFallback = availableModels.length === 0 && configuredModels.length > 0;
  // Aggregators (OpenRouter etc.) can return thousands of ids; capping the mounted
  // chips keeps the tab responsive. Filtering narrows the list, so the cap only
  // bites on the unfiltered full catalog.
  const CHIP_RENDER_CAP = 300;
  const capped = models.length > CHIP_RENDER_CAP;
  const visibleModels = capped ? models.slice(0, CHIP_RENDER_CAP) : models;

  return (
    <div className="pws-section">
      <div className="pws-section-head">
        <h3 className="pws-section-title">{t("pws.tab.models")}</h3>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {models.length > 0 && (
            <span className="muted">{t("pws.modelsAvailable", { count: models.length })}</span>
          )}
          {customModels.length > 0 && (
            <span className="muted text-label">{t("models.customSummary", { count: customModels.length })}</span>
          )}
          {canFetchLive && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => { void refreshFromProvider(); }}
              disabled={refreshingModels || modelsLoading || needsReauth}
              aria-label={t("pws.refreshModels")}
              title={needsReauth ? t("pws.modelsNeedsReauth") : t("pws.refreshModelsDesc")}
            >
              <IconRefresh width={14} />
              {refreshingModels ? t("pws.refreshingModels") : t("pws.refreshModels")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={openAddModal}
            disabled={!customModelsReady || customSaving}
            aria-label={t("models.customAdd")}
            aria-haspopup="dialog"
          >
            {t("models.customAddBtn")}
          </button>
        </div>
      </div>
      {refreshNote && (
        <p className={refreshNote.ok ? "muted text-label" : "pws-inline-error"} role="status">
          {refreshNote.text}
        </p>
      )}
      {needsReauth && (
        <div className="pws-inline-error" role="status">
          <span>{t("pws.modelsNeedsReauth")}</span>
          {onOpenAccounts && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAccounts}>
              {t("pws.tab.accounts")}
            </button>
          )}
        </div>
      )}
      {showingConfiguredFallback && !needsReauth && (
        <p className="muted text-label" style={{ marginBottom: 10 }}>{t("pws.modelsConfiguredFallback")}</p>
      )}
      {customSuccess && <p className="muted text-label" role="status">{customSuccess}</p>}
      {customError && (
        <p className="pws-inline-error" role="alert">
          {customError}
          {customModelsLoadFailed && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={retryCustomModels} style={{ marginLeft: 8 }}>
              {t("common.retry")}
            </button>
          )}
        </p>
      )}
      {!emptyBase && (
        <input
          type="search"
          className="input pws-model-search"
          placeholder={t("pws.modelSearchPlaceholder")}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label={t("pws.modelSearchPlaceholder")}
        />
      )}
      {modelsLoading && emptyBase ? (
        <p className="muted" role="status">{t("pws.modelsLoading")}</p>
      ) : modelsLoadFailed && emptyBase ? (
        <div role="alert" className="pws-inline-error">
          <span>{t("pws.modelsLoadFailed")}</span>
          {onRetryModels && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryModels}>
              {t("pws.retry")}
            </button>
          )}
        </div>
      ) : emptyBase ? (
        <p className="muted">{t("pws.noModels")}</p>
      ) : models.length === 0 ? (
        <p className="muted" role="status">{t("pws.noModelMatch")}</p>
      ) : (
        <ul className="pws-model-list">
          {visibleModels.map(modelId => {
            const isDefault = modelId === item.defaultModel;
            const isSelected = selectedSet.has(modelId);
            const custom = customById.get(modelId);
            const copied = copiedId === modelId;
            return (
              <li key={modelId} className="pws-model-chip">
                <button
                  type="button"
                  className="pws-model-chip-main"
                  onClick={() => { void copyModelId(modelId); }}
                  title={custom?.displayName ? `${modelId} (${custom.displayName})` : modelId}
                  aria-label={copied ? t("pws.modelCopied") : t("pws.copyModelId")}
                >
                  <span className="pws-model-id">{modelId}</span>
                </button>
                {custom ? <span className="badge badge-muted pws-model-flag">{t("models.customBadge")}</span> : null}
                {isDefault ? <span className="badge badge-muted pws-model-flag">{t("prov.defaultBadge")}</span> : null}
                {isSelected ? <span className="badge badge-accent pws-model-flag">{t("pws.selected")}</span> : null}
                {custom && (
                  <span className="pws-model-chip-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm text-caption"
                      onClick={() => openEditModal(custom)}
                      disabled={customSaving || !customModelsReady}
                    >
                      {t("models.customEdit")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm text-caption"
                      style={{ color: "var(--red)" }}
                      onClick={() => { void deleteCustomModel(custom); }}
                      disabled={customSaving || !customModelsReady}
                    >
                      {t("models.customDelete")}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {capped && (
        <p className="muted text-label" style={{ marginTop: 10 }}>
          {t("pws.modelsTruncated", { shown: String(CHIP_RENDER_CAP), total: String(models.length) })}
        </p>
      )}

      {modalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={modalMode === "add" ? t("models.customAdd") : t("models.customEdit")}
          onClick={() => { if (!customSaving) setModalOpen(false); }}
          onKeyDown={e => {
            if (e.key === "Escape" && !customSaving) setModalOpen(false);
          }}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {modalMode === "add"
                  ? t("models.customAddTitle", { provider: item.name })
                  : t("models.customEditTitle", { provider: item.name })}
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setModalOpen(false)}
                disabled={customSaving}
                aria-label={t("common.close")}
              >
                &times;
              </button>
            </div>

            {formError && <Notice tone="err">{formError}</Notice>}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {t("models.customFieldModelId")}
                <input
                  className="input"
                  value={formModelId}
                  onChange={e => setFormModelId(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldModelIdPlaceholder")}
                  aria-label={t("models.customAdd")}
                  autoFocus
                />
              </label>

              <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {t("models.customFieldDisplayName")}
                <input
                  className="input"
                  value={formDisplayName}
                  onChange={e => setFormDisplayName(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldDisplayNamePlaceholder")}
                />
              </label>

              <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {t("models.customFieldContext")}
                <div className="row" style={{ gap: 6 }}>
                  <Select
                    value={formShowCustomCtx ? CUSTOM_OPTION : formContextWindow}
                    options={[
                      { value: "", label: "—" },
                      ...CONTEXT_PRESETS.map(p => ({ value: p.value, label: p.label })),
                      { value: CUSTOM_OPTION, label: t("models.custom") },
                    ]}
                    onChange={v => {
                      if (v === CUSTOM_OPTION) {
                        setFormShowCustomCtx(true);
                        return;
                      }
                      setFormShowCustomCtx(false);
                      setFormContextWindow(v);
                    }}
                    disabled={customSaving}
                    label={t("models.customFieldContext")}
                  />
                  {formShowCustomCtx && (
                    <input
                      className="input"
                      style={{ width: 120 }}
                      inputMode="numeric"
                      value={formContextWindow}
                      onChange={e => setFormContextWindow(e.target.value)}
                      disabled={customSaving}
                      placeholder={t("models.customPlaceholder")}
                      aria-label={t("models.customFieldContext")}
                    />
                  )}
                </div>
              </label>

              <div className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {t("models.customFieldModalities")}
                <div className="row" style={{ gap: 8 }}>
                  {(["text", "image", "audio"] as const).map(mod => (
                    <label key={mod} className="row" style={{ gap: 4, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={formModalities.includes(mod)}
                        onChange={e => {
                          setFormModalities(prev => (
                            e.target.checked ? [...prev, mod] : prev.filter(m => m !== mod)
                          ));
                        }}
                        disabled={customSaving}
                      />
                      <span className="text-control">{mod}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setModalOpen(false)}
                disabled={customSaving}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={customSaving || formInvalid}
                onClick={() => { void saveCustomModel(); }}
              >
                {customSaving
                  ? t("models.customSaving")
                  : (modalMode === "add" ? t("models.customAddBtn") : t("models.customEditBtn"))}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
