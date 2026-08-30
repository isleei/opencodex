import { useState } from "react";
import { useT } from "../../i18n/shared";
import { IconX, IconTrash, IconRefresh, IconCheck } from "../../icons";
import { EmptyState, Notice } from "../../ui";
import type { TrashRecord } from "./skills-mcp-types";

interface SkillsTrashModalProps {
  isOpen: boolean;
  trashItems: TrashRecord[];
  isLoading: boolean;
  onClose: () => void;
  onRestore: (trashId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function SkillsTrashModal({
  isOpen,
  trashItems,
  isLoading,
  onClose,
  onRestore,
  onRefresh,
}: SkillsTrashModalProps) {
  const t = useT();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; message: string } | null>(null);

  if (!isOpen) return null;

  const handleRestore = async (trashId: string, skillName: string) => {
    setRestoringId(trashId);
    setFeedback(null);
    try {
      await onRestore(trashId);
      setFeedback({
        tone: "ok",
        message: t("skillsMcp.skills.trash.restoreSuccess", { name: skillName }),
      });
    } catch (err: unknown) {
      setFeedback({
        tone: "err",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="skills-trash-modal-title"
      className="modal-overlay"
    >
      <div className="modal-card modal-card--medium">
        <div className="modal-head">
          <div className="modal-head-title">
            <IconTrash />
            <h3 id="skills-trash-modal-title">{t("skillsMcp.skills.trash.modalTitle")}</h3>
          </div>
          <div className="modal-head-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => void onRefresh()}
              disabled={isLoading}
              title={t("common.retry")}
              aria-label={t("common.retry")}
            >
              <IconRefresh />
            </button>
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
        </div>

        <div className="modal-body">
          <p className="modal-subtitle">{t("skillsMcp.skills.trash.modalSubtitle")}</p>

          {feedback && (
            <div className="modal-notice-wrap">
              <Notice tone={feedback.tone}>{feedback.message}</Notice>
            </div>
          )}

          {trashItems.length === 0 ? (
            <EmptyState
              icon={<IconTrash style={{ width: 32, height: 32, opacity: 0.4 }} />}
              title={t("skillsMcp.skills.trash.emptyTitle")}
            >
              {t("skillsMcp.skills.trash.emptyBody")}
            </EmptyState>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl trash-tbl">
                <thead>
                  <tr>
                    <th>{t("skillsMcp.skills.trash.colSkill")}</th>
                    <th>{t("skillsMcp.skills.trash.colDeletedAt")}</th>
                    <th>{t("skillsMcp.skills.trash.colOriginalPath")}</th>
                    <th className="num">{t("skillsMcp.skills.trash.colAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {trashItems.map(item => {
                    const isRestoring = restoringId === item.trashId;
                    const dateFormatted = item.deletedAt
                      ? new Date(item.deletedAt).toLocaleString()
                      : item.trashId;

                    return (
                      <tr key={item.trashId}>
                        <td className="trash-skill-name font-mono">{item.skillName}</td>
                        <td className="trash-date">{dateFormatted}</td>
                        <td className="trash-path text-muted font-mono" title={item.originalPath}>
                          {item.originalPath}
                        </td>
                        <td className="num">
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => void handleRestore(item.trashId, item.skillName)}
                            disabled={isRestoring || isLoading}
                            title={t("skillsMcp.skills.trash.restoreBtn")}
                          >
                            <IconCheck />{" "}
                            {isRestoring
                              ? t("skillsMcp.skills.trash.restoring")
                              : t("skillsMcp.skills.trash.restoreBtn")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
