/**
 * `ocx sessions` — Cross-Agent Session Hub & Handoff CLI.
 *
 * Subcommands:
 * - list: List all discovered sessions across agents (Codex, AGY, Claude Code)
 * - view: Inspect a session's details, turns, modified files, and token usage
 * - handoff: Generate handoff context and optionally execute/dispatch to target agent
 */

import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import type {
  DispatchResult,
  HandoffContext,
  UnifiedSession,
  UnifiedSessionDetail,
} from "../sessions/types";

const USAGE = `Usage:
  ocx sessions [list] [--agent <all|codex|agy|claude|grok>] [--status <all|active|archived>]
      [--search <query>] [--limit <n>] [--json]
  ocx sessions view <agent> <session-id> [--json]
  ocx sessions handoff <agent> <session-id> --to <codex|agy|claude|grok>
      [--execute] [--strategy <smart|full>] [--instructions <text>] [--json]`;

function pad(str: string, length: number): string {
  return str.length >= length ? str : str + " ".repeat(length - str.length);
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "unknown";
  }
}

function formatSessionsTable(sessions: UnifiedSession[]): string[] {
  if (!sessions || sessions.length === 0) {
    return ["No sessions found."];
  }

  const header = `${pad("AGENT", 10)} ${pad("SESSION ID", 38)} ${pad("TURNS", 7)} ${pad("MODIFIED", 10)} ${pad("UPDATED AT", 20)} TITLE / SUMMARY`;
  const lines = [header];

  for (const s of sessions) {
    const agent = s.agent;
    const id = s.id.length > 36 ? s.id.slice(0, 33) + "..." : s.id;
    const turns = String(s.turnCount);
    const modCount = `${s.modifiedFiles.length} files`;
    const updated = formatDate(s.updatedAt);
    const title = s.title ? s.title.replace(/\n/g, " ").slice(0, 50) : "";

    lines.push(`${pad(agent, 10)} ${pad(id, 38)} ${pad(turns, 7)} ${pad(modCount, 10)} ${pad(updated, 20)} ${title}`);
  }

  return lines;
}

function formatSessionDetail(detail: UnifiedSessionDetail): string[] {
  const lines: string[] = [
    `Session: ${detail.id}`,
    `Agent:   ${detail.agent}`,
    `Title:   ${detail.title}`,
    `Status:  ${detail.status}`,
    `Created: ${formatDate(detail.createdAt)}`,
    `Updated: ${formatDate(detail.updatedAt)}`,
    `Turns:   ${detail.turnCount}`,
    `Tokens:  ${detail.tokens.totalTokens} (Prompt: ${detail.tokens.promptTokens}, Completion: ${detail.tokens.completionTokens})`,
    `Source:  ${detail.sourcePath}`,
  ];

  if (detail.modifiedFiles && detail.modifiedFiles.length > 0) {
    lines.push(`\nModified Files (${detail.modifiedFiles.length}):`);
    for (const f of detail.modifiedFiles) {
      lines.push(`  - ${f}`);
    }
  }

  if (detail.turns && detail.turns.length > 0) {
    lines.push(`\nTurn Timeline (${detail.turns.length} turns):`);
    for (let i = 0; i < Math.min(detail.turns.length, 10); i++) {
      const t = detail.turns[i];
      const roleBadge = t.role.toUpperCase();
      const snippet = t.content.split("\n")[0].slice(0, 80);
      lines.push(`  [${roleBadge}] ${snippet}`);
    }
    if (detail.turns.length > 10) {
      lines.push(`  ... and ${detail.turns.length - 10} more turns`);
    }
  }

  return lines;
}

function formatHandoffResult(result: DispatchResult): string[] {
  const lines: string[] = [
    `=== Session Handoff Result ===`,
    `Source Agent:     ${result.sourceAgent}`,
    `Target Agent:     ${result.targetAgent}`,
    `Source Session:   ${result.sourceSessionId}`,
    `Strategy:         ${result.handoffContext.strategy}`,
    `Auto Executed:    ${result.executed ? "YES" : "NO (Preview mode)"}`,
    `Command Line:     ${result.command}`,
  ];

  if (result.executed) {
    lines.push(`Execution Status: ${result.ok ? "SUCCESS" : "FAILED"}`);
    if (result.executionOutput) {
      lines.push(`\nOutput:\n${result.executionOutput}`);
    }
    if (result.error) {
      lines.push(`\nError:\n${result.error}`);
    }
  } else {
    lines.push(`\n--- Rendered Target Prompt ---`);
    lines.push(result.handoffContext.renderedPrompt);
    lines.push(`\nTip: To automatically execute, add the --execute flag.`);
  }

  return lines;
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const agent = takeOption(args, "--agent");
  const status = takeOption(args, "--status");
  const search = takeOption(args, "--search");
  const limit = takeOption(args, "--limit");
  rejectArgs(args, USAGE);

  const query = new URLSearchParams();
  if (agent) query.set("agent", agent);
  if (status) query.set("status", status);
  if (search) query.set("search", search);
  if (limit) query.set("limit", limit);

  const qs = query.toString();
  const endpoint = `/api/sessions${qs ? `?${qs}` : ""}`;

  const result = await runtimeRequest<{ sessions: UnifiedSession[] }>(endpoint, {}, deps);
  printData(result, wantsJson, formatSessionsTable(result.sessions ?? []));
}

async function view(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const agent = args.shift();
  const id = args.shift();
  rejectArgs(args, USAGE);

  if (!agent || !id) {
    throw new CliUsageError("Missing agent or session id", USAGE);
  }

  const endpoint = `/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`;
  const result = await runtimeRequest<{ session: UnifiedSessionDetail }>(endpoint, {}, deps);
  printData(result, wantsJson, formatSessionDetail(result.session));
}

async function handoff(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const autoExecute = takeFlag(args, "--execute");
  const toAgent = takeOption(args, "--to");
  const strategy = takeOption(args, "--strategy");
  const instructions = takeOption(args, "--instructions");
  const agent = args.shift();
  const id = args.shift();
  rejectArgs(args, USAGE);

  if (!agent || !id) {
    throw new CliUsageError("Missing agent or session id", USAGE);
  }
  if (!toAgent) {
    throw new CliUsageError("Missing target agent (--to <codex|agy|claude|grok>)", USAGE);
  }

  const action = autoExecute ? "dispatch" : "handoff";
  const body = {
    targetAgent: toAgent,
    strategy: strategy === "full" ? "full_replay" : "smart_handoff",
    customInstructions: instructions,
    autoExecute,
  };

  const endpoint = `/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(id)}/${action}`;
  const result = await runtimeRequest<{ result?: DispatchResult; handoff?: HandoffContext }>(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    deps,
  );

  if (wantsJson) {
    printData(result, wantsJson);
    return;
  }

  if (result.result) {
    printData(result, wantsJson, formatHandoffResult(result.result));
  } else if (result.handoff) {
    const lines = [
      `=== Session Handoff Preview ===`,
      `Source Agent:   ${result.handoff.sourceAgent}`,
      `Target Agent:   ${result.handoff.targetAgent}`,
      `Session ID:     ${result.handoff.sourceSessionId}`,
      `Goal:           ${result.handoff.goal}`,
      `Modified Files: ${result.handoff.modifiedFiles.length}`,
      `\n--- Rendered Prompt ---\n`,
      result.handoff.renderedPrompt,
      `\nTip: Run with --execute to automatically trigger target agent execution.`,
    ];
    printData(result, wantsJson, lines);
  }
}

export async function handleSessionsCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
  const sub = hasSub ? argv[0]! : "list";
  const rest = hasSub ? argv.slice(1) : argv;

  return runCliAction(async () => {
    if (sub === "list") await list(rest, deps);
    else if (sub === "view" || sub === "show" || sub === "get") await view(rest, deps);
    else if (sub === "handoff" || sub === "sync" || sub === "dispatch") await handoff(rest, deps);
    else throw new CliUsageError(`unknown sessions subcommand: "${sub}"`, USAGE);
  });
}

export const runSessions = handleSessionsCommand;
export const SESSIONS_USAGE = USAGE;
