import { useEffect, useState, type FormEvent } from "react";
import { useT } from "../../i18n/shared";
import { IconX, IconCopy } from "../../icons";
import { Notice, Select } from "../../ui";
import type { McpClientType, McpCloneOptions, UnifiedMcpServer } from "./skills-mcp-types";

interface McpCloneDialogProps {
  isOpen: boolean;
  sourceServer: UnifiedMcpServer | null;
  onClose: () => void;
  onClone: (options: McpCloneOptions) => Promise<void>;
}

export default function McpCloneDialog({
  isOpen,
  sourceServer,
  onClose,
  onClone,
}: McpCloneDialogProps) {
  const t = useT();
  const [targetClient, setTargetClient] = useState<McpClientType>("claude_code");
  const [newId, setNewId] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const allClients: McpClientType[] = ["claude_desktop", "claude_code", "codex", "antigravity"];

  useEffect(() => {
    if (isOpen && sourceServer) {
      const remainingClients = allClients.filter(c => c !== sourceServer.client);
      setTargetClient(remainingClients[0] || "claude_code");
      setNewId(sourceServer.id);
      setOverwrite(false);
      setErrorMessage(null);
    }
  }, [isOpen, sourceServer]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !sourceServer) return null;

  const targetClientOptions = allClients
    .filter(c => c !== sourceServer.client)
    .map(c => ({
      value: c,
      label: t(
        c === "claude_desktop"
          ? "skillsMcp.mcp.client.claudeDesktop"
          : c === "claude_code"
          ? "skillsMcp.mcp.client.claudeCode"
          : c === "codex"
          ? "skillsMcp.mcp.client.codex"
          : "skillsMcp.mcp.client.antigravity"
      ),
    }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanNewId = newId.trim() || sourceServer.id;

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await onClone({
        fromClient: sourceServer.client,
        toClient: targetClient,
        serverId: sourceServer.id,
        newId: cleanNewId !== sourceServer.id ? cleanNewId : undefined,
        overwrite,
      });
      onClose();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const getClientLabel = (clientType: McpClientType) => {
    if (clientType === "claude_desktop") return t("skillsMcp.mcp.client.claudeDesktop");
    if (clientType === "claude_code") return t("skillsMcp.mcp.client.claudeCode");
    if (clientType === "codex") return t("skillsMcp.mcp.client.codex");
    return t("skillsMcp.mcp.client.antigravity");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-clone-title"
      className="modal-overlay"
    >
      <div className="modal-card modal-card--medium">
        <div className="modal-head">
          <div className="modal-head-title">
            <IconCopy />
            <h3 id="mcp-clone-title">{t("skillsMcp.mcp.clone.modalTitle")}</h3>
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
          <p className="modal-subtitle">
            {t("skillsMcp.mcp.clone.modalSubtitle", {
              id: sourceServer.id,
              client: getClientLabel(sourceServer.client),
            })}
          </p>

          {errorMessage && (
            <div className="modal-notice-wrap">
              <Notice tone="err">{errorMessage}</Notice>
            </div>
          )}

          <div className="field">
            <label className="text-label">{t("skillsMcp.mcp.clone.sourceLabel")}</label>
            <div className="card card--inset mcp-clone-source-card">
              <span className="font-mono font-bold">{sourceServer.id}</span>
              <span className="badge badge--neutral">{getClientLabel(sourceServer.client)}</span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="mcp-clone-target-client" className="text-label">
              {t("skillsMcp.mcp.clone.targetClientLabel")}
            </label>
            <Select
              id="mcp-clone-target-client"
              value={targetClient}
              options={targetClientOptions}
              onChange={v => setTargetClient(v as McpClientType)}
              disabled={submitting}
              style={{ width: "100%" }}
            />
          </div>

          <div className="field">
            <label htmlFor="mcp-clone-new-id" className="text-label">
              {t("skillsMcp.mcp.clone.newIdLabel")}
            </label>
            <input
              id="mcp-clone-new-id"
              type="text"
              className="input font-mono"
              value={newId}
              onChange={e => setNewId(e.target.value)}
              disabled={submitting}
              placeholder={sourceServer.id}
            />
          </div>

          <div className="field field--checkbox">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={e => setOverwrite(e.target.checked)}
                disabled={submitting}
              />
              <span>{t("skillsMcp.mcp.clone.overwriteLabel")}</span>
            </label>
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
              <IconCopy /> {submitting ? t("common.saving") : t("skillsMcp.mcp.clone.cloneBtn")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
