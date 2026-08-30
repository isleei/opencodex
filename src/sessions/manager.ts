import type {
  AgentType,
  DispatchResult,
  HandoffContext,
  HandoffOptions,
  SessionFilterOptions,
  SessionScannerConfig,
  UnifiedSession,
  UnifiedSessionDetail,
} from "./types";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCodexSessionFile } from "./scanners/codex-scanner";
import { parseAgyConversationDir } from "./scanners/agy-scanner";
import { parseClaudeSessionFile } from "./scanners/claude-scanner";
import { parseGrokSessionFile } from "./scanners/grok-scanner";
import { getSessionStore, resolveSessionHomes } from "./store";
import { extractHandoffContext } from "./handoff/extractor";
import { buildDispatchCommand, executeAgentDispatch } from "./dispatcher/runner";

export async function listUnifiedSessions(
  options: SessionFilterOptions = {},
  config: SessionScannerConfig = {},
): Promise<UnifiedSession[]> {
  const store = getSessionStore(config);
  await store.refresh();
  return store.list(options);
}

export async function getUnifiedSessionStats(
  config: SessionScannerConfig = {},
): Promise<{ total: number; codex: number; agy: number; claude_code: number; grok: number }> {
  const store = getSessionStore(config);
  await store.refresh();
  return store.stats();
}

/**
 * List + stats under a single index refresh — the REST list handler needs both, and
 * two separate calls would walk the source directories twice.
 */
export async function listUnifiedSessionsWithStats(
  options: SessionFilterOptions = {},
  config: SessionScannerConfig = {},
): Promise<{ sessions: UnifiedSession[]; stats: { total: number; codex: number; agy: number; claude_code: number; grok: number } }> {
  const store = getSessionStore(config);
  await store.refresh();
  return { sessions: store.list(options), stats: store.stats() };
}

export async function getUnifiedSession(
  agent: AgentType,
  id: string,
  config: SessionScannerConfig = {},
): Promise<UnifiedSessionDetail | null> {
  const homes = resolveSessionHomes(config);

  if (agent === "agy") {
    const convDir = join(homes.agyBrainDir, id);
    if (existsSync(convDir)) {
      return parseAgyConversationDir(convDir, id);
    }
    return null;
  }

  // Codex, Claude Code, and Grok sessions live in per-id files whose location is not
  // derivable from the id alone; the index remembers it, so a detail view reads one
  // file instead of rescanning the library.
  const store = getSessionStore(config);
  await store.refresh();
  const location = store.locate(agent, id);
  if (!location) return null;

  if (agent === "codex") {
    return parseCodexSessionFile(location.path, location.status === "archived");
  }
  if (agent === "grok") {
    return parseGrokSessionFile(location.path);
  }
  return parseClaudeSessionFile(location.path);
}

export async function generateSessionHandoff(
  agent: AgentType,
  id: string,
  options: HandoffOptions,
  config: SessionScannerConfig = {},
): Promise<HandoffContext> {
  const detail = await getUnifiedSession(agent, id, config);
  if (!detail) {
    throw new Error(`Session not found for agent '${agent}' with id '${id}'`);
  }

  return extractHandoffContext(detail, options);
}

export async function dispatchSessionHandoff(
  agent: AgentType,
  id: string,
  options: HandoffOptions,
  config: SessionScannerConfig = {},
): Promise<DispatchResult> {
  const handoff = await generateSessionHandoff(agent, id, options, config);
  const { fullCommandLine } = buildDispatchCommand(options.targetAgent, handoff.renderedPrompt);

  if (options.autoExecute) {
    const execResult = await executeAgentDispatch(
      options.targetAgent,
      handoff.renderedPrompt,
      config.workspaceDir,
    );

    return {
      ok: execResult.ok,
      sourceAgent: agent,
      targetAgent: options.targetAgent,
      sourceSessionId: id,
      command: fullCommandLine,
      executed: true,
      executionOutput: execResult.output,
      error: execResult.error,
      handoffContext: handoff,
    };
  }

  return {
    ok: true,
    sourceAgent: agent,
    targetAgent: options.targetAgent,
    sourceSessionId: id,
    command: fullCommandLine,
    executed: false,
    handoffContext: handoff,
  };
}
