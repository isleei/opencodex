/**
 * Unified types for Cross-Agent Session Hub and Handoff Engine.
 */

export type AgentType = "codex" | "agy" | "claude_code" | "grok";

export type SessionStatus = "active" | "archived" | "all";

export interface SessionStats {
  total: number;
  codex: number;
  agy: number;
  claude_code: number;
  grok: number;
}

export interface SessionTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModifiedFileInfo {
  path: string;
  changeType: "create" | "modify" | "delete";
  summary?: string;
}

export interface SessionTurn {
  turnId: string;
  role: "user" | "assistant" | "system" | "tool";
  timestamp?: number;
  content: string;
  toolCalls?: Array<{
    toolName: string;
    args?: Record<string, unknown> | string;
    result?: string;
  }>;
}

export interface UnifiedSession {
  id: string;
  agent: AgentType;
  title: string;
  summary?: string;
  project?: string;
  projectPath?: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  modifiedFiles: string[];
  tokens: SessionTokenUsage;
  sourcePath: string;
}

export interface UnifiedSessionDetail extends UnifiedSession {
  turns: SessionTurn[];
  modifiedFileDetails: ModifiedFileInfo[];
  rawMetadata?: Record<string, unknown>;
}

export type HandoffStrategy = "smart_handoff" | "full_replay";

export interface HandoffContext {
  sourceAgent: AgentType;
  targetAgent: AgentType;
  sourceSessionId: string;
  generatedAt: number;
  strategy: HandoffStrategy;
  goal: string;
  completedMilestones: string[];
  modifiedFiles: ModifiedFileInfo[];
  unresolvedIssues: string[];
  pendingTasks: string[];
  customInstructions?: string;
  renderedPrompt: string;
}

export interface HandoffOptions {
  targetAgent: AgentType;
  strategy?: HandoffStrategy;
  customInstructions?: string;
  autoExecute?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  sourceAgent: AgentType;
  targetAgent: AgentType;
  sourceSessionId: string;
  command: string;
  executed: boolean;
  executionOutput?: string;
  error?: string;
  handoffContext: HandoffContext;
}

export interface SessionFilterOptions {
  agent?: AgentType | "all";
  status?: SessionStatus;
  project?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  workspaceDir?: string;
}

export interface SessionScannerConfig {
  codexHome?: string;
  antigravityHome?: string;
  claudeHome?: string;
  grokHome?: string;
  workspaceDir?: string;
}
