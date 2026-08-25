/**
 * Read-only snapshot of each coding client's *effective* on-disk config.
 *
 * Answers "what base URL / model is this agent actually pointed at right now?"
 * without serializing secrets. Writers (inject, CC Switch, export) live elsewhere;
 * this module only reads paths that already exist on the host.
 *
 * Per-client probe failures never fail the whole response — one broken settings
 * file must not blank the Clients page.
 */
import { homedir } from "node:os";
import type { OcxConfig } from "../types";
import { providerBaseHost } from "../codex/inject";
import { probeHostname } from "../server/proxy-liveness";
import { probeClaude } from "./probes/claude";
import { probeCodex } from "./probes/codex";
import { probePi } from "./probes/pi";
import { probeGrok } from "./probes/grok";
import { probeOpencode } from "./probes/opencode";
import { probeAgy } from "./probes/agy";
import { probeCline } from "./probes/cline";
import { readCcSwitchCurrentProfiles, type CcSwitchProfile } from "./probes/cc-switch";
import { readPaseoProviderCommands, type PaseoProviderCommand } from "./probes/paseo";

export type ClientId = "claude" | "codex" | "pi" | "grok" | "opencode" | "agy" | "cline";

export type ClientVerdict = "ocx" | "direct" | "mixed" | "missing" | "unknown";

export interface ClientSwitcherInfo {
  name: string | null;
  appType: string;
}

export interface ClientEffectiveStatus {
  id: ClientId;
  label: string;
  present: boolean;
  viaOcx: boolean | null;
  verdict: ClientVerdict;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  launcher: string | null;
  switcher: ClientSwitcherInfo | null;
  notes: string[];
}

export interface ClientsEffectiveStatusResponse {
  generatedAt: number;
  proxy: {
    baseUrl: string;
    running: boolean;
    port: number;
    hostname: string;
  };
  clients: ClientEffectiveStatus[];
}

export interface EffectiveStatusOpts {
  home?: string;
  /** Override live proxy detection (tests). */
  running?: boolean;
  /** Override live bind port when runtime differs from config.port. */
  livePort?: number;
  liveHostname?: string;
  /** Inject probe I/O for unit tests. */
  probes?: {
    claude?: typeof probeClaude;
    codex?: typeof probeCodex;
    pi?: typeof probePi;
    grok?: typeof probeGrok;
    opencode?: typeof probeOpencode;
    agy?: typeof probeAgy;
    cline?: typeof probeCline;
    ccSwitch?: typeof readCcSwitchCurrentProfiles;
    paseo?: typeof readPaseoProviderCommands;
  };
}

const CLIENT_LABELS: Record<ClientId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  grok: "Grok Build",
  opencode: "OpenCode",
  agy: "Antigravity (agy)",
  cline: "Cline",
};

/** Map client id → CC Switch `app_type` column (when present). */
const CC_SWITCH_APP: Partial<Record<ClientId, string>> = {
  claude: "claude",
  codex: "codex",
  grok: "grokbuild",
  opencode: "opencode",
  cline: "cline",
};

/** Map client id → Paseo `agents.providers` key. */
const PASEO_PROVIDER: Partial<Record<ClientId, string>> = {
  pi: "pi",
  grok: "grok",
  agy: "antigravity-acp",
  claude: "claude",
  codex: "codex",
  cline: "cline",
};

export interface ProxyTarget {
  port: number;
  hostname: string;
  /** OpenAI-compatible surface: `http://host:port/v1`. */
  openAiBaseUrl: string;
  /** Claude Code surface: `http://host:port` (no /v1). */
  claudeBaseUrl: string;
}

export function buildProxyTarget(
  config: Pick<OcxConfig, "port" | "hostname">,
  live?: { port?: number; hostname?: string },
): ProxyTarget {
  const port = live?.port ?? config.port ?? 10100;
  const hostname = providerBaseHost(live?.hostname ?? config.hostname);
  const host = probeHostname(hostname);
  return {
    port,
    hostname: host,
    openAiBaseUrl: `http://${host}:${port}/v1`,
    claudeBaseUrl: `http://${host}:${port}`,
  };
}

/**
 * Does `candidate` point at this proxy?
 *
 * Compares host + port only. Path differences (`/v1` vs bare) are ignored so
 * Claude's bare base and Codex's `/v1` both count as via-ocx when the port matches.
 */
export function urlPointsAtProxy(candidate: string | null | undefined, proxy: ProxyTarget): boolean {
  if (!candidate) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
  const hostOk = host === proxyHost
    || (loopback.has(host) && loopback.has(proxyHost));
  if (!hostOk) return false;
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  return port === proxy.port;
}

export function verdictFromBaseUrl(
  baseUrl: string | null,
  proxy: ProxyTarget,
  extras?: { present?: boolean; mixed?: boolean },
): { verdict: ClientVerdict; viaOcx: boolean | null } {
  if (extras?.present === false && !baseUrl) {
    return { verdict: "missing", viaOcx: null };
  }
  if (extras?.mixed) {
    return { verdict: "mixed", viaOcx: baseUrl ? urlPointsAtProxy(baseUrl, proxy) : null };
  }
  if (!baseUrl) {
    return {
      verdict: extras?.present === false ? "missing" : "unknown",
      viaOcx: null,
    };
  }
  if (urlPointsAtProxy(baseUrl, proxy)) {
    return { verdict: "ocx", viaOcx: true };
  }
  return { verdict: "direct", viaOcx: false };
}

function switcherFor(
  id: ClientId,
  profiles: CcSwitchProfile[],
): ClientSwitcherInfo | null {
  const appType = CC_SWITCH_APP[id];
  if (!appType) return null;
  const hit = profiles.find(p => p.appType === appType);
  if (!hit) return null;
  return { name: hit.name, appType: hit.appType };
}

function paseoLauncher(
  id: ClientId,
  commands: PaseoProviderCommand[],
): string | null {
  const key = PASEO_PROVIDER[id];
  if (!key) return null;
  const hit = commands.find(c => c.provider === key);
  if (!hit?.command?.length) return null;
  return `paseo: ${hit.command.join(" ")}`;
}

async function safeProbeAsync<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    void label;
    return fallback;
  }
}

export async function readClientsEffectiveStatus(
  config: Pick<OcxConfig, "port" | "hostname">,
  opts: EffectiveStatusOpts = {},
): Promise<ClientsEffectiveStatusResponse> {
  const home = opts.home ?? homedir();
  const proxy = buildProxyTarget(config, {
    port: opts.livePort,
    hostname: opts.liveHostname,
  });
  const running = opts.running ?? false;

  const claudeFn = opts.probes?.claude ?? probeClaude;
  const codexFn = opts.probes?.codex ?? probeCodex;
  const piFn = opts.probes?.pi ?? probePi;
  const grokFn = opts.probes?.grok ?? probeGrok;
  const opencodeFn = opts.probes?.opencode ?? probeOpencode;
  const agyFn = opts.probes?.agy ?? probeAgy;
  const clineFn = opts.probes?.cline ?? probeCline;
  const ccSwitchFn = opts.probes?.ccSwitch ?? readCcSwitchCurrentProfiles;
  const paseoFn = opts.probes?.paseo ?? readPaseoProviderCommands;

  const emptyProfiles: CcSwitchProfile[] = [];
  const emptyPaseo: PaseoProviderCommand[] = [];

  const [ccProfiles, paseoCommands, claude, codex, pi, grok, opencode, agy, cline] = await Promise.all([
    safeProbeAsync("cc-switch", () => Promise.resolve(ccSwitchFn({ home })), emptyProfiles),
    safeProbeAsync("paseo", () => Promise.resolve(paseoFn({ home })), emptyPaseo),
    safeProbeAsync("claude", () => Promise.resolve(claudeFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"],
    }),
    safeProbeAsync("codex", () => Promise.resolve(codexFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"], mixed: false, injected: false,
    }),
    safeProbeAsync("pi", () => Promise.resolve(piFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"], binary: null,
    }),
    safeProbeAsync("grok", () => Promise.resolve(grokFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"],
    }),
    safeProbeAsync("opencode", () => Promise.resolve(opencodeFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"],
    }),
    safeProbeAsync("agy", () => Promise.resolve(agyFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"], binary: null,
    }),
    safeProbeAsync("cline", () => Promise.resolve(clineFn({ home })), {
      present: false, baseUrl: null, model: null, configPaths: [] as string[], notes: ["probe failed"], binary: null,
    }),
  ]);

  const clients: ClientEffectiveStatus[] = [];

  // Claude
  {
    const raw = claude;
    const { verdict, viaOcx } = verdictFromBaseUrl(raw.baseUrl, proxy, { present: raw.present });
    clients.push({
      id: "claude",
      label: CLIENT_LABELS.claude,
      present: raw.present,
      viaOcx,
      verdict: raw.present ? verdict : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: paseoLauncher("claude", paseoCommands) ?? (raw.present ? "claude" : null),
      switcher: switcherFor("claude", ccProfiles),
      notes: raw.notes,
    });
  }

  // Codex
  {
    const raw = codex;
    const { verdict, viaOcx } = verdictFromBaseUrl(raw.baseUrl, proxy, {
      present: raw.present,
      mixed: raw.mixed,
    });
    const notes = [...raw.notes];
    if (raw.mixed && !notes.some(n => n.includes("model_providers"))) {
      notes.push("Root openai_base_url points at ocx, but other model_providers remain on disk.");
    }
    clients.push({
      id: "codex",
      label: CLIENT_LABELS.codex,
      present: raw.present,
      viaOcx,
      verdict: raw.present ? verdict : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: paseoLauncher("codex", paseoCommands) ?? (raw.present ? "codex" : null),
      switcher: switcherFor("codex", ccProfiles),
      notes,
    });
  }

  // Pi
  {
    const raw = pi;
    const { verdict, viaOcx } = verdictFromBaseUrl(raw.baseUrl, proxy, { present: raw.present });
    clients.push({
      id: "pi",
      label: CLIENT_LABELS.pi,
      present: raw.present || Boolean(raw.binary),
      viaOcx,
      verdict: raw.present || raw.binary ? (raw.baseUrl ? verdict : (raw.present ? "unknown" : "missing")) : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: paseoLauncher("pi", paseoCommands) ?? (raw.binary ? "pi" : null),
      switcher: null,
      notes: raw.notes,
    });
  }

  // Grok
  {
    const raw = grok;
    const { verdict, viaOcx } = verdictFromBaseUrl(raw.baseUrl, proxy, { present: raw.present });
    clients.push({
      id: "grok",
      label: CLIENT_LABELS.grok,
      present: raw.present,
      viaOcx,
      verdict: raw.present ? verdict : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: paseoLauncher("grok", paseoCommands) ?? (raw.present ? "grok" : null),
      switcher: switcherFor("grok", ccProfiles),
      notes: raw.notes,
    });
  }

  // OpenCode
  {
    const raw = opencode;
    const { verdict, viaOcx } = verdictFromBaseUrl(raw.baseUrl, proxy, { present: raw.present });
    clients.push({
      id: "opencode",
      label: CLIENT_LABELS.opencode,
      present: raw.present,
      viaOcx,
      verdict: raw.present ? verdict : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: raw.present ? "opencode" : null,
      switcher: switcherFor("opencode", ccProfiles),
      notes: raw.notes,
    });
  }

  // Agy / Antigravity
  {
    const raw = agy;
    const present = raw.present || Boolean(raw.binary);
    clients.push({
      id: "agy",
      label: CLIENT_LABELS.agy,
      present,
      viaOcx: null,
      verdict: present ? (raw.baseUrl ? verdictFromBaseUrl(raw.baseUrl, proxy).verdict : "unknown") : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: paseoLauncher("agy", paseoCommands) ?? (raw.binary ? raw.binary : null),
      switcher: null,
      notes: raw.notes,
    });
  }

  // Cline
  {
    const raw = cline;
    const { verdict, viaOcx } = verdictFromBaseUrl(raw.baseUrl, proxy, { present: raw.present });
    clients.push({
      id: "cline",
      label: CLIENT_LABELS.cline,
      present: raw.present,
      viaOcx,
      verdict: raw.present ? (raw.baseUrl ? verdict : "unknown") : "missing",
      baseUrl: raw.baseUrl,
      model: raw.model,
      configPaths: raw.configPaths,
      launcher: paseoLauncher("cline", paseoCommands) ?? (raw.binary ? "cline" : null),
      switcher: switcherFor("cline", ccProfiles),
      notes: raw.notes,
    });
  }

  return {
    generatedAt: Date.now(),
    proxy: {
      baseUrl: proxy.openAiBaseUrl,
      running,
      port: proxy.port,
      hostname: proxy.hostname,
    },
    clients,
  };
}
