/**
 * Workflow engine types — Codex-led, phase-sequenced model workflows.
 *
 * A workflow is an ordered list of phases. Each phase binds an ocx-routable model
 * reference (explicit id like `openai/gpt-5.6-sol`, `combo/x`, `policy/y`, or a
 * `role:<name>` indirection resolved through definition defaults and task overrides),
 * an execution mode, and an optional operator gate that halts the run.
 *
 * W1 scope: state machine, persistence, REST, CLI. Phase *execution* (proxied chat
 * calls and headless `codex exec` dispatch) is W2 — advancing a phase records outputs
 * supplied by the operator or the orchestrating agent.
 */

export type WorkflowPhaseMode = "chat" | "agent";

export interface WorkflowGate {
  /** Stable gate id (e.g. `plan-approval`). */
  id: string;
  /** Phase id to send the run back to when rejected. Default: nearest previous non-gate phase. */
  rejectTo?: string;
}

export interface WorkflowPhase {
  /** Unique within the workflow. */
  id: string;
  title?: string;
  /** Gate phase: the run halts here until the operator approves or rejects. */
  gate?: WorkflowGate;
  /** ocx-routable model id, or `role:<name>` resolved via defaults/overrides. */
  modelRef?: string;
  /** `chat` = proxied model call; `agent` = headless tool-loop run in the task workspace. */
  mode?: WorkflowPhaseMode;
  /** Inline prompt template for the phase. */
  prompt?: string;
  /** Documentation of expected inputs (e.g. ["diff", "plan"]). */
  inputs?: string[];
}

export interface WorkflowDefinition {
  id: string;
  title?: string;
  description?: string;
  /** Role name -> ocx-routable id, used to resolve `role:<name>` modelRefs. */
  defaults?: Record<string, string>;
  phases: WorkflowPhase[];
  /** True for definitions shipped with opencodex; user files may shadow them by id. */
  builtin?: boolean;
}

export type WorkflowTaskStatus = "running" | "awaiting_gate" | "completed" | "aborted";

export type WorkflowPhaseStatus = "pending" | "in_progress" | "done" | "rejected" | "skipped";

export interface WorkflowPhaseTokens {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface WorkflowPhaseState {
  id: string;
  status: WorkflowPhaseStatus;
  /** Resolved model reference at the time the phase started. */
  modelRef?: string;
  startedAt?: number;
  completedAt?: number;
  /** Text output supplied when the phase was advanced past. */
  outputs?: string;
  /** Set when automated execution failed; the phase stays in_progress for a retry. */
  error?: string;
  /** Token usage captured from an automated chat execution. */
  tokens?: WorkflowPhaseTokens;
}

export interface WorkflowGateState {
  id: string;
  reachedAt: number;
}

export interface WorkflowTask {
  id: string;
  workflowId: string;
  title: string;
  status: WorkflowTaskStatus;
  /** Index into `phases` for the current or next actionable phase. */
  phaseIndex: number;
  phases: WorkflowPhaseState[];
  /** Role name -> modelRef pinned at run start; wins over definition defaults. */
  roleOverrides?: Record<string, string>;
  /** When true, advance/gate automatically re-kick execution after a manual phase. */
  autoRun?: boolean;
  workspaceDir?: string;
  currentGate?: WorkflowGateState;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowJournalEntry {
  ts: number;
  event:
    | "created"
    | "phase_done"
    | "gate_reached"
    | "gate_approved"
    | "gate_rejected"
    | "phase_started"
    | "completed"
    | "aborted";
  phaseId?: string;
  detail?: string;
}

export interface WorkflowRoleResolution {
  modelRef?: string;
  source: "explicit" | "task-override" | "definition-default" | "unresolved";
}
