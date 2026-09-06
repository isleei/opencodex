/**
 * Workflow persistence: definitions and run tasks under
 * `<configDir>/workflows/{definitions,tasks}/`.
 *
 * Layout per run mirrors CCG's `.ccg/tasks/<id>/` shape, scoped to what W1 needs:
 * `task.json` (state), `journal.jsonl` (transition log). `plan.md` / `review.md`
 * arrive with W2 phase outputs.
 *
 * All paths resolve at CALL time from `getConfigDir()` so tests sandbox via
 * `OPENCODEX_HOME`, or isolate further with an explicit `baseDir`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { BUILTIN_WORKFLOWS } from "./builtins";
import { WORKFLOW_AGENTS, type WorkflowDefinition, type WorkflowJournalEntry, type WorkflowTask } from "./types";

export interface WorkflowStoreDirs {
  base: string;
  definitions: string;
  tasks: string;
}

export function workflowDirs(baseDir?: string): WorkflowStoreDirs {
  const base = baseDir || join(getConfigDir(), "workflows");
  return { base, definitions: join(base, "definitions"), tasks: join(base, "tasks") };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export function validateDefinition(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  if (!def.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(def.id)) {
    errors.push(`invalid workflow id: ${JSON.stringify(def.id)}`);
  }
  if (!Array.isArray(def.phases) || def.phases.length === 0) {
    errors.push("workflow must declare at least one phase");
    return errors;
  }
  if (def.phases[0]?.gate) {
    errors.push("the first phase must not be a gate");
  }
  const ids = new Set<string>();
  for (const phase of def.phases) {
    if (!phase || typeof phase !== "object") { errors.push("phase must be an object"); continue; }
    if (!phase.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(phase.id)) {
      errors.push(`invalid phase id: ${JSON.stringify(phase.id)}`);
      continue;
    }
    if (ids.has(phase.id)) errors.push(`duplicate phase id: ${phase.id}`);
    ids.add(phase.id);
    if (phase.mode && phase.mode !== "chat" && phase.mode !== "agent") {
      errors.push(`phase ${phase.id}: unknown mode ${phase.mode}`);
    }
    if (phase.agent && !WORKFLOW_AGENTS.includes(phase.agent)) errors.push(`phase ${phase.id}: unknown agent ${phase.agent}`);
    if (phase.modelRef !== undefined && typeof phase.modelRef !== "string") errors.push(`phase ${phase.id}: modelRef must be a string`);
    if (phase.prompt !== undefined && typeof phase.prompt !== "string") errors.push(`phase ${phase.id}: prompt must be a string`);
    if (phase.inputs && (!Array.isArray(phase.inputs) || phase.inputs.some(input => typeof input !== "string"))) errors.push(`phase ${phase.id}: inputs must be strings`);
    if (phase.gate && phase.modelRef) {
      errors.push(`phase ${phase.id}: a gate phase cannot also bind a model`);
    }
  }
  if (def.defaults && (typeof def.defaults !== "object" || Array.isArray(def.defaults) || Object.values(def.defaults).some(ref => typeof ref !== "string"))) errors.push("defaults must map roles to model strings");
  for (const phase of def.phases) {
    const target = phase?.gate?.rejectTo;
    if (target && !ids.has(target)) {
      errors.push(`phase ${phase.id}: rejectTo references unknown phase ${target}`);
    }
    if (target && ids.has(target)) {
      const index = def.phases.findIndex(p => p?.id === target);
      if (def.phases[index]?.gate || index >= def.phases.indexOf(phase)) errors.push(`phase ${phase.id}: rejectTo must reference an earlier work phase`);
    }
  }
  return errors;
}

/** User definitions shadow built-ins by id; built-ins are never written to disk. */
export function listDefinitions(baseDir?: string): WorkflowDefinition[] {
  const { definitions } = workflowDirs(baseDir);
  const byId = new Map<string, WorkflowDefinition>();
  for (const def of BUILTIN_WORKFLOWS) byId.set(def.id, def);

  if (existsSync(definitions)) {
    let entries: string[];
    try {
      entries = readdirSync(definitions);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const def = JSON.parse(readFileSync(join(definitions, name), "utf8")) as WorkflowDefinition;
        if (!def || typeof def.id !== "string") continue;
        byId.set(def.id, { ...def, builtin: false });
      } catch {
        // A broken user definition must not hide the rest.
      }
    }
  }
  return Array.from(byId.values());
}

export function getDefinition(id: string, baseDir?: string): WorkflowDefinition | null {
  return listDefinitions(baseDir).find(def => def.id === id) ?? null;
}

export function definitionForTask(task: WorkflowTask, baseDir?: string): WorkflowDefinition | null {
  return task.definition ?? getDefinition(task.workflowId, baseDir);
}

/** Remove a USER definition file. Built-ins cannot be deleted (they shadow nothing). */
export function deleteDefinition(id: string, baseDir?: string): { ok: true } | { ok: false; error: string } {
  const builtin = BUILTIN_WORKFLOWS.some(def => def.id === id);
  if (builtin) return { ok: false, error: `'${id}' is a built-in workflow and cannot be deleted` };
  const file = join(workflowDirs(baseDir).definitions, `${id}.json`);
  if (!existsSync(file)) return { ok: false, error: `no user definition '${id}'` };
  rmSync(file, { force: true });
  return { ok: true };
}

export function saveDefinition(def: WorkflowDefinition, baseDir?: string): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateDefinition(def);
  if (errors.length > 0) return { ok: false, errors };
  const { definitions } = workflowDirs(baseDir);
  mkdirSync(definitions, { recursive: true });
  writeFileSync(join(definitions, `${def.id}.json`), JSON.stringify(def, null, 2) + "\n");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function taskDir(taskId: string, baseDir?: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(taskId)) {
    throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
  }
  return join(workflowDirs(baseDir).tasks, taskId);
}

export function createTaskId(now = new Date()): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function loadTask(taskId: string, baseDir?: string): WorkflowTask | null {
  const file = join(taskDir(taskId, baseDir), "task.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WorkflowTask;
  } catch {
    return null;
  }
}

export function saveTask(task: WorkflowTask, baseDir?: string): void {
  const dir = taskDir(task.id, baseDir);
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.task-${randomUUID()}.tmp`);
  try {
    writeFileSync(staging, JSON.stringify(task, null, 2) + "\n", { mode: 0o600 });
    renameSync(staging, join(dir, "task.json"));
  } finally { rmSync(staging, { force: true }); }
}

export function appendJournal(taskId: string, entry: WorkflowJournalEntry, baseDir?: string): void {
  const dir = taskDir(taskId, baseDir);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "journal.jsonl"), JSON.stringify(entry) + "\n");
}

export function readJournal(taskId: string, baseDir?: string): WorkflowJournalEntry[] {
  const file = join(taskDir(taskId, baseDir), "journal.jsonl");
  if (!existsSync(file)) return [];
  const entries: WorkflowJournalEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WorkflowJournalEntry);
    } catch {
      // Skip torn or corrupt lines; the task.json state stays authoritative.
    }
  }
  return entries;
}

export function listTasks(baseDir?: string): WorkflowTask[] {
  const { tasks } = workflowDirs(baseDir);
  if (!existsSync(tasks)) return [];
  let entries;
  try {
    entries = readdirSync(tasks, { withFileTypes: true });
  } catch {
    return [];
  }
  const list: WorkflowTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const task = loadTask(entry.name, baseDir);
    if (task) list.push(task);
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}
