import { useEffect, useRef, useState, type FormEvent } from "react";
import { useT } from "../../i18n/shared";
import { IconX, IconTrash, IconFileText, IconEye, IconPencil } from "../../icons";
import { Switch, Notice } from "../../ui";
import MarkdownPreview from "./MarkdownPreview";
import type { SkillItem } from "./skills-mcp-types";

interface SkillDetailModalProps {
  skill: SkillItem | null;
  isOpen: boolean;
  isCreateMode?: boolean;
  onClose: () => void;
  onSave: (data: {
    name: string;
    description: string;
    tags: string[];
    version: string;
    author: string;
    content: string;
    disabled?: boolean;
  }) => Promise<void>;
  onDelete?: (skillName: string) => Promise<void>;
}

type EditorViewMode = "edit" | "preview" | "split";

export default function SkillDetailModal({
  skill,
  isOpen,
  isCreateMode = false,
  onClose,
  onSave,
  onDelete,
}: SkillDetailModalProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [author, setAuthor] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [content, setContent] = useState("");
  const [viewMode, setViewMode] = useState<EditorViewMode>("split");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Initialize draft when modal opens or skill changes
  useEffect(() => {
    if (isOpen) {
      if (skill && !isCreateMode) {
        setName(skill.name || "");
        setDescription(skill.metadata?.description || "");
        setTagsInput((skill.metadata?.tags || []).join(", "));
        setVersion(skill.metadata?.version || "1.0.0");
        setAuthor(skill.metadata?.author || "");
        setDisabled(Boolean(skill.metadata?.disabled));
        setContent(skill.content || "");
      } else {
        setName("");
        setDescription("");
        setTagsInput("");
        setVersion("1.0.0");
        setAuthor("");
        setDisabled(false);
        setContent("# New Skill\n\nProvide clear instructions and triggers for this skill.\n");
      }
      setErrorMessage(null);
      setConfirmDelete(false);
    }
  }, [isOpen, skill, isCreateMode]);

  // Handle ESC key to dismiss modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) {
      setErrorMessage(t("skillsMcp.skills.modal.errorNameRequired"));
      return;
    }
    if (!/^[a-z0-9-_]+$/.test(cleanName)) {
      setErrorMessage(t("skillsMcp.skills.modal.errorNameInvalid"));
      return;
    }

    const parsedTags = tagsInput
      .split(",")
      .map(tag => tag.trim())
      .filter(Boolean);

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await onSave({
        name: cleanName,
        description: description.trim(),
        tags: parsedTags,
        version: version.trim() || "1.0.0",
        author: author.trim(),
        content,
        disabled,
      });
      onClose();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!skill || !onDelete) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onDelete(skill.name);
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
      aria-labelledby="skill-modal-title"
      className="modal-overlay modal-overlay--wide"
    >
      <div className="modal-card modal-card--skills" ref={modalRef}>
        <div className="modal-head">
          <div className="modal-head-title">
            <IconFileText />
            <h3 id="skill-modal-title">
              {isCreateMode
                ? t("skillsMcp.skills.modal.createTitle")
                : t("skillsMcp.skills.modal.editTitle", { name: skill?.name ?? "" })}
            </h3>
          </div>
          <div className="modal-head-actions">
            <div className="segmented-view-controls">
              <button
                type="button"
                className={`segmented-btn${viewMode === "edit" ? " active" : ""}`}
                onClick={() => setViewMode("edit")}
                title={t("skillsMcp.skills.modal.viewEditOnly")}
                aria-label={t("skillsMcp.skills.modal.viewEditOnly")}
              >
                <IconPencil /> <span>{t("skillsMcp.skills.modal.tabEdit")}</span>
              </button>
              <button
                type="button"
                className={`segmented-btn${viewMode === "split" ? " active" : ""}`}
                onClick={() => setViewMode("split")}
                title={t("skillsMcp.skills.modal.viewSplit")}
                aria-label={t("skillsMcp.skills.modal.viewSplit")}
              >
                <span>{t("skillsMcp.skills.modal.tabSplit")}</span>
              </button>
              <button
                type="button"
                className={`segmented-btn${viewMode === "preview" ? " active" : ""}`}
                onClick={() => setViewMode("preview")}
                title={t("skillsMcp.skills.modal.viewPreviewOnly")}
                aria-label={t("skillsMcp.skills.modal.viewPreviewOnly")}
              >
                <IconEye /> <span>{t("skillsMcp.skills.modal.tabPreview")}</span>
              </button>
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
        </div>

        <form onSubmit={handleSubmit} className="modal-body-form">
          {errorMessage && (
            <div className="modal-notice-wrap">
              <Notice tone="err">{errorMessage}</Notice>
            </div>
          )}

          {confirmDelete ? (
            <div className="modal-danger-confirm card">
              <h4>{t("skillsMcp.skills.modal.deleteConfirmTitle")}</h4>
              <p>{t("skillsMcp.skills.modal.deleteConfirmBody", { name: skill?.name ?? "" })}</p>
              <div className="modal-danger-actions">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={handleDelete}
                  disabled={submitting}
                >
                  <IconTrash /> {submitting ? t("common.saving") : t("common.delete")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={submitting}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : null}

          <div className="skill-form-meta-grid">
            <div className="field">
              <label htmlFor="skill-field-name" className="text-label">
                {t("skillsMcp.skills.modal.fieldName")}
              </label>
              <input
                id="skill-field-name"
                type="text"
                className="input"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={!isCreateMode || submitting}
                placeholder={t("skillsMcp.skills.modal.placeholderName")}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="skill-field-version" className="text-label">
                {t("skillsMcp.skills.modal.fieldVersion")}
              </label>
              <input
                id="skill-field-version"
                type="text"
                className="input"
                value={version}
                onChange={e => setVersion(e.target.value)}
                disabled={submitting}
                placeholder="1.0.0"
              />
            </div>

            <div className="field">
              <label htmlFor="skill-field-author" className="text-label">
                {t("skillsMcp.skills.modal.fieldAuthor")}
              </label>
              <input
                id="skill-field-author"
                type="text"
                className="input"
                value={author}
                onChange={e => setAuthor(e.target.value)}
                disabled={submitting}
                placeholder={t("skillsMcp.skills.modal.placeholderAuthor")}
              />
            </div>

            <div className="field">
              <label htmlFor="skill-field-tags" className="text-label">
                {t("skillsMcp.skills.modal.fieldTags")}
              </label>
              <input
                id="skill-field-tags"
                type="text"
                className="input"
                value={tagsInput}
                onChange={e => setTagsInput(e.target.value)}
                disabled={submitting}
                placeholder="workflow, testing, git"
              />
            </div>

            <div className="field field--full">
              <label htmlFor="skill-field-desc" className="text-label">
                {t("skillsMcp.skills.modal.fieldDescription")}
              </label>
              <input
                id="skill-field-desc"
                type="text"
                className="input"
                value={description}
                onChange={e => setDescription(e.target.value)}
                disabled={submitting}
                placeholder={t("skillsMcp.skills.modal.placeholderDescription")}
              />
            </div>

            {!isCreateMode && (
              <div className="field field--switch-row">
                <span className="text-label">{t("skillsMcp.skills.modal.fieldActive")}</span>
                <Switch
                  on={!disabled}
                  onClick={() => setDisabled(prev => !prev)}
                  disabled={submitting}
                  label={t("skillsMcp.skills.modal.fieldActive")}
                />
              </div>
            )}
          </div>

          <div className="skill-editor-workspace">
            {(viewMode === "edit" || viewMode === "split") && (
              <div className="skill-editor-pane">
                <div className="pane-header">
                  <span className="pane-title">{t("skillsMcp.skills.modal.sourceHeader")}</span>
                  <span className="pane-subtitle">SKILL.md</span>
                </div>
                <textarea
                  className="input skill-markdown-textarea"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder={t("skillsMcp.skills.modal.placeholderContent")}
                  disabled={submitting}
                  spellCheck={false}
                  rows={14}
                />
              </div>
            )}

            {(viewMode === "preview" || viewMode === "split") && (
              <div className="skill-preview-pane">
                <div className="pane-header">
                  <span className="pane-title">{t("skillsMcp.skills.modal.previewHeader")}</span>
                </div>
                <div className="skill-preview-scroll-area">
                  <MarkdownPreview content={content} />
                </div>
              </div>
            )}
          </div>

          <div className="modal-actions">
            {!isCreateMode && !confirmDelete && onDelete && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setConfirmDelete(true)}
                disabled={submitting}
                style={{ marginRight: "auto" }}
              >
                <IconTrash /> {t("common.delete")}
              </button>
            )}

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
              disabled={submitting || confirmDelete}
            >
              {submitting ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
