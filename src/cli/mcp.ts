/**
 * `ocx mcp` — Multi-Client MCP Server Configuration CLI.
 *
 * Subcommands:
 * - list: List all configured MCP servers across all supported clients
 * - get: Inspect details of a specific MCP server in a client
 * - add: Add a new MCP server to a client configuration
 * - edit: Update an existing MCP server configuration
 * - toggle: Enable or disable an MCP server
 * - delete: Remove an MCP server from a client configuration
 * - clone: One-click cross-client MCP server cloning / sharing
 */

import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  takeIntegerOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import type {
  UnifiedMcpServer,
} from "../mcp/types";

const USAGE = `Usage:
  ocx mcp [list] [--client <all|claude-desktop|claude-code|codex|antigravity>]
      [--scope <global|project>] [--json]
  ocx mcp get <server-id> --client <client> [--scope <global|project>] [--json]
  ocx mcp add <server-id> --client <client> [--command <cmd>] [--args <a1,a2>]
      [--env <KEY=VAL,...>] [--cwd <dir>] [--url <url>] [--scope <global|project>] [--json]
  ocx mcp edit <server-id> --client <client> [--command <cmd>] [--args <a1,a2>]
      [--env <KEY=VAL,...>] [--cwd <dir>] [--url <url>] [--scope <global|project>] [--json]
  ocx mcp toggle <server-id> --client <client> <--enable|--disable> [--scope <global|project>] [--json]
  ocx mcp delete <server-id> --client <client> --yes [--scope <global|project>] [--json]
  ocx mcp clone <server-id> --from <client> --to <client> [--new-id <id>]
      [--overwrite] [--scope <global|project>] [--json]`;

function normalizeClientName(raw: string): string {
  const norm = raw.trim().toLowerCase().replace(/-/g, "_");
  if (norm === "claude_desktop" || norm === "desktop") return "claude_desktop";
  if (norm === "claude_code" || norm === "claude") return "claude_code";
  if (norm === "codex") return "codex";
  if (norm === "antigravity" || norm === "gemini") return "antigravity";
  return norm;
}

function pad(str: string, length: number): string {
  return str.length >= length ? str : str + " ".repeat(length - str.length);
}

function parseEnvString(envRaw: string): Record<string, string> {
  const env: Record<string, string> = {};
  const pairs = envRaw.split(",").map(p => p.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return env;
}

function formatServerTable(servers: UnifiedMcpServer[]): string[] {
  if (servers.length === 0) {
    return ["No MCP servers configured."];
  }

  const header = `${pad("CLIENT", 16)} ${pad("ID", 20)} ${pad("TRANSPORT", 10)} ${pad("STATUS", 10)} COMMAND / URL`;
  const lines = [header];

  for (const server of servers) {
    const status = server.enabled ? "enabled" : "disabled";
    const target = server.transport === "stdio"
      ? `${server.command ?? ""}${(server.args ?? []).length ? ` ${(server.args ?? []).join(" ")}` : ""}`
      : (server.url ?? "");

    lines.push(`${pad(server.client, 16)} ${pad(server.id, 20)} ${pad(server.transport, 10)} ${pad(status, 10)} ${target}`);
  }

  return lines;
}

function formatServerDetail(server: UnifiedMcpServer): string[] {
  const envPairs = Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
  const lines = [
    `ID:          ${server.id}`,
    `Client:      ${server.client}`,
    `Transport:   ${server.transport}`,
    `Status:      ${server.enabled ? "enabled" : "disabled"}`,
    `Scope:       ${server.scope}`,
  ];

  if (server.transport === "stdio") {
    lines.push(`Command:     ${server.command ?? "(none)"}`);
    lines.push(`Args:        ${(server.args ?? []).join(" ") || "(none)"}`);
    if (server.cwd) lines.push(`CWD:         ${server.cwd}`);
  } else {
    lines.push(`URL:         ${server.url ?? "(none)"}`);
  }

  lines.push(`Env:         ${envPairs || "(none)"}`);
  if (server.timeoutSec) lines.push(`Timeout:     ${server.timeoutSec}s`);
  if (server.autoApprove?.length) lines.push(`AutoApprove: ${server.autoApprove.join(", ")}`);

  return lines;
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const clientRaw = takeOption(args, "--client");
  const scope = takeOption(args, "--scope");
  rejectArgs(args, USAGE);

  const query = new URLSearchParams();
  if (clientRaw) query.set("client", normalizeClientName(clientRaw));
  if (scope) query.set("scope", scope);

  const qs = query.toString();
  const path = `/api/mcp${qs ? `?${qs}` : ""}`;
  const result = await runtimeRequest<{ servers: UnifiedMcpServer[] }>(path, {}, deps);

  printData(result, wantsJson, formatServerTable(result.servers ?? []));
}

async function get(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift()?.trim();
  const clientRaw = takeOption(args, "--client");
  const scope = takeOption(args, "--scope");
  if (!id) throw new CliUsageError("Server ID is required", USAGE);
  if (!clientRaw) throw new CliUsageError("--client is required", USAGE);
  rejectArgs(args, USAGE);

  const client = normalizeClientName(clientRaw);
  const query = new URLSearchParams();
  if (scope) query.set("scope", scope);
  const qs = query.toString();

  const result = await runtimeRequest<{ client: string; servers: UnifiedMcpServer[] }>(`/api/mcp/${encodeURIComponent(client)}${qs ? `?${qs}` : ""}`, {}, deps);
  const server = (result.servers ?? []).find(s => s.id === id);

  if (!server) {
    throw new CliUsageError(`MCP server "${id}" not found for client "${client}"`);
  }

  printData({ server }, wantsJson, formatServerDetail(server));
}

async function add(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift()?.trim();
  const clientRaw = takeOption(args, "--client");
  const command = takeOption(args, "--command");
  const argsRaw = takeOption(args, "--args");
  const envRaw = takeOption(args, "--env");
  const cwd = takeOption(args, "--cwd");
  const url = takeOption(args, "--url");
  const scope = takeOption(args, "--scope");
  const timeoutSec = takeIntegerOption(args, "--timeout", { min: 1 });
  const overwrite = takeFlag(args, "--overwrite");
  rejectArgs(args, USAGE);

  if (!id) throw new CliUsageError("Server ID is required", USAGE);
  if (!clientRaw) throw new CliUsageError("--client is required", USAGE);
  if (!command && !url) throw new CliUsageError("Either --command (for stdio) or --url (for remote) is required", USAGE);

  const client = normalizeClientName(clientRaw);
  const parsedArgs = argsRaw ? argsRaw.split(",").map(a => a.trim()).filter(Boolean) : undefined;
  const parsedEnv = envRaw ? parseEnvString(envRaw) : undefined;
  const transport = url ? "sse" : "stdio";

  const body = {
    id,
    transport,
    command,
    args: parsedArgs,
    env: parsedEnv,
    cwd,
    url,
    scope: scope ?? "global",
    timeoutSec,
    overwrite,
  };

  const result = await runtimeRequest<{ ok: boolean; server: UnifiedMcpServer }>(`/api/mcp/${encodeURIComponent(client)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);

  const lines = [
    `Added MCP server "${id}" to client "${client}".`,
    `Transport: ${result.server.transport}`,
  ];
  printData(result, wantsJson, lines);
}

async function edit(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift()?.trim();
  const clientRaw = takeOption(args, "--client");
  const command = takeOption(args, "--command");
  const argsRaw = takeOption(args, "--args");
  const envRaw = takeOption(args, "--env");
  const cwd = takeOption(args, "--cwd");
  const url = takeOption(args, "--url");
  const scope = takeOption(args, "--scope");
  const timeoutSec = takeIntegerOption(args, "--timeout", { min: 1 });
  rejectArgs(args, USAGE);

  if (!id) throw new CliUsageError("Server ID is required", USAGE);
  if (!clientRaw) throw new CliUsageError("--client is required", USAGE);

  const client = normalizeClientName(clientRaw);
  const body: Record<string, unknown> = {};
  if (command !== undefined) body.command = command;
  if (argsRaw !== undefined) body.args = argsRaw.split(",").map(a => a.trim()).filter(Boolean);
  if (envRaw !== undefined) body.env = parseEnvString(envRaw);
  if (cwd !== undefined) body.cwd = cwd;
  if (url !== undefined) body.url = url;
  if (scope !== undefined) body.scope = scope;
  if (timeoutSec !== undefined) body.timeoutSec = timeoutSec;

  if (Object.keys(body).length === 0) {
    throw new CliUsageError("edit requires at least one parameter to update (--command, --args, --env, --cwd, --url, --timeout)", USAGE);
  }

  const result = await runtimeRequest<{ ok: boolean; server: UnifiedMcpServer }>(`/api/mcp/${encodeURIComponent(client)}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);

  printData(result, wantsJson, [`Updated MCP server "${id}" in client "${client}".`]);
}

async function toggle(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift()?.trim();
  const clientRaw = takeOption(args, "--client");
  const enable = takeFlag(args, "--enable");
  const disable = takeFlag(args, "--disable");
  const scope = takeOption(args, "--scope");
  rejectArgs(args, USAGE);

  if (!id) throw new CliUsageError("Server ID is required", USAGE);
  if (!clientRaw) throw new CliUsageError("--client is required", USAGE);
  if ((!enable && !disable) || (enable && disable)) {
    throw new CliUsageError("Specify either --enable or --disable", USAGE);
  }

  const client = normalizeClientName(clientRaw);
  const enabled = enable;

  const result = await runtimeRequest<{ ok: boolean; enabled: boolean }>(`/api/mcp/${encodeURIComponent(client)}/${encodeURIComponent(id)}/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled, scope }),
  }, deps);

  printData(result, wantsJson, [`MCP server "${id}" in "${client}" is now ${result.enabled ? "enabled" : "disabled"}.`]);
}

async function del(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift()?.trim();
  const clientRaw = takeOption(args, "--client");
  const yes = takeFlag(args, "--yes");
  const scope = takeOption(args, "--scope");
  rejectArgs(args, USAGE);

  if (!id) throw new CliUsageError("Server ID is required", USAGE);
  if (!clientRaw) throw new CliUsageError("--client is required", USAGE);
  if (!yes) throw new CliUsageError("delete requires --yes to confirm", USAGE);

  const client = normalizeClientName(clientRaw);
  const query = new URLSearchParams();
  if (scope) query.set("scope", scope);
  const qs = query.toString();

  const result = await runtimeRequest<{ ok: boolean; message: string }>(`/api/mcp/${encodeURIComponent(client)}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, {
    method: "DELETE",
  }, deps);

  printData(result, wantsJson, [result.message ?? `Deleted MCP server "${id}" from client "${client}".`]);
}

async function clone(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const serverId = args.shift()?.trim();
  const fromRaw = takeOption(args, "--from");
  const toRaw = takeOption(args, "--to");
  const newId = takeOption(args, "--new-id");
  const overwrite = takeFlag(args, "--overwrite");
  const scope = takeOption(args, "--scope");
  rejectArgs(args, USAGE);

  if (!serverId) throw new CliUsageError("Server ID is required", USAGE);
  if (!fromRaw) throw new CliUsageError("--from <client> is required", USAGE);
  if (!toRaw) throw new CliUsageError("--to <client> is required", USAGE);

  const fromClient = normalizeClientName(fromRaw);
  const toClient = normalizeClientName(toRaw);

  const body = {
    serverId,
    fromClient,
    toClient,
    newId,
    overwrite,
    scope,
  };

  const result = await runtimeRequest<{ ok: boolean; created: UnifiedMcpServer }>("/api/mcp/clone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);

  const lines = [
    `Cloned MCP server "${serverId}" from "${fromClient}" to "${toClient}" as "${result.created.id}".`,
    `Transport: ${result.created.transport}`,
  ];
  printData(result, wantsJson, lines);
}

export async function handleMcpCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
  const sub = hasSub ? argv[0]! : "list";
  const rest = hasSub ? argv.slice(1) : argv;

  return runCliAction(async () => {
    if (sub === "list") await list(rest, deps);
    else if (sub === "get" || sub === "show" || sub === "view") await get(rest, deps);
    else if (sub === "add" || sub === "create") await add(rest, deps);
    else if (sub === "edit" || sub === "update" || sub === "set") await edit(rest, deps);
    else if (sub === "toggle") await toggle(rest, deps);
    else if (sub === "delete" || sub === "remove" || sub === "rm") await del(rest, deps);
    else if (sub === "clone" || sub === "copy" || sub === "share") await clone(rest, deps);
    else throw new CliUsageError(`unknown mcp subcommand: "${sub}"`, USAGE);
  });
}

export const MCP_USAGE = USAGE;
