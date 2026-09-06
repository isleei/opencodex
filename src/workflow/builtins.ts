/**
 * Starter workflow definitions shipped with opencodex. User files in
 * `<configDir>/workflows/definitions/` shadow these by id.
 *
 * Built-ins pin roles, not concrete models: `role:<name>` references resolve through
 * the definition `defaults` (empty here) and the role overrides supplied at run start
 * (`ocx workflow run feature-delivery --set planner=openai/gpt-5.6 --set worker=...`),
 * so the same definition works against any provider setup.
 */

import type { WorkflowDefinition } from "./types";

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "feature-delivery",
    title: "Feature delivery (plan → implement → review)",
    description:
      "Planner model writes the plan and hard-stops for approval; worker model implements and verifies; reviewer model audits the diff; operator accepts.",
    defaults: {},
    builtin: true,
    phases: [
      {
        id: "plan",
        title: "Write the implementation plan",
        modelRef: "role:planner",
        mode: "agent",
        agent: "codex",
        inputs: ["requirements"],
        prompt:
          "Write a step-by-step implementation plan for the task. List the files you intend to touch, the riskiest part, and how you will verify the result. Do not implement anything.",
      },
      { id: "approve-plan", title: "Plan approval", gate: { id: "plan-approval", rejectTo: "plan" } },
      {
        id: "implement",
        title: "Implement the plan",
        modelRef: "role:worker",
        mode: "agent",
        inputs: ["plan"],
        prompt:
          "Implement the approved plan exactly. Work through the steps in order and stop when everything in the plan is done. Do not expand scope.",
      },
      {
        id: "verify",
        title: "Verify the implementation",
        modelRef: "role:worker",
        mode: "agent",
        inputs: ["plan"],
        prompt:
          "Verify the implementation against the plan: run the relevant tests, fix what fails, and summarize the result.",
      },
      {
        id: "review",
        title: "Independent review of the diff",
        modelRef: "role:reviewer",
        mode: "chat",
        inputs: ["diff", "plan", "implement", "verify"],
        prompt:
          "Review the actual code changes against the original requirements and plan. Challenge incorrect assumptions in the plan; distinguish observed test evidence from unverified claims. Report blockers, risks, and nits as separate lists. Do not restate the plan.",
      },
      { id: "accept-review", title: "Review acceptance", gate: { id: "review-acceptance", rejectTo: "implement" } },
      {
        id: "report",
        title: "Summarize the run",
        modelRef: "role:planner",
        mode: "chat",
        inputs: ["plan", "implement", "verify", "review"],
        prompt: "Summarize what was delivered, what the review found, and any follow-up work.",
      },
    ],
  },
  {
    id: "review-audit",
    title: "Dual-model review audit",
    description:
      "Two reviewer models audit the same diff independently; disagreement is the finding. Finish with an operator acceptance gate.",
    defaults: {},
    builtin: true,
    phases: [
      {
        id: "collect-diff",
        title: "Collect the diff under review",
        modelRef: "role:planner",
        mode: "chat",
        inputs: ["diff"],
        prompt: "State the scope under review and list the changed files.",
      },
      {
        id: "review-a",
        title: "Reviewer A",
        modelRef: "role:reviewer-a",
        mode: "chat",
        inputs: ["diff"],
        prompt: "Review the diff. Verdict first, then blockers, risks, and nits.",
      },
      {
        id: "review-b",
        title: "Reviewer B (independent)",
        modelRef: "role:reviewer-b",
        mode: "chat",
        inputs: ["diff"],
        prompt: "Review the diff independently. Verdict first, then blockers, risks, and nits.",
      },
      {
        id: "compare",
        title: "Diff of opinions",
        modelRef: "role:planner",
        mode: "chat",
        inputs: ["review-a", "review-b"],
        prompt:
          "Both reviews are shown verbatim. Add one line: where they agree, where they disagree, and which disagreement matters.",
      },
      { id: "accept", title: "Acceptance", gate: { id: "audit-acceptance", rejectTo: "collect-diff" } },
    ],
  },
  {
    id: "debug-investigate",
    title: "Debug investigation (diagnose → fix → verify)",
    description:
      "Reproduce the bug, diagnose with the planner model, fix and verify with the worker model, review before acceptance.",
    defaults: {},
    builtin: true,
    phases: [
      {
        id: "reproduce",
        title: "Reproduce the bug",
        modelRef: "role:worker",
        mode: "agent",
        prompt: "Reproduce the reported bug and record the minimal reliable reproduction.",
      },
      {
        id: "diagnose",
        title: "Root-cause diagnosis",
        modelRef: "role:planner",
        mode: "chat",
        inputs: ["reproduce"],
        prompt: "Name the root cause, the evidence for it, and the smallest safe fix. Do not fix yet.",
      },
      {
        id: "fix",
        title: "Apply the fix",
        modelRef: "role:worker",
        mode: "agent",
        inputs: ["diagnose"],
        prompt: "Apply the diagnosed fix. Smallest change that addresses the root cause.",
      },
      {
        id: "verify",
        title: "Verify the fix",
        modelRef: "role:worker",
        mode: "agent",
        prompt: "Re-run the reproduction: it must now fail to reproduce. Run the relevant tests.",
      },
      {
        id: "review",
        title: "Review the fix",
        modelRef: "role:reviewer",
        mode: "chat",
        inputs: ["diff", "diagnose", "fix", "verify"],
        prompt: "Review the fix against the diagnosis. Blockers, risks, nits.",
      },
      { id: "accept", title: "Acceptance", gate: { id: "fix-acceptance", rejectTo: "fix" } },
    ],
  },
];
