/**
 * Pi effective-status probe — wraps readPiModelsStatus + curated settings.
 * Never reads auth.json.
 */
import { readPiModelsStatus } from "../../pi/models";
import { readPiSettings } from "../../pi/settings";
import { piAgentDirExists, piModelsPath, piSettingsPath, resolvePiAgentDir } from "../../pi/home";
import { resolvePiBinary } from "../../pi/packages";

export interface PiProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
  binary: string | null;
}

export function probePi(opts: { home?: string; piHome?: string } = {}): PiProbeResult {
  // When a test home is supplied without piHome, treat home as the Pi root parent
  // so fixtures can use `<tmp>/.pi/...` layout.
  const piHome = opts.piHome ?? (opts.home ? `${opts.home}/.pi` : undefined);
  const notes: string[] = [];
  const models = readPiModelsStatus(piHome !== undefined ? { piHome } : {});
  const settings = readPiSettings(piHome !== undefined ? { piHome } : {});
  let binary: string | null = null;
  try {
    binary = resolvePiBinary();
  } catch {
    binary = null;
  }

  const agentDir = resolvePiAgentDir(piHome);
  const present = models.present || piAgentDirExists(piHome) || settings.present;
  const configPaths = [piModelsPath(piHome), piSettingsPath(piHome)];
  if (piAgentDirExists(piHome)) configPaths.unshift(agentDir);

  const model = settings.settings.defaultModel
    ?? (models.models[0]?.id ?? null);
  if (settings.settings.defaultProvider && settings.settings.defaultProvider !== "opencodex") {
    notes.push(`defaultProvider is "${settings.settings.defaultProvider}" (not opencodex).`);
  }
  if (!models.present && present) {
    notes.push("providers.opencodex block not present in models.json.");
  }

  return {
    present,
    baseUrl: models.baseUrl,
    model,
    configPaths: [...new Set(configPaths)],
    notes,
    binary,
  };
}
