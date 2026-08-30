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

import { spawn } from "node:child_process";
import { advanceRun, resolveModelRef, WorkflowError } from "./engine";
import { getDefinition, loadTask, saveTask } from "./store";
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
}

export interface ExecutionResult {
  ok: boolean;
  outputs?: string;
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
  mode: "chat" | "agent" | "manual";
}

const inFlight = new Map<string, Promise<void>>();

export function isExecuting(taskId: string): boolean {
  return inFlight.has(taskId);
}

/** Resolves when the task's in-flight execution pipeline finishes (test/CLI convenience). */
export async function waitForExecution(taskId: string, timeoutMs = 15_000): Promise<void> {
  const pipeline = inFlight.get(taskId);
  if (!pipeline) return;
  await Promise.race([
    pipeline,
    new Promise((_, reject) => setTimeout(() => reject(new Error("execution timed out")), timeoutMs)),
  ]);
}

/** Assemble the phase prompt, appending earlier phases' outputs named in `inputs`. */
export function assemblePrompt(phase: WorkflowPhase, definition: WorkflowDefinition, task: WorkflowTask): string {
  const parts: string[] = [];
  if (task.title) parts.push(`# Task\n${task.title}`);
  if (phase.prompt) parts.push(phase.prompt);
  for (const input of phase.inputs ?? []) {
    const index = task.phases.findIndex(p => p.id === input);
    if (index < 0 || index >= task.phaseIndex) continue;
    const output = task.phases[index].outputs?.trim();
    if (output) parts.push(`# Output of phase '${input}'\n${output}`);
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
      signal: controller.signal,
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
  modelRef: string,
  prompt: string,
  opts: ExecutorOptions,
  workspaceDir?: string,
): Promise<ExecutionResult> {
  // Codex leads every workflow, so agent phases exec codex with the pinned model.
  const args = ["exec", "-m", modelRef, prompt];
  return new Promise<ExecutionResult>(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("codex", args, {
      cwd: workspaceDir || process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, mode: "agent", error: `agent phase timed out after ${opts.agentTimeoutMs ?? 3_600_000}ms` });
      }
    }, opts.agentTimeoutMs ?? 3_600_000);
    child.stdout?.on("data", d => {
      stdout += d.toString();
      if (stdout.length > 512_000) stdout = stdout.slice(-256_000);
    });
    child.stderr?.on("data", d => {
      stderr += d.toString();
    });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, mode: "agent", error: `failed to spawn codex: ${err.message}` });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = stdout.trim() || stderr.trim();
      if (code === 0 || code === null) {
        resolve({ ok: output.length > 0, mode: "agent", outputs: output || undefined, error: output ? undefined : "agent run produced no output" });
      } else {
        resolve({ ok: false, mode: "agent", error: `codex exec exited with code ${code}: ${(stderr || stdout).slice(0, 500)}` });
      }
    });
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
  const definition = getDefinition(task.workflowId, baseDir);
  if (!definition) throw new WorkflowError(`workflow '${task.workflowId}' no longer exists`, 404);
  const phase = definition.phases[task.phaseIndex];
  if (phase.gate) throw new WorkflowError(`phase '${phase.id}' is a gate`, 409);

  const resolved = resolveModelRef(phase, definition, task);
  if (!resolved.modelRef) {
    throw new WorkflowError(
      `phase '${phase.id}' has no model — pin it with --set or run it manually, then advance`, 409);
  }
  const prompt = assemblePrompt(phase, definition, task);
  const result = phase.mode === "agent"
    ? await runAgentPhase(resolved.modelRef, prompt, opts, task.workspaceDir)
    : await runChatPhase(phase, resolved.modelRef, prompt, opts);
  if (!result.ok) {
    // Record at the point of failure so any caller (and the dashboard) sees why the
    // phase is stuck; a retry overwrites it.
    applyError(taskId, result.error, baseDir);
  }
  return result;
}

function applyResult(taskId: string, result: ExecutionResult, baseDir?: string): void {
  const task = loadTask(taskId, baseDir);
  if (!task) return;
  const definition = getDefinition(task.workflowId, baseDir);
  const state = task.phases[task.phaseIndex];
  if (!definition || !state) return;
  if (result.ok) {
    state.outputs = result.outputs;
    if (result.tokens) state.tokens = result.tokens;
    state.error = undefined;
    saveTask(task, baseDir);
    advanceRun(taskId, { outputs: result.outputs }, baseDir);
  } else {
    state.error = result.error;
    saveTask(task, baseDir);
  }
}

/**
 * Fire-and-forget execution of the current phase, then — when `auto` — keep
 * executing/advancing until a gate, a manual phase, or completion. Concurrent
 * calls for the same task share one in-flight pipeline.
 */
export function kickExecution(
  taskId: string,
  opts: ExecutorOptions & { auto?: boolean },
  baseDir?: string,
): { started: true } | { started: false; reason: string } {
  if (inFlight.has(taskId)) return { started: false, reason: "already executing" };
  const pipeline = (async () => {
    try {
      for (;;) {
        const task = loadTask(taskId, baseDir);
        if (!task || task.status !== "running") return;
        const definition = getDefinition(task.workflowId, baseDir);
        const phase = definition?.phases[task.phaseIndex];
        if (!definition || !phase || phase.gate) return;
        if (!resolveModelRef(phase, definition, task).modelRef) return; // manual phase
        const result = await executeCurrentPhase(taskId, opts, baseDir);
        if (!result.ok) {
          applyError(taskId, result.error, baseDir);
          return;
        }
        applyResult(taskId, result, baseDir);
        const after = loadTask(taskId, baseDir);
        if (!after || after.status !== "running") return; // gate or completed
        if (!opts.auto) return;
      }
    } catch (error) {
      // Synchronous engine failures (unknown task, validation) must not surface as
      // unhandled rejections — the phase state carries the error instead.
      applyError(taskId, error instanceof Error ? error.message : String(error), baseDir);
    }
  })();
  inFlight.set(taskId, pipeline);
  void pipeline.finally(() => inFlight.delete(taskId));
  return { started: true };
}

function applyError(taskId: string, error: string | undefined, baseDir?: string): void {
  const task = loadTask(taskId, baseDir);
  if (!task) return;
  const state = task.phases[task.phaseIndex];
  if (!state) return;
  state.error = error;
  saveTask(task, baseDir);
}
