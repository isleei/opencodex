/**
 * `ocx skills` — Centralized Skills management CLI.
 *
 * Subcommands:
 * - list: List all discovered skills across central store and agent symlinks
 * - view: Inspect a single skill's frontmatter metadata and markdown body
 * - create: Create a new skill in central store and link to agents
 * - edit: Update an existing skill's metadata and/or markdown body
 * - toggle: Enable or disable a skill globally or for a specific agent
 * - delete: Move a skill to trash (or permanently delete with --permanent)
 * - sync: Deduplicate physical skills, migrate to central store, and link agents
 * - trash: List all recoverable deleted skills in trash
 * - restore: Restore a deleted skill from trash
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
  SkillItem,
  SyncResult,
  TrashRecord,
} from "../skills/types";

const USAGE = `Usage:
  ocx skills [list] [--status <active|disabled|all>] [--agent <all|claude|codex|project>]
      [--search <query>] [--tags <t1,t2>] [--json]
  ocx skills view <skill-name> [--raw] [--json]
  ocx skills create <skill-name> [--description <desc>] [--tags <t1,t2>]
      [--content <markdown>] [--link <claude,codex,project>] [--json]
  ocx skills edit <skill-name> [--description <desc>] [--tags <t1,t2>]
      [--content <markdown>] [--json]
  ocx skills toggle <skill-name> <--enable|--disable> [--agent <all|claude|codex>] [--json]
  ocx skills delete <skill-name> --yes [--permanent] [--json]
  ocx skills sync [--dry-run] [--migrate] [--json]
  ocx skills trash [--json]
  ocx skills restore <trash-id> [--json]`;

function pad(str: string, length: number): string {
  return str.length >= length ? str : str + " ".repeat(length - str.length);
}

function formatSkillsTable(skills: SkillItem[]): string[] {
  if (skills.length === 0) {
    return ["No skills found."];
  }

  const header = `${pad("NAME", 24)} ${pad("STATUS", 10)} ${pad("VERSION", 10)} ${pad("AGENTS", 20)} DESCRIPTION`;
  const lines = [header];

  for (const skill of skills) {
    const name = skill.isSystem ? `${skill.name} (system)` : skill.name;
    const status = skill.metadata.disabled ? "disabled" : "active";
    const version = skill.metadata.version ?? "1.0.0";
    const agents = skill.linkedAgents.length > 0 ? skill.linkedAgents.join(",") : "none";
    const desc = skill.metadata.description ? skill.metadata.description.replace(/\n/g, " ").slice(0, 60) : "";

    lines.push(`${pad(name, 24)} ${pad(status, 10)} ${pad(version, 10)} ${pad(agents, 20)} ${desc}`);
  }

  return lines;
}

function formatTrashTable(items: TrashRecord[]): string[] {
  if (items.length === 0) {
    return ["No trashed skills found."];
  }

  const header = `${pad("TRASH ID", 36)} ${pad("SKILL", 20)} ${pad("DELETED AT", 24)} ORIGINAL PATH`;
  const lines = [header];

  for (const item of items) {
    lines.push(`${pad(item.trashId, 36)} ${pad(item.skillName, 20)} ${pad(item.deletedAt.slice(0, 19), 24)} ${item.originalPath}`);
  }

  return lines;
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const status = takeOption(args, "--status");
  const agent = takeOption(args, "--agent");
  const search = takeOption(args, "--search");
  const tags = takeOption(args, "--tags");
  rejectArgs(args, USAGE);

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (agent) query.set("agent", agent);
  if (search) query.set("search", search);
  if (tags) query.set("tags", tags);

  const qs = query.toString();
  const path = `/api/skills${qs ? `?${qs}` : ""}`;
  const result = await runtimeRequest<{ skills: SkillItem[] }>(path, {}, deps);

  printData(result, wantsJson, formatSkillsTable(result.skills ?? []));
}

async function view(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const raw = takeFlag(args, "--raw");
  const name = args.shift()?.trim();
  if (!name) throw new CliUsageError("Skill name is required", USAGE);
  rejectArgs(args, USAGE);

  const result = await runtimeRequest<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(name)}`, {}, deps);
  const skill = result.skill;

  if (raw) {
    if (wantsJson) {
      printData({ raw: skill.content, metadata: skill.metadata }, wantsJson);
    } else {
      console.log(`---\nname: ${skill.name}\ndescription: ${skill.metadata.description}\nversion: ${skill.metadata.version ?? "1.0.0"}\ndisabled: ${Boolean(skill.metadata.disabled)}\n---\n\n${skill.content}`);
    }
    return;
  }

  const lines = [
    `Name:        ${skill.name}${skill.isSystem ? " (system)" : ""}`,
    `Description: ${skill.metadata.description || "(no description)"}`,
    `Status:      ${skill.metadata.disabled ? "disabled" : "active"}`,
    `Version:     ${skill.metadata.version ?? "1.0.0"}`,
    `Author:      ${skill.metadata.author || "(none)"}`,
    `Agents:      ${skill.linkedAgents.join(", ") || "none"}`,
    `Tags:        ${skill.metadata.tags?.join(", ") || "none"}`,
    `Path:        ${skill.path}`,
    "",
    "--- Content ---",
    skill.content || "(empty body)",
  ];

  printData(result, wantsJson, lines);
}

async function create(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const name = args.shift()?.trim();
  if (!name) throw new CliUsageError("Skill name is required", USAGE);

  const description = takeOption(args, "--description") ?? "";
  const tagsRaw = takeOption(args, "--tags");
  const content = takeOption(args, "--content");
  const linkRaw = takeOption(args, "--link");
  const version = takeOption(args, "--version");
  const author = takeOption(args, "--author");
  rejectArgs(args, USAGE);

  const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : undefined;
  const linkAgents = linkRaw ? linkRaw.split(",").map(a => a.trim()).filter(Boolean) : undefined;

  const body = {
    name,
    description,
    tags,
    content,
    linkAgents,
    version,
    author,
  };

  const result = await runtimeRequest<{ ok: boolean; skill: SkillItem }>("/api/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);

  const lines = [
    `Created skill "${result.skill.name}" in central store.`,
    `Path: ${result.skill.path}`,
    `Linked to agents: ${result.skill.linkedAgents.join(", ") || "none"}`,
  ];

  printData(result, wantsJson, lines);
}

async function edit(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const name = args.shift()?.trim();
  if (!name) throw new CliUsageError("Skill name is required", USAGE);

  const description = takeOption(args, "--description");
  const tagsRaw = takeOption(args, "--tags");
  const content = takeOption(args, "--content");
  const version = takeOption(args, "--version");
  const author = takeOption(args, "--author");
  rejectArgs(args, USAGE);

  const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : undefined;

  const body: Record<string, unknown> = {};
  if (description !== undefined) body.description = description;
  if (tags !== undefined) body.tags = tags;
  if (content !== undefined) body.content = content;
  if (version !== undefined) body.version = version;
  if (author !== undefined) body.author = author;

  if (Object.keys(body).length === 0) {
    throw new CliUsageError("edit requires at least one of --description, --tags, --content, --version, --author", USAGE);
  }

  const result = await runtimeRequest<{ ok: boolean; skill: SkillItem }>(`/api/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);

  printData(result, wantsJson, [`Updated skill "${name}".`]);
}

async function toggle(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const name = args.shift()?.trim();
  if (!name) throw new CliUsageError("Skill name is required", USAGE);

  const enable = takeFlag(args, "--enable");
  const disable = takeFlag(args, "--disable");
  const agent = takeOption(args, "--agent");
  rejectArgs(args, USAGE);

  if ((!enable && !disable) || (enable && disable)) {
    throw new CliUsageError("Specify either --enable or --disable", USAGE);
  }

  const enabled = enable;
  const result = await runtimeRequest<{ ok: boolean; enabled: boolean }>(`/api/skills/${encodeURIComponent(name)}/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled, agent }),
  }, deps);

  const lines = [`Skill "${name}" is now ${result.enabled ? "enabled" : "disabled"}.`];
  printData(result, wantsJson, lines);
}

async function del(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const name = args.shift()?.trim();
  if (!name) throw new CliUsageError("Skill name is required", USAGE);

  const yes = takeFlag(args, "--yes");
  const permanent = takeFlag(args, "--permanent");
  rejectArgs(args, USAGE);

  if (!yes) {
    throw new CliUsageError("delete requires --yes to confirm", USAGE);
  }

  const qs = permanent ? "?permanent=true" : "";
  const result = await runtimeRequest<{ ok: boolean; trashId?: string }>(`/api/skills/${encodeURIComponent(name)}${qs}`, {
    method: "DELETE",
  }, deps);

  const lines = [
    permanent
      ? `Permanently deleted skill "${name}".`
      : `Deleted skill "${name}" (moved to trash: ${result.trashId ?? "backup"}).`,
  ];
  printData(result, wantsJson, lines);
}

async function sync(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const dryRun = takeFlag(args, "--dry-run");
  const migrate = takeFlag(args, "--migrate");
  rejectArgs(args, USAGE);

  const result = await runtimeRequest<SyncResult>("/api/skills/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun, migrate }),
  }, deps);

  const lines = [
    `Synced ${result.synced} skill(s).`,
    `  Migrated:        ${result.migrated.length} (${result.migrated.join(", ") || "none"})`,
    `  Deduplicated:    ${result.deduped.length} (${result.deduped.join(", ") || "none"})`,
    `  Broken repaired: ${result.broken.length} (${result.broken.join(", ") || "none"})`,
  ];
  if (result.conflicts && result.conflicts.length > 0) {
    lines.push(`  Conflicts:       ${result.conflicts.length} (${result.conflicts.join(", ")})`);
  }

  printData(result, wantsJson, lines);
}

async function trash(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);

  const result = await runtimeRequest<{ items: TrashRecord[] }>("/api/skills/trash", {}, deps);
  printData(result, wantsJson, formatTrashTable(result.items ?? []));
}

async function restore(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const trashId = args.shift()?.trim();
  if (!trashId) throw new CliUsageError("trash-id is required", USAGE);
  rejectArgs(args, USAGE);

  const result = await runtimeRequest<{ ok: boolean; restored: string }>("/api/skills/trash/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashId }),
  }, deps);

  printData(result, wantsJson, [`Restored skill "${result.restored}" from trash ${trashId}.`]);
}

export async function handleSkillsCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
  const sub = hasSub ? argv[0]! : "list";
  const rest = hasSub ? argv.slice(1) : argv;

  return runCliAction(async () => {
    if (sub === "list") await list(rest, deps);
    else if (sub === "view" || sub === "show" || sub === "get") await view(rest, deps);
    else if (sub === "create" || sub === "add" || sub === "new") await create(rest, deps);
    else if (sub === "edit" || sub === "update" || sub === "set") await edit(rest, deps);
    else if (sub === "toggle" || sub === "enable" || sub === "disable") {
      // Allow `ocx skills enable <name>` and `ocx skills disable <name>` directly
      if (sub === "enable") await toggle([rest[0] ?? "", "--enable", ...rest.slice(1)], deps);
      else if (sub === "disable") await toggle([rest[0] ?? "", "--disable", ...rest.slice(1)], deps);
      else await toggle(rest, deps);
    }
    else if (sub === "delete" || sub === "remove" || sub === "rm") await del(rest, deps);
    else if (sub === "sync") await sync(rest, deps);
    else if (sub === "trash") await trash(rest, deps);
    else if (sub === "restore") await restore(rest, deps);
    else throw new CliUsageError(`unknown skills subcommand: "${sub}"`, USAGE);
  });
}

export const SKILLS_USAGE = USAGE;
