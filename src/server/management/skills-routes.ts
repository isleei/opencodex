/**
 * Management routes for Centralized Skills Engine.
 *
 * REST Endpoints:
 * - GET /api/skills: List all skills across central store and agent symlinks
 * - POST /api/skills: Create a new skill in central store
 * - GET /api/skills/:name: Retrieve a single skill's metadata and content
 * - PUT /api/skills/:name: Update an existing skill's metadata/content
 * - POST /api/skills/:name/toggle: Toggle a skill's active status
 * - DELETE /api/skills/:name: Move a skill to trash (or permanently delete)
 * - POST /api/skills/sync: Synchronize, deduplicate, and create symlinks
 * - GET /api/skills/trash: List all deleted skills in trash
 * - POST /api/skills/trash/restore: Restore a deleted skill from trash
 */

import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  listTrash,
  restoreSkill,
  syncSkills,
  toggleSkill,
  updateSkill,
} from "../../skills/manager";
import type {
  CreateSkillInput,
  SkillFilterOptions,
  SyncOptions,
  UpdateSkillInput,
} from "../../skills/types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(ctx: ManagementContext): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(ctx.req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({
      error: "invalid JSON body",
      code: "invalid_json_body",
    }, 400, ctx.req, ctx.config);
  }
}

export async function handleSkillsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (!url.pathname.startsWith("/api/skills")) {
    return null;
  }

  const skillsConfig = ctx.deps.skillsConfig;

  // 1. GET /api/skills
  if (url.pathname === "/api/skills" && req.method === "GET") {
    try {
      const statusParam = url.searchParams.get("status");
      const agentParam = url.searchParams.get("agent");
      const searchParam = url.searchParams.get("search");
      const tagsParam = url.searchParams.get("tags");

      const options: SkillFilterOptions = {
        config: skillsConfig,
      };

      if (statusParam === "active" || statusParam === "disabled" || statusParam === "all") {
        options.status = statusParam;
      }
      if (agentParam) {
        options.agent = agentParam;
      }
      if (searchParam) {
        options.search = searchParam;
      }
      if (tagsParam) {
        options.tags = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
      }

      const skills = await listSkills(options);
      return jsonResponse({ skills }, 200, req, ctx.config);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        code: "skills_list_error",
      }, 500, req, ctx.config);
    }
  }

  // 2. POST /api/skills
  if (url.pathname === "/api/skills" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed)) {
      return jsonResponse({
        error: "Request body must be a JSON object",
        code: "invalid_request_body",
      }, 400, req, ctx.config);
    }

    if (typeof parsed.name !== "string" || !parsed.name.trim()) {
      return jsonResponse({
        error: "Skill name is required and must be a non-empty string",
        code: "missing_skill_name",
      }, 400, req, ctx.config);
    }

    if (typeof parsed.description !== "string") {
      return jsonResponse({
        error: "Skill description must be a string",
        code: "invalid_skill_description",
      }, 400, req, ctx.config);
    }

    try {
      const input: CreateSkillInput = {
        name: parsed.name,
        description: parsed.description,
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
        version: typeof parsed.version === "string" ? parsed.version : undefined,
        author: typeof parsed.author === "string" ? parsed.author : undefined,
        source: typeof parsed.source === "string" ? parsed.source : undefined,
        content: typeof parsed.content === "string" ? parsed.content : undefined,
        disabled: typeof parsed.disabled === "boolean" ? parsed.disabled : undefined,
        linkAgents: Array.isArray(parsed.linkAgents) ? parsed.linkAgents as ("claude" | "codex" | "project")[] : undefined,
      };

      const skill = await createSkill(input, skillsConfig);
      return jsonResponse({ ok: true, skill }, 200, req, ctx.config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("already exists")) {
        return jsonResponse({ error: msg, code: "skill_already_exists" }, 409, req, ctx.config);
      }
      if (msg.includes("Invalid skill name")) {
        return jsonResponse({ error: msg, code: "invalid_skill_name" }, 400, req, ctx.config);
      }
      return jsonResponse({ error: msg, code: "skill_create_error" }, 500, req, ctx.config);
    }
  }

  // 3. POST /api/skills/sync
  if (url.pathname === "/api/skills/sync" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    let options: SyncOptions = { config: skillsConfig };
    if (! (parsed instanceof Response) && isPlainRecord(parsed)) {
      options = {
        ...options,
        dryRun: typeof parsed.dryRun === "boolean" ? parsed.dryRun : undefined,
        migrate: typeof parsed.migrate === "boolean" ? parsed.migrate : undefined,
      };
    }
    try {
      const result = await syncSkills(options);
      return jsonResponse(result, 200, req, ctx.config);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        code: "skills_sync_error",
      }, 500, req, ctx.config);
    }
  }

  // 4. GET /api/skills/trash
  if (url.pathname === "/api/skills/trash" && req.method === "GET") {
    try {
      const items = await listTrash(skillsConfig);
      return jsonResponse({ items }, 200, req, ctx.config);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        code: "skills_trash_list_error",
      }, 500, req, ctx.config);
    }
  }

  // 5. POST /api/skills/trash/restore
  if (url.pathname === "/api/skills/trash/restore" && req.method === "POST") {
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed) || typeof parsed.trashId !== "string" || !parsed.trashId.trim()) {
      return jsonResponse({
        error: "trashId is required and must be a non-empty string",
        code: "missing_trash_id",
      }, 400, req, ctx.config);
    }
    try {
      const result = await restoreSkill(parsed.trashId.trim(), skillsConfig);
      return jsonResponse(result, 200, req, ctx.config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) {
        return jsonResponse({ error: msg, code: "trash_record_not_found" }, 404, req, ctx.config);
      }
      return jsonResponse({ error: msg, code: "skills_restore_error" }, 500, req, ctx.config);
    }
  }

  // 6. POST /api/skills/:name/toggle
  const toggleMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === "POST") {
    const skillName = decodeURIComponent(toggleMatch[1]);
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed) || typeof parsed.enabled !== "boolean") {
      return jsonResponse({
        error: "enabled must be a boolean",
        code: "invalid_toggle_body",
      }, 400, req, ctx.config);
    }
    try {
      const agent = typeof parsed.agent === "string" ? parsed.agent : undefined;
      const result = await toggleSkill(skillName, parsed.enabled, { agent, config: skillsConfig });
      return jsonResponse(result, 200, req, ctx.config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) {
        return jsonResponse({ error: msg, code: "skill_not_found" }, 404, req, ctx.config);
      }
      return jsonResponse({ error: msg, code: "skills_toggle_error" }, 500, req, ctx.config);
    }
  }

  // Dynamic skill item routes: GET, PUT, DELETE /api/skills/:name
  const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch && skillMatch[1] !== "sync" && skillMatch[1] !== "trash") {
    const skillName = decodeURIComponent(skillMatch[1]);

    // 7. GET /api/skills/:name
    if (req.method === "GET") {
      try {
        const skill = await getSkill(skillName, skillsConfig);
        if (!skill) {
          return jsonResponse({
            error: `Skill "${skillName}" not found`,
            code: "skill_not_found",
          }, 404, req, ctx.config);
        }
        return jsonResponse({ skill }, 200, req, ctx.config);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : String(error),
          code: "skills_get_error",
        }, 500, req, ctx.config);
      }
    }

    // 8. PUT /api/skills/:name
    if (req.method === "PUT") {
      const parsed = await readJsonBody(ctx);
      if (parsed instanceof Response) return parsed;
      if (!isPlainRecord(parsed)) {
        return jsonResponse({
          error: "Request body must be a JSON object",
          code: "invalid_request_body",
        }, 400, req, ctx.config);
      }
      try {
        const input: UpdateSkillInput = {
          description: typeof parsed.description === "string" ? parsed.description : undefined,
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
          version: typeof parsed.version === "string" ? parsed.version : undefined,
          author: typeof parsed.author === "string" ? parsed.author : undefined,
          source: typeof parsed.source === "string" ? parsed.source : undefined,
          content: typeof parsed.content === "string" ? parsed.content : undefined,
          disabled: typeof parsed.disabled === "boolean" ? parsed.disabled : undefined,
        };
        const skill = await updateSkill(skillName, input, skillsConfig);
        return jsonResponse({ ok: true, skill }, 200, req, ctx.config);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("not found")) {
          return jsonResponse({ error: msg, code: "skill_not_found" }, 404, req, ctx.config);
        }
        if (msg.includes("protected system skill")) {
          return jsonResponse({ error: msg, code: "protected_system_skill" }, 403, req, ctx.config);
        }
        return jsonResponse({ error: msg, code: "skills_update_error" }, 500, req, ctx.config);
      }
    }

    // 9. DELETE /api/skills/:name
    if (req.method === "DELETE") {
      let permanent = false;
      let reason: string | undefined;
      try {
        const parsed = await readJsonBody(ctx);
        if (! (parsed instanceof Response) && isPlainRecord(parsed)) {
          if (typeof parsed.permanent === "boolean") permanent = parsed.permanent;
          if (typeof parsed.reason === "string") reason = parsed.reason;
        }
      } catch {
        // Body is optional on DELETE
      }
      if (url.searchParams.get("permanent") === "true") {
        permanent = true;
      }
      try {
        const result = await deleteSkill(skillName, { permanent, reason, config: skillsConfig });
        return jsonResponse(result, 200, req, ctx.config);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("not found")) {
          return jsonResponse({ error: msg, code: "skill_not_found" }, 404, req, ctx.config);
        }
        if (msg.includes("protected system skill")) {
          return jsonResponse({ error: msg, code: "protected_system_skill" }, 403, req, ctx.config);
        }
        return jsonResponse({ error: msg, code: "skills_delete_error" }, 500, req, ctx.config);
      }
    }
  }

  return null;
}
