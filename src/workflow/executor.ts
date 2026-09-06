/**
 * Phase execution — the W2 half of the engine.
 *
 * Two execution modes, per the design (devlog/_plan/260830_codex_workflow_engine):
 * - `chat`  → a proxied model call. The engine runs INSIDE the proxy, so "through
 *   the proxy" is a loopback self-call to /v1/chat/completions with the management
 *   admission secret; the model id resolves through the full router (provider/model,
 *   combo, policy) exactly like any external client.
 * - `agent` → a headless `codex exec -m <modelRef>` tool-loop run in the task
 *   workspace, mirroring the sessions dispatcher's spawn pattern.
 *
 * Execution is asynchronous: `executePhase` returns immediately with a started
 * receipt, the phase's outputs/usage/error land in task.json when it finishes, and
 * `--auto` keeps advancing until the next gate, manual phase, or completion.
 */

import { execFileSync, spawn } from "node:child_process";
import { advanceRun, resolveModelRef, WorkflowError } from "./engine";
import { definitionForTask, loadTask, saveTask } from "./store";
import { activeExecution, claimExecution, executionKey, releaseExecution, type PhaseExecution } from "./execution-state";
import { collectDiff, validateWorkspace } from "./workspace";
import { buildAgentCommand } from "./agent-command";
import type { WorkflowDefinition, WorkflowPhase, WorkflowTask } from "./types";

export interface ExecutorOptions {
  /** Loopback base URL of this proxy (default http://127.0.0.1:<config port>). */
  baseUrl?: string;
  /** Management admission secret for the data-plane self-call (empty on open loopback). */
  adminToken?: string;
  /** Timeout for chat calls, ms (default 300000). */
  chatTimeoutMs?: number;
  /** Timeout for agent spawns, ms (default 3600000). */
  agentTimeoutMs?: number;
  signal?: AbortSignal;
  /** Called after automated transitions by the server's composition layer. */
  onTransition?: () => void;
}

export interface ExecutionResult {
  ok: boolean;
  outputs?: string;
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
  mode: "chat" | "agent" | "manual";
  phaseIndex?: number;
  attemptId?: string;
}

const inFlight = new Map<string, Promise<void>>();

export function isExecuting(taskId: string, baseDir?: string): boolean {
  return inFlight.has(executionKey(taskId, baseDir)) || !!activeExecution(taskId, baseDir);
}

/** Resolves when the task's in-flight execution pipeline finishes (test/CLI convenience). */
export async function waitForExecution(taskId: string, timeoutMs = 15_000, baseDir?: string): Promise<void> {
  const pipeline = baseDir ? inFlight.get(executionKey(taskId, baseDir))
    : [...inFlight].find(([key]) => key.endsWith(`:${taskId}`))?.[1];
  if (!pipeline) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pipeline, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("execution timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Assemble the phase prompt, appending earlier phases' outputs named in `inputs`. */
export function assemblePrompt(phase: WorkflowPhase, definition: WorkflowDefinition, task: WorkflowTask): string {
  const parts: string[] = [];
  if (task.title) parts.push(`# Task\n${task.title}`);
  if (task.requirements) parts.push(`# Requirements\n${task.requirements}`);
  if (phase.prompt) parts.push(phase.prompt);
  for (const input of phase.inputs ?? []) {
    if (input === "requirements") continue;
    if (input === "diff") {
      const evidence = task.phases[task.phaseIndex].evidence;
      if (!evidence) throw new WorkflowError("diff evidence is missing; execute this phase to collect it", 409);
      parts.push(`# Code diff (${evidence.baseRevision} → ${evidence.headRevision}, including working-tree changes)\n${evidence.diff}`);
      continue;
    }
    const index = task.phases.findIndex(p => p.id === input);
    if (index < 0 || index >= task.phaseIndex) continue;
    const output = task.phases[index].outputs?.trim();
    if (output) parts.push(`# Output of phase '${input}'\n${output}`);
  }
  if (task.rework?.targetPhaseId === phase.id) {
    parts.push(`# Rework request\n${task.rework.note || "Address the rejected result."}`);
    for (const previous of task.rework.phases) {
      if (previous.outputs) parts.push(`# Previous ${previous.id}\n${previous.outputs}`);
    }
  }
  return parts.join("\n\n");
}

async function runChatPhase(
  phase: WorkflowPhase,
  modelRef: string,
  prompt: string,
  opts: ExecutorOptions,
): Promise<ExecutionResult> {
  const base = opts.baseUrl || `http://127.0.0.1:${process.env.PORT || 10100}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.chatTimeoutMs ?? 300_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.adminToken) headers.authorization = `Bearer ${opts.adminToken}`;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelRef,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      return { ok: false, mode: "chat", error: `chat call failed (${res.status}): ${text}` };
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, mode: "chat", error: "chat call returned no content" };
    const usage = body.usage;
    return {
      ok: true,
      mode: "chat",
      outputs: content,
      tokens: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    };
  } catch (error) {
    return { ok: false, mode: "chat", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function runAgentPhase(
  phase: WorkflowPhase, task: WorkflowTask, modelRef: string, prompt: string, opts: ExecutorOptions,
): Promise<ExecutionResult> {
  if (!task.workspaceDir) throw new WorkflowError("agent execution requires an explicit workspaceDir", 409);
  const workspaceDir = validateWorkspace(task.workspaceDir);
  const command = buildAgentCommand(phase, task, modelRef,
    "You are executing one delegated workflow phase. Return the result and verification evidence. The workflow engine owns transitions; do not call workflow advance, gate, or execute commands.\n\n" + prompt);
  return new Promise<ExecutionResult>(resolve => {
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    const child = spawn(command.bin, command.args, {
      cwd: workspaceDir, shell: false, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = (reason: string) => {
      failure = reason;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (child.pid) {
          const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
          execFileSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "pipe", windowsHide: true, timeout: 5_000 });
        }
      } catch { child.kill("SIGKILL"); }
    };
    const abort = () => stop("agent execution aborted");
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("agent phase timed out"), opts.agentTimeoutMs ?? 3_600_000);
    const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", abort); };
    child.stdin?.on("error", () => {}); // A failed/early-exiting CLI can close stdin first.
    child.stdin?.end(command.stdin);
    child.stdout?.on("data", d => {
      stdout += d.toString();
      if (stdout.length > 2_000_000) stop("agent output exceeded 2 MB; output was not accepted");
    });
    child.stderr?.on("data", d => { stderr = (stderr + d.toString()).slice(-32_000); });
    child.on("error", error => {
      cleanup();
      resolve({ ok: false, mode: "agent", error: `failed to spawn ${command.bin}: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      cleanup();
      const output = stdout.trim();
      if (failure || code !== 0 || !output) {
        resolve({ ok: false, mode: "agent", error: failure || `${command.bin} exited (${code ?? signal}): ${stderr.slice(-500) || "no output"}` });
      } else resolve({ ok: true, mode: "agent", outputs: output });
    });
    if (opts.signal?.aborted) abort();
  });
}

/**
 * Execute the current phase of a run. Synchronous failures (manual phase, unknown
 * model role) throw WorkflowError; transport failures come back as {ok:false}.
 */
export async function executeCurrentPhase(taskId: string, opts: ExecutorOptions, baseDir?: string): Promise<ExecutionResult> {
  const task = loadTask(taskId, baseDir);
  if (!task) throw new WorkflowError(`unknown run '${taskId}'`, 404);
  if (task.status !== "running") {
    throw new WorkflowError(task.status === "awaiting_gate"
      ? `run ${taskId} is waiting at gate '${task.currentGate?.id}'`
      : `run ${taskId} is ${task.status}`, 409);
  }
  const definition = definitionForTask(task, baseDir);
  if (!definition) throw new WorkflowError(`workflow '${task.workflowId}' no longer exists`, 404);
  const phase = definition.phases[task.phaseIndex];
  if (!phase || phase.gate) throw new WorkflowError("current phase is not executable", 409);
  const resolved = resolveModelRef(phase, definition, task);
  if (!resolved.modelRef) throw new WorkflowError(`phase '${phase.id}' has no model — pin it or run manually`, 409);
  if (activeExecution(taskId, baseDir)) throw new WorkflowError("phase is already executing", 409);
  const execution = claimExecution(taskId, task.phaseIndex, task.phases[task.phaseIndex].attemptId, baseDir);
  try {
    if (phase.inputs?.includes("diff")) {
      const collected = task.phases.find(p => p.id === "collect-diff" && p.status === "done")?.evidence;
      task.phases[task.phaseIndex].evidence = collected ?? collectDiff(task.workspaceDir, task.baseRevision);
      saveTask(task, baseDir);
    }
    const prompt = assemblePrompt(phase, definition, task);
    const options = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, execution.controller.signal]) : execution.controller.signal };
    const result = phase.mode === "agent"
      ? await runAgentPhase(phase, task, resolved.modelRef, prompt, options)
      : await runChatPhase(phase, resolved.modelRef, prompt, options);
    if (!result.ok) applyError(taskId, result.error, execution, baseDir);
    return { ...result, phaseIndex: execution.phaseIndex, attemptId: execution.attemptId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    applyError(taskId, message, execution, baseDir);
    return { ok: false, mode: phase.mode || "chat", error: message, phaseIndex: execution.phaseIndex, attemptId: execution.attemptId };
  } finally { releaseExecution(taskId, execution, baseDir); }
}

function sameAttempt(task: WorkflowTask, result: { phaseIndex?: number; attemptId?: string }): boolean {
  return task.status === "running" && task.phaseIndex === result.phaseIndex
    && task.phases[task.phaseIndex]?.attemptId === result.attemptId;
}

function applyResult(taskId: string, result: ExecutionResult, baseDir?: string): boolean {
  const task = loadTask(taskId, baseDir);
  if (!task || !sameAttempt(task, result)) return false;
  const state = task.phases[task.phaseIndex];
  if (!result.ok) return false;
  state.outputs = result.outputs;
  state.tokens = result.tokens;
  state.error = undefined;
  saveTask(task, baseDir);
  advanceRun(taskId, { outputs: result.outputs }, baseDir);
  return true;
}

/** Execute serially until a gate, manual phase, error, or completion. */
export function kickExecution(
  taskId: string, opts: ExecutorOptions & { auto?: boolean }, baseDir?: string,
): { started: true } | { started: false; reason: string } {
  const key = executionKey(taskId, baseDir);
  if (isExecuting(taskId, baseDir)) return { started: false, reason: "already executing" };
  const initial = loadTask(taskId, baseDir);
  if (!initial) throw new WorkflowError(`unknown run '${taskId}'`, 404);
  if (initial.status !== "running") throw new WorkflowError(`run is ${initial.status}`, 409);
  const pipeline = (async () => {
    for (;;) {
      const task = loadTask(taskId, baseDir);
      if (!task || task.status !== "running") return;
      const definition = definitionForTask(task, baseDir);
      const phase = definition?.phases[task.phaseIndex];
      if (!definition || !phase || phase.gate || !resolveModelRef(phase, definition, task).modelRef) return;
      try {
        const result = await executeCurrentPhase(taskId, opts, baseDir);
        if (!applyResult(taskId, result, baseDir)) return;
        opts.onTransition?.();
        if (!opts.auto) return;
      } catch (error) {
        applyError(taskId, error instanceof Error ? error.message : String(error),
          { phaseIndex: task.phaseIndex, attemptId: task.phases[task.phaseIndex].attemptId }, baseDir);
        return;
      }
    }
  })();
  inFlight.set(key, pipeline);
  void pipeline.finally(() => inFlight.delete(key));
  return { started: true };
}

function applyError(taskId: string, error: string | undefined, execution: Pick<PhaseExecution, "phaseIndex" | "attemptId">, baseDir?: string): void {
  const task = loadTask(taskId, baseDir);
  if (!task || !sameAttempt(task, execution)) return;
  task.phases[task.phaseIndex].error = error;
  task.updatedAt = Date.now();
  saveTask(task, baseDir);
}
