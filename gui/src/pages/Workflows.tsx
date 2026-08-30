import { useCallback, useEffect, useRef, useState } from "react";
import { IconBot, IconCheck, IconCopy, IconFolder, IconPlay, IconRefresh, IconTerminal, IconX } from "../icons";
import { formatTokens } from "../format-tokens";
import "../styles-workflow.css";

interface WorkflowPhase {
  id: string;
  title?: string;
  gate?: { id: string; rejectTo?: string };
  modelRef?: string;
  mode?: "chat" | "agent";
  prompt?: string;
  inputs?: string[];
}

interface WorkflowDefinition {
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

function statusPill(task: WorkflowTask): string {
  if (task.status === "awaiting_gate") return `awaiting gate: ${task.currentGate?.id ?? "?"}`;
  return task.status;
}

export default function Workflows({ apiBase = "" }: { apiBase?: string }) {
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
      setNotice(startAuto ? "Run started — executing until the next gate" : "Run started");
      await refreshLists();
      if (body.task) void openRun(body.task.id);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    void navigator.clipboard.writeText(`Run ${selected.id} (${selected.workflowId}) — ${statusPill(selected)}\n${lines.join("\n")}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="workflows-container">
      <div className="sessions-header">
        <div className="sessions-header-left">
          <h2 className="sessions-title">
            <IconBot className="sessions-title-icon" />
            Workflows
          </h2>
          <p className="sessions-subtitle">
            Codex-led, phase-sequenced model runs: plan with one model, implement with another, review before it lands.
          </p>
        </div>
        <div className="workflows-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void refreshLists()}
            disabled={loading}
          >
            <IconRefresh className={loading ? "spin" : ""} /> Refresh
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
            <IconPlay /> New Run
          </button>
        </div>
      </div>

      {error && <div className="session-error-banner">{error}</div>}
      {notice && <div className="session-error-banner workflows-notice">{notice}</div>}

      <div className="workflows-layout">
        <div className="workflows-runs-column">
          <h3 className="workflows-column-title">Runs</h3>
          {runs.length === 0 ? (
            <div className="session-empty-state">
              <IconFolder className="session-empty-icon" />
              <p>No workflow runs yet. Start one with “New Run”.</p>
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
                      {run.workflowId} · phase {run.phaseIndex + 1}/{run.phases.length} · {statusPill(run)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="workflows-detail-column">
          <h3 className="workflows-column-title">Definitions</h3>
          <div className="workflows-def-list">
            {definitions.map(def => (
              <div key={def.id} className="workflows-def-card">
                <div className="workflows-def-head">
                  <strong>{def.id}</strong>
                  {def.builtin && <span className="workflows-def-badge">built-in</span>}
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
                  {statusPill(selected)}
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
                      onClick={() => void action(`${selected.id}/execute`, { auto: false }, executing ? "Already executing" : "Phase execution started")}
                      disabled={executing}
                    >
                      <IconPlay /> Execute phase
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => { void action(`${selected.id}/advance`, { outputs: outputsDraft }, "Advanced"); setOutputsDraft(""); }}
                    >
                      <IconTerminal /> Advance
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm workflows-abort"
                      onClick={() => void action(`${selected.id}/abort`, { reason: "aborted from dashboard" }, "Run aborted")}
                    >
                      <IconX /> Abort
                    </button>
                  </div>
                </div>
              )}

              {selected.status === "awaiting_gate" && (
                <div className="workflows-gate-box">
                  <strong>Waiting at gate: {selected.currentGate?.id}</strong>
                  <div className="workflows-advance-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void action(`${selected.id}/gate`, { action: "approve", note: "approved from dashboard" }, "Gate approved")}
                    >
                      <IconCheck /> Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void action(`${selected.id}/gate`, { action: "reject", note: "rejected from dashboard" }, "Gate rejected — sent back for rework")}
                    >
                      <IconX /> Reject
                    </button>
                  </div>
                </div>
              )}

              {journal.length > 0 && (
                <div className="workflows-journal">
                  <strong>Journal</strong>
                  <pre className="mono">
                    {journal.slice(-12).map(e => `${new Date(e.ts).toLocaleTimeString()}  ${e.event}${e.phaseId ? ` ${e.phaseId}` : ""}${e.detail ? ` — ${e.detail}` : ""}`).join("\n")}
                  </pre>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-ghost btn-sm" onClick={copyStatus}>
                <IconCopy /> {copied ? "Copied" : "Copy status"}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => { setSelected(null); setJournal([]); }}
              >
                <IconRefresh /> Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showStart && (
        <div className="modal-backdrop" onClick={() => setShowStart(false)}>
          <div className="modal-container workflows-start-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-row"><h3 className="modal-title">Start a workflow run</h3></div>
              <button type="button" className="btn-icon-close" onClick={() => setShowStart(false)}>
                <IconX />
              </button>
            </div>
            <div className="modal-body">
              <label className="workflows-field">
                Workflow
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
                Title
                <input
                  type="text"
                  value={startTitle}
                  placeholder="e.g. Add JWT authentication"
                  onChange={e => setStartTitle(e.target.value)}
                />
              </label>
              {roleSlotsFor(definitions.find(d => d.id === startWorkflowId) ?? null).map(role => (
                <label key={role} className="workflows-field">
                  Model for role “{role}”
                  <input
                    type="text"
                    className="mono"
                    placeholder="provider/model, combo/id or policy/id"
                    value={startRoles[role] ?? ""}
                    onChange={e => setStartRoles(prev => ({ ...prev, [role]: e.target.value }))}
                  />
                </label>
              ))}
              <label className="workflows-field workflows-field-inline">
                <input type="checkbox" checked={startAuto} onChange={e => setStartAuto(e.target.checked)} />
                Execute phases automatically until the next gate
              </label>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowStart(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void startRun()}
                disabled={!startWorkflowId || !startTitle.trim()}
              >
                <IconPlay /> Start run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
