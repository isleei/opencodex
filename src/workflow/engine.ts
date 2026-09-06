/**
 * Workflow state machine — start, advance, gate, abort.
 *
 * The engine owns transitions; the executor supplies automated phase results,
 * while interactive agents may advance manual phases.
 *
 * Invariants:
 * - `task.phases[task.phaseIndex]` is the actionable phase.
 * - A gate phase never carries work: arriving at one flips the task to
 *   `awaiting_gate`, and only an explicit approve/reject leaves it.
 * - Transitions append a journal entry; the atomically replaced task snapshot
 *   remains authoritative after interruption.
 */

import {
  appendJournal,
  getDefinition,
  loadTask,
  readJournal,
  saveTask,
  validateDefinition,
  definitionForTask,
} from "./store";
import { randomUUID } from "node:crypto";
import { activeExecution, cancelExecution } from "./execution-state";
import { collectDiff, validateWorkspace, resolveBaseRevision } from "./workspace";
import { WORKFLOW_AGENTS, type WorkflowAgent } from "./types";
import type {
  WorkflowDefinition,
  WorkflowJournalEntry,
  WorkflowPhase,
  WorkflowRoleResolution,
  WorkflowTask,
} from "./types";

export class WorkflowError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function now(): number {
  return Date.now();
}

function journal(taskId: string, entry: Omit<WorkflowJournalEntry, "ts">, baseDir?: string): void {
  appendJournal(taskId, { ts: now(), ...entry }, baseDir);
}

// ---------------------------------------------------------------------------
// Role resolution: phase.modelRef → task.roleOverrides → definition.defaults
// ---------------------------------------------------------------------------

export function resolveModelRef(
  phase: WorkflowPhase,
  definition: WorkflowDefinition,
  task: Pick<WorkflowTask, "roleOverrides">,
): WorkflowRoleResolution {
  const ref = phase.modelRef?.trim();
  if (!ref) return { source: "unresolved" };
  if (!ref.startsWith("role:")) return { modelRef: ref, source: "explicit" };
  const role = ref.slice("role:".length).trim();
  if (!role) return { source: "unresolved" };
  const override = task.roleOverrides?.[role]?.trim();
  if (override) return { modelRef: override, source: "task-override" };
  const fallback = definition.defaults?.[role]?.trim();
  if (fallback) return { modelRef: fallback, source: "definition-default" };
  return { source: "unresolved" };
}

function enterPhase(task: WorkflowTask, definition: WorkflowDefinition, index: number, baseDir?: string): void {
  task.phaseIndex = index;
  const phase = definition.phases[index];
  const state = task.phases[index];
  state.status = "in_progress";
  state.attemptId = randomUUID();
  state.startedAt = now();
  state.modelRef = resolveModelRef(phase, definition, task).modelRef;
  journal(task.id, { event: "phase_started", phaseId: phase.id, detail: state.modelRef }, baseDir);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function startRun(
  input: {
    workflowId: string;
    title: string;
    requirements?: string;
    baseRevision?: string;
    agentOverrides?: Record<string, WorkflowAgent>;
    workspaceDir?: string;
    roleOverrides?: Record<string, string>;
    autoRun?: boolean;
    /** Model ref used for every role the operator did not pin (one-command starts). */
    fallbackModelRef?: string;
  },
  baseDir?: string,
): WorkflowTask {
  const definition = getDefinition(input.workflowId, baseDir);
  if (!definition) {
    throw new WorkflowError(`unknown workflow '${input.workflowId}'`, 404);
  }
  const errors = validateDefinition(definition);
  if (errors.length > 0) {
    throw new WorkflowError(`workflow '${definition.id}' is invalid: ${errors.join("; ")}`);
  }
  const title = input.title.trim();
  if (!title) throw new WorkflowError("run title is required");

  // One-command starts: pin every role the definition references that the operator
  // did not set, so "go" works with zero configuration.
  const roleOverrides: Record<string, string> = { ...(input.roleOverrides ?? {}) };
  if (input.fallbackModelRef) {
    for (const phase of definition.phases) {
      const ref = phase.modelRef?.trim();
      if (ref?.startsWith("role:")) {
        const role = ref.slice(5).trim();
        if (role && !roleOverrides[role] && !definition.defaults?.[role]?.trim()) roleOverrides[role] = input.fallbackModelRef;
      }
    }
  }

  for (const agent of Object.values(input.agentOverrides ?? {})) {
    if (!WORKFLOW_AGENTS.includes(agent)) throw new WorkflowError(`unknown workflow agent: ${agent}`);
  }
  let workspaceDir: string | undefined;
  let baseRevision: string | undefined;
  try {
    workspaceDir = input.workspaceDir ? validateWorkspace(input.workspaceDir) : undefined;
    if (input.baseRevision && !workspaceDir) throw new Error("baseRevision requires workspaceDir");
    baseRevision = workspaceDir ? resolveBaseRevision(workspaceDir, input.baseRevision) : undefined;
  } catch (error) { throw new WorkflowError(error instanceof Error ? error.message : String(error)); }
  if (input.autoRun && !workspaceDir && definition.phases.some(p => p.mode === "agent" || p.inputs?.includes("diff"))) {
    throw new WorkflowError("automated code workflows require an explicit workspaceDir");
  }
  if (input.autoRun && !baseRevision && definition.phases.some(p => p.inputs?.includes("diff"))) {
    throw new WorkflowError("automated diff review requires a Git workspace with a base commit");
  }

  const createdAt = now();
  const task: WorkflowTask = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    workflowId: definition.id,
    title,
    requirements: input.requirements?.trim() || title,
    definition: structuredClone(definition),
    agentOverrides: input.agentOverrides,
    baseRevision,
    status: "running",
    phaseIndex: 0,
    phases: definition.phases.map(phase => ({ id: phase.id, status: "pending" as const })),
    roleOverrides,
    autoRun: input.autoRun,
    workspaceDir,
    createdAt,
    updatedAt: createdAt,
  };
  saveTask(task, baseDir);
  journal(task.id, { event: "created", detail: `${definition.id}: ${title}` }, baseDir);
  enterPhase(task, definition, 0, baseDir);
  task.updatedAt = now();
  saveTask(task, baseDir);
  return task;
}

export function advanceRun(
  taskId: string,
  input: { outputs?: string; executionId?: string } = {},
  baseDir?: string,
): WorkflowTask {
  const task = requireTask(taskId, baseDir);
  const execution = activeExecution(taskId, baseDir);
  if (execution && execution.id !== input.executionId) throw new WorkflowError("phase is executing; wait for it to finish or abort the run", 409);
  if (task.status !== "running") {
    throw new WorkflowError(
      task.status === "awaiting_gate"
        ? `run ${taskId} is waiting at gate '${task.currentGate?.id}' — approve or reject it first`
        : `run ${taskId} is ${task.status} and cannot advance`,
      409,
    );
  }
  const definition = requireDefinition(task, baseDir);
  const index = task.phaseIndex;
  const phase = definition.phases[index];
  const state = task.phases[index];
  if (phase.gate || state.status !== "in_progress") {
    throw new WorkflowError(`phase '${phase.id}' is not advanceable`, 409);
  }

  state.status = "done";
  state.completedAt = now();
  if (input.outputs) state.outputs = input.outputs;
  task.updatedAt = state.completedAt;
  journal(task.id, { event: "phase_done", phaseId: phase.id }, baseDir);

  const next = index + 1;
  if (next >= definition.phases.length) {
    task.status = "completed";
    journal(task.id, { event: "completed" }, baseDir);
    saveTask(task, baseDir);
    return task;
  }
  if (definition.phases[next].gate) {
    task.status = "awaiting_gate";
    // phaseIndex moves onto the gate itself: it is now the actionable phase.
    task.phaseIndex = next;
    task.currentGate = { id: definition.phases[next].gate!.id, reachedAt: now() };
    journal(task.id, { event: "gate_reached", phaseId: definition.phases[next].id }, baseDir);
    saveTask(task, baseDir);
    return task;
  }
  enterPhase(task, definition, next, baseDir);
  task.updatedAt = now();
  saveTask(task, baseDir);
  return task;
}

export function approveGate(taskId: string, input: { note?: string } = {}, baseDir?: string): WorkflowTask {
  const task = requireTask(taskId, baseDir);
  if (task.status !== "awaiting_gate") {
    throw new WorkflowError(`run ${taskId} is not waiting at a gate`, 409);
  }
  const definition = requireDefinition(task, baseDir);
  const index = task.phaseIndex;
  const phase = definition.phases[index];
  if (!phase.gate) throw new WorkflowError(`phase '${phase.id}' is not a gate`, 409);

  const evidence = [...task.phases.slice(0, index)].reverse().find(p => p.status === "done" && p.evidence)?.evidence;
  if (evidence) {
    const current = collectDiff(task.workspaceDir, evidence.baseRevision);
    if (current.headRevision !== evidence.headRevision || current.diff !== evidence.diff) {
      throw new WorkflowError("code changed since review; reject the gate and review the updated code before accepting", 409);
    }
  }

  const state = task.phases[index];
  state.status = "done";
  state.completedAt = now();
  task.updatedAt = state.completedAt;
  journal(task.id, { event: "gate_approved", phaseId: phase.id, detail: input.note }, baseDir);

  const next = index + 1;
  if (next >= definition.phases.length) {
    task.status = "completed";
    task.currentGate = undefined;
    journal(task.id, { event: "completed" }, baseDir);
    saveTask(task, baseDir);
    return task;
  }
  task.currentGate = undefined;
  if (definition.phases[next].gate) {
    task.status = "awaiting_gate";
    task.phaseIndex = next;
    task.currentGate = { id: definition.phases[next].gate!.id, reachedAt: now() };
    journal(task.id, { event: "gate_reached", phaseId: definition.phases[next].id }, baseDir);
    saveTask(task, baseDir);
    return task;
  }
  task.status = "running";
  enterPhase(task, definition, next, baseDir);
  task.updatedAt = now();
  saveTask(task, baseDir);
  return task;
}

export function rejectGate(taskId: string, input: { note?: string } = {}, baseDir?: string): WorkflowTask {
  const task = requireTask(taskId, baseDir);
  if (task.status !== "awaiting_gate") {
    throw new WorkflowError(`run ${taskId} is not waiting at a gate`, 409);
  }
  const definition = requireDefinition(task, baseDir);
  const index = task.phaseIndex;
  const phase = definition.phases[index];
  if (!phase.gate) throw new WorkflowError(`phase '${phase.id}' is not a gate`, 409);

  const state = task.phases[index];
  state.status = "rejected";
  task.updatedAt = now();
  journal(task.id, { event: "gate_rejected", phaseId: phase.id, detail: input.note }, baseDir);

  // Rework target: explicit rejectTo, else the nearest previous non-gate phase.
  let target = -1;
  if (phase.gate.rejectTo) {
    target = definition.phases.findIndex(p => p.id === phase.gate!.rejectTo);
  }
  if (target < 0) {
    for (let i = index - 1; i >= 0; i--) {
      if (!definition.phases[i].gate) {
        target = i;
        break;
      }
    }
  }
  if (target < 0) {
    throw new WorkflowError(`gate '${phase.id}' has no phase to rework into`, 409);
  }

  task.currentGate = undefined;
  task.rework = {
    targetPhaseId: definition.phases[target].id,
    note: input.note,
    phases: structuredClone(task.phases.slice(target, index)),
  };
  for (let i = target; i < task.phases.length; i++) {
    task.phases[i] = { id: definition.phases[i].id, status: i === index ? "rejected" : "pending" };
  }
  task.status = "running";
  enterPhase(task, definition, target, baseDir);
  task.updatedAt = now();
  saveTask(task, baseDir);
  cancelExecution(taskId, baseDir);
  return task;
}

export function abortRun(taskId: string, input: { reason?: string } = {}, baseDir?: string): WorkflowTask {
  const task = requireTask(taskId, baseDir);
  if (task.status === "completed" || task.status === "aborted") {
    throw new WorkflowError(`run ${taskId} is already ${task.status}`, 409);
  }
  task.status = "aborted";
  task.currentGate = undefined;
  task.updatedAt = now();
  journal(task.id, { event: "aborted", detail: input.reason }, baseDir);
  saveTask(task, baseDir);
  cancelExecution(taskId, baseDir);
  return task;
}

export function getRun(
  taskId: string,
  baseDir?: string,
): { task: WorkflowTask; definition: WorkflowDefinition; journal: WorkflowJournalEntry[] } | null {
  const task = loadTask(taskId, baseDir);
  if (!task) return null;
  const definition = requireDefinition(task, baseDir);
  const entries = readJournal(taskId, baseDir);
  return { task, definition, journal: entries };
}

function requireTask(taskId: string, baseDir?: string): WorkflowTask {
  const task = loadTask(taskId, baseDir);
  if (!task) throw new WorkflowError(`unknown run '${taskId}'`, 404);
  return task;
}

function requireDefinition(task: WorkflowTask, baseDir?: string): WorkflowDefinition {
  const definition = definitionForTask(task, baseDir);
  if (!definition) {
    throw new WorkflowError(`workflow '${task.workflowId}' for run ${task.id} no longer exists`, 404);
  }
  return definition;
}
