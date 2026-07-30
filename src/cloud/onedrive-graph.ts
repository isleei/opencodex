/**
 * Minimal Microsoft Graph OneDrive helpers (upload / download / ensure folder).
 * Remote root: /OpenCodex/sync/ under the user's OneDrive.
 */
import { getValidOneDriveAccessToken } from "./onedrive-auth";

const GRAPH = "https://graph.microsoft.com/v1.0";
const REMOTE_ROOT = "OpenCodex/sync";

function encodePath(relativePath: string): string {
  // Graph path encoding: each segment URI-encoded, colon syntax for path
  return relativePath
    .split("/")
    .filter(Boolean)
    .map(seg => encodeURIComponent(seg))
    .join("/");
}

async function authHeaders(): Promise<Headers> {
  const { token } = await getValidOneDriveAccessToken();
  return new Headers({ Authorization: `Bearer ${token}` });
}

/** Ensure OpenCodex/sync folder exists (idempotent). */
export async function ensureSyncFolder(): Promise<void> {
  const headers = await authHeaders();
  // Create OpenCodex then sync via children path
  for (const folder of ["OpenCodex", "OpenCodex/sync"]) {
    const parent = folder.includes("/") ? folder.split("/").slice(0, -1).join("/") : "";
    const name = folder.split("/").pop()!;
    const parentUrl = parent
      ? `${GRAPH}/me/drive/root:/${encodePath(parent)}:/children`
      : `${GRAPH}/me/drive/root/children`;
    const res = await fetch(parentUrl, {
      method: "POST",
      headers: {
        Authorization: headers.get("Authorization")!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 409 || res.ok) continue;
    // 409 conflict = already exists for some tenants; also accept nameAlreadyExists
    const body = await res.text();
    if (res.status === 409 || body.includes("nameAlreadyExists")) continue;
    // If fail conflict, try again with replace noop by GETting
    const check = await fetch(`${GRAPH}/me/drive/root:/${encodePath(folder)}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (check.ok) continue;
    throw new Error(`failed to ensure OneDrive folder ${folder}: ${res.status} ${body.slice(0, 300)}`);
  }
}

export async function uploadTextFile(relativePath: string, content: string | Buffer, contentType = "application/json"): Promise<void> {
  await ensureSyncFolder();
  const headers = await authHeaders();
  const path = `${REMOTE_ROOT}/${relativePath}`.replace(/\/+/g, "/");
  const url = `${GRAPH}/me/drive/root:/${encodePath(path)}:/content`;
  const body = typeof content === "string" ? content : new Uint8Array(content);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: headers.get("Authorization")!,
      "Content-Type": contentType,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OneDrive upload failed for ${relativePath}: ${res.status} ${text.slice(0, 400)}`);
  }
}

export async function downloadFile(relativePath: string): Promise<Buffer | null> {
  const headers = await authHeaders();
  const path = `${REMOTE_ROOT}/${relativePath}`.replace(/\/+/g, "/");
  const url = `${GRAPH}/me/drive/root:/${encodePath(path)}:/content`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OneDrive download failed for ${relativePath}: ${res.status} ${text.slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function remoteFileExists(relativePath: string): Promise<boolean> {
  const headers = await authHeaders();
  const path = `${REMOTE_ROOT}/${relativePath}`.replace(/\/+/g, "/");
  const url = `${GRAPH}/me/drive/root:/${encodePath(path)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  return res.ok;
}

export function remoteSyncRootDescription(): string {
  return `OneDrive:/${REMOTE_ROOT}/`;
}
