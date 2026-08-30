/**
 * Management routes for Cross-Agent Session Hub and Handoff Engine.
 *
 * REST Endpoints:
 * - GET /api/sessions: List all sessions across discovered agents
 * - GET /api/sessions/:agent/:id: Get full details and turn timeline for a session
 * - POST /api/sessions/:agent/:id/handoff: Generate structured handoff context & prompt
 * - POST /api/sessions/:agent/:id/dispatch: Execute or preview handoff to target agent
 */

import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import {
  dispatchSessionHandoff,
  generateSessionHandoff,
  getUnifiedSession,
  listUnifiedSessionsWithStats,
} from "../../sessions/manager";
import type {
  AgentType,
  HandoffOptions,
  SessionFilterOptions,
  SessionStatus,
} from "../../sessions/types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(ctx: ManagementContext): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(ctx.req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse(
      {
        error: "invalid JSON body",
        code: "invalid_json_body",
      },
      400,
      ctx.req,
      ctx.config,
    );
  }
}

function normalizeAgent(raw?: string | null): AgentType | null {
  if (!raw) return null;
  const n = raw.trim().toLowerCase();
  if (n === "codex" || n === "openai_codex" || n === "openai") return "codex";
  if (n === "agy" || n === "antigravity" || n === "gemini") return "agy";
  if (n === "claude" || n === "claude_code" || n === "claude-code") return "claude_code";
  if (n === "grok" || n === "grok-build" || n === "grok_build" || n === "xai") return "grok";
  return null;
}

export async function handleSessionsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (!url.pathname.startsWith("/api/sessions")) {
    return null;
  }

  // 1. GET /api/sessions
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    try {
      const agentParam = url.searchParams.get("agent");
      const projectParam = url.searchParams.get("project") || undefined;
      const statusParam = url.searchParams.get("status") as SessionStatus | null;
      const searchParam = url.searchParams.get("search") || undefined;
      const limitParam = url.searchParams.get("limit");

      const options: SessionFilterOptions = {
        agent: agentParam === "all" ? "all" : normalizeAgent(agentParam) || "all",
        project: projectParam,
        status: statusParam || "all",
        search: searchParam,
        limit: limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : 50,
      };

      const { sessions, stats } = await listUnifiedSessionsWithStats(options);
      return jsonResponse({ sessions, stats }, 200, req, ctx.config);
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : String(error),
          code: "sessions_list_error",
        },
        500,
        req,
        ctx.config,
      );
    }
  }

  // 2. /api/sessions/:agent/:id (with optional subpath /handoff or /dispatch)
  // Regex: ^/api/sessions/([^/]+)/([^/]+)(?:/(handoff|dispatch))?$
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)(?:\/(handoff|dispatch))?$/);
  if (match) {
    const rawAgent = match[1];
    const sessionId = decodeURIComponent(match[2]);
    const action = match[3]; // undefined | "handoff" | "dispatch"

    const agent = normalizeAgent(rawAgent);
    if (!agent) {
      return jsonResponse(
        {
          error: `Unknown agent '${rawAgent}'. Expected 'codex', 'agy', 'claude_code', or 'grok'`,
          code: "unknown_agent",
        },
        400,
        req,
        ctx.config,
      );
    }

    // GET /api/sessions/:agent/:id
    if (!action && req.method === "GET") {
      try {
        const session = await getUnifiedSession(agent, sessionId);
        if (!session) {
          return jsonResponse(
            {
              error: `Session '${sessionId}' not found for agent '${agent}'`,
              code: "session_not_found",
            },
            404,
            req,
            ctx.config,
          );
        }
        return jsonResponse({ session }, 200, req, ctx.config);
      } catch (error) {
        return jsonResponse(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "session_detail_error",
          },
          500,
          req,
          ctx.config,
        );
      }
    }

    // POST /api/sessions/:agent/:id/handoff
    if (action === "handoff" && req.method === "POST") {
      const parsed = await readJsonBody(ctx);
      if (parsed instanceof Response) return parsed;

      const body = isPlainRecord(parsed) ? parsed : {};
      const targetAgent = normalizeAgent(typeof body.targetAgent === "string" ? body.targetAgent : undefined);

      if (!targetAgent) {
        return jsonResponse(
          {
            error: "Missing or invalid 'targetAgent' in request body. Expected 'codex', 'agy', 'claude_code', or 'grok'.",
            code: "invalid_target_agent",
          },
          400,
          req,
          ctx.config,
        );
      }

      const options: HandoffOptions = {
        targetAgent,
        strategy: body.strategy === "full_replay" ? "full_replay" : "smart_handoff",
        customInstructions: typeof body.customInstructions === "string" ? body.customInstructions : undefined,
      };

      try {
        const handoff = await generateSessionHandoff(agent, sessionId, options);
        return jsonResponse({ handoff }, 200, req, ctx.config);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const status = msg.includes("not found") ? 404 : 500;
        return jsonResponse(
          {
            error: msg,
            code: "session_handoff_error",
          },
          status,
          req,
          ctx.config,
        );
      }
    }

    // POST /api/sessions/:agent/:id/dispatch
    if (action === "dispatch" && req.method === "POST") {
      const parsed = await readJsonBody(ctx);
      if (parsed instanceof Response) return parsed;

      const body = isPlainRecord(parsed) ? parsed : {};
      const targetAgent = normalizeAgent(typeof body.targetAgent === "string" ? body.targetAgent : undefined);

      if (!targetAgent) {
        return jsonResponse(
          {
            error: "Missing or invalid 'targetAgent' in request body. Expected 'codex', 'agy', 'claude_code', or 'grok'.",
            code: "invalid_target_agent",
          },
          400,
          req,
          ctx.config,
        );
      }

      const options: HandoffOptions = {
        targetAgent,
        strategy: body.strategy === "full_replay" ? "full_replay" : "smart_handoff",
        customInstructions: typeof body.customInstructions === "string" ? body.customInstructions : undefined,
        autoExecute: body.autoExecute === true,
      };

      try {
        const result = await dispatchSessionHandoff(agent, sessionId, options);
        return jsonResponse({ result }, 200, req, ctx.config);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const status = msg.includes("not found") ? 404 : 500;
        return jsonResponse(
          {
            error: msg,
            code: "session_dispatch_error",
          },
          status,
          req,
          ctx.config,
        );
      }
    }
  }

  return null;
}
