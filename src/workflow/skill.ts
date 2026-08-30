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

const SKILL_BODY = `${MANAGED_MARKER}
---
name: ocx-workflow
description: Drive OpenCodex workflow runs — execute the current phase of a running workflow when the <ocx-workflow> breadcrumb is present, record outputs, and respect approval gates. Use when a run breadcrumb appears or the operator asks about workflow phases.
---

# OpenCodex Workflow Protocol

When a conversation involves an OpenCodex workflow run (a \`<ocx-workflow>\` breadcrumb
is present, or the operator names a run):

1. Inspect the run state:

   \`\`\`bash
   ocx workflow status <task-id>
   \`\`\`

2. The current phase tells you what to do (its prompt is in the run's definition —
   \`ocx workflow show <workflow-id>\`). Do exactly that work. Stay inside the phase
   scope; do not start the next phase.
3. When the phase work is done, record it and move on:

   \`\`\`bash
   ocx workflow advance <task-id> --outputs "<one-paragraph summary of what you did>"
   \`\`\`

4. If the run is \`awaiting_gate\`, STOP. The operator approves or rejects through the
   CLI or the dashboard. Never approve your own gate.
5. If a phase has an \`error\` recorded, explain the failure and retry only after
   fixing the cause.

Phases bound to a model reference may be executed automatically by the engine
(\`ocx workflow execute\`); your job is the phases that need an interactive agent.
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
