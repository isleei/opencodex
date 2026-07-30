/** Local cloud-sync settings (stored in ~/.opencodex/cloud-sync.json). */

/** Microsoft identity platform tenant path segment for OAuth. */
export type MsAuthority = "common" | "consumers" | "organizations";

export interface CloudSyncSettings {
  provider: "onedrive";
  /** Azure AD / Entra application (public client) ID. */
  clientId?: string;
  /**
   * Optional client secret — only if the Azure app is a confidential (Web) client.
   * Prefer public client: Authentication → Allow public client flows = Yes (no secret).
   */
  clientSecret?: string;
  /**
   * login.microsoftonline.com/{msAuthority}/…
   * Personal-MSA-only apps must use "consumers" (not "common").
   */
  msAuthority?: MsAuthority;
  /**
   * Fixed loopback port for browser OAuth (default 18765).
   * Azure redirect URI must be exactly: http://localhost:{port}
   */
  loopbackPort?: number;
  /** Last successful push/pull ISO timestamp. */
  lastSyncAt?: string;
  lastSyncDirection?: "push" | "pull";
  lastDeviceId?: string;
  /** Include usage.jsonl on push/pull. Default false (can grow large). */
  includeUsage?: boolean;
  /** Include encrypted vault (auth + codex-accounts). Requires passphrase. Default true when pushing with --passphrase. */
  includeVault?: boolean;
}

export interface OneDriveTokenStore {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  account?: string;
  clientId: string;
  /** Authority used when this token was issued (must match refresh). */
  authority?: MsAuthority;
}

export interface CloudSyncManifest {
  version: 1;
  updatedAt: string;
  deviceId: string;
  deviceName: string;
  /** Relative paths present in the remote folder. */
  files: string[];
  /** true if vault.enc is present and encrypted. */
  hasVault: boolean;
  includeUsage: boolean;
}
