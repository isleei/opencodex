/**
 * Grok Build fence probe — wraps readGrokStatus (managed block only).
 */
import { readGrokStatus } from "../../grok/status";

export interface GrokProbeResult {
  present: boolean;
  baseUrl: string | null;
  model: string | null;
  configPaths: string[];
  notes: string[];
}

export function probeGrok(opts: { home?: string; grokHome?: string } = {}): GrokProbeResult {
  const grokHome = opts.grokHome ?? (opts.home ? `${opts.home}/.grok` : undefined);
  const status = readGrokStatus(grokHome !== undefined ? { grokHome } : {});
  const notes: string[] = [];
  if (!status.present) {
    notes.push("No opencodex managed block in config.toml.");
  }
  const model = status.models[0]?.id ?? status.models[0]?.alias ?? null;
  return {
    present: status.present,
    baseUrl: status.baseUrl,
    model,
    configPaths: [status.configPath],
    notes: status.present ? [] : notes,
  };
}
