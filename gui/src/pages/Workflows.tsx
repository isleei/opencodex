import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TFn } from "../i18n/shared";
import { IconBot, IconCheck, IconCopy, IconFolder, IconPlay, IconRefresh, IconTerminal, IconX } from "../icons";
import { formatTokens } from "../format-tokens";
import WorkflowEditor from "./WorkflowEditor";
import "../styles-workflow.css";

export interface WorkflowPhase {
  id: string;
  title?: string;
  gate?: { id: string; rejectTo?: string };
  modelRef?: string;
  mode?: "chat" | "agent";
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
  id: string;
  workflowId: string;
  title: string;
  status: "running" | "awaiting_gate" | "completed" | "aborted";
  phaseIndex: number;
  phases: WorkflowPhaseState[];
  workspaceDir?: string;
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
  const [outputsDraft, setOutputsDraft] = useState("");
  const [showStart, setShowStart] = useState(false);
  const [startWorkflowId, setStartWorkflowId] = useState("");
  const [startTitle, setStartTitle] = useState("");
  const [startRoles, setStartRoles] = useState<Record<string, string>>({});
  const [startAuto, setStartAuto] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [goDescription, setGoDescription] = useState("");
  const [goBusy, setGoBusy] = useState(false);
  const [editor, setEditor] = useState<{ draft: WorkflowDefinition; idLocked: boolean; overridesBuiltin: boolean } | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorErrors, setEditorErrors] = useState<string[] | null>(null);
  const pollRef = useRef<number | null>(null);

  const refreshLists = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
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
    void refreshLists();
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
    }
  };

  const startRun = async () => {
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: startWorkflowId,
          title: startTitle,
          roleOverrides: startRoles,
          auto: startAuto,
        }),
      });
      const body = (await res.json()) as { error?: string; task?: WorkflowTask };
      if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
      setShowStart(false);
      setStartTitle("");
      setStartRoles({});
      setNotice(startAuto ? t("workflows.startAutoNotice") : t("workflows.startNotice"));
      await refreshLists();
      if (body.task) void openRun(body.task.id);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const quickGo = async () => {
    if (!goDescription.trim()) return;
    setGoBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/go`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: goDescription.trim() }),
      });
      const body = (await res.json()) as { error?: string; task?: WorkflowTask };
      if (!res.ok) throw new Error(body.error || `go failed (${res.status})`);
      setNotice(t("workflows.go.started"));
      setGoDescription("");
      await refreshLists();
      if (body.task) void openRun(body.task.id);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGoBusy(false);
    }
  };

  const roleSlotsFor = (def: WorkflowDefinition | null): string[] => {
    if (!def) return [];
    const roles = new Set<string>();
    for (const phase of def.phases) {
      if (phase.modelRef?.startsWith("role:")) roles.add(phase.modelRef.slice(5));
    }
    return Array.from(roles);
  };

  const selectedDefinition = definitions.find(d => d.id === selected?.workflowId) ?? null;

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
            {t("workflows.subtitle")}
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
          <button
            id="workflows-btn-editor"
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setEditorErrors(null);
              setEditor({
                draft: {
                  id: "",
                  title: "",
                  description: "",
                  defaults: {},
                  phases: [{ id: "plan", mode: "chat", prompt: "" }],
                },
                idLocked: false,
                overridesBuiltin: false,
              });
            }}
          >
            {t("workflows.editor.new")}
          </button>
          <button
            id="workflows-btn-start"
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setShowStart(true);
              setStartWorkflowId(definitions[0]?.id ?? "");
            }}
          >
            <IconPlay /> {t("workflows.newRun")}
          </button>
        </div>
      </div>

      {error && <div className="session-error-banner">{error}</div>}
      {notice && <div className="session-error-banner workflows-notice">{notice}</div>}

      <div className="workflows-quickgo">
        <input
          type="text"
          className="workflows-quickgo-input"
          placeholder={t("workflows.go.placeholder")}
          value={goDescription}
          onChange={e => setGoDescription(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !goBusy) void quickGo(); }}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void quickGo()}
          disabled={goBusy || !goDescription.trim()}
        >
          <IconPlay /> {t("workflows.go.button")}
        </button>
      </div>
      <p className="workflows-quickgo-hint">{t("workflows.go.hint")}</p>

      <div className="workflows-layout">
        <div className="workflows-runs-column">
          <h3 className="workflows-column-title">{t("workflows.runs")}</h3>
          {runs.length === 0 ? (
            <div className="session-empty-state">
              <IconFolder className="session-empty-icon" />
              <p>{t("workflows.empty")}</p>
            </div>
          ) : (
            <div className="workflows-run-list">
              {runs.map(run => (
                <button
                  key={run.id}
                  type="button"
                  className={`workflows-run-row ${selected?.id === run.id ? "active" : ""}`}
                  onClick={() => void openRun(run.id)}
                >
                  <span className={`workflows-run-status st-${run.status}`}>
                    {run.status === "awaiting_gate" ? "⏸" : run.status === "running" ? "▶" : run.status === "completed" ? "✓" : "✗"}
                  </span>
                  <span className="workflows-run-main">
                    <span className="workflows-run-title">{run.title}</span>
                    <span className="workflows-run-meta">
                      {run.workflowId} · {t("workflows.phaseProgress", { index: run.phaseIndex + 1, total: run.phases.length })} · {statusPill(run, t)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="workflows-detail-column">
          <h3 className="workflows-column-title">{t("workflows.definitions")}</h3>
          <div className="workflows-def-list">
            {definitions.map(def => (
              <div key={def.id} className="workflows-def-card">
                <div className="workflows-def-head">
                  <strong>{def.id}</strong>
                  {def.builtin && <span className="workflows-def-badge">{t("workflows.builtin")}</span>}
                  <span className="workflows-def-actions">
                    {def.builtin ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditorErrors(null);
                          setEditor({ draft: structuredClone(def), idLocked: true, overridesBuiltin: true });
                        }}
                      >
                        Customize
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditorErrors(null);
                            setEditor({ draft: structuredClone(def), idLocked: true, overridesBuiltin: false });
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm workflows-abort"
                          onClick={() => void deleteDefinition(def.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <p className="workflows-def-desc">{def.title || def.description}</p>
                <div className="workflows-def-phases">
                  {def.phases.map(p => (
                    <span key={p.id} className={`workflows-def-phase ${p.gate ? "is-gate" : ""}`}>
                      {p.gate ? `⏸ ${p.gate.id}` : `${p.mode ?? "chat"}: ${p.id}`}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
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
                  <textarea
                    className="workflows-outputs-input"
                    rows={2}
                    placeholder="Outputs to record for the current phase (optional)…"
                    value={outputsDraft}
                    onChange={e => setOutputsDraft(e.target.value)}
                  />
                  <div className="workflows-advance-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void action(`${selected.id}/execute`, { auto: false }, executing ? t("workflows.notice.alreadyExecuting") : t("workflows.notice.executeStarted"))}
                      disabled={executing}
                    >
                      <IconPlay /> {t("workflows.executePhase")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => { void action(`${selected.id}/advance`, { outputs: outputsDraft }, t("workflows.notice.advanced")); setOutputsDraft(""); }}
                    >
                      <IconTerminal /> {t("workflows.advance")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm workflows-abort"
                      onClick={() => void action(`${selected.id}/abort`, { reason: "aborted from dashboard" }, t("workflows.notice.aborted"))}
                    >
                      <IconX /> {t("workflows.abort")}
                    </button>
                  </div>
                </div>
              )}

              {selected.status === "awaiting_gate" && (
                <div className="workflows-gate-box">
                  <strong>{t("workflows.gateWaiting", { gate: selected.currentGate?.id ?? "?" })}</strong>
                  <div className="workflows-advance-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void action(`${selected.id}/gate`, { action: "approve", note: "approved from dashboard" }, t("workflows.notice.gateApproved"))}
                    >
                      <IconCheck /> {t("workflows.gateApprove")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void action(`${selected.id}/gate`, { action: "reject", note: "rejected from dashboard" }, t("workflows.notice.gateRejected"))}
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

      {showStart && (
        <div className="modal-backdrop" onClick={() => setShowStart(false)}>
          <div className="modal-container workflows-start-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-row"><h3 className="modal-title">{t("workflows.start.title")}</h3></div>
              <button type="button" className="btn-icon-close" onClick={() => setShowStart(false)}>
                <IconX />
              </button>
            </div>
            <div className="modal-body">
              <label className="workflows-field">
                {t("workflows.start.workflow")}
                <select
                  value={startWorkflowId}
                  onChange={e => {
                    setStartWorkflowId(e.target.value);
                    setStartRoles({});
                  }}
                >
                  {definitions.map(d => (
                    <option key={d.id} value={d.id}>{d.id} — {d.title || d.description || ""}</option>
                  ))}
                </select>
              </label>
              <label className="workflows-field">
                {t("workflows.start.titleField")}
                <input
                  type="text"
                  value={startTitle}
                  placeholder="e.g. Add JWT authentication"
                  onChange={e => setStartTitle(e.target.value)}
                />
              </label>
              {roleSlotsFor(definitions.find(d => d.id === startWorkflowId) ?? null).map(role => (
                <label key={role} className="workflows-field">
                  {t("workflows.start.roleModel", { role })}
                  <input
                    type="text"
                    className="mono"
                    list="ocx-model-refs"
                    placeholder="provider/model, combo/id or policy/id"
                    value={startRoles[role] ?? ""}
                    onChange={e => setStartRoles(prev => ({ ...prev, [role]: e.target.value }))}
                  />
                </label>
              ))}
              <label className="workflows-field workflows-field-inline">
                <input type="checkbox" checked={startAuto} onChange={e => setStartAuto(e.target.checked)} />
                {t("workflows.start.auto")}
              </label>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowStart(false)}>{t("workflows.editor.cancel")}</button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void startRun()}
                disabled={!startWorkflowId || !startTitle.trim()}
              >
                <IconPlay /> {t("workflows.start.submit")}
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
