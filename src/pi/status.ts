/**
 * Aggregate Pi integration status for CLI + management API + GUI.
 * Never reads auth.json body (credentials).
 */
import { existsSync } from "node:fs";
import {
  piAgentDirExists,
  piModelsPath,
  piSettingsPath,
  resolvePiAgentDir,
  resolvePiRoot,
} from "./home";
import { readPiModelsStatus, type PiModelsStatus } from "./models";
import { readPiSettings, type PiSettingsStatus } from "./settings";
import {
  listPiPackagesDetailed,
  readPiPackages,
  resolvePiBinary,
  type PiPackagesStatus,
} from "./packages";
import { readPiExtensions, type PiExtensionsStatus } from "./extensions";

export interface PiStatus {
  piRoot: string;
  agentDir: string;
  agentDirPresent: boolean;
  piBinary: string | null;
  modelsPath: string;
  settingsPath: string;
  models: PiModelsStatus;
  settings: PiSettingsStatus;
  packages: PiPackagesStatus;
  extensions: PiExtensionsStatus;
}

export async function readPiStatus(opts: { piHome?: string; includePackageList?: boolean } = {}): Promise<PiStatus> {
  const packages: PiPackagesStatus = opts.includePackageList === false
    ? readPiPackages(opts)
    : await listPiPackagesDetailed(opts);

  return {
    piRoot: resolvePiRoot(opts.piHome),
    agentDir: resolvePiAgentDir(opts.piHome),
    agentDirPresent: piAgentDirExists(opts.piHome),
    piBinary: resolvePiBinary(),
    modelsPath: piModelsPath(opts.piHome),
    settingsPath: piSettingsPath(opts.piHome),
    models: readPiModelsStatus(opts),
    settings: readPiSettings(opts),
    packages,
    extensions: readPiExtensions(opts),
  };
}

/** Cheap existence probe for status lines that should not shell out. */
export function piInstallHint(status: Pick<PiStatus, "agentDirPresent" | "piBinary">): string | null {
  if (status.piBinary && status.agentDirPresent) return null;
  if (!status.piBinary && !status.agentDirPresent) {
    return "Pi is not installed (binary missing and ~/.pi/agent absent). Install: npm i -g @earendil-works/pi-coding-agent";
  }
  if (!status.piBinary) return "pi binary not on PATH; package install/remove will be unavailable.";
  if (!status.agentDirPresent) return "Pi agent dir missing; run `pi` once to create ~/.pi/agent.";
  return null;
}

export function modelsFileExists(opts: { piHome?: string } = {}): boolean {
  return existsSync(piModelsPath(opts.piHome));
}
