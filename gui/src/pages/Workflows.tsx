import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TFn } from "../i18n/shared";
import { IconBot, IconCheck, IconCopy, IconFolder, IconRefresh, IconX } from "../icons";
import { formatTokens } from "../format-tokens";
import WorkflowEditor from "./WorkflowEditor";
import "../styles-workflow.css";

export interface WorkflowPhase {
  id: string;
  title?: string;
  gate?: { id: string; rejectTo?: string };
  modelRef?: string;
  mode?: "chat" | "agent";
  agent?: "codex" | "agy" | "grok" | "opencode" | "claude";
  prompt?: string;
  inputs?: string[];
}

export interface WorkflowDefinition {
  id: string;
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  phases: WorkflowPhase[];
  builtin?: boolean;
}

interface WorkflowPhaseState {
  id: string;
  status: "pending" | "in_progress" | "done" | "rejected" | "skipped";
  modelRef?: string;
  startedAt?: number;
  completedAt?: number;
  outputs?: string;
  error?: string;
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface WorkflowTask {
  definition?: WorkflowDefinition;
  requirements?: string;
  id: string;
  workflowId: string;
  title: string;
  status: "running" | "awaiting_gate" | "completed" | "aborted";
  phaseIndex: number;
  phases: WorkflowPhaseState[];
  workspaceDir?: string;
  autoRun?: boolean;
  currentGate?: { id: string; reachedAt: number };
  createdAt: number;
  updatedAt: number;
}

interface JournalEntry {
  ts: number;
  event: string;
  phaseId?: string;
  detail?: string;
}

function statusPill(task: WorkflowTask, t: TFn): string {
  if (task.status === "awaiting_gate") return t("workflows.status.awaiting", { gate: task.currentGate?.id ?? "?" });
  if (task.status === "running") return t("workflows.status.running");
  if (task.status === "completed") return t("workflows.status.completed");
  return t("workflows.status.aborted");
}

export default function Workflows({ apiBase = "" }: { apiBase?: string }) {
  const t = useT();
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowTask[]>([]);
  const [selected, setSelected] = useState<WorkflowTask | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectionNote, setRejectionNote] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [templateId, setTemplateId] = useState(() => {
    try { return localStorage.getItem(`ocx-workflow-template:${apiBase}`) || "feature-delivery"; } catch { return "feature-delivery"; }
  });
  const [promptCopied, setPromptCopied] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ draft: WorkflowDefinition; idLocked: boolean; overridesBuiltin: boolean } | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorErrors, setEditorErrors] = useState<string[] | null>(null);
  const pollRef = useRef<number | null>(null);

  const refreshLists = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [defsRes, runsRes] = await Promise.all([
        fetch(`${apiBase}/api/workflows`),
        fetch(`${apiBase}/api/workflows/runs`),
      ]);
      if (!defsRes.ok || !runsRes.ok) throw new Error("failed to load workflows");
      const defs = (await defsRes.json()) as { definitions: WorkflowDefinition[] };
      const runsBody = (await runsRes.json()) as { runs: WorkflowTask[] };
      setDefinitions(defs.definitions || []);
      setRuns(runsBody.runs || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiBase]);

  const openRun = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/workflows/runs/${encodeURIComponent(taskId)}`);
      if (!res.ok) throw new Error("failed to load run");
      const body = (await res.json()) as { task: WorkflowTask; journal: JournalEntry[]; executing?: boolean };
      setSelected(body.task);
      setJournal(body.journal || []);
      setExecuting(body.executing === true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiBase]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshLists(); }, 0);
    const poll = window.setInterval(() => { void refreshLists(true); }, 5000);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); };
  }, [refreshLists]);

  // Model catalog for pickers: combos and policy profiles first (virtual ids), then
  // every enabled provider/model row from /api/models.
  useEffect(() => {
    void (async () => {
      try {
        const [modelsRes, combosRes, profilesRes] = await Promise.all([
          fetch(`${apiBase}/api/models`),
          fetch(`${apiBase}/api/combos`).catch(() => null),
          fetch(`${apiBase}/api/routing-profiles`).catch(() => null),
        ]);
        const options: string[] = [];
        if (combosRes?.ok) {
          const body = (await combosRes.json()) as { combos?: Array<{ model?: string }> };
          for (const combo of body.combos ?? []) {
            if (combo.model) options.push(combo.model);
          }
        }
        if (profilesRes?.ok) {
          const body = (await profilesRes.json()) as { profiles?: Array<{ id?: string }> };
          for (const profile of body.profiles ?? []) {
            if (profile.id) options.push(`policy/${profile.id}`);
          }
        }
        if (modelsRes.ok) {
          const rows = (await modelsRes.json()) as Array<{ namespaced?: string; provider?: string; id?: string; disabled?: boolean }>;
          for (const row of rows) {
            if (row.disabled) continue;
            const ref = row.namespaced || (row.provider && row.id ? `${row.provider}/${row.id}` : row.id);
            if (ref && !options.includes(ref)) options.push(ref);
          }
        }
        setModelOptions(options);
      } catch {
        // Pickers stay free-text when the catalog is unavailable.
      }
    })();
  }, [apiBase]);

  // Poll the open run while it is executing or waiting at a gate.
  useEffect(() => {
    if (!selected || (selected.status !== "running" && selected.status !== "awaiting_gate")) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = window.setInterval(() => {
      void openRun(selected.id);
    }, 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [selected, openRun]);

  const action = async (path: string, body: Record<string, unknown>, done: string) => {
    if (actionBusy) return;
    setActionBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/runs/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const body2 = (await res.json()) as { error?: string; task?: WorkflowTask; execution?: { started: boolean; reason?: string } };
      if (!res.ok) throw new Error(body2.error || `request failed (${res.status})`);
      setNotice(done);
      if (body2.task) setSelected(body2.task);
      await openRun(selected?.id ?? "");
      void refreshLists();
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const saveDefinition = async (draft: WorkflowDefinition) => {
    setEditorSaving(true);
    setEditorErrors(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: draft }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || `save failed (${res.status})`);
      chooseTemplate(draft.id);
      setEditor(null);
      setNotice(t("workflows.runSaved", { id: draft.id }));
      await refreshLists();
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setEditorErrors(err instanceof Error ? err.message.split("; ") : [String(err)]);
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteDefinition = async (id: string) => {
    if (!window.confirm(t("workflows.deleteConfirm", { id }))) return;
    try {
      const res = await fetch(`${apiBase}/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || `delete failed (${res.status})`);
      setNotice(t("workflows.runDeleted", { id }));
      await refreshLists();
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const workflowTitle = (def: WorkflowDefinition) => {
    if (def.builtin && def.id === "feature-delivery") return t("workflows.monitor.feature");
    if (def.builtin && def.id === "review-audit") return t("workflows.monitor.audit");
    if (def.builtin && def.id === "debug-investigate") return t("workflows.monitor.debug");
    return def.title || def.id;
  };
  const template = definitions.find(def => def.id === templateId) ?? definitions[0];
  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    setPromptCopied(false);
    try { localStorage.setItem(`ocx-workflow-template:${apiBase}`, id); } catch { /* Selection still works without storage. */ }
  };
  const roleTitle = (role: string) => {
    if (role === "planner") return t("workflows.templates.planner");
    if (role === "worker") return t("workflows.templates.worker");
    if (role === "reviewer") return t("workflows.templates.reviewer");
    return role;
  };
  const templateRoles = (def: WorkflowDefinition) => Array.from(new Set(def.phases.flatMap(phase => phase.modelRef?.startsWith("role:") ? [phase.modelRef.slice(5)] : [])));
  const visibleRuns = runs.filter(run => showHistory || run.status === "running" || run.status === "awaiting_gate");
  const historyCount = runs.filter(run => run.status === "completed" || run.status === "aborted").length;
  const selectedDefinition = selected?.definition ?? definitions.find(d => d.id === selected?.workflowId) ?? null;

  const copyPrompt = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyStatus = () => {
    if (!selected) return;
    const lines = selected.phases.map(p => `${p.status === "done" ? "✓" : p.status === "in_progress" ? "▶" : "·"} ${p.id}${p.outputs ? ` — ${p.outputs}` : ""}`);
    void navigator.clipboard.writeText(`Run ${selected.id} (${selected.workflowId}) — ${statusPill(selected, t)}\n${lines.join("\n")}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="workflows-container">
      <datalist id="ocx-model-refs">
        {modelOptions.map(ref => <option key={ref} value={ref} />)}
      </datalist>
      <div className="sessions-header">
        <div className="sessions-header-left">
          <h2 className="sessions-title">
            <IconBot className="sessions-title-icon" />
            {t("workflows.title")}
          </h2>
          <p className="sessions-subtitle">
            {t("workflows.monitor.subtitle")}
          </p>
        </div>
        <div className="workflows-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void refreshLists()}
            disabled={loading}
          >
            <IconRefresh className={loading ? "spin" : ""} /> {t("workflows.refresh")}
          </button>

        </div>
      </div>

      {error && <div className="session-error-banner">{error}</div>}
      {notice && <div className="session-error-banner workflows-notice">{notice}</div>}

      <section className="workflows-template-picker">
        <div className="workflows-list-heading">
          <h3 className="workflows-column-title">{t("workflows.templates.title")}</h3>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!template} onClick={() => {
            if (!template) return;
            setEditorErrors(null);
            setEditor({ draft: { ...structuredClone(template), id: "", title: "", builtin: false }, idLocked: false, overridesBuiltin: false });
          }}>{t("workflows.templates.create")}</button>
        </div>
        <p className="workflows-template-hint">{t("workflows.templates.hint")}</p>
        <div className="workflows-template-options" role="group" aria-label={t("workflows.templates.title")}>
          {definitions.map(def => <button type="button" key={def.id} className={`workflows-template-option ${template?.id === def.id ? "active" : ""}`} aria-pressed={template?.id === def.id} onClick={() => chooseTemplate(def.id)}>
            <strong>{workflowTitle(def)}</strong>
            <code>{def.id}</code>
            <span>{def.builtin ? t("workflows.builtin") : t("workflows.templates.personal")}</span>
          </button>)}
        </div>
        {template && <div className="workflows-template-config">
          <div className="workflows-template-roles">
            {templateRoles(template).map(role => {
              const phases = template.phases.filter(phase => phase.modelRef === `role:${role}`);
              const tools = Array.from(new Set(phases.map(phase => phase.mode === "agent" ? phase.agent ?? "codex" : t("workflows.templates.api"))));
              return <div className="workflows-template-role" key={role}>
                <strong>{roleTitle(role)}</strong>
                <span>{role === "planner" || role === "reviewer" ? t("workflows.templates.conversation") : tools.join(" / ")}</span>
                {role !== "planner" && role !== "reviewer" && <code>{template.defaults?.[role] || t("workflows.templates.unset")}</code>}
              </div>;
            })}
          </div>
          <p className="workflows-template-hint">{t("workflows.templates.conversationHint")}</p>
          <div className="workflows-def-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
              setEditorErrors(null);
              setEditor({ draft: structuredClone(template), idLocked: true, overridesBuiltin: template.builtin === true });
            }}>{t("workflows.templates.configure")}</button>
            {!template.builtin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void deleteDefinition(template.id)}>{t("common.delete")}</button>}
          </div>
        </div>}
      </section>

      {template && <div className="workflows-chat-entry">
        <div>
          <strong>{t("workflows.monitor.title")}</strong>
          <blockquote>{t("workflows.templates.prompt", { id: template.id })}</blockquote>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyPrompt(t("workflows.templates.prompt", { id: template.id }))}>
          <IconCopy /> {promptCopied ? t("workflows.copied") : t("workflows.monitor.copy")}
        </button>
      </div>}

      <div className="workflows-layout">
        <div className="workflows-runs-column">
          <div className="workflows-list-heading">
            <h3 className="workflows-column-title">{t("workflows.runs")}</h3>
            {historyCount > 0 && <label className="workflows-history-toggle"><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} />{t("workflows.monitor.history", { count: historyCount })}</label>}
          </div>
          {visibleRuns.length === 0 ? (
            <div className="session-empty-state">
              <IconFolder className="session-empty-icon" />
              <p>{t("workflows.monitor.empty")}</p>
            </div>
          ) : (
            <div className="workflows-run-list">
              {visibleRuns.map(run => (
                <button
                  key={run.id}
                  type="button"
                  className={`workflows-run-row ${selected?.id === run.id ? "active" : ""}`}
                  onClick={() => { setRejectionNote(""); void openRun(run.id); }}
                >
                  <span className={`workflows-run-status st-${run.status}`}>
                    {run.status === "awaiting_gate" ? "⏸" : run.status === "running" ? "▶" : run.status === "completed" ? "✓" : "✗"}
                  </span>
                  <span className="workflows-run-main">
                    <span className="workflows-run-title">{run.title}</span>
                    <span className="workflows-run-meta">
                      {workflowTitle(run.definition ?? definitions.find(d => d.id === run.workflowId) ?? { id: run.workflowId, phases: [] })} · {t("workflows.phaseProgress", { index: run.phaseIndex + 1, total: run.phases.length })} · {statusPill(run, t)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>


      </div>

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal-container workflows-run-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-row">
                <h3 className="modal-title">{selected.title}</h3>
                <span className={`workflows-run-status st-${selected.status}`}>
                  {statusPill(selected, t)}
                </span>
              </div>
              <button type="button" className="btn-icon-close" onClick={() => setSelected(null)}>
                <IconX />
              </button>
            </div>

            <div className="modal-body">
              <div className="detail-meta-banner">
                <div><strong>Run:</strong> <span className="mono">{selected.id}</span></div>
                <div><strong>Workflow:</strong> {selected.workflowId}</div>
                {selected.workspaceDir && (
                  <div><strong>Workspace:</strong> <span className="mono">{selected.workspaceDir}</span></div>
                )}
              </div>

              <div className="workflows-phase-list">
                {selected.phases.map((phase, i) => {
                  const def = selectedDefinition?.phases[i];
                  return (
                    <div key={phase.id} className={`workflows-phase-card ph-${phase.status}`}>
                      <div className="workflows-phase-head">
                        <span className="workflows-phase-index">{i + 1}</span>
                        <strong>{phase.id}</strong>
                        {def?.gate && <span className="workflows-def-phase is-gate">gate: {def.gate.id}</span>}
                        {phase.modelRef && <span className="workflows-phase-model">{phase.modelRef}</span>}
                        {def?.mode && <span className="workflows-phase-mode">{def.mode}</span>}
                        <span className="workflows-phase-state">{phase.status}</span>
                      </div>
                      {phase.outputs && <pre className="workflows-phase-outputs mono">{phase.outputs}</pre>}
                      {phase.error && <div className="workflows-phase-error mono">{phase.error}</div>}
                      {phase.tokens && phase.tokens.totalTokens > 0 && (
                        <div className="workflows-phase-tokens">
                          {formatTokens(phase.tokens.totalTokens, "en")} tokens
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {selected.status === "running" && (
                <div className="workflows-advance-box">
                  <p>{t(executing || selected.autoRun ? "workflows.monitor.executing" : "workflows.monitor.resumeHint")}</p>
                  <div className="workflows-advance-actions">
                    {!executing && !selected.autoRun && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyPrompt(t("workflows.monitor.resume", { id: selected.id }))}>
                      <IconCopy /> {promptCopied ? t("workflows.copied") : t("workflows.monitor.copy")}
                    </button>}
                    <button type="button" className="btn btn-ghost btn-sm workflows-abort" disabled={actionBusy} onClick={() => void action(`${selected.id}/abort`, { reason: "aborted from dashboard" }, t("workflows.notice.aborted"))}>
                      <IconX /> {t("workflows.abort")}
                    </button>
                  </div>
                </div>
              )}

              {selected.status === "awaiting_gate" && (
                <div className="workflows-gate-box">
                  <strong>{t("workflows.gateWaiting", { gate: selected.currentGate?.id ?? "?" })}</strong>
                  <label className="workflows-field">
                    {t("workflows.rejectionNote")}
                    <textarea value={rejectionNote} onChange={e => setRejectionNote(e.target.value)} />
                  </label>
                  <div className="workflows-advance-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={actionBusy}
                      onClick={() => void action(`${selected.id}/gate`, { action: "approve", note: undefined }, t("workflows.notice.gateApproved"))}
                    >
                      <IconCheck /> {t("workflows.gateApprove")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={actionBusy}
                      onClick={() => void action(`${selected.id}/gate`, { action: "reject", note: rejectionNote.trim() || undefined }, t("workflows.notice.gateRejected"))}
                    >
                      <IconX /> {t("workflows.gateReject")}
                    </button>
                  </div>
                </div>
              )}

              {journal.length > 0 && (
                <div className="workflows-journal">
                  <strong>{t("workflows.journal")}</strong>
                  <pre className="mono">
                    {journal.slice(-12).map(e => `${new Date(e.ts).toLocaleTimeString()}  ${e.event}${e.phaseId ? ` ${e.phaseId}` : ""}${e.detail ? ` — ${e.detail}` : ""}`).join("\n")}
                  </pre>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-ghost btn-sm" onClick={copyStatus}>
                <IconCopy /> {copied ? t("workflows.copied") : t("workflows.copyStatus")}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => { setSelected(null); setJournal([]); }}
              >
                <IconRefresh /> {t("workflows.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <WorkflowEditor
          draft={editor.draft}
          modelOptions={modelOptions}
          idLocked={editor.idLocked}
          overridesBuiltin={editor.overridesBuiltin}
          saving={editorSaving}
          errors={editorErrors}
          onSave={draft => void saveDefinition(draft)}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
