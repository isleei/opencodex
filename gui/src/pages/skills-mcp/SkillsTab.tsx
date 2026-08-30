import { useCallback, useMemo, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  IconSearch,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconPencil,
  IconCheck,
  IconSparkles,
  IconX,
  IconLink,
} from "../../icons";
import { EmptyState, Notice, Switch, ToastNotice } from "../../ui";
import { readJsonOrThrow } from "../../fetch-json";
import { useKeyedClientResource } from "../../client-resource";
import SkillDetailModal from "./SkillDetailModal";
import SkillsTrashModal from "./SkillsTrashModal";
import type { SkillItem, SkillLinkedAgent, SyncResult, TrashRecord } from "./skills-mcp-types";

interface SkillsTabProps {
  apiBase: string;
  active: boolean;
}

export default function SkillsTab({ apiBase, active }: SkillsTabProps) {
  const t = useT();

  // Search and filter states
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("all");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all");

  // Modal states
  const [editingSkill, setEditingSkill] = useState<SkillItem | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [isTrashOpen, setIsTrashOpen] = useState(false);

  // Operation feedback
  const [syncing, setSyncing] = useState(false);
  const [toastFeedback, setToastFeedback] = useState<{
    tone: "ok" | "warn" | "err";
    message: string;
  } | null>(null);

  // Fetch skills list
  const skillsResource = useKeyedClientResource(
    `skills-list:${apiBase}`,
    [apiBase],
    async signal => {
      const res = await fetch(`${apiBase}/api/skills`, { signal });
      const data = await readJsonOrThrow<{ skills?: SkillItem[] }>(res, "Failed to load skills");
      return data?.skills || [];
    },
    { pollMs: active ? 10_000 : 0 }
  );

  // Fetch trash items list
  const trashResource = useKeyedClientResource(
    `skills-trash:${apiBase}`,
    [apiBase],
    async signal => {
      const res = await fetch(`${apiBase}/api/skills/trash`, { signal });
      if (!res.ok) return [];
      const data = await readJsonOrThrow<{ items?: TrashRecord[] }>(res, "Failed to load trash");
      return data?.items || [];
    },
    { pollMs: active && isTrashOpen ? 10_000 : 0 }
  );

  const skills = skillsResource.data || [];
  const trashItems = trashResource.data || [];



  // Filter skills
  const filteredSkills = useMemo(() => {
    return skills.filter(skill => {
      // 1. Status filter
      const isDisabled = Boolean(skill.metadata?.disabled);
      if (statusFilter === "active" && isDisabled) return false;
      if (statusFilter === "disabled" && !isDisabled) return false;

      // 2. Tag filter
      if (selectedTag !== "all") {
        const skillTags = skill.metadata?.tags || [];
        if (!skillTags.includes(selectedTag)) return false;
      }

      // 3. Agent filter
      if (selectedAgent !== "all") {
        const agents = skill.linkedAgents || [];
        if (!agents.includes(selectedAgent as SkillLinkedAgent)) return false;
      }

      // 4. Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const inName = (skill.name || "").toLowerCase().includes(q);
        const inDesc = (skill.metadata?.description || "").toLowerCase().includes(q);
        const inAuthor = (skill.metadata?.author || "").toLowerCase().includes(q);
        const inTags = (skill.metadata?.tags || []).some(tg => tg.toLowerCase().includes(q));
        const inContent = (skill.content || "").toLowerCase().includes(q);
        if (!inName && !inDesc && !inAuthor && !inTags && !inContent) return false;
      }

      return true;
    });
  }, [skills, statusFilter, selectedTag, selectedAgent, searchQuery]);

  // Actions
  const handleToggle = useCallback(
    async (skill: SkillItem) => {
      const nextEnabled = Boolean(skill.metadata?.disabled);
      try {
        const res = await fetch(`${apiBase}/api/skills/${encodeURIComponent(skill.name)}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        await readJsonOrThrow(res, "Failed to toggle skill");
        void skillsResource.refresh();
      } catch (err: unknown) {
        setToastFeedback({
          tone: "err",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [apiBase, skillsResource]
  );

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${apiBase}/api/skills/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const result = await readJsonOrThrow<SyncResult>(res, "Sync failed");
      void skillsResource.refresh();
      setToastFeedback({
        tone: "ok",
        message: t("skillsMcp.skills.syncSuccess", {
          synced: String(result?.synced ?? 0),
          migrated: String(result?.migrated?.length ?? 0),
          deduped: String(result?.deduped?.length ?? 0),
        }),
      });
    } catch (err: unknown) {
      setToastFeedback({
        tone: "err",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveSkill = async (data: {
    name: string;
    description: string;
    tags: string[];
    version: string;
    author: string;
    content: string;
    disabled?: boolean;
  }) => {
    if (isCreateMode) {
      const res = await fetch(`${apiBase}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      await readJsonOrThrow(res, "Failed to create skill");
      setToastFeedback({
        tone: "ok",
        message: t("skillsMcp.skills.createSuccess", { name: data.name }),
      });
    } else {
      const res = await fetch(`${apiBase}/api/skills/${encodeURIComponent(data.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      await readJsonOrThrow(res, "Failed to update skill");
      setToastFeedback({
        tone: "ok",
        message: t("skillsMcp.skills.updateSuccess", { name: data.name }),
      });
    }
    void skillsResource.refresh();
  };

  const handleDeleteSkill = async (skillName: string) => {
    const res = await fetch(`${apiBase}/api/skills/${encodeURIComponent(skillName)}`, {
      method: "DELETE",
    });
    await readJsonOrThrow(res, "Failed to delete skill");
    setToastFeedback({
      tone: "ok",
      message: t("skillsMcp.skills.deleteSuccess", { name: skillName }),
    });
    void skillsResource.refresh();
    void trashResource.refresh();
  };

  const handleRestoreTrash = async (trashId: string) => {
    const res = await fetch(`${apiBase}/api/skills/trash/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashId }),
    });
    await readJsonOrThrow(res, "Failed to restore skill");
    void skillsResource.refresh();
    void trashResource.refresh();
  };

  const openCreateModal = () => {
    setEditingSkill(null);
    setIsCreateMode(true);
    setIsDetailOpen(true);
  };

  const openEditModal = (skill: SkillItem) => {
    setEditingSkill(skill);
    setIsCreateMode(false);
    setIsDetailOpen(true);
  };

  const agentBadgeClass = (agent: SkillLinkedAgent) => {
    if (agent === "claude") return "badge--claude";
    if (agent === "codex") return "badge--codex";
    if (agent === "antigravity") return "badge--antigravity";
    return "badge--project";
  };

  const agentLabel = (agent: SkillLinkedAgent) => {
    if (agent === "claude") return "Claude";
    if (agent === "codex") return "Codex";
    if (agent === "antigravity") return "Antigravity";
    return "Project";
  };

  const totalCount = skills.length;
  const activeCount = skills.filter(s => !s.metadata?.disabled).length;
  const symlinkCount = skills.filter(s => s.isSymlink).length;

  return (
    <div className="skills-tab-pane">
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
      <div className="skills-summary-bar">
        <div className="skills-summary-stats">
          <div className="skills-stat-cell">
            <span className="stat-label">Total Skills</span>
            <span className="stat-val font-mono">{totalCount}</span>
          </div>
          <div className="skills-stat-cell">
            <span className="stat-label">Active</span>
            <span className="stat-val font-mono">{activeCount}</span>
          </div>
          <div className="skills-stat-cell">
            <span className="stat-label">Symlinked</span>
            <span className="stat-val font-mono">{symlinkCount}</span>
          </div>
        </div>

        <div className="skills-summary-actions skills-toolbar-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleSyncAll}
            disabled={syncing}
            title={t("skillsMcp.skills.syncAllBtn")}
          >
            <IconRefresh className={syncing ? "spin" : ""} />
            <span>
              {syncing ? t("skillsMcp.skills.syncing") : t("skillsMcp.skills.syncAllBtn")}
            </span>
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setIsTrashOpen(true)}
            title={t("skillsMcp.skills.trashBtn")}
          >
            <IconTrash />
            <span>{t("skillsMcp.skills.trashBtn")}</span>
            {trashItems.length > 0 && (
              <span className="badge badge--neutral badge--xs">{trashItems.length}</span>
            )}
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={openCreateModal}
          >
            <IconPlus /> <span>{t("skillsMcp.skills.newSkillBtn")}</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="skills-toolbar-compact">
        <div className="skills-filter-pills" role="tablist">
          <button
            type="button"
            className={`filter-pill-btn${selectedAgent === "all" ? " active" : ""}`}
            onClick={() => setSelectedAgent("all")}
          >
            All Agents
          </button>
          <button
            type="button"
            className={`filter-pill-btn${selectedAgent === "claude" ? " active" : ""}`}
            onClick={() => setSelectedAgent("claude")}
          >
            Claude
          </button>
          <button
            type="button"
            className={`filter-pill-btn${selectedAgent === "codex" ? " active" : ""}`}
            onClick={() => setSelectedAgent("codex")}
          >
            Codex
          </button>
          <button
            type="button"
            className={`filter-pill-btn${selectedAgent === "antigravity" ? " active" : ""}`}
            onClick={() => setSelectedAgent("antigravity")}
          >
            Antigravity
          </button>
          <button
            type="button"
            className={`filter-pill-btn${selectedAgent === "project" ? " active" : ""}`}
            onClick={() => setSelectedAgent("project")}
          >
            Project
          </button>
        </div>

        <div className="skills-search-and-status">
          <div className="skills-toolbar-search">
            <IconSearch className="search-icon" />
            <input
              type="text"
              className="input skills-search-input"
              placeholder={t("skillsMcp.skills.searchPlaceholder")}
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

          <div className="segmented-view-controls">
            <button
              type="button"
              className={`segmented-btn${statusFilter === "all" ? " active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={`segmented-btn${statusFilter === "active" ? " active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              Active
            </button>
            <button
              type="button"
              className={`segmented-btn${statusFilter === "disabled" ? " active" : ""}`}
              onClick={() => setStatusFilter("disabled")}
            >
              Disabled
            </button>
          </div>
        </div>
      </div>

      {skillsResource.error ? (
        <Notice tone="err">
          {skillsResource.error instanceof Error ? skillsResource.error.message : String(skillsResource.error)}
        </Notice>
      ) : filteredSkills.length === 0 ? (
        <EmptyState
          icon={<IconSparkles style={{ width: 36, height: 36, opacity: 0.4 }} />}
          title={
            searchQuery || selectedTag !== "all" || selectedAgent !== "all" || statusFilter !== "all"
              ? t("skillsMcp.skills.emptyFilteredTitle")
              : t("skillsMcp.skills.emptyTitle")
          }
        >
          <div className="empty-actions">
            {searchQuery || selectedTag !== "all" || selectedAgent !== "all" || statusFilter !== "all" ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedTag("all");
                  setSelectedAgent("all");
                  setStatusFilter("all");
                }}
              >
                {t("skillsMcp.skills.resetFiltersBtn")}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={openCreateModal}>
                <IconPlus /> {t("skillsMcp.skills.newSkillBtn")}
              </button>
            )}
          </div>
        </EmptyState>
      ) : (
        <div className="tbl-wrap skills-table-wrap">
          <table className="tbl skills-tbl">
            <thead>
              <tr>
                <th style={{ width: 44 }}>{t("skillsMcp.skills.colActive")}</th>
                <th>{t("skillsMcp.skills.colName")}</th>
                <th>{t("skillsMcp.skills.colDescription")}</th>
                <th>{t("skillsMcp.skills.colTags")}</th>
                <th>{t("skillsMcp.skills.colLinkedAgents")}</th>
                <th>{t("skillsMcp.skills.colStorage")}</th>
                <th className="num" style={{ width: 90 }}>
                  {t("skillsMcp.skills.colActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredSkills.map(skill => {
                const isDisabled = Boolean(skill.metadata?.disabled);
                const tags = skill.metadata?.tags || [];
                const agents = skill.linkedAgents || [];

                return (
                  <tr key={skill.name} className={isDisabled ? "row-disabled" : ""}>
                    <td>
                      <Switch
                        on={!isDisabled}
                        onClick={() => void handleToggle(skill)}
                        label={t("skillsMcp.skills.toggleAria", { name: skill.name })}
                      />
                    </td>
                    <td className="skill-cell-name">
                      <button
                        type="button"
                        className="btn-link skill-name-btn font-mono"
                        onClick={() => openEditModal(skill)}
                        title={t("skillsMcp.skills.editBtn")}
                      >
                        {skill.name}
                      </button>
                      {skill.isSystem && (
                        <span className="badge badge--system badge--xs">
                          {t("skillsMcp.skills.badgeSystem")}
                        </span>
                      )}
                      {skill.metadata?.version && (
                        <span className="text-muted text-xs font-mono skill-version-chip">
                          v{skill.metadata.version}
                        </span>
                      )}
                    </td>
                    <td className="skill-cell-desc">
                      <div className="skill-desc-text" title={skill.metadata?.description}>
                        {skill.metadata?.description || <span className="text-muted">–</span>}
                      </div>
                      {skill.metadata?.author && (
                        <div className="text-muted text-xs">
                          {t("skillsMcp.skills.byAuthor", { author: skill.metadata.author })}
                        </div>
                      )}
                    </td>
                    <td className="skill-cell-tags">
                      <div className="skill-tags-list">
                        {tags.length > 0 ? (
                          tags.map(tg => (
                            <button
                              key={tg}
                              type="button"
                              className="tag-chip badge--xs"
                              onClick={() => setSelectedTag(tg)}
                              title={t("skillsMcp.skills.filterByTag", { tag: tg })}
                            >
                              #{tg}
                            </button>
                          ))
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </div>
                    </td>
                    <td className="skill-cell-agents">
                      <div className="skill-agents-badges">
                        {agents.length > 0 ? (
                          agents.map(ag => (
                            <span
                              key={ag}
                              className={`badge badge--xs ${agentBadgeClass(ag)}`}
                            >
                              {agentLabel(ag)}
                            </span>
                          ))
                        ) : (
                          <span className="text-muted text-xs">
                            {t("skillsMcp.skills.noAgentsLinked")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="skill-cell-storage">
                      {skill.isSymlink ? (
                        <span className="storage-badge storage-badge--symlink" title={skill.targetPath}>
                          <IconLink /> {t("skillsMcp.skills.storageSymlinked")}
                        </span>
                      ) : (
                        <span className="storage-badge storage-badge--central">
                          <IconCheck /> {t("skillsMcp.skills.storageCentral")}
                        </span>
                      )}
                    </td>
                    <td className="num skill-cell-actions">
                      <div className="cell-action-btns">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => openEditModal(skill)}
                          title={t("skillsMcp.skills.editBtn")}
                          aria-label={t("skillsMcp.skills.editBtn")}
                        >
                          <IconPencil />
                        </button>
                        {!skill.isSystem && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm btn-danger-hover"
                            onClick={() => void handleDeleteSkill(skill.name)}
                            title={t("common.delete")}
                            aria-label={t("common.delete")}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isDetailOpen && (
        <SkillDetailModal
          skill={editingSkill}
          isOpen={isDetailOpen}
          isCreateMode={isCreateMode}
          onClose={() => setIsDetailOpen(false)}
          onSave={handleSaveSkill}
          onDelete={handleDeleteSkill}
        />
      )}

      {isTrashOpen && (
        <SkillsTrashModal
          isOpen={isTrashOpen}
          trashItems={trashItems}
          isLoading={trashResource.refreshing}
          onClose={() => setIsTrashOpen(false)}
          onRestore={handleRestoreTrash}
          onRefresh={async () => {
            void trashResource.refresh();
          }}
        />
      )}
    </div>
  );
}
