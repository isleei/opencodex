import { useEffect, useState, type FormEvent } from "react";
import { useT } from "../../i18n/shared";
import { IconX, IconServer, IconPlus, IconTrash, IconEye, IconEyeOff } from "../../icons";
import { Notice, Select, Switch } from "../../ui";
import type { McpClientType, McpTransportType, UnifiedMcpServer } from "./skills-mcp-types";

interface McpServerDialogProps {
  isOpen: boolean;
  server: UnifiedMcpServer | null;
  defaultClient?: McpClientType;
  isCreateMode?: boolean;
  onClose: () => void;
  onSave: (data: {
    client: McpClientType;
    id: string;
    transport: McpTransportType;
    command?: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    url?: string;
    enabled: boolean;
  }) => Promise<void>;
}

interface EnvRow {
  id: string;
  key: string;
  value: string;
}

export default function McpServerDialog({
  isOpen,
  server,
  defaultClient = "claude_desktop",
  isCreateMode = false,
  onClose,
  onSave,
}: McpServerDialogProps) {
  const t = useT();
  const [client, setClient] = useState<McpClientType>(defaultClient);
  const [serverId, setServerId] = useState("");
  const [transport, setTransport] = useState<McpTransportType>("stdio");
  const [command, setCommand] = useState("");
  const [argsInput, setArgsInput] = useState("");
  const [cwd, setCwd] = useState("");
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [showSecrets, setShowSecrets] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (server && !isCreateMode) {
        setClient(server.client);
        setServerId(server.id);
        setTransport(server.transport || (server.url ? "sse" : "stdio"));
        setCommand(server.command || "");
        setArgsInput((server.args || []).join(" "));
        setCwd(server.cwd || "");
        setUrl(server.url || "");
        setEnabled(server.enabled !== false);

        const rows: EnvRow[] = Object.entries(server.env || {}).map(([k, v], idx) => ({
          id: `env-${idx}-${k}`,
          key: k,
          value: v,
        }));
        setEnvRows(rows);
      } else {
        setClient(defaultClient);
        setServerId("");
        setTransport("stdio");
        setCommand("npx");
        setArgsInput("-y");
        setCwd("");
        setUrl("");
        setEnabled(true);
        setEnvRows([]);
      }
      setErrorMessage(null);
      setShowSecrets(false);
    }
  }, [isOpen, server, isCreateMode, defaultClient]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const clientOptions = [
    { value: "claude_desktop", label: t("skillsMcp.mcp.client.claudeDesktop") },
    { value: "claude_code", label: t("skillsMcp.mcp.client.claudeCode") },
    { value: "codex", label: t("skillsMcp.mcp.client.codex") },
    { value: "antigravity", label: t("skillsMcp.mcp.client.antigravity") },
  ];

  const transportOptions = [
    { value: "stdio", label: "stdio" },
    { value: "sse", label: "sse / http" },
  ];

  const handleAddEnvRow = () => {
    setEnvRows(prev => [...prev, { id: `env-${Date.now()}`, key: "", value: "" }]);
  };

  const handleRemoveEnvRow = (id: string) => {
    setEnvRows(prev => prev.filter(r => r.id !== id));
  };

  const handleEnvChange = (id: string, field: "key" | "value", val: string) => {
    setEnvRows(prev => prev.map(r => (r.id === id ? { ...r, [field]: val } : r)));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanId = serverId.trim();
    if (!cleanId) {
      setErrorMessage(t("skillsMcp.mcp.modal.errorIdRequired"));
      return;
    }

    if (transport === "stdio" && !command.trim()) {
      setErrorMessage(t("skillsMcp.mcp.modal.errorCommandRequired"));
      return;
    }

    if (transport === "sse" && !url.trim()) {
      setErrorMessage(t("skillsMcp.mcp.modal.errorUrlRequired"));
      return;
    }

    // Parse args
    const parsedArgs = argsInput
      .split(/\s+/)
      .map(a => a.trim())
      .filter(Boolean);

    // Build env map
    const envMap: Record<string, string> = {};
    for (const row of envRows) {
      const k = row.key.trim();
      if (k) {
        envMap[k] = row.value;
      }
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await onSave({
        client,
        id: cleanId,
        transport,
        command: transport === "stdio" ? command.trim() : undefined,
        args: transport === "stdio" ? parsedArgs : [],
        env: envMap,
        cwd: cwd.trim() ? cwd.trim() : undefined,
        url: transport === "sse" ? url.trim() : undefined,
        enabled,
      });
      onClose();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-dialog-title"
      className="modal-overlay"
    >
      <div className="modal-card modal-card--medium">
        <div className="modal-head">
          <div className="modal-head-title">
            <IconServer />
            <h3 id="mcp-dialog-title">
              {isCreateMode
                ? t("skillsMcp.mcp.modal.createTitle")
                : t("skillsMcp.mcp.modal.editTitle", { id: server?.id ?? "" })}
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <IconX />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body-form">
          {errorMessage && (
            <div className="modal-notice-wrap">
              <Notice tone="err">{errorMessage}</Notice>
            </div>
          )}

          <div className="form-grid-two">
            <div className="field">
              <label htmlFor="mcp-client-select" className="text-label">
                {t("skillsMcp.mcp.modal.fieldClient")}
              </label>
              <Select
                id="mcp-client-select"
                value={client}
                options={clientOptions}
                onChange={v => setClient(v as McpClientType)}
                disabled={!isCreateMode || submitting}
                style={{ width: "100%" }}
              />
            </div>

            <div className="field">
              <label htmlFor="mcp-transport-select" className="text-label">
                {t("skillsMcp.mcp.modal.fieldTransport")}
              </label>
              <Select
                id="mcp-transport-select"
                value={transport}
                options={transportOptions}
                onChange={v => setTransport(v as McpTransportType)}
                disabled={submitting}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="mcp-server-id" className="text-label">
              {t("skillsMcp.mcp.modal.fieldServerId")}
            </label>
            <input
              id="mcp-server-id"
              type="text"
              className="input font-mono"
              value={serverId}
              onChange={e => setServerId(e.target.value)}
              disabled={!isCreateMode || submitting}
              placeholder={t("skillsMcp.mcp.modal.placeholderServerId")}
              required
            />
          </div>

          {transport === "stdio" ? (
            <>
              <div className="field">
                <label htmlFor="mcp-command" className="text-label">
                  {t("skillsMcp.mcp.modal.fieldCommand")}
                </label>
                <input
                  id="mcp-command"
                  type="text"
                  className="input font-mono"
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  disabled={submitting}
                  placeholder="npx, uvx, node, python"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="mcp-args" className="text-label">
                  {t("skillsMcp.mcp.modal.fieldArgs")}
                </label>
                <input
                  id="mcp-args"
                  type="text"
                  className="input font-mono"
                  value={argsInput}
                  onChange={e => setArgsInput(e.target.value)}
                  disabled={submitting}
                  placeholder="-y @modelcontextprotocol/server-memory"
                />
              </div>

              <div className="field">
                <label htmlFor="mcp-cwd" className="text-label">
                  {t("skillsMcp.mcp.modal.fieldCwd")}
                </label>
                <input
                  id="mcp-cwd"
                  type="text"
                  className="input font-mono"
                  value={cwd}
                  onChange={e => setCwd(e.target.value)}
                  disabled={submitting}
                  placeholder="/Users/username/project"
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="mcp-url" className="text-label">
                {t("skillsMcp.mcp.modal.fieldUrl")}
              </label>
              <input
                id="mcp-url"
                type="url"
                className="input font-mono"
                value={url}
                onChange={e => setUrl(e.target.value)}
                disabled={submitting}
                placeholder="https://mcp.example.com/sse"
                required
              />
            </div>
          )}

          <div className="field field--switch-row">
            <span className="text-label">{t("skillsMcp.mcp.modal.fieldEnabled")}</span>
            <Switch
              on={enabled}
              onClick={() => setEnabled(prev => !prev)}
              disabled={submitting}
              label={t("skillsMcp.mcp.modal.fieldEnabled")}
            />
          </div>

          <div className="mcp-env-section">
            <div className="mcp-env-header">
              <span className="text-label">{t("skillsMcp.mcp.modal.envHeader")}</span>
              <div className="mcp-env-controls">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setShowSecrets(prev => !prev)}
                  title={t(showSecrets ? "skillsMcp.mcp.maskSecrets" : "skillsMcp.mcp.showSecrets")}
                >
                  {showSecrets ? <IconEyeOff /> : <IconEye />}
                  <span>{t(showSecrets ? "skillsMcp.mcp.maskSecrets" : "skillsMcp.mcp.showSecrets")}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={handleAddEnvRow}
                  disabled={submitting}
                >
                  <IconPlus /> <span>{t("skillsMcp.mcp.modal.addEnvVar")}</span>
                </button>
              </div>
            </div>

            {envRows.length === 0 ? (
              <p className="text-muted text-xs mcp-env-empty">
                {t("skillsMcp.mcp.modal.envEmptyNote")}
              </p>
            ) : (
              <div className="mcp-env-rows">
                {envRows.map(row => (
                  <div key={row.id} className="mcp-env-row">
                    <input
                      type="text"
                      className="input input-sm font-mono"
                      placeholder="KEY"
                      value={row.key}
                      onChange={e => handleEnvChange(row.id, "key", e.target.value)}
                      disabled={submitting}
                    />
                    <span className="mcp-env-equals">=</span>
                    <input
                      type={showSecrets ? "text" : "password"}
                      className="input input-sm font-mono"
                      placeholder="VALUE"
                      value={row.value}
                      onChange={e => handleEnvChange(row.id, "value", e.target.value)}
                      disabled={submitting}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => handleRemoveEnvRow(row.id)}
                      disabled={submitting}
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                    >
                      <IconTrash />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              disabled={submitting}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={submitting}
            >
              {submitting ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
