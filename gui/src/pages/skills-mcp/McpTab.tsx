import { useCallback, useMemo, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  IconSearch,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconPencil,
  IconCopy,
  IconCheck,
  IconServer,
  IconEye,
  IconEyeOff,
  IconTerminal,
  IconMonitor,
  IconBot,
  IconKey,
  IconX,
  IconGlobe,
  IconList,
  IconGrid,
} from "../../icons";
import { EmptyState, Notice, Switch, ToastNotice } from "../../ui";
import { readJsonOrThrow } from "../../fetch-json";
import { useKeyedClientResource } from "../../client-resource";
import McpServerDialog from "./McpServerDialog";
import McpCloneDialog from "./McpCloneDialog";
import {
  MCP_CLIENT_INFO,
  type McpClientType,
  type McpCloneOptions,
  type McpTransportType,
  type UnifiedMcpServer,
} from "./skills-mcp-types";

interface McpTabProps {
  apiBase: string;
  active: boolean;
}

const CLIENT_ORDER: McpClientType[] = [
  "claude_desktop",
  "claude_code",
  "codex",
  "antigravity",
];

export default function McpTab({ apiBase, active }: McpTabProps) {
  const t = useT();

  // Search and filter
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedClient, setSelectedClient] = useState<McpClientType | "all">("all");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [showGlobalSecrets, setShowGlobalSecrets] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modals
  const [editingServer, setEditingServer] = useState<UnifiedMcpServer | null>(null);
  const [cloningServer, setCloningServer] = useState<UnifiedMcpServer | null>(null);
  const [isServerDialogOpen, setIsServerDialogOpen] = useState(false);
  const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false);
  const [dialogClient, setDialogClient] = useState<McpClientType>("claude_desktop");
  const [isCreateMode, setIsCreateMode] = useState(false);

  // Toast feedback
  const [toastFeedback, setToastFeedback] = useState<{
    tone: "ok" | "warn" | "err";
    message: string;
  } | null>(null);

  // Fetch all MCP servers
  const mcpResource = useKeyedClientResource(
    `mcp-servers:${apiBase}`,
    [apiBase],
    async signal => {
      const res = await fetch(`${apiBase}/api/mcp`, { signal });
      const data = await readJsonOrThrow<{ servers?: UnifiedMcpServer[] }>(
        res,
        "Failed to load MCP servers"
      );
      return data?.servers || [];
    },
    { pollMs: active ? 10_000 : 0 }
  );

  const servers = mcpResource.data || [];

  // Group servers by client
  const serversByClient = useMemo(() => {
    const map: Record<McpClientType, UnifiedMcpServer[]> = {
      claude_desktop: [],
      claude_code: [],
      codex: [],
      antigravity: [],
    };

    for (const server of servers) {
      if (map[server.client]) {
        // Filter by search query if present
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase().trim();
          const inId = (server.id || "").toLowerCase().includes(q);
          const inCmd = (server.command || "").toLowerCase().includes(q);
          const inUrl = (server.url || "").toLowerCase().includes(q);
          const inArgs = (server.args || []).some(a => a.toLowerCase().includes(q));
          const inEnv = Object.entries(server.env || {}).some(
            ([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q)
          );
          if (!inId && !inCmd && !inUrl && !inArgs && !inEnv) continue;
        }
        map[server.client].push(server);
      }
    }

    return map;
  }, [servers, searchQuery]);

  // Flat list of filtered servers for table view
  const flatFilteredServers = useMemo(() => {
    const list: UnifiedMcpServer[] = [];
    for (const clientType of CLIENT_ORDER) {
      if (selectedClient === "all" || selectedClient === clientType) {
        list.push(...serversByClient[clientType]);
      }
    }
    return list;
  }, [serversByClient, selectedClient]);

  // Actions
  const handleToggle = useCallback(
    async (server: UnifiedMcpServer) => {
      const nextEnabled = !server.enabled;
      try {
        const res = await fetch(
          `${apiBase}/api/mcp/${encodeURIComponent(server.client)}/${encodeURIComponent(
            server.id
          )}/toggle`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: nextEnabled }),
          }
        );
        await readJsonOrThrow(res, "Failed to toggle MCP server");
        void mcpResource.refresh();
      } catch (err: unknown) {
        setToastFeedback({
          tone: "err",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [apiBase, mcpResource]
  );

  const handleSaveServer = async (data: {
    client: McpClientType;
    id: string;
    transport: McpTransportType;
    command?: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    url?: string;
    enabled: boolean;
  }) => {
    if (isCreateMode) {
      const res = await fetch(`${apiBase}/api/mcp/${encodeURIComponent(data.client)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      await readJsonOrThrow(res, "Failed to add MCP server");
      setToastFeedback({
        tone: "ok",
        message: t("skillsMcp.mcp.addSuccess", { id: data.id }),
      });
    } else {
      const res = await fetch(
        `${apiBase}/api/mcp/${encodeURIComponent(data.client)}/${encodeURIComponent(data.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      );
      await readJsonOrThrow(res, "Failed to update MCP server");
      setToastFeedback({
        tone: "ok",
        message: t("skillsMcp.mcp.updateSuccess", { id: data.id }),
      });
    }
    void mcpResource.refresh();
  };

  const handleDeleteServer = async (clientType: McpClientType, serverId: string) => {
    const res = await fetch(
      `${apiBase}/api/mcp/${encodeURIComponent(clientType)}/${encodeURIComponent(serverId)}`,
      {
        method: "DELETE",
      }
    );
    await readJsonOrThrow(res, "Failed to delete MCP server");
    setToastFeedback({
      tone: "ok",
      message: t("skillsMcp.mcp.deleteSuccess", { id: serverId }),
    });
    void mcpResource.refresh();
  };

  const handleCloneServer = async (options: McpCloneOptions) => {
    const res = await fetch(`${apiBase}/api/mcp/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    await readJsonOrThrow(res, "Failed to clone MCP server");
    setToastFeedback({
      tone: "ok",
      message: t("skillsMcp.mcp.cloneSuccess", {
        id: options.newId || options.serverId,
        target: t(MCP_CLIENT_INFO[options.toClient].labelKey),
      }),
    });
    void mcpResource.refresh();
  };

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const openAddDialog = (clientType: McpClientType = "claude_desktop") => {
    setEditingServer(null);
    setDialogClient(clientType);
    setIsCreateMode(true);
    setIsServerDialogOpen(true);
  };

  const openEditDialog = (server: UnifiedMcpServer) => {
    setEditingServer(server);
    setDialogClient(server.client);
    setIsCreateMode(false);
    setIsServerDialogOpen(true);
  };

  const openCloneDialog = (server: UnifiedMcpServer) => {
    setCloningServer(server);
    setIsCloneDialogOpen(true);
  };

  const renderClientIcon = (clientType: McpClientType) => {
    switch (clientType) {
      case "claude_desktop":
        return <IconMonitor />;
      case "claude_code":
        return <IconTerminal />;
      case "codex":
        return <IconKey />;
      case "antigravity":
        return <IconBot />;
    }
  };

  const totalCount = servers.length;
  const activeCount = servers.filter(s => s.enabled).length;
  const totalFilteredCount = Object.values(serversByClient).reduce(
    (acc, list) => acc + list.length,
    0
  );

  const displayedClients = selectedClient === "all"
    ? CLIENT_ORDER
    : [selectedClient];

  return (
    <div className="mcp-tab-pane">
      {toastFeedback && (
        <ToastNotice
          tone={toastFeedback.tone}
          onDismiss={() => setToastFeedback(null)}
          dismissLabel={t("common.close")}
        >
          {toastFeedback.message}
        </ToastNotice>
      )}

      {/* Summary & Primary Actions Header */}
      <div className="mcp-summary-bar">
        <div className="mcp-summary-stats">
          <div className="mcp-stat-cell">
            <span className="stat-label">Total Servers</span>
            <span className="stat-val font-mono">{totalCount}</span>
          </div>
          <div className="mcp-stat-cell">
            <span className="stat-label">Active</span>
            <span className="stat-val font-mono">{activeCount}</span>
          </div>
          <div className="mcp-stat-cell">
            <span className="stat-label">Clients</span>
            <span className="stat-val font-mono">{CLIENT_ORDER.length}</span>
          </div>
        </div>

        <div className="mcp-summary-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowGlobalSecrets(prev => !prev)}
            title={t(showGlobalSecrets ? "skillsMcp.mcp.maskSecrets" : "skillsMcp.mcp.showSecrets")}
          >
            {showGlobalSecrets ? <IconEyeOff /> : <IconEye />}
            <span>
              {t(showGlobalSecrets ? "skillsMcp.mcp.maskSecrets" : "skillsMcp.mcp.showSecrets")}
            </span>
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => mcpResource.refresh()}
            disabled={mcpResource.refreshing}
            title={t("common.retry")}
          >
            <IconRefresh className={mcpResource.refreshing ? "spin" : ""} />
            <span>{t("common.retry")}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => openAddDialog(selectedClient === "all" ? "claude_desktop" : selectedClient)}
          >
            <IconPlus /> <span>{t("skillsMcp.mcp.addServerBtn")}</span>
          </button>
        </div>
      </div>

      {/* Compact Filter & View Toolbar */}
      <div className="mcp-toolbar-compact">
        {/* Client Filter Pills */}
        <div className="mcp-client-filter-pills" role="tablist">
          <button
            type="button"
            className={`filter-pill-btn${selectedClient === "all" ? " active" : ""}`}
            onClick={() => setSelectedClient("all")}
          >
            <IconServer />
            <span>All Clients</span>
            <span className="pill-count">{totalCount}</span>
          </button>
          {CLIENT_ORDER.map(clientKey => {
            const count = (serversByClient[clientKey] || []).length;
            const isSelected = selectedClient === clientKey;
            const info = MCP_CLIENT_INFO[clientKey];
            return (
              <button
                key={clientKey}
                type="button"
                className={`filter-pill-btn${isSelected ? " active" : ""}`}
                onClick={() => setSelectedClient(clientKey)}
              >
                {renderClientIcon(clientKey)}
                <span>{t(info.labelKey)}</span>
                <span className="pill-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Search and View Mode */}
        <div className="mcp-search-and-view">
          <div className="mcp-toolbar-search">
            <IconSearch className="search-icon" />
            <input
              type="text"
              className="input mcp-search-input"
              placeholder={t("skillsMcp.mcp.searchPlaceholder")}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-xs search-clear"
                onClick={() => setSearchQuery("")}
                aria-label={t("common.close")}
              >
                <IconX />
              </button>
            )}
          </div>

          <div className="mcp-view-toggle segmented-view-controls">
            <button
              type="button"
              className={`segmented-btn${viewMode === "cards" ? " active" : ""}`}
              onClick={() => setViewMode("cards")}
              title="Cards View"
            >
              <IconGrid /> <span>Cards</span>
            </button>
            <button
              type="button"
              className={`segmented-btn${viewMode === "table" ? " active" : ""}`}
              onClick={() => setViewMode("table")}
              title="Table View"
            >
              <IconList /> <span>Table</span>
            </button>
          </div>
        </div>
      </div>

      {mcpResource.error ? (
        <Notice tone="err">
          {mcpResource.error instanceof Error ? mcpResource.error.message : String(mcpResource.error)}
        </Notice>
      ) : totalFilteredCount === 0 && searchQuery ? (
        <EmptyState
          icon={<IconServer style={{ width: 36, height: 36, opacity: 0.4 }} />}
          title={t("skillsMcp.mcp.emptyFilteredTitle")}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSearchQuery("")}
          >
            {t("skillsMcp.skills.resetFiltersBtn")}
          </button>
        </EmptyState>
      ) : viewMode === "table" ? (
        /* ================= TABLE VIEW ================= */
        <div className="mcp-table-wrap">
          <table className="skills-tbl mcp-tbl">
            <thead>
              <tr>
                <th style={{ width: 64 }}>Status</th>
                <th style={{ width: 140 }}>Client</th>
                <th style={{ width: 180 }}>Server ID</th>
                <th style={{ width: 110 }}>Transport</th>
                <th>Command / Endpoint</th>
                <th style={{ width: 180 }}>Environment</th>
                <th style={{ width: 110, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {flatFilteredServers.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
                    {t("skillsMcp.mcp.noServersConfigured")}
                  </td>
                </tr>
              ) : (
                flatFilteredServers.map(srv => {
                  const clientInfo = MCP_CLIENT_INFO[srv.client];
                  const envEntries = Object.entries(srv.env || {});
                  const cmdText = srv.transport === "sse" || srv.url
                    ? (srv.url || "")
                    : `${srv.command || ""} ${(srv.args || []).join(" ")}`.trim();
                  const isCopied = copiedId === `${srv.client}:${srv.id}`;

                  return (
                    <tr key={`${srv.client}:${srv.id}`} className={!srv.enabled ? "row-disabled" : ""}>
                      {/* 1. Status Toggle */}
                      <td>
                        <Switch
                          on={srv.enabled}
                          onClick={() => void handleToggle(srv)}
                          label={t("skillsMcp.mcp.toggleAria", { id: srv.id })}
                        />
                      </td>

                      {/* 2. Client */}
                      <td>
                        <span className="mcp-client-badge-cell">
                          {renderClientIcon(srv.client)}
                          <span>{t(clientInfo.labelKey)}</span>
                        </span>
                      </td>

                      {/* 3. Server ID */}
                      <td>
                        <div className="mcp-id-cell font-mono font-bold">
                          {srv.id}
                        </div>
                      </td>

                      {/* 4. Transport & Scope */}
                      <td>
                        <div className="mcp-badges-stack">
                          <span
                            className={`badge badge--xs ${
                              srv.transport === "sse" ? "badge--accent" : "badge--neutral"
                            }`}
                          >
                            {srv.transport || "stdio"}
                          </span>
                          {srv.scope === "project" && (
                            <span className="badge badge--project badge--xs">
                              {t("skillsMcp.mcp.scopeProject")}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 5. Command / URL */}
                      <td>
                        <div className="mcp-cmd-cell">
                          <code className="mcp-code-snippet font-mono text-xs" title={cmdText}>
                            {cmdText}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-xs copy-btn"
                            onClick={() => copyToClipboard(cmdText, `${srv.client}:${srv.id}`)}
                            title="Copy command"
                          >
                            {isCopied ? <IconCheck style={{ color: "var(--green)" }} /> : <IconCopy />}
                          </button>
                        </div>
                        {srv.cwd && (
                          <div className="text-muted text-xs font-mono" style={{ marginTop: 2 }}>
                            cwd: {srv.cwd}
                          </div>
                        )}
                      </td>

                      {/* 6. Environment Variables */}
                      <td>
                        {envEntries.length === 0 ? (
                          <span className="text-muted text-xs">—</span>
                        ) : (
                          <div className="mcp-env-chips-compact">
                            {envEntries.map(([k, v]) => (
                              <span key={k} className="mcp-env-chip text-xs font-mono" title={`${k}=${v}`}>
                                <span className="env-key">{k}</span>=
                                <span className="env-val">{showGlobalSecrets ? v : "••••"}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* 7. Actions */}
                      <td>
                        <div className="cell-action-btns">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            onClick={() => openEditDialog(srv)}
                            title={t("skillsMcp.mcp.editBtn")}
                            aria-label={t("skillsMcp.mcp.editBtn")}
                          >
                            <IconPencil />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            onClick={() => openCloneDialog(srv)}
                            title={t("skillsMcp.mcp.cloneBtn")}
                            aria-label={t("skillsMcp.mcp.cloneBtn")}
                          >
                            <IconCopy />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm btn-danger-hover"
                            onClick={() => void handleDeleteServer(srv.client, srv.id)}
                            title={t("common.delete")}
                            aria-label={t("common.delete")}
                          >
                            <IconTrash />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* ================= CARDS VIEW ================= */
        <div className="mcp-clients-sections">
          {displayedClients.map(clientType => {
            const clientInfo = MCP_CLIENT_INFO[clientType];
            const clientServers = serversByClient[clientType];

            return (
              <div key={clientType} className="card mcp-client-card mcp-client-section-card">
                <div className="mcp-client-header">
                  <div className="mcp-client-header-title">
                    <div className="mcp-client-icon">{renderClientIcon(clientType)}</div>
                    <div>
                      <h4 className="mcp-client-name">{t(clientInfo.labelKey)}</h4>
                      <span className="text-muted text-xs font-mono mcp-path-hint">
                        {clientInfo.configPathHint}
                      </span>
                    </div>
                  </div>
                  <div className="mcp-client-header-actions">
                    <span className="badge badge--neutral badge--xs">
                      {t("skillsMcp.mcp.serverCount", { count: String(clientServers.length) })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => openAddDialog(clientType)}
                      title={t("skillsMcp.mcp.addServerToClient", {
                        client: t(clientInfo.labelKey),
                      })}
                    >
                      <IconPlus /> <span>{t("skillsMcp.mcp.addServerBtn")}</span>
                    </button>
                  </div>
                </div>

                <div className="mcp-client-body">
                  {clientServers.length === 0 ? (
                    <div className="mcp-client-empty">
                      <p className="text-muted text-xs">{t("skillsMcp.mcp.noServersConfigured")}</p>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => openAddDialog(clientType)}
                      >
                        <IconPlus /> {t("skillsMcp.mcp.addServerBtn")}
                      </button>
                    </div>
                  ) : (
                    <div className="mcp-servers-grid">
                      {clientServers.map(srv => {
                        const envEntries = Object.entries(srv.env || {});
                        const cmdText = srv.transport === "sse" || srv.url
                          ? (srv.url || "")
                          : `${srv.command || ""} ${(srv.args || []).join(" ")}`.trim();
                        const isCopied = copiedId === `${srv.client}:${srv.id}`;

                        return (
                          <div
                            key={srv.id}
                            className={`mcp-server-item card card--inset${
                              !srv.enabled ? " mcp-server-item--disabled" : ""
                            }`}
                          >
                            {/* Server Header */}
                            <div className="mcp-server-row-head">
                              <div className="mcp-server-title-row">
                                <Switch
                                  on={srv.enabled}
                                  onClick={() => void handleToggle(srv)}
                                  label={t("skillsMcp.mcp.toggleAria", { id: srv.id })}
                                />
                                <span className="mcp-server-id font-mono font-bold">
                                  {srv.id}
                                </span>
                                <span
                                  className={`badge badge--xs ${
                                    srv.transport === "sse" ? "badge--accent" : "badge--neutral"
                                  }`}
                                >
                                  {srv.transport || "stdio"}
                                </span>
                                {srv.scope === "project" && (
                                  <span className="badge badge--project badge--xs">
                                    {t("skillsMcp.mcp.scopeProject")}
                                  </span>
                                )}
                              </div>

                              <div className="mcp-server-actions">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon btn-sm"
                                  onClick={() => openEditDialog(srv)}
                                  title={t("skillsMcp.mcp.editBtn")}
                                  aria-label={t("skillsMcp.mcp.editBtn")}
                                >
                                  <IconPencil />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon btn-sm"
                                  onClick={() => openCloneDialog(srv)}
                                  title={t("skillsMcp.mcp.cloneBtn")}
                                  aria-label={t("skillsMcp.mcp.cloneBtn")}
                                >
                                  <IconCopy />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon btn-sm btn-danger-hover"
                                  onClick={() => void handleDeleteServer(srv.client, srv.id)}
                                  title={t("common.delete")}
                                  aria-label={t("common.delete")}
                                >
                                  <IconTrash />
                                </button>
                              </div>
                            </div>

                            {/* Command Snippet */}
                            <div className="mcp-server-cmd-box">
                              <div className="mcp-cmd-inner">
                                {srv.transport === "sse" || srv.url ? (
                                  <span className="mcp-url-text font-mono text-xs">
                                    <IconGlobe style={{ width: 12, height: 12, display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                                    {srv.url}
                                  </span>
                                ) : (
                                  <span className="mcp-cmd-text font-mono text-xs">
                                    <span className="cmd-name">{srv.command}</span>{" "}
                                    <span className="cmd-args">{(srv.args || []).join(" ")}</span>
                                  </span>
                                )}
                              </div>
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon btn-xs copy-btn"
                                onClick={() => copyToClipboard(cmdText, `${srv.client}:${srv.id}`)}
                                title="Copy command"
                              >
                                {isCopied ? <IconCheck style={{ color: "var(--green)" }} /> : <IconCopy />}
                              </button>
                            </div>

                            {/* CWD if present */}
                            {srv.cwd && (
                              <div className="mcp-server-cwd text-xs text-muted font-mono">
                                cwd: {srv.cwd}
                              </div>
                            )}

                            {/* Environment Variables */}
                            {envEntries.length > 0 && (
                              <div className="mcp-server-env-chips">
                                {envEntries.map(([k, v]) => (
                                  <span
                                    key={k}
                                    className="mcp-env-chip text-xs font-mono"
                                    title={`${k}=${v}`}
                                  >
                                    <span className="env-key">{k}</span>=
                                    <span className="env-val">
                                      {showGlobalSecrets ? v : "••••••"}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isServerDialogOpen && (
        <McpServerDialog
          isOpen={isServerDialogOpen}
          server={editingServer}
          defaultClient={dialogClient}
          isCreateMode={isCreateMode}
          onClose={() => setIsServerDialogOpen(false)}
          onSave={handleSaveServer}
        />
      )}

      {isCloneDialogOpen && cloningServer && (
        <McpCloneDialog
          isOpen={isCloneDialogOpen}
          sourceServer={cloningServer}
          onClose={() => setIsCloneDialogOpen(false)}
          onClone={handleCloneServer}
        />
      )}
    </div>
  );
}
