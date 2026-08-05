/**
 * `ocx pi [args...]` — launch Pi wired to the local proxy, and
 * `ocx pi <status|apply|remove|settings|packages>` management subcommands.
 *
 * Launch path: ensure proxy is up, apply models.json providers.opencodex when
 * possible, then exec `pi` with OPENCODEX_API_KEY in the environment (if an
 * admission key is configured). Management subcommands talk to the live proxy API.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { PI_API_KEY_ENV } from "../clients/config-export";
import { resolvePiBinary } from "../pi/packages";
import { commandInvocation } from "../lib/win-exec";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../lib/service-secrets";
import { findLiveProxy } from "../server/proxy-liveness";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const PI_USAGE = `Usage:
  ocx pi [pi args...]                 Launch Pi (applies models.json first)
  ocx pi status [--json]              Show Pi integration status
  ocx pi apply [--json]               Write providers.opencodex into models.json
  ocx pi remove [--json]              Remove providers.opencodex only
  ocx pi settings [show] [--json]     Show curated settings
  ocx pi settings set --key value...  Patch curated settings
  ocx pi packages [list] [--json]     List installed packages
  ocx pi packages install <source>    Install a package (runs \`pi install\`)
  ocx pi packages remove <source>     Remove a package (runs \`pi remove\`)`;

const MANAGEMENT = new Set(["status", "apply", "remove", "settings", "packages"]);

export async function handlePiCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const head = (argv[0] ?? "").toLowerCase();
  if (MANAGEMENT.has(head) || head === "show") {
    return handlePiManagement(argv, deps);
  }
  return cmdPi(argv);
}

async function handlePiManagement(argv: string[], deps: RuntimeApiDeps): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const action = (args.shift() ?? "status").toLowerCase();
    const wantsJson = takeFlag(args, "--json");

    if (action === "status" || action === "show") {
      rejectArgs(args, PI_USAGE);
      const result = await runtimeRequest("/api/pi", {}, deps);
      printData(result, wantsJson, summaryLines(result));
      return;
    }
    if (action === "apply") {
      rejectArgs(args, PI_USAGE);
      const result = await runtimeRequest("/api/pi/apply", { method: "POST" }, deps);
      printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? "Pi models applied.")]);
      return;
    }
    if (action === "remove") {
      rejectArgs(args, PI_USAGE);
      const result = await runtimeRequest("/api/pi/remove", { method: "POST" }, deps);
      printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? "Pi models removed.")]);
      return;
    }
    if (action === "settings") {
      const sub = (args.shift() ?? "show").toLowerCase();
      if (sub === "show" || sub === "status") {
        rejectArgs(args, PI_USAGE);
        const result = await runtimeRequest("/api/pi/settings", {}, deps);
        printData(result, wantsJson, summaryLines(result));
        return;
      }
      if (sub !== "set") throw new CliUsageError(`unknown Pi settings command ${sub}`, PI_USAGE);
      const body: Record<string, unknown> = {};
      const defaultProvider = takeOption(args, "--default-provider");
      const defaultModel = takeOption(args, "--default-model");
      const thinking = takeOption(args, "--thinking");
      const theme = takeOption(args, "--theme");
      const trust = takeOption(args, "--project-trust");
      const quiet = takeFlag(args, "--quiet-startup") ? true : takeFlag(args, "--no-quiet-startup") ? false : undefined;
      const hideThinking = takeFlag(args, "--hide-thinking") ? true : takeFlag(args, "--show-thinking") ? false : undefined;
      rejectArgs(args, PI_USAGE);
      if (defaultProvider !== undefined) body.defaultProvider = defaultProvider === "-" ? null : defaultProvider;
      if (defaultModel !== undefined) body.defaultModel = defaultModel === "-" ? null : defaultModel;
      if (thinking !== undefined) body.defaultThinkingLevel = thinking === "-" ? null : thinking;
      if (theme !== undefined) body.theme = theme === "-" ? null : theme;
      if (trust !== undefined) body.defaultProjectTrust = trust === "-" ? null : trust;
      if (quiet !== undefined) body.quietStartup = quiet;
      if (hideThinking !== undefined) body.hideThinkingBlock = hideThinking;
      if (Object.keys(body).length === 0) {
        throw new CliUsageError("at least one settings flag is required", PI_USAGE);
      }
      const result = await runtimeRequest("/api/pi/settings", { method: "PUT", body: JSON.stringify(body) }, deps);
      printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? "Pi settings updated.")]);
      return;
    }
    if (action === "packages") {
      const sub = (args.shift() ?? "list").toLowerCase();
      if (sub === "list" || sub === "status") {
        rejectArgs(args, PI_USAGE);
        const result = await runtimeRequest("/api/pi/packages", {}, deps);
        printData(result, wantsJson, summaryLines(result));
        return;
      }
      if (sub === "install" || sub === "remove") {
        const source = args.shift();
        if (!source) throw new CliUsageError("package source is required", PI_USAGE);
        rejectArgs(args, PI_USAGE);
        const result = await runtimeRequest(`/api/pi/packages/${sub}`, {
          method: "POST",
          body: JSON.stringify({ source }),
        }, deps);
        printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? `pi ${sub} done`)]);
        return;
      }
      throw new CliUsageError(`unknown Pi packages command ${sub}`, PI_USAGE);
    }
    throw new CliUsageError(`unknown Pi command ${action}`, PI_USAGE);
  });
}

/**
 * Launch path. When the first arg is a management verb it is handled above; everything
 * else is forwarded to the real `pi` binary after a best-effort apply.
 */
export async function cmdPi(argv: string[]): Promise<number> {
  const binary = resolvePiBinary();
  if (!binary) {
    console.error("pi not found on PATH. Install: npm i -g @earendil-works/pi-coding-agent");
    return 1;
  }

  // Best-effort: ensure proxy is discoverable and models are wired.
  try {
    const live = await findLiveProxy();
    if (live) {
      const config = loadConfig();
      const { syncPiConfig } = await import("../pi/sync");
      const result = await syncPiConfig(live.port, config, { hostname: live.hostname });
      if (result.changed) console.error(result.message);
      else if (!result.ok) console.error(result.message);
    } else {
      console.error("No running opencodex proxy found. Start with `ocx start` for routed models.");
    }
  } catch (error) {
    console.error(`Pi models apply skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const config = loadConfig();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Admission key for the proxy env reference in models.json (`$OPENCODEX_API_KEY`).
  if (!env[PI_API_KEY_ENV]?.trim()) {
    const authToken = env.OPENCODEX_API_AUTH_TOKEN?.trim();
    if (authToken) env[PI_API_KEY_ENV] = authToken;
    else {
      const tokenEnv = env.OCX_API_TOKEN_FILE?.trim()
        ? env
        : { ...env, OCX_API_TOKEN_FILE: serviceApiTokenFilePath() };
      const serviceToken = loadServiceTokenFromFile(tokenEnv);
      env[PI_API_KEY_ENV] = serviceToken || config.apiKeys?.[0]?.key || "ocx";
    }
  }

  const inv = commandInvocation(binary, argv);
  return await new Promise<number>(resolve => {
    const child = spawn(inv.file, inv.args, {
      stdio: "inherit",
      env,
      windowsHide: true,
      ...inv.options,
    });
    child.on("error", error => {
      console.error(error.message);
      resolve(1);
    });
    child.on("close", code => resolve(code ?? 1));
  });
}

export const PI_CLI_USAGE = PI_USAGE;
