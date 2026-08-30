import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkflowError,
  abortRun,
  advanceRun,
  approveGate,
  getRun,
  rejectGate,
  resolveModelRef,
  startRun,
} from "../src/workflow/engine";
import {
  createTaskId,
  getDefinition,
  listDefinitions,
  listTasks,
  readJournal,
  saveDefinition,
  validateDefinition,
} from "../src/workflow/store";
import type { WorkflowDefinition } from "../src/workflow/types";

describe("Workflow engine and store", () => {
  const base = join(tmpdir(), `ocx-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

  afterAll(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("definition validation catches structural mistakes", () => {
    const errors = validateDefinition({
      id: "bad",
      phases: [
        { id: "gate-1", gate: { id: "g" } },
        { id: "plan", modelRef: "openai/gpt-5.6" },
        { id: "plan", modelRef: "openai/gpt-5.6" },
        { id: "review", modelRef: "role:reviewer", mode: "chat" },
        { id: "accept", gate: { id: "g2", rejectTo: "nope" } },
      ],
    });
    expect(errors.some(e => e.includes("first phase must not be a gate"))).toBe(true);
    expect(errors.some(e => e.includes("duplicate phase id: plan"))).toBe(true);
    expect(errors.some(e => e.includes("rejectTo references unknown phase nope"))).toBe(true);

    expect(validateDefinition({ id: "ok", phases: [{ id: "only" }] })).toEqual([]);
  });

  test("user definitions shadow built-ins by id and persist round-trip", () => {
    saveDefinition(
      {
        id: "feature-delivery",
        title: "Shadowed delivery",
        defaults: { planner: "openai/gpt-5.6" },
        phases: [
          { id: "plan", modelRef: "role:planner" },
          { id: "done-check", gate: { id: "final" } },
        ],
      },
      base,
    );
    const def = getDefinition("feature-delivery", base);
    expect(def?.builtin).toBe(false);
    expect(def?.title).toBe("Shadowed delivery");

    const ids = listDefinitions(base).map(d => d.id);
    expect(ids).toContain("review-audit");
    expect(ids).toContain("debug-investigate");
  });

  test("role resolution precedence: explicit > task override > definition default", () => {
    const definition: WorkflowDefinition = {
      id: "roles",
      defaults: { planner: "default/planner-model" },
      phases: [],
    };
    const task = { roleOverrides: { planner: "override/planner-model" } };
    expect(resolveModelRef({ id: "p", modelRef: "openai/gpt-5.6" }, definition, task)).toEqual({
      modelRef: "openai/gpt-5.6",
      source: "explicit",
    });
    expect(resolveModelRef({ id: "p", modelRef: "role:planner" }, definition, task)).toEqual({
      modelRef: "override/planner-model",
      source: "task-override",
    });
    expect(resolveModelRef({ id: "p", modelRef: "role:planner" }, definition, {})).toEqual({
      modelRef: "default/planner-model",
      source: "definition-default",
    });
    expect(resolveModelRef({ id: "p", modelRef: "role:unknown" }, definition, {})).toEqual({
      source: "unresolved",
    });
  });

  test("feature-delivery run walks plan → gate → implement → ... → completed", () => {
    // Dedicated store base: the shadowing test above replaces feature-delivery by id.
    const walkBase = join(base, "walk");
    const task = startRun(
      {
        workflowId: "feature-delivery",
        title: "Add JWT auth",
        roleOverrides: {
          planner: "openai/gpt-5.6",
          worker: "openai/gpt-5.5",
          reviewer: "anthropic/claude-opus-5",
        },
      },
      walkBase,
    );
    expect(task.status).toBe("running");
    expect(task.phases[0].status).toBe("in_progress");
    expect(task.phases[0].modelRef).toBe("openai/gpt-5.6");

    // advance → gate
    const atGate = advanceRun(task.id, { outputs: "the plan" }, walkBase);
    expect(atGate.status).toBe("awaiting_gate");
    expect(atGate.currentGate?.id).toBe("plan-approval");
    expect(atGate.phases[0].outputs).toBe("the plan");

    // advance is blocked at a gate
    expect(() => advanceRun(task.id, {}, walkBase)).toThrow(/waiting at gate/);

    // reject → rework back to plan (explicit rejectTo)
    const reworked = rejectGate(task.id, { note: "plan misses migrations" }, walkBase);
    expect(reworked.status).toBe("running");
    expect(reworked.phaseIndex).toBe(0);
    expect(reworked.phases[0].status).toBe("in_progress");
    expect(reworked.phases.find(p => p.id === "approve-plan")?.status).toBe("rejected");

    // approve after re-advance walks into implement
    advanceRun(task.id, { outputs: "the plan v2" }, walkBase);
    const implementing = approveGate(task.id, { note: "ship it" }, walkBase);
    expect(implementing.status).toBe("running");
    expect(implementing.phases[1].status).toBe("done");
    expect(implementing.phases[2].id).toBe("implement");
    expect(implementing.phases[2].status).toBe("in_progress");
    expect(implementing.phases[2].modelRef).toBe("openai/gpt-5.5");

    // walk the rest: implement → verify → review → accept gate → report → completed
    advanceRun(task.id, {}, walkBase);
    advanceRun(task.id, {}, walkBase);
    const atReviewGate = advanceRun(task.id, {}, walkBase);
    expect(atReviewGate.currentGate?.id).toBe("review-acceptance");
    const accepted = approveGate(task.id, {}, walkBase);
    expect(accepted.phases[6].id).toBe("report");
    const done = advanceRun(task.id, {}, walkBase);
    expect(done.status).toBe("completed");
    expect(done.currentGate).toBeUndefined();

    // the journal recorded every transition in order
    const events = readJournal(task.id, walkBase).map(e => e.event);
    expect(events[0]).toBe("created");
    expect(events).toContain("gate_rejected");
    expect(events).toContain("gate_approved");
    expect(events[events.length - 1]).toBe("completed");

    const run = getRun(task.id, walkBase);
    expect(run?.definition.id).toBe("feature-delivery");
    expect(run?.journal.length).toBe(events.length);

    // a completed run cannot advance again
    expect(() => advanceRun(task.id, {}, walkBase)).toThrow(/completed/);
  });

  test("gate reject falls back to the nearest previous non-gate phase", () => {
    saveDefinition(
      {
        id: "reject-fallback",
        phases: [
          { id: "a" },
          { id: "g1", gate: { id: "g1" } },
          { id: "g2", gate: { id: "g2" } },
        ],
      },
      base,
    );
    const task = startRun({ workflowId: "reject-fallback", title: "fallback" }, base);
    advanceRun(task.id, {}, base);
    approveGate(task.id, {}, base);
    const atG2 = getRun(task.id, base)!.task;
    expect(atG2.status).toBe("awaiting_gate");
    expect(atG2.currentGate?.id).toBe("g2");
    const rejected = rejectGate(task.id, {}, base);
    expect(rejected.phaseIndex).toBe(0);
    expect(rejected.phases[0].status).toBe("in_progress");
  });

  test("abort works from running and awaiting_gate, then the run is terminal", () => {
    const a = startRun({ workflowId: "reject-fallback", title: "abort running" }, base);
    const aborted = abortRun(a.id, { reason: "changed mind" }, base);
    expect(aborted.status).toBe("aborted");
    expect(() => abortRun(a.id, {}, base)).toThrow(/already aborted/);

    const b = startRun({ workflowId: "reject-fallback", title: "abort at gate" }, base);
    advanceRun(b.id, {}, base);
    const abortedAtGate = abortRun(b.id, {}, base);
    expect(abortedAtGate.status).toBe("aborted");
  });

  test("startRun validates unknown workflow, missing title, and invalid definitions", () => {
    expect(() => startRun({ workflowId: "nope", title: "x" }, base)).toThrow(/unknown workflow/);
    expect(() => startRun({ workflowId: "reject-fallback", title: "  " }, base)).toThrow(/title is required/);

    mkdirSync(join(base, "definitions"), { recursive: true });
    writeFileSync(
      join(base, "definitions", "broken.json"),
      JSON.stringify({ id: "broken", phases: [{ id: "g", gate: { id: "g" } }] }),
    );
    expect(() => startRun({ workflowId: "broken", title: "x" }, base)).toThrow(/is invalid/);
  });

  test("listTasks returns runs newest-first; task ids are unique and filesystem-safe", () => {
    const t1 = startRun({ workflowId: "reject-fallback", title: "one" }, base);
    const t2 = startRun({ workflowId: "reject-fallback", title: "two" }, base);
    const tasks = listTasks(base);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(createTaskId()).toMatch(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/);
    expect(t1.id).not.toBe(t2.id);
  });
});
