import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/shared";
import {
  IconBot,
  IconCheck,
  IconCopy,
  IconFileText,
  IconFolder,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTerminal,
  IconX,
} from "../icons";
import { formatTokens } from "../format-tokens";
import "../styles-sessions-workspace.css";

export type AgentType = "codex" | "agy" | "claude_code" | "grok";

export interface SessionTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModifiedFileInfo {
  path: string;
  changeType: "create" | "modify" | "delete";
}

export interface SessionTurn {
  turnId: string;
  role: "user" | "assistant" | "system" | "tool";
  timestamp?: number;
  content: string;
  toolCalls?: Array<{
    toolName: string;
    args?: Record<string, unknown> | string;
    result?: string;
  }>;
}

export interface UnifiedSession {
  id: string;
  agent: AgentType;
  title: string;
  summary?: string;
  project?: string;
  projectPath?: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  modifiedFiles: string[];
  tokens: SessionTokenUsage;
  sourcePath: string;
}

export interface UnifiedSessionDetail extends UnifiedSession {
  turns: SessionTurn[];
  modifiedFileDetails: ModifiedFileInfo[];
}

export interface HandoffContext {
  sourceAgent: AgentType;
  targetAgent: AgentType;
  sourceSessionId: string;
  generatedAt: number;
  strategy: "smart_handoff" | "full_replay";
  goal: string;
  completedMilestones: string[];
  modifiedFiles: ModifiedFileInfo[];
  unresolvedIssues: string[];
  pendingTasks: string[];
  customInstructions?: string;
  renderedPrompt: string;
}

export interface DispatchResult {
  ok: boolean;
  sourceAgent: AgentType;
  targetAgent: AgentType;
  sourceSessionId: string;
  command: string;
  executed: boolean;
  executionOutput?: string;
  error?: string;
  handoffContext: HandoffContext;
}

export default function Sessions({ apiBase = "" }: { apiBase?: string }) {
  const t = useT();

  const [allSessions, setAllSessions] = useState<UnifiedSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentFilter, setAgentFilter] = useState<"all" | AgentType>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived">("all");
  const [viewMode, setViewMode] = useState<"timeline" | "grouped">("timeline");
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");

  // Detail Modal
  const [selectedSession, setSelectedSession] = useState<UnifiedSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Handoff Modal
  const [handoffSource, setHandoffSource] = useState<UnifiedSession | null>(null);
  const [targetAgent, setTargetAgent] = useState<AgentType>("agy");
  const [strategy, setStrategy] = useState<"smart_handoff" | "full_replay">("smart_handoff");
  const [customInstructions, setCustomInstructions] = useState("");
  const [generatedHandoff, setGeneratedHandoff] = useState<HandoffContext | null>(null);
  const [generating, setGenerating] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/sessions?limit=200`);
      if (!res.ok) {
        throw new Error(`Failed to load sessions: ${res.status}`);
      }
      const data = (await res.json()) as {
        sessions: UnifiedSession[];
      };
      setAllSessions(data.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Stable counts across all loaded sessions
  const totalCount = allSessions.length;
  const codexCount = useMemo(() => allSessions.filter((s) => s.agent === "codex").length, [allSessions]);
  const agyCount = useMemo(() => allSessions.filter((s) => s.agent === "agy").length, [allSessions]);
  const claudeCount = useMemo(() => allSessions.filter((s) => s.agent === "claude_code").length, [allSessions]);
  const grokCount = useMemo(() => allSessions.filter((s) => s.agent === "grok").length, [allSessions]);

  // Discovered projects list with counts
  const projectList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allSessions) {
      const p = s.project || "Other";
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [allSessions]);

  // Instant in-memory filtered sessions list
  const filteredSessions = useMemo(() => {
    return allSessions.filter((s) => {
      if (agentFilter !== "all" && s.agent !== agentFilter) return false;
      if (projectFilter !== "all" && (s.project || "Other") !== projectFilter) return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchTitle = s.title.toLowerCase().includes(q);
        const matchId = s.id.toLowerCase().includes(q);
        const matchProject = s.project ? s.project.toLowerCase().includes(q) : false;
        const matchSummary = s.summary?.toLowerCase().includes(q) ?? false;
        const matchFiles = s.modifiedFiles.some((f) => f.toLowerCase().includes(q));
        return matchTitle || matchId || matchProject || matchSummary || matchFiles;
      }
      return true;
    });
  }, [allSessions, agentFilter, projectFilter, statusFilter, searchQuery]);

  // Grouped sessions by project
  const groupedSessions = useMemo(() => {
    const map = new Map<string, { project: string; path?: string; sessions: UnifiedSession[] }>();
    for (const s of filteredSessions) {
      const proj = s.project || "Other";
      if (!map.has(proj)) {
        map.set(proj, { project: proj, path: s.projectPath, sessions: [] });
      }
      map.get(proj)!.sessions.push(s);
    }
    return Array.from(map.values()).sort((a, b) => b.sessions.length - a.sessions.length);
  }, [filteredSessions]);

  const toggleProjectCollapse = (proj: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [proj]: !prev[proj] }));
  };

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const openDetail = async (session: UnifiedSession) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(session.agent)}/${encodeURIComponent(session.id)}`);
      if (!res.ok) throw new Error("Failed to load session details");
      const data = (await res.json()) as { session: UnifiedSessionDetail };
      setSelectedSession(data.session);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error loading session details");
    } finally {
      setDetailLoading(false);
    }
  };

  const openHandoff = (session: UnifiedSession) => {
    setHandoffSource(session);
    const defaultTarget: AgentType = session.agent === "codex" ? "agy" : "codex";
    setTargetAgent(defaultTarget);
    setStrategy("smart_handoff");
    setCustomInstructions("");
    setGeneratedHandoff(null);
    setDispatchResult(null);
    setCopied(false);

    void generatePreview(session, defaultTarget, "smart_handoff", "");
  };

  const generatePreview = async (
    session: UnifiedSession,
    target: AgentType,
    strat: "smart_handoff" | "full_replay",
    instructions: string,
  ) => {
    setGenerating(true);
    setGeneratedHandoff(null);
    try {
      const res = await fetch(
        `${apiBase}/api/sessions/${encodeURIComponent(session.agent)}/${encodeURIComponent(session.id)}/handoff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetAgent: target,
            strategy: strat,
            customInstructions: instructions,
          }),
        },
      );
      if (!res.ok) throw new Error("Failed to generate handoff preview");
      const data = (await res.json()) as { handoff: HandoffContext };
      setGeneratedHandoff(data.handoff);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error generating handoff");
    } finally {
      setGenerating(false);
    }
  };

  const handleExecuteDispatch = async () => {
    if (!handoffSource) return;
    setDispatching(true);
    try {
      const res = await fetch(
        `${apiBase}/api/sessions/${encodeURIComponent(handoffSource.agent)}/${encodeURIComponent(handoffSource.id)}/dispatch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetAgent,
            strategy,
            customInstructions,
            autoExecute: true,
          }),
        },
      );
      if (!res.ok) throw new Error("Failed to dispatch session handoff");
      const data = (await res.json()) as { result: DispatchResult };
      setDispatchResult(data.result);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Dispatch error");
    } finally {
      setDispatching(false);
    }
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatAgentBadge = (agent: AgentType) => {
    if (agent === "codex") {
      return <span className="agent-badge agent-badge-codex">OpenAI Codex</span>;
    }
    if (agent === "agy") {
      return <span className="agent-badge agent-badge-agy">Google AGY</span>;
    }
    if (agent === "grok") {
      return <span className="agent-badge agent-badge-grok">Grok Build</span>;
    }
    return <span className="agent-badge agent-badge-claude">Claude Code</span>;
  };

  const renderSessionCard = (session: UnifiedSession) => (
    <div key={`${session.agent}-${session.id}`} className="session-card">
      <div className="session-card-header">
        <div className="session-card-badges">
          {formatAgentBadge(session.agent)}
          <span className="session-id-pill" title={session.id}>
            {session.id.length > 24 ? `${session.id.slice(0, 20)}...` : session.id}
          </span>
          {session.project && (
            <span className="sessions-card-project-chip" title={session.projectPath}>
              <IconFolder style={{ width: 12, height: 12, flexShrink: 0 }} />
              <span>{session.project}</span>
            </span>
          )}
          {session.status === "archived" && <span className="status-archived-pill">Archived</span>}
        </div>
        <span className="session-time">
          {new Date(session.updatedAt).toLocaleString()}
        </span>
      </div>

      <div className="session-card-body">
        <h4 className="session-goal-title">{session.title}</h4>
        {session.summary && session.summary !== session.title && (
          <p className="session-goal-desc">{session.summary}</p>
        )}
      </div>

      <div className="session-card-footer">
        <div className="session-meta-stats">
          <span className="meta-pill" title="Turns count">
            <IconTerminal className="pill-icon" /> {session.turnCount} turns
          </span>
          {session.modifiedFiles.length > 0 && (
            <span className="meta-pill" title="Touched files">
              <IconFileText className="pill-icon" /> {session.modifiedFiles.length} files
            </span>
          )}
          {session.tokens.totalTokens > 0 && (
            <span className="meta-pill" title="Token consumption">
              {formatTokens(session.tokens.totalTokens, "en")} tokens
            </span>
          )}
        </div>

        <div className="session-card-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void openDetail(session)}
            disabled={detailLoading}
          >
            <IconFileText /> {t("sessions.action.inspect") || "Inspect"}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => openHandoff(session)}
          >
            <IconSparkles /> {t("sessions.action.handoff") || "Handoff"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="sessions-container">
      {/* Header */}
      <div className="sessions-header">
        <div className="sessions-header-left">
          <h2 className="sessions-title">
            <IconBot className="sessions-title-icon" />
            {t("sessions.title") || "Cross-Agent Session Hub"}
          </h2>
          <p className="sessions-subtitle">
            {t("sessions.subtitle") ||
              "Discover, inspect, and synchronize active agent sessions across OpenAI Codex, Google Antigravity (AGY), and Claude Code."}
          </p>
        </div>

        <button
          id="sessions-btn-refresh"
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void fetchSessions()}
          disabled={loading}
        >
          <IconRefresh className={loading ? "spin" : ""} />
          <span>{t("sessions.refresh") || "Refresh"}</span>
        </button>
      </div>

      {/* Summary Stats Bar */}
      <div className="sessions-summary-bar">
        <div className="sessions-summary-stats">
          <div className="session-stat-cell">
            <span className="stat-label">{t("sessions.total") || "Total Sessions"}</span>
            <span className="stat-val">{totalCount}</span>
          </div>
          <div className="session-stat-cell">
            <span className="stat-label">
              <span className="stat-dot stat-dot-codex" /> OpenAI Codex
            </span>
            <span className="stat-val">{codexCount}</span>
          </div>
          <div className="session-stat-cell">
            <span className="stat-label">
              <span className="stat-dot stat-dot-agy" /> Google Antigravity
            </span>
            <span className="stat-val">{agyCount}</span>
          </div>
          <div className="session-stat-cell">
            <span className="stat-label">
              <span className="stat-dot stat-dot-claude" /> Claude Code
            </span>
            <span className="stat-val">{claudeCount}</span>
          </div>
          <div className="session-stat-cell">
            <span className="stat-label">
              <span className="stat-dot stat-dot-grok" /> Grok Build
            </span>
            <span className="stat-val">{grokCount}</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="sessions-toolbar">
        <div className="sessions-toolbar-left">
          <div className="sessions-pill-group">
            <button
              id="sessions-tab-all"
              type="button"
              className={`sessions-pill-btn ${agentFilter === "all" ? "active" : ""}`}
              onClick={() => setAgentFilter("all")}
            >
              {t("sessions.filter.all") || "All Agents"} ({totalCount})
            </button>
            <button
              id="sessions-tab-codex"
              type="button"
              className={`sessions-pill-btn ${agentFilter === "codex" ? "active" : ""}`}
              onClick={() => setAgentFilter("codex")}
            >
              Codex ({codexCount})
            </button>
            <button
              id="sessions-tab-agy"
              type="button"
              className={`sessions-pill-btn ${agentFilter === "agy" ? "active" : ""}`}
              onClick={() => setAgentFilter("agy")}
            >
              AGY ({agyCount})
            </button>
            <button
              id="sessions-tab-claude"
              type="button"
              className={`sessions-pill-btn ${agentFilter === "claude_code" ? "active" : ""}`}
              onClick={() => setAgentFilter("claude_code")}
            >
              Claude ({claudeCount})
            </button>
            <button
              id="sessions-tab-grok"
              type="button"
              className={`sessions-pill-btn ${agentFilter === "grok" ? "active" : ""}`}
              onClick={() => setAgentFilter("grok")}
            >
              Grok ({grokCount})
            </button>
          </div>

          {/* Project Selector */}
          <div className="sessions-filter-select-wrapper">
            <IconFolder className="sessions-filter-select-icon" />
            <select
              id="sessions-project-select"
              className="sessions-filter-select"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label="Filter by project"
            >
              <option value="all">
                {t("sessions.filter.all_projects") || "All Projects"} ({totalCount})
              </option>
              {projectList.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.count})
                </option>
              ))}
            </select>
          </div>

          <div className="sessions-pill-group">
            <button
              id="sessions-status-all"
              type="button"
              className={`sessions-pill-btn ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All Status
            </button>
            <button
              id="sessions-status-active"
              type="button"
              className={`sessions-pill-btn ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              Active
            </button>
            <button
              id="sessions-status-archived"
              type="button"
              className={`sessions-pill-btn ${statusFilter === "archived" ? "active" : ""}`}
              onClick={() => setStatusFilter("archived")}
            >
              Archived
            </button>
          </div>
        </div>

        <div className="sessions-toolbar-right">
          <div className="sessions-view-mode-group">
            <button
              id="sessions-view-timeline"
              type="button"
              className={`sessions-view-btn ${viewMode === "timeline" ? "active" : ""}`}
              onClick={() => setViewMode("timeline")}
              title={t("sessions.view.flat") || "Timeline"}
            >
              <IconFileText style={{ width: 14, height: 14 }} />
              <span>{t("sessions.view.flat") || "Timeline"}</span>
            </button>
            <button
              id="sessions-view-grouped"
              type="button"
              className={`sessions-view-btn ${viewMode === "grouped" ? "active" : ""}`}
              onClick={() => setViewMode("grouped")}
              title={t("sessions.view.grouped") || "Group by Project"}
            >
              <IconFolder style={{ width: 14, height: 14 }} />
              <span>{t("sessions.view.grouped") || "Group by Project"}</span>
            </button>
          </div>

          <div className="sessions-search-box">
            <IconSearch className="sessions-search-icon" />
            <input
              id="sessions-search-input"
              type="text"
              className="sessions-search-input"
              placeholder={t("sessions.search.placeholder") || "Search session prompt, id, files..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="sessions-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <IconX style={{ width: 12, height: 12 }} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Sessions Grid / Grouped Content */}
      {error && <div className="session-error-banner">{error}</div>}

      {loading && allSessions.length === 0 ? (
        <div className="session-loading-state">
          <IconRefresh className="spin session-empty-icon" />
          <span>{t("sessions.loading") || "Scanning agent sessions on disk..."}</span>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="session-empty-state">
          <IconFolder className="session-empty-icon" />
          <h3>{t("sessions.empty.title") || "No Agent Sessions Found"}</h3>
          <p>
            {t("sessions.empty.desc") ||
              "Run tasks in OpenAI Codex, Antigravity (AGY), or Claude Code to see active sessions appear here."}
          </p>
        </div>
      ) : viewMode === "grouped" ? (
        <div className="sessions-project-groups">
          {groupedSessions.map((group) => {
            const isCollapsed = !!collapsedProjects[group.project];
            const codexInGroup = group.sessions.filter((s) => s.agent === "codex").length;
            const agyInGroup = group.sessions.filter((s) => s.agent === "agy").length;
            const claudeInGroup = group.sessions.filter((s) => s.agent === "claude_code").length;
            const grokInGroup = group.sessions.filter((s) => s.agent === "grok").length;

            return (
              <div key={group.project} className="sessions-project-card">
                <div
                  className={`sessions-project-card-header ${isCollapsed ? "collapsed" : ""}`}
                  onClick={() => toggleProjectCollapse(group.project)}
                >
                  <div className="sessions-project-header-left">
                    <IconFolder className="sessions-project-header-icon" />
                    <h3 className="sessions-project-header-title">
                      {group.project}
                      <span className="sessions-project-count-pill">
                        {t("sessions.project.sessions_count", { count: group.sessions.length }) ||
                          `${group.sessions.length} sessions`}
                      </span>
                    </h3>
                    {group.path && (
                      <span className="sessions-project-header-path" title={group.path}>
                        {group.path}
                      </span>
                    )}
                  </div>
                  <div className="sessions-project-header-right">
                    <div className="sessions-project-breakdown">
                      {codexInGroup > 0 && <span className="stat-dot stat-dot-codex" title={`Codex: ${codexInGroup}`} />}
                      {agyInGroup > 0 && <span className="stat-dot stat-dot-agy" title={`AGY: ${agyInGroup}`} />}
                      {claudeInGroup > 0 && <span className="stat-dot stat-dot-claude" title={`Claude: ${claudeInGroup}`} />}
                      {grokInGroup > 0 && <span className="stat-dot stat-dot-grok" title={`Grok: ${grokInGroup}`} />}
                    </div>
                    <span className={`sessions-project-chevron ${isCollapsed ? "rotated" : ""}`}>
                      ▼
                    </span>
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="sessions-project-card-body">
                    {group.sessions.map(renderSessionCard)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="sessions-list">
          {filteredSessions.map(renderSessionCard)}
        </div>
      )}

      {/* Session Detail Modal */}
      {selectedSession && (
        <div className="modal-backdrop" onClick={() => setSelectedSession(null)}>
          <div className="modal-container session-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-row">
                <h3 className="modal-title">{selectedSession.title}</h3>
                {formatAgentBadge(selectedSession.agent)}
              </div>
              <button
                type="button"
                className="btn-icon-close"
                onClick={() => setSelectedSession(null)}
              >
                <IconX />
              </button>
            </div>

            <div className="modal-body session-detail-body">
              <div className="detail-meta-banner">
                <div>
                  <strong>Session ID:</strong> <span className="mono">{selectedSession.id}</span>
                </div>
                {selectedSession.project && (
                  <div>
                    <strong>Project:</strong> <span className="mono">{selectedSession.project}</span>
                  </div>
                )}
                {selectedSession.projectPath && (
                  <div>
                    <strong>Workspace:</strong> <span className="mono">{selectedSession.projectPath}</span>
                  </div>
                )}
                <div>
                  <strong>Source Path:</strong> <span className="mono">{selectedSession.sourcePath}</span>
                </div>
                <div>
                  <strong>Last Active:</strong> {new Date(selectedSession.updatedAt).toLocaleString()}
                </div>
                <div>
                  <strong>Total Tokens:</strong> {formatTokens(selectedSession.tokens.totalTokens, "en")}
                </div>
              </div>

              {selectedSession.modifiedFileDetails.length > 0 && (
                <div className="detail-section">
                  <h4 className="detail-section-title">
                    <IconFileText style={{ width: 15, height: 15, flexShrink: 0 }} /> Modified Files ({selectedSession.modifiedFileDetails.length})
                  </h4>
                  <div className="modified-files-list">
                    {selectedSession.modifiedFileDetails.map((f, i) => (
                      <div key={i} className="modified-file-row">
                        <span className={`file-change-badge change-${f.changeType}`}>
                          {f.changeType.toUpperCase()}
                        </span>
                        <span className="file-path mono">{f.path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="detail-section">
                <h4 className="detail-section-title">
                  <IconTerminal style={{ width: 15, height: 15, flexShrink: 0 }} /> Turn Timeline ({selectedSession.turns.length})
                </h4>
                <div className="turns-timeline">
                  {selectedSession.turns.map((turn, i) => (
                    <div key={turn.turnId || i} className={`turn-card role-${turn.role}`}>
                      <div className="turn-card-head">
                        <span className={`turn-role-pill role-${turn.role}`}>
                          {turn.role.toUpperCase()}
                        </span>
                        {turn.timestamp && (
                          <span className="turn-timestamp">
                            {new Date(turn.timestamp).toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                      <div className="turn-card-content">{turn.content}</div>
                      {turn.toolCalls && turn.toolCalls.length > 0 && (
                        <div className="turn-tools-box">
                          {turn.toolCalls.map((tc, tcIdx) => (
                            <div key={tcIdx} className="tool-call-pill">
                              <span className="tool-name">Tool: {tc.toolName}</span>
                              {tc.args && (
                                <pre className="tool-args mono">
                                  {typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedSession(null)}
              >
                Close
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  const s = selectedSession;
                  setSelectedSession(null);
                  openHandoff(s);
                }}
              >
                <IconSparkles /> Continue Handoff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handoff & Dispatch Modal */}
      {handoffSource && (
        <div className="modal-backdrop" onClick={() => setHandoffSource(null)}>
          <div className="modal-container session-handoff-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-row">
                <h3 className="modal-title">
                  <IconSparkles style={{ width: 18, height: 18, color: "var(--blue)" }} />
                  {t("sessions.handoff.title") || "Cross-Agent Session Handoff"}
                </h3>
              </div>
              <button
                type="button"
                className="btn-icon-close"
                onClick={() => setHandoffSource(null)}
              >
                <IconX />
              </button>
            </div>

            <div className="modal-body handoff-modal-body">
              <div className="handoff-flow-banner">
                <div className="flow-step">
                  <span className="flow-label">Source Agent</span>
                  <span className="flow-badge">{handoffSource.agent.toUpperCase()}</span>
                </div>
                <div className="flow-arrow">➔</div>
                <div className="flow-step">
                  <span className="flow-label">Target Agent</span>
                  <div className="target-select-pills">
                    {(["agy", "codex", "claude_code", "grok"] as AgentType[])
                      .filter((a) => a !== handoffSource.agent)
                      .map((agent) => (
                        <button
                          key={agent}
                          type="button"
                          className={`target-pill ${targetAgent === agent ? "active" : ""}`}
                          onClick={() => {
                            setTargetAgent(agent);
                            void generatePreview(handoffSource, agent, strategy, customInstructions);
                          }}
                        >
                          {agent === "agy" ? "Google AGY" : agent === "codex" ? "OpenAI Codex" : agent === "grok" ? "Grok Build" : "Claude Code"}
                        </button>
                      ))}
                  </div>
                </div>
              </div>

              {/* Instructions and Strategy */}
              <div className="handoff-config-grid">
                <div className="config-field">
                  <label className="config-label">
                    {t("sessions.handoff.strategy") || "Handoff Strategy"}
                  </label>
                  <div className="strategy-options">
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="strategy"
                        checked={strategy === "smart_handoff"}
                        onChange={() => {
                          setStrategy("smart_handoff");
                          void generatePreview(handoffSource, targetAgent, "smart_handoff", customInstructions);
                        }}
                      />
                      <span>
                        <strong>Smart Handoff (Recommended)</strong> — High-signal goal & state summary
                      </span>
                    </label>
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="strategy"
                        checked={strategy === "full_replay"}
                        onChange={() => {
                          setStrategy("full_replay");
                          void generatePreview(handoffSource, targetAgent, "full_replay", customInstructions);
                        }}
                      />
                      <span>
                        <strong>Full Replay</strong> — Full turn-by-turn transcript schema conversion
                      </span>
                    </label>
                  </div>
                </div>

                <div className="config-field">
                  <label className="config-label">
                    {t("sessions.handoff.custom") || "Additional Instructions (Optional)"}
                  </label>
                  <textarea
                    className="custom-instructions-input"
                    rows={2}
                    placeholder="e.g. Focus on unit tests first, verify with bun test..."
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    onBlur={() => {
                      void generatePreview(handoffSource, targetAgent, strategy, customInstructions);
                    }}
                  />
                </div>
              </div>

              {/* Generated Prompt Preview */}
              <div className="prompt-preview-container">
                <div className="prompt-preview-header">
                  <span className="preview-title">
                    <IconFileText style={{ width: 14, height: 14, flexShrink: 0 }} /> Rendered Prompt for {targetAgent.toUpperCase()}
                  </span>
                  {generatedHandoff && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => copyToClipboard(generatedHandoff.renderedPrompt)}
                    >
                      {copied ? <IconCheck /> : <IconCopy />}
                      {copied ? "Copied" : "Copy Prompt"}
                    </button>
                  )}
                </div>

                {generating ? (
                  <div className="preview-loading">
                    <IconRefresh className="spin" /> Generating handoff context...
                  </div>
                ) : generatedHandoff ? (
                  <pre className="prompt-preview-content">{generatedHandoff.renderedPrompt}</pre>
                ) : null}
              </div>

              {/* Dispatch Execution Result */}
              {dispatchResult && (
                <div className={`dispatch-result-box ${dispatchResult.ok ? "success" : "failed"}`}>
                  <div className="result-header">
                    <strong>{dispatchResult.ok ? "✓ Dispatch Successful" : "✗ Dispatch Failed"}</strong>
                    <span className="result-cmd mono">{dispatchResult.command}</span>
                  </div>
                  {dispatchResult.executionOutput && (
                    <pre className="result-output mono">{dispatchResult.executionOutput}</pre>
                  )}
                  {dispatchResult.error && (
                    <div className="result-error mono">{dispatchResult.error}</div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setHandoffSource(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleExecuteDispatch()}
                disabled={dispatching || generating}
              >
                {dispatching ? <IconRefresh className="spin" /> : <IconPlay />}
                {dispatching ? "Executing Dispatch..." : "Launch Target Agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
