/**
 * Workflow state breadcrumbs for Codex.
 *
 * While a run is active, a managed custom prompt layer carries an `<ocx-workflow>`
 * breadcrumb into every Codex turn — the prompt-layer analog of CCG's hook-injected
 * state, so an orchestrating Codex session keeps its place across compaction. When no
 * run is active the layer is removed: non-workflow sessions never see workflow prose.
 *
 * All writes go through prompt-layers' public API (store-owned custom layers,
 * byte-verified projection) and FAIL OPEN: an injection problem must never break a
 * run transition. Disable entirely with OCX_WORKFLOW_INJECT=off.
 */

import { existsSync, readFileSync } from "node:fs";
import { activeConfigPath, inspectOwnership, readPromptLayers, writeCustomLayers, type CustomLayer, type Paths } from "../codex/prompt-layers";
import { listTasks } from "./store";
import type { WorkflowTask } from "./types";

const LAYER_ID = "wflow1";
const LAYER_TITLE = "OpenCodex workflow state";

export function injectionDisabled(): boolean {
  return process.env.OCX_WORKFLOW_INJECT?.trim().toLowerCase() === "off";
}

function breadcrumbFor(task: WorkflowTask): string | null {
  if (task.status !== "running" && task.status !== "awaiting_gate") return null;
  const phase = task.phases[task.phaseIndex];
  if (!phase) return null;
  const lines = [
    "<ocx-workflow>",
    `run: ${task.id} (${task.workflowId}) — ${task.title}`,
    `phase: ${task.phaseIndex + 1}/${task.phases.length} ${phase.id} [${phase.status}]${phase.modelRef ? ` model=${phase.modelRef}` : ""}`,
  ];
  if (task.status === "awaiting_gate") {
    lines.push(`gate: ${task.currentGate?.id ?? "?"} — wait for the operator to approve or reject`);
  } else {
    lines.push(
      `next: do the phase work${task.workspaceDir ? ` in ${task.workspaceDir}` : ""}, then run \`ocx workflow advance ${task.id}\` (record a short summary with --outputs)`,
    );
  }
  lines.push("ignore this block if your current conversation is unrelated to this run.");
  lines.push("</ocx-workflow>");
  return lines.join("\n");
}

/**
 * Reconcile the breadcrumb layer with the current run state. Fire after every run
 * transition. Returns whether the store now reflects the desired state.
 */
export function syncWorkflowLayer(baseDir?: string, paths?: Paths): { ok: boolean; detail: string } {
  if (injectionDisabled()) return { ok: true, detail: "injection disabled" };
  try {
    const snapshot = readPromptLayers(paths);
    // Writable when the config is absent (the projection creates it), when ocx owns
    // the developer_instructions line, or when there is no such line at all. Only a
    // FOREIGN line or unresolved drift blocks the write.
    const configPath = activeConfigPath(paths);
    const ownership = inspectOwnership(existsSync(configPath) ? readFileSync(configPath, "utf8") : null);
    const writable = ownership.state === "owned" || ownership.state === "absent";
    if (!writable || snapshot.drift) {
      return { ok: false, detail: `prompt layers not writable (ownership=${ownership.state}${"line" in ownership && ownership.line ? ` at line ${ownership.line}` : ""}, drift=${snapshot.drift ?? "none"})` };
    }
    const active = listTasks(baseDir).find(t => t.status === "running" || t.status === "awaiting_gate");
    const body = active ? breadcrumbFor(active) : null;
    const others = snapshot.custom.filter(layer => layer.id !== LAYER_ID);
    const desired: CustomLayer[] = body
      ? [...others, { id: LAYER_ID, title: LAYER_TITLE, body, enabled: true }]
      : others;

    const current = snapshot.custom.find(layer => layer.id === LAYER_ID);
    if (!body && !current) return { ok: true, detail: "no breadcrumb needed" };
    if (current && body && current.body === body && current.enabled) {
      return { ok: true, detail: "breadcrumb up to date" };
    }
    const result = writeCustomLayers(desired, snapshot.revision, paths);
    return result.ok
      ? { ok: true, detail: body ? "breadcrumb written" : "breadcrumb removed" }
      : { ok: false, detail: `write failed: ${result.error}${"detail" in result && result.detail ? ` (${result.detail})` : ""}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
