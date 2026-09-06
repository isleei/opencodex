/**
 * Management routes for the workflow engine.
 *
 * - GET  /api/workflows                        → { definitions }
 * - POST /api/workflows                        → save a user definition (shadows built-ins by id)
 * - GET  /api/workflows/runs                   → { runs }
 * - POST /api/workflows/runs                   → start a run ({ workflowId, title, workspaceDir?, roleOverrides? })
 * - GET  /api/workflows/runs/{id}              → { task, definition, journal }
 * - POST /api/workflows/runs/{id}/advance      → { outputs? }
 * - POST /api/workflows/runs/{id}/gate         → { action: "approve"|"reject", note? }
 * - POST /api/workflows/runs/{id}/abort        → { reason? }
 */

import { configuredApiAuthToken, jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import {
  WorkflowError,
  abortRun,
  advanceRun,
  approveGate,
  getRun,
  rejectGate,
  startRun,
} from "../../workflow/engine";
import { deleteDefinition, getDefinition, listDefinitions, listTasks, saveDefinition } from "../../workflow/store";
import { isExecuting as kickIsExecuting, kickExecution } from "../../workflow/executor";
import { syncWorkflowLayer } from "../../workflow/inject";
import { ensureWorkflowSkill } from "../../workflow/skill";
import type { WorkflowAgent, WorkflowDefinition } from "../../workflow/types";

/** CCG-style one-command classification: keyword match, else feature delivery. */
export function classifyWorkflow(description: string): string {
  const d = description.toLowerCase();
  if (/(debug|bug|报错|报错|修复|排查|错误|investigat|diagnos|fix\b)/i.test(d)) return "debug-investigate";
  if (/(review|审查|审计|audit|检查.*代码|code.*check)/i.test(d)) return "review-audit";
  return "feature-delivery";
}

/** The operator's current default model as a routable ref, if one is resolvable. */
export async function defaultModelRef(config: ManagementContext["config"]): Promise<string | null> {
  const refFor = (providerName: string, model: string): string => {
    // Bare gpt-* ids route through the canonical openai provider; everyone else
    // needs the namespaced form.
    if (providerName === "openai" || /^(gpt-|o[134]-)/i.test(model)) return model;
    return `${providerName}/${model}`;
  };
  const providerName = config.defaultProvider;
  const provider = providerName ? config.providers?.[providerName] : undefined;
  const model = provider?.defaultModel?.trim();
  if (model) return refFor(providerName, model);
  // First combo — the virtual model the operator already maintains as a daily driver.
  const { comboPublicModelId, getCombo, listComboIds } = await import("../../combos");
  const comboId = listComboIds(config)[0];
  const combo = comboId ? getCombo(config, comboId) : undefined;
  if (comboId && combo) return comboPublicModelId(comboId, combo);
  for (const [name, p] of Object.entries(config.providers ?? {})) {
    const candidate = (p as { defaultModel?: string } | undefined)?.defaultModel?.trim();
    if (candidate) return refFor(name, candidate);
  }
  return null;
}

function executorOptions(ctx: ManagementContext) {
  // Use a data-plane credential only; management credentials cannot admit model calls.
  const token = configuredApiAuthToken() ?? ctx.config.apiKeys?.find(entry => entry.key.trim())?.key ?? "";
  return {
    baseUrl: `http://127.0.0.1:${ctx.config.port}`,
    adminToken: token,
    onTransition: () => { syncWorkflowLayer(); },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentOverrides(body: Record<string, unknown>): Record<string, WorkflowAgent> | undefined {
  if (body.agentOverrides === undefined) return undefined;
  if (!isPlainRecord(body.agentOverrides) || Object.values(body.agentOverrides).some(v => typeof v !== "string")) {
    throw new WorkflowError("agentOverrides must map roles to agent names");
  }
  return body.agentOverrides as Record<string, WorkflowAgent>;
}

async function readJsonBody(ctx: ManagementContext): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(ctx.req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body", code: "invalid_json_body" }, 400, ctx.req, ctx.config);
  }
}

function errorResponse(error: unknown, req: Request, config: ManagementContext["config"]): Response {
  const status = error instanceof WorkflowError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: message, code: "workflow_error" }, status, req, config);
}

export async function handleWorkflowRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (!url.pathname.startsWith("/api/workflows")) {
    return null;
  }

  // 1. GET /api/workflows
  if (url.pathname === "/api/workflows" && req.method === "GET") {
    return jsonResponse({ definitions: listDefinitions() }, 200, req, ctx.config);
  }

  // 2. POST /api/workflows — save a user definition
  if (url.pathname === "/api/workflows" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    const body = isPlainRecord(parsed) ? parsed : {};
    const candidate = isPlainRecord(body.definition) ? body.definition : body;
    const def = candidate as unknown as WorkflowDefinition;
    if (!isPlainRecord(candidate) || typeof def.id !== "string") {
      return jsonResponse({ error: "definition with a string 'id' is required", code: "invalid_definition" }, 400, req, ctx.config);
    }
    const result = saveDefinition(def);
    if (!result.ok) {
      return jsonResponse({ error: result.errors.join("; "), code: "invalid_definition" }, 400, req, ctx.config);
    }
    return jsonResponse({ ok: true, definition: def }, 200, req, ctx.config);
  }

  // 2b. DELETE /api/workflows/{id} — remove a user definition
  const deleteMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]);
    const result = deleteDefinition(id);
    if (!result.ok) {
      return jsonResponse({ error: result.error, code: "delete_definition_failed" }, result.error.includes("built-in") ? 400 : 404, req, ctx.config);
    }
    return jsonResponse({ ok: true }, 200, req, ctx.config);
  }

  // 2c. POST /api/workflows/go — the one-command entry: classify, bind the operator's
  // default model to every role, and start executing immediately.
  if (url.pathname === "/api/workflows/go" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    const body = isPlainRecord(parsed) ? parsed : {};
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!description) {
      return jsonResponse({ error: "description is required", code: "invalid_description" }, 400, req, ctx.config);
    }
    const workflowId = typeof body.workflowId === "string" && body.workflowId ? body.workflowId : classifyWorkflow(description);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : description.slice(0, 80);
    const fallbackModelRef = typeof body.modelRef === "string" && body.modelRef.trim()
      ? body.modelRef.trim()
      : await defaultModelRef(ctx.config);
    const roleOverrides = isPlainRecord(body.roleOverrides)
      ? Object.fromEntries(Object.entries(body.roleOverrides).filter(([, value]) => typeof value === "string") as Array<[string, string]>)
      : undefined;
    const definition = getDefinition(workflowId);
    const needsFallback = definition?.phases.some(phase => {
      if (!phase.modelRef?.startsWith("role:")) return false;
      const role = phase.modelRef.slice(5).trim();
      return !roleOverrides?.[role]?.trim() && !definition.defaults?.[role]?.trim();
    });
    if (!fallbackModelRef && needsFallback) {
      return jsonResponse(
        { error: "no default model configured — pass modelRef or set a provider defaultModel", code: "no_default_model" },
        409,
        req,
        ctx.config,
      );
    }
    try {
      const task = startRun({
        workflowId,
        title,
        requirements: description,
        agentOverrides: agentOverrides(body),
        baseRevision: typeof body.baseRevision === "string" ? body.baseRevision : undefined,
        workspaceDir: typeof body.workspaceDir === "string" ? body.workspaceDir : undefined,
        roleOverrides,
        autoRun: true,
        fallbackModelRef: fallbackModelRef ?? undefined,
      });
      ensureWorkflowSkill();
      const execution = kickExecution(task.id, { ...executorOptions(ctx), auto: true });
      syncWorkflowLayer();
      return jsonResponse({ ok: true, task, workflowId, fallbackModelRef, execution }, 200, req, ctx.config);
    } catch (error) {
      return errorResponse(error, req, ctx.config);
    }
  }

  // 3. GET /api/workflows/runs
  if (url.pathname === "/api/workflows/runs" && req.method === "GET") {
    return jsonResponse({ runs: listTasks() }, 200, req, ctx.config);
  }

  // 4. POST /api/workflows/runs — start a run
  if (url.pathname === "/api/workflows/runs" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    const body = isPlainRecord(parsed) ? parsed : {};
    const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
    const title = typeof body.title === "string" ? body.title : "";
    const workspaceDir = typeof body.workspaceDir === "string" ? body.workspaceDir : undefined;
    const roleOverrides = isPlainRecord(body.roleOverrides)
      ? Object.fromEntries(
          Object.entries(body.roleOverrides).filter(([, v]) => typeof v === "string") as Array<[string, string]>,
        )
      : undefined;
    try {
      const auto = body.auto === true;
      const task = startRun({ workflowId, title, workspaceDir, roleOverrides, autoRun: auto,
        requirements: typeof body.requirements === "string" ? body.requirements : undefined,
        baseRevision: typeof body.baseRevision === "string" ? body.baseRevision : undefined,
        agentOverrides: agentOverrides(body),
      });
      ensureWorkflowSkill();
      let execution: { started: boolean; reason?: string } = { started: false };
      if (auto) execution = kickExecution(task.id, { ...executorOptions(ctx), auto: true });
      syncWorkflowLayer();
      return jsonResponse({ ok: true, task, execution }, 200, req, ctx.config);
    } catch (error) {
      return errorResponse(error, req, ctx.config);
    }
  }

  // 5. /api/workflows/runs/{id}[/action]
  const match = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)(?:\/(advance|gate|abort|execute))?$/);
  if (match) {
    const taskId = decodeURIComponent(match[1]);
    const action = match[2];

    // GET /api/workflows/runs/{id}
    if (!action && req.method === "GET") {
      const run = getRun(taskId);
      if (!run) {
        return jsonResponse({ error: `unknown run '${taskId}'`, code: "run_not_found" }, 404, req, ctx.config);
      }
      return jsonResponse({ ...run, executing: kickIsExecuting(taskId) }, 200, req, ctx.config);
    }

    if (req.method !== "POST") return null;
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    const body = isPlainRecord(parsed) ? parsed : {};
    const note = typeof body.note === "string" ? body.note : typeof body.reason === "string" ? body.reason : undefined;

    try {
      if (action === "advance") {
        const outputs = typeof body.outputs === "string" ? body.outputs : undefined;
        const task = advanceRun(taskId, { outputs });
        syncWorkflowLayer();
        // An auto run resumes executing by itself once the operator moves it past a
        // manual phase.
        if (task.autoRun && task.status === "running") {
          kickExecution(task.id, { ...executorOptions(ctx), auto: true });
        }
        return jsonResponse({ ok: true, task }, 200, req, ctx.config);
      }
      if (action === "gate") {
        if (body.action !== "approve" && body.action !== "reject") {
          return jsonResponse(
            { error: "gate body must carry action: \"approve\" or \"reject\"", code: "invalid_gate_action" },
            400,
            req,
            ctx.config,
          );
        }
        const task = body.action === "approve" ? approveGate(taskId, { note }) : rejectGate(taskId, { note });
        syncWorkflowLayer();
        if (task.autoRun && task.status === "running") {
          kickExecution(task.id, { ...executorOptions(ctx), auto: true });
        }
        return jsonResponse({ ok: true, task }, 200, req, ctx.config);
      }
      if (action === "execute") {
        const auto = body.auto === true;
        const kicked = kickExecution(taskId, { ...executorOptions(ctx), auto });
        if (!kicked.started) {
          return jsonResponse({ ok: true, executing: true, started: false, reason: kicked.reason }, 200, req, ctx.config);
        }
        return jsonResponse({ ok: true, started: true, auto }, 202, req, ctx.config);
      }
      if (action === "abort") {
        const task = abortRun(taskId, { reason: note });
        syncWorkflowLayer();
        return jsonResponse({ ok: true, task }, 200, req, ctx.config);
      }
    } catch (error) {
      return errorResponse(error, req, ctx.config);
    }
  }

  return null;
}
