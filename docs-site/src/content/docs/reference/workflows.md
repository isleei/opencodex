---
title: Model workflows
description: Plan with Codex, implement with a native coding CLI, and review through OpenCodex.
---

`ocx workflow` records ordered phases and approval gates. Start tasks in your
Codex project conversation; use the dashboard to inspect progress and results,
and approve or reject work.

## Start in Codex

With the OpenCodex proxy running and the `ocx-workflow` skill installed, say:

> Use ocx-workflow for this project: you plan, OpenCode implements, then you
> review. Wait for my approval after the plan. Task: [requirements and acceptance criteria].

Codex uses the project directory and your chosen worker tool/model, creates a run,
and records the plan. This conversation orchestrates the run: it executes worker
phases individually, then reviews the changes itself. The worker CLI must be
installed and authenticated on the machine running the proxy, and the workspace
must be accessible there. A directory on a different machine cannot be inferred
or transferred automatically.

The dashboard refreshes progress automatically. Completed and aborted runs are
hidden behind **Show finished tasks**; templates are visible above the run list. Opening a run shows phase outputs and approval controls. After approving
in the dashboard, return to the original Codex conversation and say "continue";
the dashboard cannot automatically wake that conversation. The run view provides
a continuation prompt containing its id.

For this mode the orchestrator uses `workflow run` without `--auto`, performs
planning/review in the conversation, and calls `workflow execute TASK_ID` for each
worker phase. `workflow advance` records results produced in the conversation.

## Fully automated delivery

The `go` command uses a separate Codex planning process, a worker CLI and an
OpenCodex API model for review. Choose this mode when you want the engine to own
all execution phases rather than returning planning and review to the conversation.

Start the OpenCodex proxy first. Install and authenticate each native CLI you use.
Replace the model placeholders below with identifiers accepted by your configuration:

```bash
ocx workflow go "Describe the full requirement and acceptance criteria" \
  --workspace /absolute/path/to/project \
  --agent grok \
  --set planner=YOUR_CODEX_MODEL \
  --set worker=YOUR_GROK_MODEL \
  --set reviewer=YOUR_OCX_REVIEW_MODEL
```

`--agent` selects the worker tool: `codex`, `agy`, `grok`, `opencode`, or `claude`.
It does not change the planner tool. Each agent phase can also set `agent` in the
workflow editor; omitted values use Codex. Native model identifiers are passed
unchanged to that CLI. In particular, an OpenCode provider/model identifier and an
OpenCodex proxy model identifier are not necessarily interchangeable.

Chat phases use OpenCodex model references, including configured combos and routing
policies. Their precedence is: explicit phase model, task role override, definition
default, then the `go` fallback model. Choosing a fallback preserves existing role
defaults. The native CLIs use their installed authentication and permission policies;
OpenCodex does not enable permission-bypass flags.

The CLI defaults the workspace to its current directory. In the REST
API, supply the absolute directory on the machine running the proxy. Automated code
workflows require a Git repository with a base commit. Use `--base <revision>` to
review against a particular branch or commit; otherwise the starting HEAD is saved.

## Review and rework

```bash
ocx workflow status TASK_ID --json
ocx workflow gate TASK_ID approve
ocx workflow gate TASK_ID reject --note "Handle timeout and test cancellation"
ocx workflow abort TASK_ID
```

Automatic runs resume after a gate decision. Manual runs use
`ocx workflow execute TASK_ID --auto` to execute until the next gate, or
`ocx workflow advance TASK_ID --outputs "Evidence from manual work"` after manual
completion. A running phase cannot be manually advanced. Aborting cancels active
execution and discards late results.

Automated review receives the full requirements, approved plan, implementation and verification
outputs, and the actual Git diff. That diff includes commits since the saved base,
staged and unstaged edits, and untracked files that Git does not ignore. Existing
changes in the chosen workspace are therefore part of the review scope. Diffs over
2 MB fail rather than being silently truncated; split the task before retrying.
Verification output is agent-reported evidence, not an independent test-runner verdict.

Rejecting a gate preserves the preceding results and rejection note for the rework
attempt, and invalidates downstream results. For reviews with automatically captured evidence, acceptance checks that the reviewed code
has not changed. Conversation reviews must check the actual workspace before acceptance. If it has, reject the gate and review the updated code.

## Definitions and saved runs

The dashboard provides run monitoring and gate controls with a rejection note.
The template picker shows built-in and personal templates. Configure a template once
with worker tools and role models, or use **Save as my template** to copy its phases
and settings under a new id. Choosing a template updates the conversation prompt
and remembers your selection in this browser; copying it does not launch a run.
In Codex, say "Use template daily-opencode; task: …". The skill resolves its saved
id and preserves the template settings. Only explicit changes override them.
Planning and review in conversation mode use the current Codex conversation;
the saved planner/reviewer models apply when running those phases automatically.
Task requirements and workspace selection belong to the initiating conversation or CLI.
Custom definitions live under `workflows/definitions/` in the OpenCodex config
directory. Each new run stores a definition snapshot, full requirements, workspace,
base revision, phase results, and review evidence in `workflows/tasks/<id>/task.json`.
Transitions are recorded in `journal.jsonl`. Editing a template affects new runs;
existing runs retain their snapshot. Legacy runs without a snapshot use their stored
definition and may need to be recreated to supply a workspace and review baseline.

The `review-audit` workflow sends the collected diff independently to both reviewer
roles and then compares their outputs. `debug-investigate` passes reproduction,
diagnosis, fix and verification outputs through its phases. Extra strategies and
automatic multi-agent parallelism are not required for the delivery loop.
