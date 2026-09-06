/**
 * Distribution for the `ocx-workflow` Codex skill.
 *
 * The skill teaches an orchestrating Codex session the workflow protocol: read the
 * `<ocx-workflow>` breadcrumb, do the phase work, advance with the CLI, stop at
 * gates. It lands in `~/.agents/skills/` (the centralized store from the skills
 * engine) and is symlinked into `~/.codex/skills/` and `~/.claude/skills/` so every
 * agent sees it. Managed ownership: the directory carries the managed marker and is
 * rewritten on ensure — user edits under the ocx- prefix are not a supported surface.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_NAME = "ocx-workflow";
const MANAGED_MARKER = "<!-- managed-by: opencodex (ocx workflow ensure) -->";

const SKILL_BODY = `---
name: ocx-workflow
description: Start or resume OpenCodex workflows from a project conversation. Use when the user asks Codex to plan, delegate implementation to an agent CLI, and review, or when an ocx-workflow run is named or its breadcrumb is present.
---
${MANAGED_MARKER}

# OpenCodex Workflow Protocol

## Start from a conversation

For a request to plan here, delegate implementation, then review here:

1. Use the current project directory. Inspect \`ocx workflow --help\` and
   \`ocx workflow list --json\` for the installed interface and template defaults.
   Resolve the user's template by exact id or an unambiguous saved title; when
   no template was named, offer the available templates or use feature-delivery
   for a feature request. Preserve its phases, per-phase tools, defaults and gates.
   If the user asks to reuse a personal preset, save its definition once through
   the supported workflow definition interface; subsequent runs reference its id.
   Confirm the template's worker CLIs are available and resolve models from saved
   defaults. Apply tool/model overrides only when the user explicitly changes them.
   Ask only for missing information; keep native
   CLI model identifiers distinct from OpenCodex proxy model identifiers.
2. Create a manually orchestrated run:

   \`\`\`bash
   ocx workflow run <selected-template-id> --title "<full requirements and acceptance criteria>" --workspace "<current project absolute path>" --json
   \`\`\`

   Omit \`--auto\`: this conversation owns planning and review. \`go\` starts the
   automated pipeline, including a separate planning process and API review;
   use it only when that is the requested delivery mode. The directory must be
   accessible to the proxy process. If it is on another machine, resolve that
   mismatch before starting. Record the returned run id and inspect its saved
   definition, requirements, workspace and Git base with \`status --json\`.
3. Follow the saved phase order; the steps below describe a feature-delivery run.
   Custom templates may start with investigation or review: perform planner/reviewer
   roles in this conversation and execute other model-bound phases individually.
   Plan in this conversation using the actual project. Save the complete plan
   with \`ocx workflow advance <task-id> --outputs "<plan and acceptance criteria>"\`.
   Show the plan and wait at the approval gate.
4. After the operator approves, inspect the state again. For each worker phase,
   invoke \`ocx workflow execute <task-id>\` without \`--auto\`. It runs one phase,
   records outputs and advances. Inspect status until it finishes or reports an
   error, then handle the next phase. The engine supplies the saved plan and any
   rework instructions to the worker; preserve them when diagnosing failures.
5. At review, inspect the saved Git base and the actual workspace changes
   (committed, staged, unstaged and unignored new files). Check requirements,
   the plan and verification evidence yourself. Record the review with \`advance\`,
   then wait for acceptance. After acceptance, record the delivery summary.
   For a rejected plan or implementation, read the saved rework note and previous
   results, then repeat from the current phase.

The dashboard shows progress, outputs and approval controls. A dashboard decision
updates the run but cannot wake this conversation. On a later "continue", fetch
its current state before resuming. Reuse the recorded run id rather than creating
another run for the same task.

## Resume a run

A breadcrumb is a pointer, not authorization to work on an unrelated task. For a
named or relevant run, read \`ocx workflow status <task-id> --json\`; the saved
snapshot is authoritative even if the reusable template has changed.

- While execution is active, wait for its result; the engine owns advancement.
- For an automatic run, \`ocx workflow execute <task-id> --auto\` resumes its pipeline
  after an execution error has been diagnosed and fixed.
- For a conversation-orchestrated run, perform planner/reviewer phases here and
  execute worker phases individually as above. For custom templates, follow their
  saved phase definitions and the user's specified division of responsibilities.
- At \`awaiting_gate\`, present the result and wait. An explicit operator decision
  in this conversation can be recorded with \`ocx workflow gate <task-id> approve\`
  or \`reject --note "<requested changes>"\`. Never supply your own approval.
- Stop at completed or aborted runs. Explain recorded errors before retrying.

A delegated worker returns its phase results to the engine. It does not operate
workflow transitions or approve gates.

`;

function skillBody(): string {
  return SKILL_BODY;
}

export function ensureWorkflowSkill(opts?: { agentsHome?: string; codexHome?: string; claudeHome?: string }): { ok: boolean; skillPath: string; detail: string } {
  const agentsHome = opts?.agentsHome || join(homedir(), ".agents");
  const codexHome = opts?.codexHome || join(homedir(), ".codex");
  const claudeHome = opts?.claudeHome || join(homedir(), ".claude");

  try {
    const skillDir = join(agentsHome, "skills", SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");

    let current = "";
    if (existsSync(skillPath)) {
      try {
        current = readFileSync(skillPath, "utf8");
      } catch {
        current = "";
      }
      if (current && !current.includes(MANAGED_MARKER)) {
        return { ok: false, skillPath, detail: "a non-managed ocx-workflow skill exists; left untouched" };
      }
    }
    if (current !== skillBody()) writeFileSync(skillPath, skillBody());

    for (const home of [codexHome, claudeHome]) {
      const skillsDir = join(home, "skills");
      if (!existsSync(skillsDir)) continue; // agent never used skills; do not create dirs
      const linkPath = join(skillsDir, SKILL_NAME);
      if (existsSync(linkPath)) {
        try {
          const body = readFileSync(join(linkPath, "SKILL.md"), "utf8");
          if (body.includes(MANAGED_MARKER)) continue; // link already in place
          // different content — it's a symlink to somewhere else or a real dir; replace only if ours
          continue;
        } catch {
          // unreadable — try to relink below
        }
      }
      try {
        rmSync(linkPath, { force: true });
        symlinkSync(skillDir, linkPath, "dir");
      } catch {
        // best-effort
      }
    }
    return { ok: true, skillPath, detail: "skill ensured" };
  } catch (error) {
    return { ok: false, skillPath: join(agentsHome, "skills", SKILL_NAME, "SKILL.md"), detail: error instanceof Error ? error.message : String(error) };
  }
}
