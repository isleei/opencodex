import type { WorkflowPhase, WorkflowTask } from "./types";

/** Native CLI model ids are passed unchanged; a provider model is not an agent. */
export function buildAgentCommand(phase: WorkflowPhase, task: WorkflowTask, model: string, prompt: string) {
  const role = phase.modelRef?.startsWith("role:") ? phase.modelRef.slice(5).trim() : undefined;
  const agent = (role ? task.agentOverrides?.[role] : undefined) ?? phase.agent ?? "codex";
  switch (agent) {
    case "codex": return { bin: "codex", args: ["exec", "-m", model, "--sandbox", role === "planner" || role?.startsWith("reviewer") ? "read-only" : "workspace-write", "-"], stdin: prompt };
    case "agy": return { bin: "agy", args: ["--model", model, "--print", prompt], stdin: undefined };
    case "grok": return { bin: "grok", args: ["--model", model, "--single", prompt], stdin: undefined };
    case "opencode": return { bin: "opencode", args: ["run", "--model", model, "--", prompt], stdin: undefined };
    case "claude": return { bin: "claude", args: ["--model", model, "-p", prompt], stdin: undefined };
  }
}
