import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { abortRun, advanceRun, approveGate, rejectGate, startRun } from "../src/workflow/engine";
import { getDefinition, loadTask, saveDefinition } from "../src/workflow/store";
import { assemblePrompt, executeCurrentPhase, kickExecution, waitForExecution } from "../src/workflow/executor";
import { collectDiff } from "../src/workflow/workspace";
import { buildAgentCommand } from "../src/workflow/agent-command";
import { handleWorkflowCommand } from "../src/cli/workflow";

const bases: string[] = [];
const realFetch = globalThis.fetch;
const originalPath = process.env.PATH;
function store() { const dir = mkdtempSync(join(tmpdir(), "ocx-delivery-test-")); bases.push(dir); return dir; }
afterEach(() => { globalThis.fetch = realFetch; process.env.PATH = originalPath; for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("quick-start fallback preserves configured planner and worker models", () => {
  const base = store();
  saveDefinition({ id: "roles", defaults: { planner: "a/planner", worker: "b/worker" }, phases: [
    { id: "plan", modelRef: "role:planner" }, { id: "work", modelRef: "role:worker" }, { id: "review", modelRef: "role:reviewer" },
  ] }, base);
  const task = startRun({ workflowId: "roles", title: "T", fallbackModelRef: "c/fallback" }, base);
  expect(task.phases[0].modelRef).toBe("a/planner");
  expect(advanceRun(task.id, {}, base).phases[1].modelRef).toBe("b/worker");
  expect(advanceRun(task.id, {}, base).phases[2].modelRef).toBe("c/fallback");
});

function repository() {
  const dir = store();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  writeFileSync(join(dir, "app.txt"), "before\n");
  git("add", "app.txt");
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  commit();
  return { dir, git, commit };
}

function fakeAgents(base: string) {
  const bin = join(base, "bin");
  mkdirSync(bin);
  for (const name of ["codex", "agy", "grok", "opencode", "claude"]) {
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\nconst prompt = ${JSON.stringify(name)} === "codex" ? await Bun.stdin.text() : process.argv.at(-1);\nconsole.log(JSON.stringify({agent:${JSON.stringify(name)},prompt,cwd:process.cwd(),args:process.argv.slice(2)}));\n`);
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${bin}:${originalPath}`;
}

test("native agent dispatch preserves multiline prompts literally and pins cwd", async () => {
  const base = store();
  fakeAgents(base);
  const prompt = "Use `literal backticks` and $(not-a-command)\nquotes: \" ' ; &";
  for (const agent of ["codex", "agy", "grok", "opencode", "claude"] as const) {
    saveDefinition({ id: agent, phases: [{ id: "work", mode: "agent", agent, modelRef: "native/model", prompt }] }, base);
    const task = startRun({ workflowId: agent, title: "T", workspaceDir: base }, base);
    const result = await executeCurrentPhase(task.id, {}, base);
    expect(result.ok).toBe(true);
    const received = JSON.parse(result.outputs!);
    expect(received.prompt).toContain(prompt);
    expect(received.cwd).toBe(task.workspaceDir);
    expect(received.agent).toBe(agent);
    expect(received.args).toContain("native/model");
  }
});

test("review evidence includes committed, staged, unstaged and untracked changes", () => {
  const { dir, git, commit } = repository();
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "app.txt"), "committed-change\n");
  git("add", "app.txt"); commit();
  writeFileSync(join(dir, "staged.txt"), "staged-change\n"); git("add", "staged.txt");
  writeFileSync(join(dir, "app.txt"), "committed-change\nunstaged-change\n");
  writeFileSync(join(dir, "new file.txt"), "untracked-change\n");
  const evidence = collectDiff(dir, base);
  for (const text of ["committed-change", "staged-change", "unstaged-change", "untracked-change"]) expect(evidence.diff).toContain(text);
  expect(evidence.headRevision).not.toBe(base);
});

test("delivery runs plan, native worker, review, rework and report with actual evidence", async () => {
  const base = store();
  const { dir } = repository();
  fakeAgents(base);
  const requirements = "Detailed requirement. ".repeat(20) + "KEEP_THIS_LAST_CONSTRAINT";
  const task = startRun({ workflowId: "feature-delivery", title: "Short title", requirements, workspaceDir: dir,
    roleOverrides: { planner: "test/planner", worker: "native/worker", reviewer: "test/reviewer" }, agentOverrides: { worker: "grok" } }, base);
  const prompts: string[] = [];
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    prompts.push(body.messages[0].content);
    return Response.json({ choices: [{ message: { content: "REVIEW: fix timeout handling" } }] });
  }) as typeof fetch;
  const execute = async () => { kickExecution(task.id, { auto: true }, base); await waitForExecution(task.id); };
  await execute();
  let state = loadTask(task.id, base)!;
  expect(state.status).toBe("awaiting_gate");
  expect(state.phases[0].outputs).toContain("KEEP_THIS_LAST_CONSTRAINT");
  approveGate(task.id, {}, base);
  writeFileSync(join(dir, "app.txt"), "ACTUAL_CODE_CHANGE\n");
  await execute();
  state = loadTask(task.id, base)!;
  expect(state.currentGate?.id).toBe("review-acceptance");
  expect(JSON.parse(state.phases[2].outputs!).agent).toBe("grok");
  expect(prompts[0]).toContain("ACTUAL_CODE_CHANGE");
  expect(prompts[0]).toContain("Output of phase 'verify'");
  rejectGate(task.id, { note: "Also test cancellation" }, base);
  await execute();
  state = loadTask(task.id, base)!;
  const workerPrompt = JSON.parse(state.phases[2].outputs!).prompt;
  expect(workerPrompt).toContain("fix timeout handling");
  expect(workerPrompt).toContain("Also test cancellation");
  approveGate(task.id, {}, base);
  await execute();
  expect(loadTask(task.id, base)!.status).toBe("completed");
  expect(prompts.at(-1)).toContain("Output of phase 'review'");
});

test("editing a definition does not change a running task", () => {
  const base = store();
  saveDefinition({ id: "snapshot", phases: [{ id: "a" }, { id: "b" }] }, base);
  const task = startRun({ workflowId: "snapshot", title: "T" }, base);
  saveDefinition({ id: "snapshot", phases: [{ id: "different" }] }, base);
  expect(advanceRun(task.id, {}, base).phases[1].id).toBe("b");
});

test("abort cancels active transport and late output cannot modify task state", async () => {
  const base = store();
  saveDefinition({ id: "abortable", phases: [{ id: "work", modelRef: "test/model" }] }, base);
  const task = startRun({ workflowId: "abortable", title: "T" }, base);
  let signal: AbortSignal | null | undefined;
  let release!: (response: Response) => void;
  globalThis.fetch = ((_url, opts) => { signal = opts?.signal; return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
  kickExecution(task.id, {}, base);
  abortRun(task.id, {}, base);
  expect(signal?.aborted).toBe(true);
  release(Response.json({ choices: [{ message: { content: "STALE" } }] }));
  await waitForExecution(task.id);
  const state = loadTask(task.id, base)!;
  expect(state.status).toBe("aborted");
  expect(state.phases[0].outputs).toBeUndefined();
});

test("worker CLI override does not change planner CLI", () => {
  const task = { agentOverrides: { worker: "agy" as const } } as Parameters<typeof buildAgentCommand>[1];
  expect(buildAgentCommand({ id: "plan", modelRef: "role:planner" }, task, "planner-model", "P").bin).toBe("codex");
  expect(buildAgentCommand({ id: "plan", modelRef: "role:planner" }, task, "planner-model", "P").args).toContain("read-only");
  expect(buildAgentCommand({ id: "work", modelRef: "role:worker" }, task, "worker-model", "P").bin).toBe("agy");
});

test("CLI go forwards the whole request, caller directory, role models and worker tool", async () => {
  const description = "Long requirement ".repeat(20) + "LAST_CONSTRAINT";
  let received: Record<string, unknown> = {};
  const code = await handleWorkflowCommand(["go", description, "--agent", "opencode", "--set", "worker=provider/native", "--set", "planner=planner-model", "--base", "main", "--json"], {
    baseUrl: "http://fixture.invalid",
    fetchImpl: (async (_url, options) => {
      received = JSON.parse(String(options?.body));
      return Response.json({ task: { id: "fixture", workflowId: "feature-delivery", phases: [] } });
    }) as typeof fetch,
  });
  expect(code).toBe(0);
  expect(received).toMatchObject({ description, workspaceDir: process.cwd(), baseRevision: "main", agentOverrides: { worker: "opencode" }, roleOverrides: { worker: "provider/native", planner: "planner-model" } });
});

test("approval is bound to the code that was reviewed", async () => {
  const base = store();
  const { dir } = repository();
  saveDefinition({ id: "review", phases: [{ id: "review", modelRef: "test/reviewer", inputs: ["diff"] }, { id: "accept", gate: { id: "accept" } }] }, base);
  const task = startRun({ workflowId: "review", title: "T", workspaceDir: dir }, base);
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: "Reviewed" } }] })) as typeof fetch;
  kickExecution(task.id, {}, base); await waitForExecution(task.id);
  writeFileSync(join(dir, "app.txt"), "not yet reviewed\n");
  expect(() => approveGate(task.id, {}, base)).toThrow(/changed since review/);
  expect(loadTask(task.id, base)!.status).toBe("awaiting_gate");
});

test("automatic code workflows fail before dispatch when workspace or base commit is absent", () => {
  const base = store();
  expect(() => startRun({ workflowId: "feature-delivery", title: "T", autoRun: true }, base)).toThrow(/workspace/);
  expect(() => startRun({ workflowId: "feature-delivery", title: "T", autoRun: true, workspaceDir: base }, base)).toThrow(/base commit/);
});

test("abort terminates the native worker before accepting its partial stdout", async () => {
  const base = store();
  fakeAgents(base);
  const ready = join(base, "ready");
  writeFileSync(join(base, "bin", "codex"), `#!${process.execPath}\nawait Bun.stdin.text(); await Bun.write(${JSON.stringify(ready)},String(process.pid)); console.log("PARTIAL RESULT"); await Bun.sleep(30000);\n`);
  saveDefinition({ id: "native-abort", phases: [{ id: "work", mode: "agent", modelRef: "test/model" }] }, base);
  const task = startRun({ workflowId: "native-abort", title: "T", workspaceDir: base }, base);
  kickExecution(task.id, { agentTimeoutMs: 3_000 }, base);
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
  } finally { abortRun(task.id, {}, base); await waitForExecution(task.id); }
  const pid = Number(readFileSync(ready, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(loadTask(task.id, base)!.phases[0].outputs).toBeUndefined();
});

test("review rejection carries findings and note into rework and invalidates downstream evidence", () => {
  const base = store();
  const task = startRun({ workflowId: "feature-delivery", title: "T" }, base);
  advanceRun(task.id, { outputs: "APPROVED PLAN" }, base);
  approveGate(task.id, {}, base);
  advanceRun(task.id, { outputs: "IMPLEMENTATION" }, base);
  advanceRun(task.id, { outputs: "OLD TEST RESULTS" }, base);
  advanceRun(task.id, { outputs: "BLOCKER: missing error handling" }, base);
  const rework = rejectGate(task.id, { note: "Cover timeout too" }, base);
  const def = getDefinition(task.workflowId, base)!;
  const prompt = assemblePrompt(def.phases[rework.phaseIndex], def, rework);
  expect(prompt).toContain("missing error handling");
  expect(prompt).toContain("Cover timeout too");
  expect(rework.phases.find(p => p.id === "verify")?.status).toBe("pending");
  expect(rework.phases.find(p => p.id === "review")?.outputs).toBeUndefined();
});

test("an in-flight phase cannot be manually advanced into another phase", async () => {
  const base = store();
  saveDefinition({ id: "race", phases: [{ id: "a", modelRef: "test/model" }, { id: "b", modelRef: "test/model" }] }, base);
  const task = startRun({ workflowId: "race", title: "T" }, base);
  let release!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
  kickExecution(task.id, {}, base);
  try {
    expect(() => advanceRun(task.id, {}, base)).toThrow(/execut/);
  } finally {
    release(Response.json({ choices: [{ message: { content: "RESULT A" } }] }));
    await waitForExecution(task.id);
  }
  const after = loadTask(task.id, base)!;
  expect(after.status).toBe("running");
  expect(after.phases[0].outputs).toBe("RESULT A");
  expect(after.phases[1].outputs).toBeUndefined();
});
