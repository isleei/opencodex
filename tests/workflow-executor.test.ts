import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { abortRun, advanceRun, startRun } from "../src/workflow/engine";
import { getDefinition, loadTask, saveDefinition } from "../src/workflow/store";
import { assemblePrompt, executeCurrentPhase, kickExecution, waitForExecution } from "../src/workflow/executor";
import { syncWorkflowLayer } from "../src/workflow/inject";
import { ensureWorkflowSkill } from "../src/workflow/skill";
import type { WorkflowDefinition } from "../src/workflow/types";

describe("Workflow execution, injection, and skill (W2/W4)", () => {
  const base = mkdtempSync(join(tmpdir(), "ocx-wf-exec-test-"));
  const chatFlow: WorkflowDefinition = {
    id: "chat-flow",
    defaults: {},
    phases: [
      { id: "plan", modelRef: "role:planner", mode: "chat", prompt: "Write the plan." },
      { id: "approve", gate: { id: "plan-approval" } },
      { id: "report", modelRef: "role:planner", mode: "chat", prompt: "Report." },
    ],
  };

  let server: ReturnType<typeof Bun.serve>;
  let captured: Array<{ model?: string; messages?: Array<{ content?: string }> }> = [];
  let failNextFailMe = true;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
          const body = (await req.json()) as { model?: string; messages?: Array<{ content?: string }> };
          captured.push(body);
          if (body.messages?.[0]?.content?.includes("FAIL-ME") && failNextFailMe) {
            failNextFailMe = false;
            return new Response("upstream exploded", { status: 502 });
          }
          return Response.json({
            choices: [{ message: { content: "PLAN CONTENT" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    saveDefinition(chatFlow, base);
  });

  afterAll(() => {
    server.stop(true);
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function executorOpts(): { baseUrl: string; adminToken: string } {
    return { baseUrl: `http://127.0.0.1:${server.port}`, adminToken: "test-secret" };
  }

  test("assemblePrompt appends earlier phase outputs named in inputs", () => {
    saveDefinition(
      {
        id: "input-flow",
        phases: [
          { id: "plan", modelRef: "x/y" },
          { id: "compare", modelRef: "x/y", inputs: ["plan", "missing"], prompt: "Compare." },
        ],
      },
      base,
    );
    const task = startRun({ workflowId: "input-flow", title: "T" }, base);
    advanceRun(task.id, { outputs: "THE PLAN" }, base);
    const withOutputs = loadTask(task.id, base)!;
    const definition = getDefinition("input-flow", base)!;
    const prompt = assemblePrompt(definition.phases[1], definition, withOutputs);
    expect(prompt).toContain("Compare.");
    expect(prompt).toContain("# Output of phase 'plan'\nTHE PLAN");
    expect(prompt).not.toContain("# Output of phase 'missing'");
  });

  test("auto pipeline executes chat phases and halts at the gate", async () => {
    const task = startRun(
      { workflowId: "chat-flow", title: "Auto test", roleOverrides: { planner: "fake/model" } },
      base,
    );
    const kicked = kickExecution(task.id, { ...executorOpts(), auto: true }, base);
    expect(kicked.started).toBe(true);
    await waitForExecution(task.id);

    const after = loadTask(task.id, base)!;
    expect(after.status).toBe("awaiting_gate");
    expect(after.phases[0].outputs).toBe("PLAN CONTENT");
    expect(after.phases[0].tokens?.totalTokens).toBe(15);
    expect(captured[0]?.model).toBe("fake/model");
    expect(captured[0]?.messages?.[0]?.content).toContain("Write the plan.");
    expect(captured[0]?.messages?.[0]?.content).toContain("Auto test");
  });

  test("execution failure lands in the phase state and a retry can succeed", async () => {
    saveDefinition(
      {
        id: "fail-flow",
        phases: [
          { id: "plan", modelRef: "role:planner", mode: "chat", prompt: "FAIL-ME now" },
          { id: "gate", gate: { id: "g" } },
        ],
      },
      base,
    );
    const task = startRun({ workflowId: "fail-flow", title: "fail run", roleOverrides: { planner: "fake/model" } }, base);

    const result = await executeCurrentPhase(task.id, executorOpts(), base);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("502");

    const state = loadTask(task.id, base)!;
    expect(state.status).toBe("running");
    expect(state.phases[0].error).toContain("502");
    expect(state.phases[0].outputs).toBeUndefined();

    // Retry after the outage clears.
    const kicked = kickExecution(task.id, { ...executorOpts() }, base);
    expect(kicked.started).toBe(true);
    await waitForExecution(task.id);
    const after = loadTask(task.id, base)!;
    expect(after.phases[0].error).toBeUndefined();
    expect(after.status).toBe("awaiting_gate");
  });

  test("executeCurrentPhase refuses gates and manual phases", async () => {
    saveDefinition(
      { id: "manual-flow", phases: [{ id: "think" }, { id: "stop", gate: { id: "g" } }] },
      base,
    );
    const task = startRun({ workflowId: "manual-flow", title: "manual" }, base);
    expect(() => executeCurrentPhase(task.id, executorOpts(), base)).toThrow(/no model/);
    advanceRun(task.id, {}, base);
    expect(() => executeCurrentPhase(task.id, executorOpts(), base)).toThrow(/waiting at gate/);
  });

  test("breadcrumb is injected while a run is active and removed when it ends", () => {
    // Dedicated store base: other tests leave runs awaiting gates, and the breadcrumb
    // must exist while ANY run is active.
    const injBase = join(base, "inj");
    const paths = { configPath: join(base, "wf-config.toml"), storePath: join(base, "wf-prompt.json") };
    saveDefinition(chatFlow, injBase);
    const task = startRun({ workflowId: "chat-flow", title: "Inject test", roleOverrides: { planner: "x/y" } }, injBase);

    expect(syncWorkflowLayer(injBase, paths).ok).toBe(true);
    let store = JSON.parse(readFileSync(join(base, "wf-prompt.json"), "utf8")) as { layers?: Array<{ id: string; body: string }> };
    let layer = store.layers?.find(l => l.id === "wflow1");
    expect(layer?.body).toContain("<ocx-workflow>");
    expect(layer?.body).toContain(`run: ${task.id}`);
    expect(layer?.body).toContain("ocx workflow advance");

    advanceRun(task.id, {}, injBase);
    syncWorkflowLayer(injBase, paths);
    store = JSON.parse(readFileSync(join(base, "wf-prompt.json"), "utf8"));
    layer = store.layers?.find(l => l.id === "wflow1");
    expect(layer?.body).toContain("gate: plan-approval");

    abortRun(task.id, {}, injBase);
    const removed = syncWorkflowLayer(injBase, paths);
    expect(removed.ok).toBe(true);
    store = JSON.parse(readFileSync(join(base, "wf-prompt.json"), "utf8"));
    expect(store.layers?.some(l => l.id === "wflow1")).toBe(false);
  });

  test("injection is a no-op when disabled", () => {
    process.env.OCX_WORKFLOW_INJECT = "off";
    const result = syncWorkflowLayer(base, { configPath: join(base, "x.toml"), storePath: join(base, "x.json") });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("injection disabled");
    delete process.env.OCX_WORKFLOW_INJECT;
  });

  test("ensureWorkflowSkill writes the managed skill and never overwrites a user skill", () => {
    const agentsHome = join(base, "agents-home");
    const codexHome = join(base, "codex-skills-home");
    mkdirSync(join(codexHome, "skills"), { recursive: true });
    const result = ensureWorkflowSkill({ agentsHome, codexHome });
    expect(result.ok).toBe(true);
    const skillPath = join(agentsHome, "skills", "ocx-workflow", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("name: ocx-workflow");
    expect(existsSync(join(codexHome, "skills", "ocx-workflow"))).toBe(true);

    // A user-authored skill with the same name is left untouched.
    const claudeHome = join(base, "claude-skills-home");
    const userSkill = join(claudeHome, "skills", "ocx-workflow");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "---\nname: ocx-workflow\ndescription: mine\n---\nmine");
    expect(ensureWorkflowSkill({ agentsHome, claudeHome }).ok).toBe(true);
    expect(readFileSync(join(userSkill, "SKILL.md"), "utf8")).toContain("mine");
  });
});
