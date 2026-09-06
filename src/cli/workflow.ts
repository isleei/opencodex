import { resolve } from "node:path";
import { WORKFLOW_AGENTS, type WorkflowAgent } from "../workflow/types";
/**
 * `ocx workflow` — Codex-led workflow engine CLI.
 *
 * Subcommands:
 * - list:    List workflow definitions (built-ins plus user files).
 * - show:    Inspect one definition's phases, roles, and gates.
 * - run:     Start a run of a workflow.
 * - runs:    List runs (newest first).
 * - status:  Inspect one run: phase timeline, current gate, journal tail.
 * - advance: Complete the current phase and move on (--outputs to record text).
 * - gate:    Approve or reject the gate the run is waiting at.
 * - abort:   Abort a run.
 *
 * All commands are headless and talk to the live proxy; they exit nonzero when it
 * is unreachable (the standard ocx headless convention).
 */

import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import type { WorkflowDefinition, WorkflowPhaseState, WorkflowTask } from "../workflow/types";

const USAGE = `Usage:
  ocx workflow go "<one-line description>" [--workflow <id>] [--model <ref>] [--set role=model-ref]... [--agent <cli>] [--workspace <dir>] [--base <revision>] [--json]
      One-command start: picks the workflow, binds your default model, executes
      automatically, and stops at the first approval gate.
  ocx workflow list [--json]
  ocx workflow show <workflow-id> [--json]
  ocx workflow run <workflow-id> --title <title> [--set role=model-ref]... [--workspace <dir>] [--agent <cli>] [--base <revision>] [--auto] [--json]
  ocx workflow runs [--json]
  ocx workflow status <task-id> [--json]
  ocx workflow advance <task-id> [--outputs <text>] [--json]
  ocx workflow execute <task-id> [--auto] [--json]
  ocx workflow gate <task-id> <approve|reject> [--note <text>] [--json]
  ocx workflow abort <task-id> [--reason <text>] [--json]
  ocx workflow delete <workflow-id> [--json]`;

function pad(str: string, length: number): string {
  return str.length >= length ? str : str + " ".repeat(length - str.length);
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16).replace("Z", "");
  } catch {
    return "unknown";
  }
}

function gateIds(def: WorkflowDefinition): string {
  const gates = def.phases.filter(p => p.gate).map(p => p.gate!.id);
  return gates.length > 0 ? gates.join(",") : "-";
}

function formatDefinitionTable(defs: WorkflowDefinition[]): string[] {
  if (!defs || defs.length === 0) return ["No workflows found."];
  const lines = [
    `${pad("WORKFLOW", 20)} ${pad("PHASES", 7)} ${pad("GATES", 28)} TITLE`,
  ];
  for (const def of defs) {
    lines.push(
      `${pad(def.id, 20)} ${pad(String(def.phases.length), 7)} ${pad(gateIds(def), 28)} ${def.title || def.description || ""}`,
    );
  }
  return lines;
}

function taskStatusPill(task: WorkflowTask): string {
  if (task.status === "awaiting_gate") return `awaiting:${task.currentGate?.id ?? "?"}`;
  return task.status;
}

function currentPhase(task: WorkflowTask): string {
  const state = task.phases[task.phaseIndex];
  return state ? state.id : "-";
}

function formatRunsTable(tasks: WorkflowTask[]): string[] {
  if (!tasks || tasks.length === 0) return ["No workflow runs."];
  const lines = [
    `${pad("TASK", 26)} ${pad("STATUS", 24)} ${pad("PHASE", 16)} ${pad("WORKFLOW", 20)} UPDATED`,
  ];
  for (const task of tasks) {
    lines.push(
      `${pad(task.id, 26)} ${pad(taskStatusPill(task), 24)} ${pad(currentPhase(task), 16)} ${pad(task.workflowId, 20)} ${formatDate(task.updatedAt)}`,
    );
  }
  return lines;
}

function formatPhaseTimeline(phases: WorkflowPhaseState[]): string[] {
  return phases.map(p => {
    const tag = p.status === "done" ? "✓" : p.status === "in_progress" ? "▶" : p.status === "rejected" ? "✗" : p.status === "skipped" ? "»" : "·";
    const ref = p.modelRef ? ` [${p.modelRef}]` : "";
    const outputs = p.outputs ? ` — ${p.outputs.slice(0, 80)}` : "";
    const error = p.error ? ` !! ${p.error.slice(0, 120)}` : "";
    return `  ${tag} ${p.id}${ref}${outputs}${error}`;
  });
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ definitions: WorkflowDefinition[] }>("/api/workflows", {}, deps);
  printData(result, wantsJson, formatDefinitionTable(result.definitions ?? []));
}

async function show(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("missing workflow id", USAGE);

  const result = await runtimeRequest<{ definitions: WorkflowDefinition[] }>("/api/workflows", {}, deps);
  const def = (result.definitions ?? []).find(d => d.id === id);
  if (!def) throw new CliUsageError(`unknown workflow: ${id}`, USAGE);

  if (wantsJson) {
    printData(def, true);
    return;
  }
  const lines = [
    `Workflow:  ${def.id}`,
    `Title:     ${def.title ?? "-"}`,
    `Defaults:  ${JSON.stringify(def.defaults ?? {})}`,
    `Phases:`,
    ...def.phases.map(p => {
      const kind = p.gate ? `gate:${p.gate.id}` : (p.mode ?? "chat");
      const ref = p.modelRef ? ` ${p.modelRef}` : "";
      return `  - ${pad(p.id, 18)} ${pad(kind, 16)}${ref}`;
    }),
  ];
  printData(def, false, lines);
}

function collectSetFlags(args: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) throw new CliUsageError("--set expects role=model-ref", USAGE);
      const eq = value.indexOf("=");
      if (eq <= 0) throw new CliUsageError(`--set expects role=model-ref, got: ${value}`, USAGE);
      overrides[value.slice(0, eq)] = value.slice(eq + 1);
      args.splice(i, 2);
      i--;
    }
  }
  return overrides;
}

function takeAgent(args: string[]): WorkflowAgent | undefined {
  const agent = takeOption(args, "--agent");
  if (agent && !WORKFLOW_AGENTS.includes(agent as WorkflowAgent)) throw new CliUsageError(`--agent must be one of ${WORKFLOW_AGENTS.join(", ")}`, USAGE);
  return agent as WorkflowAgent | undefined;
}

async function run(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const auto = takeFlag(args, "--auto");
  const title = takeOption(args, "--title");
  const workspace = resolve(takeOption(args, "--workspace") || process.cwd());
  const agent = takeAgent(args);
  const baseRevision = takeOption(args, "--base");
  const roleOverrides = collectSetFlags(args);
  const workflowId = args.shift();
  rejectArgs(args, USAGE);
  if (!workflowId) throw new CliUsageError("missing workflow id", USAGE);
  if (!title) throw new CliUsageError("missing --title", USAGE);

  const result = await runtimeRequest<{ ok: boolean; task: WorkflowTask }>(
    "/api/workflows/runs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, title, requirements: title, workspaceDir: workspace, roleOverrides, agentOverrides: agent ? { worker: agent } : undefined, baseRevision, auto }),
    },
    deps,
  );
  const task = result.task;
  printData(result, wantsJson, [
    `Started run ${task.id} of ${task.workflowId}`,
    `Title:  ${task.title}`,
    `Phase:  ${currentPhase(task)}`,
    ...formatPhaseTimeline(task.phases),
    `\nAdvance with: ocx workflow advance ${task.id}`,
  ]);
}

async function runs(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ runs: WorkflowTask[] }>("/api/workflows/runs", {}, deps);
  printData(result, wantsJson, formatRunsTable(result.runs ?? []));
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const taskId = args.shift();
  rejectArgs(args, USAGE);
  if (!taskId) throw new CliUsageError("missing task id", USAGE);

  const result = await runtimeRequest<{
    task: WorkflowTask;
    executing?: boolean;
    definition: WorkflowDefinition;
    journal: Array<{ ts: number; event: string; phaseId?: string; detail?: string }>;
  }>(`/api/workflows/runs/${encodeURIComponent(taskId)}`, {}, deps);
  if (wantsJson) {
    printData(result, true);
    return;
  }
  const { task, definition, journal } = result;
  const lines = [
    `Run:       ${task.id}`,
    `Workflow:  ${task.workflowId} — ${task.title}`,
    `Status:    ${taskStatusPill(task)}`,
    `Phase:     ${currentPhase(task)}`,
    `Workspace: ${task.workspaceDir ?? "-"}`,
    `Phases:`,
    ...formatPhaseTimeline(task.phases),
    `Journal (tail):`,
    ...journal.slice(-8).map(e => `  ${formatDate(e.ts)} ${e.event}${e.phaseId ? ` ${e.phaseId}` : ""}${e.detail ? ` — ${e.detail.slice(0, 60)}` : ""}`),
    `\nPhases defined: ${definition.phases.length}`,
  ];
  printData(result, false, lines);
}

async function advance(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const outputs = takeOption(args, "--outputs");
  const taskId = args.shift();
  rejectArgs(args, USAGE);
  if (!taskId) throw new CliUsageError("missing task id", USAGE);

  const result = await runtimeRequest<{ ok: boolean; task: WorkflowTask }>(
    `/api/workflows/runs/${encodeURIComponent(taskId)}/advance`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputs }),
    },
    deps,
  );
  const task = result.task;
  printData(result, wantsJson, [
    task.status === "awaiting_gate"
      ? `Phase done — run is waiting at gate '${task.currentGate?.id}'. Approve with: ocx workflow gate ${task.id} approve`
      : task.status === "completed"
        ? "Run completed."
        : `Advanced to phase: ${currentPhase(task)}`,
    ...formatPhaseTimeline(task.phases),
  ]);
}

async function execute(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const auto = takeFlag(args, "--auto");
  const taskId = args.shift();
  rejectArgs(args, USAGE);
  if (!taskId) throw new CliUsageError("missing task id", USAGE);

  const result = await runtimeRequest<{ ok: boolean; started?: boolean; reason?: string }>(
    `/api/workflows/runs/${encodeURIComponent(taskId)}/execute`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto }),
    },
    deps,
  );
  printData(result, wantsJson, [
    result.started
      ? auto
        ? "Pipeline started: phases will execute and auto-advance until the next gate, a manual phase, or completion."
        : "Phase execution started. Check progress with: ocx workflow status " + taskId
      : `Not started: ${result.reason ?? "unknown reason"}`,
  ]);
}

async function removeDefinition(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("missing workflow id", USAGE);

  const result = await runtimeRequest<{ ok: boolean }>(
    `/api/workflows/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    deps,
  );
  printData(result, wantsJson, [`Workflow "${id}" deleted.`]);
}

async function gate(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const note = takeOption(args, "--note");
  const taskId = args.shift();
  const action = args.shift();
  rejectArgs(args, USAGE);
  if (!taskId) throw new CliUsageError("missing task id", USAGE);
  if (action !== "approve" && action !== "reject") {
    throw new CliUsageError("gate action must be 'approve' or 'reject'", USAGE);
  }

  const result = await runtimeRequest<{ ok: boolean; task: WorkflowTask }>(
    `/api/workflows/runs/${encodeURIComponent(taskId)}/gate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note }),
    },
    deps,
  );
  const task = result.task;
  printData(result, wantsJson, [
    action === "approve"
      ? task.status === "completed"
        ? "Gate approved — run completed."
        : `Gate approved — advanced to phase: ${currentPhase(task)}`
      : `Gate rejected — sent back to phase: ${currentPhase(task)}`,
    ...formatPhaseTimeline(task.phases),
  ]);
}

async function abort(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const reason = takeOption(args, "--reason");
  const taskId = args.shift();
  rejectArgs(args, USAGE);
  if (!taskId) throw new CliUsageError("missing task id", USAGE);

  const result = await runtimeRequest<{ ok: boolean; task: WorkflowTask }>(
    `/api/workflows/runs/${encodeURIComponent(taskId)}/abort`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
    deps,
  );
  printData(result, wantsJson, [`Run ${result.task.id} aborted.`]);
}

async function go(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const workflowId = takeOption(args, "--workflow");
  const modelRef = takeOption(args, "--model");
  const workspaceDir = resolve(takeOption(args, "--workspace") || process.cwd());
  const baseRevision = takeOption(args, "--base");
  const agent = takeAgent(args);
  const roleOverrides = collectSetFlags(args);
  // The description is the whole positional tail — everything left after flags.
  const description = args.join(" ").trim();
  args.length = 0;
  rejectArgs(args, USAGE);
  if (!description) throw new CliUsageError('describe what you want, e.g. ocx workflow go "add rate limiting to the login API"', USAGE);

  const result = await runtimeRequest<{ ok: boolean; task: WorkflowTask; workflowId: string; fallbackModelRef: string | null }>(
    "/api/workflows/go",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, workflowId, modelRef, workspaceDir, baseRevision, roleOverrides, agentOverrides: agent ? { worker: agent } : undefined }),
    },
    deps,
  );
  const task = result.task;
  printData(result, wantsJson, [
    `Run ${task.id} started (${result.workflowId}) — models default to ${result.fallbackModelRef ?? "?"}`,
    ...formatPhaseTimeline(task.phases),
    ``,
    `The plan phase is running; the run will stop at the first gate.`,
    `Approve it with:  ocx workflow gate ${task.id} approve   (or the dashboard)`,
    `Watch progress:   ocx workflow status ${task.id}`,
  ]);
}

export async function handleWorkflowCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
  const sub = hasSub ? argv[0]! : "list";
  const rest = hasSub ? argv.slice(1) : argv;

  return runCliAction(async () => {
    if (sub === "go") await go(rest, deps);
    else if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "run" || sub === "start") await run(rest, deps);
    else if (sub === "runs" || sub === "status-list") await runs(rest, deps);
    else if (sub === "status") await status(rest, deps);
    else if (sub === "advance" || sub === "done") await advance(rest, deps);
    else if (sub === "execute" || sub === "run-phase") await execute(rest, deps);
    else if (sub === "gate") await gate(rest, deps);
    else if (sub === "abort" || sub === "stop") await abort(rest, deps);
    else if (sub === "delete" || sub === "rm") await removeDefinition(rest, deps);
    else throw new CliUsageError(`unknown workflow subcommand: "${sub}"`, USAGE);
  });
}

export const WORKFLOW_USAGE = USAGE;
