---
title: AGY Accounts
description: Switch the active Google Antigravity account and sync it to the local CLI and IDE.
---

Switching the Google Antigravity (AGY) account in the OpenCodex dashboard changes the proxy's
active account and synchronizes the proxy host's local credentials. Open
**Subscriptions → Antigravity** and use **Set as Active** on a logged-in account.

## What one switch does

`PUT /api/oauth/accounts/active` with `{"provider": "google-antigravity", "accountId": "<id>"}`
(default targets `["cli", "ide"]`):

1. Validates the account, then sets the proxy active account.
2. Writes the account's OAuth credentials to the proxy host's native `agy`
   keychain entry (`gemini` / `antigravity`, owner-only) **and** the legacy CLI files
   (`~/.gemini/oauth_creds.json` + `~/.gemini/google_accounts.json`, owner-only),
   verifying both by read-back. On macOS the keychain write is mandatory: a
   file-only result is reported as failure, never as synced.
3. Writes the account's token into the Antigravity IDE store on the proxy host
   (`Antigravity IDE` product `state.vscdb`, `antigravityUnifiedStateSync.oauthToken`)
   inside a single transaction that updates only that row, preserving all unrelated rows and the
   sibling auth state, then verifies by decoding the stored token. A WAL-aware snapshot is kept
   for manual disaster recovery only — a failed transaction rolls back and the adapter never
   copies a backup back over the live database (that would discard committed history).
   A successful disk write reports `pending_restart`, not `synced`: the write is persisted,
   but runtime activation is unconfirmed until the IDE restarts and the account is verified
   (see below).

The response carries per-target states — HTTP 200 alone is **not** success:

```json
{
  "ok": false,
  "provider": "google-antigravity",
  "activeAccountId": "<id>",
  "code": "AGY_SWITCH_IDE_ATTENTION",
  "message": "Proxy account switched and CLI credentials verified, but IDE needs attention …",
  "cli": { "target": "cli", "status": "synced", "code": "AGY_CLI_SYNCED", "retryable": false },
  "ide": { "target": "ide", "status": "pending_restart", "code": "AGY_IDE_PENDING_RESTART", "retryable": true }
}
```

`ok` is true only when every requested target reports `synced` (a requested IDE that is
`not_installed` on the proxy host counts as satisfied-with-note). Any partial failure reports the
real active account and a stable `code` per target, plus whether a retry can help.

Target statuses: `synced`, `pending_restart`, `failed`, `unsupported`, `not_installed`, `unknown`.

## Repeating a switch retries the sync

Sending the same `accountId` again re-runs the sync for the requested targets, so a previously
failed target can be retried without changing accounts — including the account that is already
active. `GET /api/oauth/accounts?provider=google-antigravity` returns a desensitized `agySync`
snapshot (booleans and status codes only, no tokens) so a page refresh shows the true CLI/IDE
state instead of assuming it from the proxy account.

## Supported environment

- **macOS proxy host** is the verified target. Unverified platforms report `unsupported`
  for the keychain/IDE writes; they are never reported as synced.
- Sync always applies to the **machine running the proxy**, not necessarily the browser's machine.
- CLI changes take effect for `agy` processes **started after** the switch. A running CLI is
  never hot-switched.
- The IDE picks the new token up on its next normal start; if it is already open,
  **quit it normally and reopen it** (unsaved work is never force-closed). While it is
  running, IDE sync reports `pending_restart` and leaves the store untouched.
- A disk write alone is **not** activation: after restarting, confirm the account in the
  IDE's own account UI. Until that confirmation, the IDE target stays `pending_restart`;
  only a verified activation reports `synced` (`AGY_IDE_ACTIVATED`).
- An IDE store whose token carries enterprise/business login flags
  (`is_gcp_tos` / `enable_business_login`) is left untouched and reported as
  `unsupported` (`AGY_IDE_ENTERPRISE_UNSUPPORTED`) — switch those accounts inside the
  IDE itself. Previous-account mode flags are never carried into the new token.
- Account switching applies to consumer-OAuth mode only. A CLI configured for API-key
  mode (`modelProvider: "gemini"` in `antigravity-cli/settings.json` with `GEMINI_API_KEY`)
  or ADC (`GOOGLE_APPLICATION_CREDENTIALS`) reports `unsupported`
  (`AGY_CLI_AUTH_MODE_UNSUPPORTED`) and nothing is written.
- Native keychain access is time-bounded: a locked keychain (or permission prompt) fails
  the operation instead of stalling the proxy, and the dashboard degrades to `unknown`
  rather than hanging. If a previous keychain write is still outstanding after a bounded
  grace, the next switch is refused with retryable `AGY_CLI_KEYRING_PENDING` so a late
  write can never silently overwrite a reported success.
- Token material never appears in API responses, logs, or process arguments: keychain
  writes go through the OS credential API, and responses carry only status codes and
  masked emails.

## Quota semantics (what the cards actually show)

The cards use Google's `retrieveUserQuotaSummary` endpoint with each account's
own credential and Cloud AI Companion project. It reports two subscription
groups, **Gemini** and **Claude / GPT**, each with **weekly** and **5-hour**
limits. The models within a group share those limits.

`fetchAvailableModels` is a model catalog, not the subscription summary. Its
per-model fractions can all be 1 even when the weekly subscription is partly
consumed. Neither that endpoint nor an old catalog cache is used as a fallback
for subscription bars. Existing catalog-only caches are re-probed immediately.

- All four explicit buckets must be valid. Missing, malformed, duplicate or
  unavailable summary data shows **unknown/unavailable**, never a fabricated
  full allowance. No plan name is inferred from the quota data.
- Percentages show up to two decimal places; real 0% and 100% remain valid.
  Missing reset dates show **Reset unknown**; an elapsed timestamp alone does
  not establish that a fresh quota was observed.
- Routing's canonical `Gem` and `Cla` windows use the most consumed limit of
  their respective groups, so a full session cannot hide an exhausted week.
- The displayed observation time is `quota.updatedAt`, never credential expiry.
  Failed probes retain the last successful summary with an explicit stale label and muted bars; its observation time is not advanced.
- Successful readings are cached for ten minutes. Failed probes are cached for
  30 seconds and retried while the page is open, stopping after recovery.
  Manual refresh bypasses the cache. Platforms render independently as their
  responses arrive.

Successful AGY probes update memory and a debounced JSON snapshot at
`provider-account-quota-cache.json` in the OpenCodex home directory. A restart
loads that snapshot. Fresh summaries are reused for ten minutes; older ones
are returned as stale while one background probe runs per account. Snapshots
older than six hours are discarded. The page polls only AGY while a refresh is
pending, then replaces the stale reading; failures retry after 30 seconds.
With no usable cache, the account appears with an updating indicator instead
of an invented quota. No credentials or emails are written to this snapshot.

## `ocx agy`

```bash
ocx agy accounts [--json]        # list logged-in AGY accounts
ocx agy use <id|email|index>     # switch proxy account + sync local CLI (CLI target only)
ocx agy --account <id> [...]     # switch, then launch agy with that account
ocx agy [...]                    # interactive picker when several accounts exist
```

`use`/`switch`, `--account`, the interactive picker, and launch all use the same sync result:

- A proxy-switch or sync failure exits nonzero and, for launch, **refuses to start** `agy`
  rather than running it with stale credentials.
- A remote (non-loopback) proxy leaves local CLI files untouched and says so.
- With no OpenCodex AGY accounts at all, `ocx agy` launches the native binary untouched so its
  own login flow still works.

## Failure handling

- Missing credentials, expired credentials whose refresh fails, unreadable/writable files,
  keychain denial, and verification mismatches each produce a distinct `AGY_CLI_*` code.
  Partial writes are restored from backup (files **and** the previous keychain entry) and
  re-verified; if a restore itself fails the result reports the inconsistent
  state (`AGY_CLI_INCONSISTENT`) instead of success.
- IDE database locks, transaction failures, and verification mismatches roll back the
  transaction and keep no changes — the live database (including committed history) is
  never overwritten from a backup. Missing tables or
  undecodable existing state refuse the write (`AGY_IDE_DB_UNEXPECTED` /
  `AGY_IDE_STATE_CORRUPT`) rather than guessing.
- IDE `pending_restart` is never reported as full success, and a failed/unknown state is never
  rendered as synced in the dashboard.
- Concurrent switches are serialized per target so two requests cannot interleave into mixed
  credentials.
