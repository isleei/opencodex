import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { classifyWorkflow } from "../src/server/management/workflow-routes";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import { saveDefinition } from "../src/workflow/store";
import { waitForExecution } from "../src/workflow/executor";

describe("Management Workflow REST API (/api/workflows*)", () => {
  let tempBase: string;
  let baseConfig: OcxConfig;
  let previousOcxHome: string | undefined;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "ocx-mgmt-workflow-test-"));
    previousOcxHome = process.env.OPENCODEX_HOME;
    // Each test gets its own workflows store via the config dir.
    process.env.OPENCODEX_HOME = join(tempBase, "ocx-home");

    baseConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {},
    };
  });

  afterEach(() => {
    if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOcxHome;
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function dispatchRequest(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    const headers: Record<string, string> = { host: "127.0.0.1:10100" };
    if (body !== undefined) headers["content-type"] = "application/json";

    const req = new Request(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const deps: ManagementApiDeps = {};
    const res = await handleManagementAPI(req, url, baseConfig, deps);
    if (!res) throw new Error(`Route not handled: ${method} ${pathname}`);
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  test("GET /api/workflows lists the built-in definitions", async () => {
    const { status, body } = await dispatchRequest("GET", "/api/workflows");
    expect(status).toBe(200);
    const ids = body.definitions.map((d: any) => d.id);
    expect(ids).toContain("feature-delivery");
    expect(ids).toContain("review-audit");
    expect(ids).toContain("debug-investigate");
  });

  test("POST /api/workflows saves a user definition and rejects invalid ones", async () => {
    const ok = await dispatchRequest("POST", "/api/workflows", {
      definition: {
        id: "custom-flow",
        defaults: { planner: "openai/gpt-5.6" },
        phases: [
          { id: "plan", modelRef: "role:planner" },
          { id: "gate", gate: { id: "final" } },
        ],
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const listed = await dispatchRequest("GET", "/api/workflows");
    expect(listed.body.definitions.map((d: any) => d.id)).toContain("custom-flow");

    const bad = await dispatchRequest("POST", "/api/workflows", {
      definition: { id: "broken", phases: [{ id: "g", gate: { id: "g" } }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_definition");
  });

  test("a run starts, advances into a gate, and resolves through it", async () => {
    const started = await dispatchRequest("POST", "/api/workflows/runs", {
      workflowId: "feature-delivery",
      title: "Wire the retry queue",
      roleOverrides: {
        planner: "openai/gpt-5.6",
        worker: "openai/gpt-5.5",
        reviewer: "anthropic/claude-opus-5",
      },
    });
    expect(started.status).toBe(200);
    const taskId = started.body.task.id;
    expect(started.body.task.status).toBe("running");

    const listed = await dispatchRequest("GET", "/api/workflows/runs");
    expect(listed.body.runs.map((r: any) => r.id)).toContain(taskId);

    const atGate = await dispatchRequest("POST", `/api/workflows/runs/${taskId}/advance`, {
      outputs: "the plan",
    });
    expect(atGate.status).toBe(200);
    expect(atGate.body.task.status).toBe("awaiting_gate");
    expect(atGate.body.task.currentGate.id).toBe("plan-approval");

    // advancing at a gate is a conflict, not a crash
    const conflict = await dispatchRequest("POST", `/api/workflows/runs/${taskId}/advance`, {});
    expect(conflict.status).toBe(409);

    const rejected = await dispatchRequest("POST", `/api/workflows/runs/${taskId}/gate`, {
      action: "reject",
      note: "missing migration step",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.task.status).toBe("running");
    expect(rejected.body.task.phaseIndex).toBe(0);

    await dispatchRequest("POST", `/api/workflows/runs/${taskId}/advance`, { outputs: "plan v2" });
    const approved = await dispatchRequest("POST", `/api/workflows/runs/${taskId}/gate`, {
      action: "approve",
      note: "ship it",
    });
    expect(approved.body.task.status).toBe("running");
    expect(approved.body.task.phases[2].id).toBe("implement");

    const detail = await dispatchRequest("GET", `/api/workflows/runs/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.definition.id).toBe("feature-delivery");
    expect(detail.body.journal.some((e: any) => e.event === "gate_rejected")).toBe(true);
  });

  test("user definitions can be deleted; built-ins cannot", async () => {
    await dispatchRequest("POST", "/api/workflows", {
      definition: { id: "deletable-flow", phases: [{ id: "only" }] },
    });
    const deleted = await dispatchRequest("DELETE", "/api/workflows/deletable-flow");
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    const listed = await dispatchRequest("GET", "/api/workflows");
    expect(listed.body.definitions.map((d: any) => d.id)).not.toContain("deletable-flow");

    const builtin = await dispatchRequest("DELETE", "/api/workflows/feature-delivery");
    expect(builtin.status).toBe(400);
    expect(builtin.body.error).toContain("built-in");

    const missing = await dispatchRequest("DELETE", "/api/workflows/never-existed");
    expect(missing.status).toBe(404);
  });

  test("go classifies by keyword and starts executing with the given model", async () => {
    expect(classifyWorkflow("fix the login bug")).toBe("debug-investigate");
    expect(classifyWorkflow("审查一下这个 diff")).toBe("review-audit");
    expect(classifyWorkflow("add rate limiting to the API")).toBe("feature-delivery");

    // Use a no-network fixture: the API test covers persistence and dispatch receipt,
    // while the executor tests exercise the provider and native CLI contracts.
    saveDefinition({ id: "go-fixture", phases: [{ id: "manual" }, { id: "plan", modelRef: "role:planner" }, { id: "work", modelRef: "role:worker" }] });
    const description = "add rate limiting to the API " + "context ".repeat(30) + "LAST_REQUIREMENT";
    const { status, body } = await dispatchRequest("POST", "/api/workflows/go", {
      description,
      workflowId: "go-fixture",
      modelRef: "xai/grok-4.5",
      workspaceDir: tempBase,
      agentOverrides: { worker: "agy" },
    });
    expect(status).toBe(200);
    expect(body.task.status).toBe("running");
    expect(body.fallbackModelRef).toBe("xai/grok-4.5");
    expect(body.task.requirements).toBe(description);
    expect(body.task.agentOverrides.worker).toBe("agy");
    await waitForExecution(body.task.id);
    // every role: reference in feature-delivery is pinned to the fallback
    const refs = new Set(Object.values(body.task.roleOverrides ?? {}));
    expect(refs).toEqual(new Set(["xai/grok-4.5"]));
  });

  test("go without a resolvable model is a 409 with guidance", async () => {
    const { status, body } = await dispatchRequest("POST", "/api/workflows/go", {
      description: "something",
    });
    expect(status).toBe(409);
    expect(body.code).toBe("no_default_model");
  });

  test("go accepts fully configured role defaults without a global fallback model", async () => {
    saveDefinition({ id: "configured-go", defaults: { worker: "native/worker" }, phases: [{ id: "manual" }, { id: "work", modelRef: "role:worker" }] });
    const { status, body } = await dispatchRequest("POST", "/api/workflows/go", {
      description: "Task", workflowId: "configured-go",
    });
    expect(status).toBe(200);
    expect(body.fallbackModelRef).toBeNull();
    expect(body.task.roleOverrides).toEqual({});
    await waitForExecution(body.task.id);
  });

  test("unknown runs return 404 and abort terminates a run", async () => {
    const missing = await dispatchRequest("GET", "/api/workflows/runs/no-such-task");
    expect(missing.status).toBe(404);

    const started = await dispatchRequest("POST", "/api/workflows/runs", {
      workflowId: "review-audit",
      title: "Audit the exporter diff",
    });
    const taskId = started.body.task.id;
    const aborted = await dispatchRequest("POST", `/api/workflows/runs/${taskId}/abort`, {
      reason: "scope changed",
    });
    expect(aborted.status).toBe(200);
    expect(aborted.body.task.status).toBe("aborted");

    const again = await dispatchRequest("POST", `/api/workflows/runs/${taskId}/abort`, {});
    expect(again.status).toBe(409);
  });
});
