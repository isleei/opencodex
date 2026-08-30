import { spawn } from "node:child_process";
import type { AgentType } from "../types";

export interface DispatchCommand {
  bin: string;
  args: string[];
  fullCommandLine: string;
}

export function buildDispatchCommand(
  targetAgent: AgentType,
  prompt: string,
): DispatchCommand {
  let bin = "";
  let args: string[] = [];

  if (targetAgent === "agy") {
    bin = "agy";
    args = [prompt];
  } else if (targetAgent === "codex") {
    bin = "codex";
    args = ["exec", prompt];
  } else if (targetAgent === "claude_code") {
    bin = "claude";
    args = ["-p", prompt];
  } else if (targetAgent === "grok") {
    bin = "grok";
    args = [prompt];
  }

  const escapedPrompt = prompt.replace(/"/g, '\\"');
  const fullCommandLine = `${bin} ${args.slice(0, -1).join(" ")} "${escapedPrompt.slice(0, 80)}..."`;

  return {
    bin,
    args,
    fullCommandLine,
  };
}

export async function executeAgentDispatch(
  targetAgent: AgentType,
  prompt: string,
  cwd?: string,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const { bin, args } = buildDispatchCommand(targetAgent, prompt);

  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, {
        cwd: cwd || process.cwd(),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });

      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      child.on("error", (err) => {
        resolve({
          ok: false,
          error: `Failed to spawn ${bin}: ${err.message}`,
        });
      });

      child.on("close", (code) => {
        if (code === 0 || code === null) {
          resolve({
            ok: true,
            output: stdout || `Started ${targetAgent} process.`,
          });
        } else {
          resolve({
            ok: false,
            error: stderr || `Process exited with code ${code}`,
            output: stdout,
          });
        }
      });
    } catch (error) {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
