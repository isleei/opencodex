import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { workflowDirs } from "./store";

export interface PhaseExecution {
  id: string;
  phaseIndex: number;
  attemptId?: string;
  controller: AbortController;
}

const executions = new Map<string, PhaseExecution>();
export function executionKey(taskId: string, baseDir?: string): string {
  return `${resolve(workflowDirs(baseDir).base)}:${taskId}`;
}
export function activeExecution(taskId: string, baseDir?: string): PhaseExecution | undefined {
  return executions.get(executionKey(taskId, baseDir));
}
export function claimExecution(taskId: string, phaseIndex: number, attemptId?: string, baseDir?: string): PhaseExecution {
  const key = executionKey(taskId, baseDir);
  if (executions.has(key)) throw new Error("phase is already executing");
  const execution = { id: randomUUID(), phaseIndex, attemptId, controller: new AbortController() };
  executions.set(key, execution);
  return execution;
}
export function releaseExecution(taskId: string, execution: PhaseExecution, baseDir?: string): void {
  const key = executionKey(taskId, baseDir);
  if (executions.get(key) === execution) executions.delete(key);
}
export function cancelExecution(taskId: string, baseDir?: string): void {
  activeExecution(taskId, baseDir)?.controller.abort();
}
