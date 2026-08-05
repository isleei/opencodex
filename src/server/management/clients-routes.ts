/**
 * Clients effective-status management route.
 *
 * GET /api/clients/status — read-only snapshot of each coding agent's on-disk
 * routing (base URL / model / verdict). Never serializes secrets.
 */
import { readRuntimePort } from "../../config";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export async function handleClientsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/clients/status" && req.method === "GET") {
    try {
      const { readClientsEffectiveStatus } = await import("../../clients/effective-status");
      const { findLiveProxy } = await import("../proxy-liveness");

      // Prefer live bind metadata so the page compares client base URLs against the
      // port the proxy actually answered on, not just config.port.
      let livePort: number | undefined;
      let liveHostname: string | undefined;
      let running = false;
      try {
        const live = await findLiveProxy();
        if (live) {
          running = true;
          livePort = live.port;
          liveHostname = live.hostname;
        }
      } catch {
        // Fall back to runtime-port file / config.
      }
      if (!running) {
        try {
          const runtime = readRuntimePort(process.pid);
          if (runtime?.port) {
            // Runtime file exists for this process → we are the proxy answering this request.
            running = true;
            livePort = runtime.port;
            liveHostname = runtime.hostname;
          }
        } catch { /* ignore */ }
      }
      // Management API is served by the proxy itself, so if we got here the process is up.
      // Still report running=true even when findLiveProxy races during startup.
      if (!running) running = true;
      if (livePort === undefined) livePort = config.port;
      if (liveHostname === undefined) liveHostname = config.hostname;

      const snapshot = await readClientsEffectiveStatus(config, {
        running,
        livePort,
        liveHostname,
      });
      return jsonResponse(snapshot);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  return null;
}
