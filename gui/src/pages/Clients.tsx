/**
 * Clients effective-config page.
 *
 * Read-only view of each coding agent's on-disk routing (base URL / model /
 * via-ocx verdict). Does not export templates (see API page) and does not
 * mutate client configs (see Claude / Pi / Grok pages).
 */
import { useCallback, useMemo, useState } from "react";
import { IconChevron, IconRefresh } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { Notice } from "../ui";

type ClientId = "claude" | "codex" | "pi" | "grok" | "opencode" | "agy";
type ClientVerdict = "ocx" | "direct" | "mixed" | "missing" | "unknown";

interface ClientSwitcherInfo {
  name: string | null;
  appType: string;
}

interface ClientEffectiveStatus {
  id: ClientId;
  label: string;
  present: boolean;
  viaOcx: boolean | null;
  verdict: ClientVerdict;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  launcher: string | null;
  switcher: ClientSwitcherInfo | null;
  notes: string[];
}

interface ClientsStatusResponse {
  generatedAt: number;
  proxy: {
    baseUrl: string;
    running: boolean;
    port: number;
    hostname: string;
  };
  clients: ClientEffectiveStatus[];
}

const VERDICT_BADGE: Record<ClientVerdict, string> = {
  ocx: "badge badge-green",
  direct: "badge badge-muted",
  mixed: "badge badge-amber",
  missing: "badge badge-muted",
  unknown: "badge badge-accent",
};

const VERDICT_TKEY: Record<ClientVerdict, TKey> = {
  ocx: "clients.verdict.ocx",
  direct: "clients.verdict.direct",
  mixed: "clients.verdict.mixed",
  missing: "clients.verdict.missing",
  unknown: "clients.verdict.unknown",
};

const MANAGE_HASH: Partial<Record<ClientId, string>> = {
  claude: "claude",
  codex: "codex-auth",
  pi: "pi",
  grok: "grok",
};

/** Show paths relative to home when possible (display only). */
function displayPath(path: string): string {
  if (typeof window === "undefined") return path;
  // Browser has no os.homedir; keep absolute — server already sends full paths.
  return path;
}

export default function Clients({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.clients.status.v1:${apiBase}`;
  const cached = readSessionListCache<ClientsStatusResponse>(cacheKey);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const fetchStatus = useCallback(async (): Promise<ClientsStatusResponse> => {
    const response = await fetch(`${apiBase}/api/clients/status`);
    const payload = await readJsonOrThrow<ClientsStatusResponse & { error?: string }>(
      response,
      t("clients.loadFail"),
    );
    if (!payload || !Array.isArray(payload.clients)) throw new Error(t("clients.loadFail"));
    writeSessionListCache(cacheKey, payload);
    return payload;
  }, [apiBase, cacheKey, t]);

  const resource = useDataSurface<ClientsStatusResponse>(
    `clients-status:${apiBase}`,
    [apiBase],
    fetchStatus,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const status = state.data ?? cached;

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generatedAt = status?.generatedAt;
  const generatedLabel = useMemo(() => {
    if (!generatedAt) return null;
    try {
      return new Date(generatedAt).toLocaleString();
    } catch {
      return null;
    }
  }, [generatedAt]);

  const errorText = state.error instanceof Error
    ? state.error.message
    : typeof state.error === "string"
      ? state.error
      : t("clients.loadFail");

  return (
    <div className="page clients-page">
      <div className="page-head">
        <div>
          <h1>{t("clients.title")}</h1>
          <p className="page-sub">{t("clients.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void resource.refresh()}
          disabled={state.refreshing}
          aria-label={t("clients.refresh")}
          title={t("clients.refresh")}
        >
          <IconRefresh /> {t("clients.refresh")}
        </button>
      </div>

      {state.showSkeleton && <DataSurfaceSkeleton label={t("clients.loading")} rows={4} />}
      {state.showError && !status && (
        <Notice tone="err">
          {errorText}
          <button type="button" className="btn btn-ghost" onClick={() => void resource.refresh()}>
            {t("common.retry")}
          </button>
        </Notice>
      )}

      {status && (
        <>
          <section className="card clients-proxy-card" aria-label={t("clients.proxyTitle")}>
            <div className="clients-proxy-row">
              <span className={status.proxy.running ? "badge badge-green" : "badge badge-amber"}>
                {status.proxy.running ? t("clients.proxyRunning") : t("clients.proxyStopped")}
              </span>
              <code className="clients-mono">{status.proxy.baseUrl}</code>
              {generatedLabel && (
                <span className="clients-meta">{t("clients.generatedAt", { time: generatedLabel })}</span>
              )}
            </div>
            <p className="clients-hint">{t("clients.readOnlyHint")}</p>
          </section>

          <section className="card clients-table-card" aria-label={t("clients.tableTitle")}>
            <div className="clients-table-wrap">
              <table className="clients-table">
                <thead>
                  <tr>
                    <th scope="col">{t("clients.col.client")}</th>
                    <th scope="col">{t("clients.col.verdict")}</th>
                    <th scope="col">{t("clients.col.baseUrl")}</th>
                    <th scope="col">{t("clients.col.model")}</th>
                    <th scope="col">{t("clients.col.launcher")}</th>
                    <th scope="col">{t("clients.col.switcher")}</th>
                    <th scope="col"><span className="sr-only">{t("clients.col.details")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {status.clients.map(client => {
                    const open = expanded.has(client.id);
                    const manageHash = MANAGE_HASH[client.id];
                    return (
                      <tr key={client.id} className={open ? "clients-row open" : "clients-row"}>
                        <td>
                          <button
                            type="button"
                            className="clients-expand"
                            onClick={() => toggle(client.id)}
                            aria-expanded={open}
                          >
                            <IconChevron
                              width={12}
                              height={12}
                              aria-hidden="true"
                              style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}
                            />
                            <strong>{client.label}</strong>
                          </button>
                        </td>
                        <td>
                          <span className={VERDICT_BADGE[client.verdict]}>
                            {t(VERDICT_TKEY[client.verdict])}
                          </span>
                        </td>
                        <td>
                          <code className="clients-mono">{client.baseUrl ?? "—"}</code>
                        </td>
                        <td>
                          <code className="clients-mono">{client.model ?? "—"}</code>
                        </td>
                        <td>
                          <span className="clients-muted">{client.launcher ?? "—"}</span>
                        </td>
                        <td>
                          <span className="clients-muted">
                            {client.switcher?.name
                              ? `${client.switcher.name} (${client.switcher.appType})`
                              : "—"}
                          </span>
                        </td>
                        <td>
                          {manageHash && (
                            <a className="clients-manage" href={`#${manageHash}`}>
                              {t("clients.manage")}
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {status.clients.map(client => {
              if (!expanded.has(client.id)) return null;
              return (
                <div key={`detail-${client.id}`} className="clients-detail" id={`clients-detail-${client.id}`}>
                  <h3>{client.label}</h3>
                  <dl className="clients-dl">
                    <dt>{t("clients.col.configPaths")}</dt>
                    <dd>
                      {client.configPaths.length === 0 ? (
                        <span className="clients-muted">—</span>
                      ) : (
                        <ul className="clients-paths">
                          {client.configPaths.map(p => (
                            <li key={p}><code className="clients-mono">{displayPath(p)}</code></li>
                          ))}
                        </ul>
                      )}
                    </dd>
                    <dt>{t("clients.col.notes")}</dt>
                    <dd>
                      {client.notes.length === 0 ? (
                        <span className="clients-muted">{t("clients.noNotes")}</span>
                      ) : (
                        <ul className="clients-notes">
                          {client.notes.map((note, i) => (
                            <li key={`${client.id}-note-${i}`}>{note}</li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </dl>
                </div>
              );
            })}
          </section>

          <p className="clients-footer-hint">
            {t("clients.exportHint")}{" "}
            <a href="#api">{t("nav.api")}</a>
          </p>
        </>
      )}
    </div>
  );
}
