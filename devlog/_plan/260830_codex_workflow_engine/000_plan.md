# Plan: Codex-Led Workflow Engine (`ocx workflow`)

Status: OPEN — W1 implemented (engine, store, REST, CLI)
Created: 2026-08-30
Reference: [CCG — fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow)

## 0. Context

The operator wants customizable multi-step model workflows — e.g. GPT-5.6 writes the
plan, GPT-5.5 implements, another model reviews — with approval gates, on this fork,
where **Codex is the primary interactive agent**. OpenCodex today has model *selection*
mechanisms (combos, routing profiles, subagent pinning) but no phase sequencer.

CCG solves the same request for Claude-Code-led users: a hook engine injects
`<ccg-state>` every turn, a Go binary bridge dispatches work to Codex/Grok/Kimi/Antigravity
CLIs, ten strategies classify tasks, task state lives in `.ccg/tasks/<id>/`, and quality
gates + dual-model cross-review close the loop. We adopt its shape (phases, gates,
task dirs, state breadcrumbs) but not its center of gravity: CCG needs Claude Code as
orchestrator and treats the other CLIs as external processes reached through a compiled
bridge. Here the orchestrator is Codex and **the bridge is the proxy we already run** —
every dispatched step is a first-class ocx request with usage, logs, and model-catalog
resolution for free.

## 1. Goals / Non-goals

Goals:

- **G1 — Workflows as data.** A workflow is an ordered list of phases; each phase binds
  a model role (any ocx-routable id: `provider/model`, `combo/<id>`, `policy/<id>`,
  `<account-selector>/<model>`), a prompt template, optional outputs, and an optional
  operator gate.
- **G2 — Codex leads.** Codex stays the interactive brain. ocx injects the current
  workflow state into every Codex turn; Codex advances phases through a headless CLI;
  the operator never edits state files by hand.
- **G3 — Hard gates.** Plan approval and review-acceptance stop the run until the
  operator approves (CLI or dashboard). A gate is a local state mutation; nothing
  proceeds implicitly.
- **G4 — Side-model steps.** A non-lead phase executes either as a headless
  `codex exec -m <modelRef>` agentic run (has tools, slower) or as a direct
  chat-completion call through the proxy (fast, no tool loop) — chosen per phase.
- **G5 — Observable.** Every phase lands in usage/logs with its provider and model;
  runs appear as linked entries in the Sessions hub; each task keeps a `journal.jsonl`.

Non-goals (v1):

- No visual DAG editor; phases are linear. Branching/parallel phases are v2 (CCG's
  strategies are linear phases too).
- No automatic task classification ("10 strategies"). v1 ships curated starter
  workflows plus user-authored definitions; classification is v2.
- No Claude-Code-led mode. The sessions hub already hands off to Claude; a
  Claude-led variant would reuse the same engine later.

## 2. Architecture — three existing seams, no new bridge

| Concern | CCG's answer | Ours (already shipped) |
| --- | --- | --- |
| Per-turn state injection | 4 JS hooks re-writing context | `src/codex/prompt-layers.ts` — managed `developer_instructions` projection into `$CODEX_HOME/config.toml`, byte-verified, journal-backed |
| State source of truth | `.ccg/tasks/<id>/task.json` + hook re-injection after compaction | `~/.opencodex/workflows/<task>/task.json`; the prompt layer is a write-only projection (prompt-layers rule #1: no prose round-trips through TOML) |
| Cross-model dispatch | Compiled Go `codeagent-wrapper` per CLI | The proxy itself: phase steps that don't need a tool loop are proxied chat calls; steps that do reuse the sessions dispatcher (`codex exec -m`, `claude -p`, `grok`, `agy`) |
| Model catalog / roles | config.toml personas per CLI | ocx model catalog + combos + policy profiles; role resolution in one place |

The load-bearing decision: **ocx owns task state and persistence; Codex owns execution.**
The prompt layer carries `<ocx-workflow>` breadcrumbs (task, phase, gate, next action)
so state survives compaction exactly like CCG's hook breadcrumb, but there is no hook
engine to write — the injection point already exists and is adversarially audited.

## 3. Phase model

```jsonc
// ~/.opencodex/workflows/definitions/feature-delivery.json
{
  "id": "feature-delivery",
  "phases": [
    { "id": "plan",      "modelRef": "combo/planner",  "mode": "chat",   "prompt": "prompts/plan.md" },
    { "id": "approve",   "gate": "plan-approval" },
    { "id": "implement", "modelRef": "combo/worker",   "mode": "agent",  "prompt": "prompts/implement.md" },
    { "id": "verify",    "modelRef": "combo/worker",   "mode": "agent",  "prompt": "prompts/verify.md" },
    { "id": "review",    "modelRef": "combo/reviewer", "mode": "chat",   "prompt": "prompts/review.md", "inputs": ["diff", "plan"] },
    { "id": "accept",    "gate": "review-acceptance" },
    { "id": "report",    "modelRef": "combo/planner",  "mode": "chat" }
  ]
}
```

- `mode: "chat"` — direct proxied call; best for plan/verify/review text work.
- `mode: "agent"` — headless `codex exec -m <modelRef>` in the task workspace; has tools.
- Starter workflows: `feature-delivery` (above), `review-audit` (same diff to two
  reviewer models, disagreement reported verbatim), `debug-investigate`.

## 4. Role resolution

Phase `modelRef` → task override → `config.workflow.defaults` per role
(`planner` / `worker` / `reviewer`). Every ref resolves through the existing model
router, so a role can be a combo (failover included), a policy profile (cost-capped),
or an account-selector pin. Per-phase reasoning effort reuses `reasoning-effort.ts`.

## 5. Codex-side surface

A managed skill `ocx-workflow` distributed through the skills engine just shipped
(`~/.agents/skills/ocx-workflow` → symlink into `~/.codex/skills`), teaching Codex to:
read the `<ocx-workflow>` breadcrumb each turn, do the phase's work, then run
`ocx workflow advance --outputs <file>` (or `ocx workflow gate approve/reject`).
The prompt layer reminds rather than carries content, so compaction cannot lose the run.

## 6. Persistence, REST, CLI, GUI

- Task dir: `task.json` (status, phase index, gate state), `plan.md`, `review.md`,
  `journal.jsonl` (one record per transition, with modelRef + token usage per phase).
- REST: `GET/POST /api/workflows` (definitions), `GET/POST /api/workflows/runs`
  (start, advance, gate, abort), registered in `route-registry.ts`; heads-up: the
  route-inventory and generated-surface tests that already drift from this feature
  train must be updated in the same change.
- CLI: `ocx workflow list|show|run|advance|gate|abort` — headless, talks to the live
  proxy, exits nonzero when unreachable (existing CLI convention).
- GUI: a **Workflows** tab — definition editor (phases table with a model picker fed by
  the catalog, prompt templates, gate toggles) and a run timeline (phase chips, per-phase
  usage, approve/reject buttons); run rows link into the Sessions hub.

## 7. Security notes

Gates and state mutations are local-only. Dispatched `agent` phases reuse the existing
spawn sandboxing and workspace pinning; `chat` phases are ordinary proxied requests with
no new credential surface. Workflow files are ocx-owned JSON — nothing user-authored is
parsed out of TOML (prompt-layers rule #1 applies to the projection).

## 8. Milestones

| # | Scope | Depends on |
| --- | --- | --- |
| W1 | Task store, phase state machine, gates, REST + CLI (no GUI, no injection) | — |
| W2 | Prompt-layer injection, `ocx-workflow` skill, `feature-delivery` end-to-end with Codex | W1 |
| W3 | GUI tab (editor + run timeline) + Sessions-hub linkage | W1 |
| W4 | `review-audit` dual-model runs, per-phase usage attribution, adversarial hardening | W2, W3 |

## 9. Test plan

- Unit: state-machine transitions (incl. gate blocking and abort), role resolution
  precedence, prompt-layer projection byte checks, task-store persistence.
- Integration: dispatch runner with fixture providers for both `chat` and `agent`
  modes; REST flows against `handleManagementAPI` fixtures (the sessions-suite pattern).
- E2E: scripted Codex run against a sandboxed `CODEX_HOME`; gate requires an explicit
  operator action; compaction-recovery (state re-injected after a truncated transcript).

## 10. Decisions (operator-approved 2026-08-30)

1. Default `mode` per phase: `plan`/`report` chat, `implement`/`verify` agent,
   `review` chat with an opt-in `mode: "agent"` when repo access is needed.
2. Gate approval UX: both CLI (`ocx workflow gate approve`) and dashboard button;
   GUI is primary (W3).
3. Dual-model review output: verbatim side-by-side verdicts plus a synthesized
   diff-of-opinions line (W4).

## 11. W1 implementation notes

- `src/workflow/`: `types.ts`, `builtins.ts` (feature-delivery, review-audit,
  debug-investigate — roles not concrete models), `store.ts` (definitions shadow
  built-ins by id; task.json + journal.jsonl per run), `engine.ts` (state machine;
  arriving at a gate moves `phaseIndex` onto the gate itself).
- REST `/api/workflows*`, CLI `ocx workflow list|show|run|runs|status|advance|gate|abort`,
  wired through registry/dispatch/help/capabilities/route-registry; skill surface
  regenerated.
- Engine rule learned in testing: every journal append must thread the store's
  baseDir, or test isolation silently writes into the real config dir.
