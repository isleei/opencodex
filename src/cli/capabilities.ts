/**
 * What `ocx` can do, as data an agent can read without parsing help text.
 *
 * This is the machine-readable index behind `ocx capabilities`. It relates each CLI
 * capability to the management route(s) it drives, which nothing in this repository did
 * before: help lived in twenty per-module `USAGE` constants and a hand-written banner
 * that a test explicitly licensed to drift from the command registry.
 *
 * LEAF MODULE. It imports nothing from `src/cli/`, and nothing here may import a command
 * module. That is not tidiness. Each command module declares its usage text as a
 * top-level `const USAGE`, evaluated at import time, so a cycle back into this table
 * would resolve to `undefined` under ESM rather than throwing -- silently emptying the
 * usage text that `rejectArgs` hands to `CliUsageError`, in the exact error-reporting
 * surface the CLI-operability issues are about. `tests/cli/cli-capabilities.test.ts` asserts
 * the absence of those imports and that every rendered usage string is non-empty, so the
 * failure mode is loud instead of degraded.
 *
 * Head-handled surfaces (`--version`, `help`) are declared separately in
 * `HEAD_CAPABILITIES`. They exit in the CLI head (`root.ts`) before dispatch and have no
 * runner key, so listing them as ordinary capabilities would break the registry parity
 * assertion that every canonical entry is a direct runner. `help` is excluded from
 * `CLI_COMMANDS` deliberately -- `tests/cli/cli-registry.test.ts` documents it as a
 * head-handled pseudo-case -- and that decision is preserved here rather than reversed.
 */

/** A management route a capability drives. Path text only; never a handler reference. */
export interface CapabilityRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
}

export interface CapabilityFlag {
  readonly name: string;
  readonly value?: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly summary: string;
}

/**
 * How a capability emits JSON.
 *
 * - `payload`: the API payload, largely unwrapped.
 * - `envelope`: a CLI-shaped object with its own schema.
 * - `none`: no `--json` mode.
 */
export type CapabilityJsonMode = "payload" | "envelope" | "none";

export interface Capability {
  /** Command path, e.g. `["account", "pause"]`. */
  readonly command: readonly string[];
  readonly summary: string;
  readonly routes: readonly CapabilityRoute[];
  readonly flags: readonly CapabilityFlag[];
  readonly mutates: boolean;
  readonly json: CapabilityJsonMode;
  readonly details?: readonly string[];
  /**
   * Extra banner rows this capability owns, for surfaces the banner shows separately
   * from the bare command (`ocx restore back`, `ocx doctor --reclaim-response-temps`).
   * Without this the banner cannot equal the capability set: it legitimately carries more
   * rows than there are commands.
   */
  readonly bannerLines?: readonly string[];
}

/**
 * Surfaces resolved in the CLI head, before dispatch.
 *
 * They belong in `ocx capabilities` output and in the banner, but not in `CLI_COMMANDS`:
 * `--version`, `-v`, and `version` are answered at `root.ts` and exit, so none of them is
 * a runner key to parity-check against.
 */
export interface HeadCapability {
  readonly invocations: readonly string[];
  readonly summary: string;
  readonly bannerLine: string;
}

export const HEAD_CAPABILITIES: readonly HeadCapability[] = [
  {
    invocations: ["--version", "-v", "version"],
    summary: "Print the CLI version and exit.",
    bannerLine: "ocx --version | -v          Print version",
  },
  {
    invocations: ["help", "--help", "-h"],
    summary: "Print the command list, or one command's usage with `ocx help <command>`.",
    bannerLine: "ocx help [command]          Show help for a command",
  },
];

/**
 * Capabilities declared so far. Incomplete by design: later phases add verbs.
 * `ocx capabilities` is the index of what is listed here, not of every CLI command.
 * A capability must not name a route the command does not actually fetch.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    command: ["models", "price"],
    summary: "Read the saved manual price for an exact provider/model selector.",
    routes: [{ method: "GET", path: "/api/providers/{provider}/model-costs" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit provider, modelId, and cost (null for automatic pricing)." }],
    mutates: false,
    json: "envelope",
    details: ["The provider must be configured; everything after the first slash is the exact upstream model ID."],
  },
  {
    command: ["models", "set-price"],
    summary: "Save four manual USD-per-1M-token rates, or restore automatic pricing for one model.",
    routes: [{ method: "PUT", path: "/api/providers/{provider}/model-costs" }],
    flags: [
      { name: "--input", value: "number", summary: "Input rate; required unless --auto is used." },
      { name: "--output", value: "number", summary: "Output rate; required unless --auto is used." },
      { name: "--cache-read", value: "number", summary: "Cache read rate; defaults to 0." },
      { name: "--cache-write", value: "number", summary: "Cache write rate; defaults to 0." },
      { name: "--auto", value: "boolean", summary: "Remove this model's override; cannot be combined with rates." },
      { name: "--json", value: "boolean", summary: "Emit the saved price or reset result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Uses the exact upstream model ID after the first slash. Omitted cache rates default to zero; sibling model prices are preserved."],
  },
  {
    command: ["status"],
    summary: "Proxy status, injection state, and version skew between this CLI and the running proxy.",
    // No management route: `collectStatus` identity-probes `/healthz` through
    // `findLiveProxy` and reads local config. Declaring `GET /api/status` here was wrong
    // -- that route does not exist, and the registry cross-check caught it.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the status envelope as JSON." }],
    mutates: false,
    json: "envelope",
    details: ["Reads /healthz plus local config; drives no management API route."],
  },
  {
    command: ["connect", "rotate"],
    summary: "Rotate the connected client's data key against the hub, with commit and abort.",
    // One command drives all three: start returns the new secret once, commit promotes it,
    // and abort unwinds a rotation that could not be confirmed. They are not separate verbs
    // because a half-rotation is not a state an operator should be able to leave behind.
    routes: [
      { method: "POST", path: "/api/keys/rotate" },
      { method: "POST", path: "/api/keys/rotate/commit" },
      { method: "DELETE", path: "/api/keys/rotate" },
    ],
    flags: [
      { name: "--pairing-code-stdin", value: "boolean", summary: "Read a one-time pairing code from stdin as the rotation authority." },
      { name: "--admin-token-stdin", value: "boolean", summary: "Read the hub admin token from stdin as the rotation authority." },
      { name: "--json", value: "boolean", summary: "Emit the rotation result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Requires transient authority on stdin; the credential is never persisted or echoed.",
      "A rotation left pending by a crash is resumed here — startup and status stop rather than guess which key generation is live.",
    ],
  },
  {
    command: ["capabilities"],
    summary: "List the declared CLI capabilities and the management routes they drive.",
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the full capability table as JSON." },
      { name: "--mutating-only", value: "boolean", summary: "Restrict output to capabilities that mutate state." },
      { name: "--route", value: "string", summary: "Show which capabilities drive a management route." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Start here when driving ocx programmatically: it is the declared surface index, not a complete verb list."],
  },
  {
    command: ["provider", "list"],
    summary: "Configured providers with connectivity and selected models.",
    // Local config + PROVIDER_REGISTRY. Does not call GET /api/providers.
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the provider list as JSON." },
      { name: "--jsonl", value: "boolean", summary: "Emit one configured provider per JSON line." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Reads local config; drives no management API route."],
  },
  {
    command: ["provider", "resets"],
    summary: "Recently detected quota resets and whether reset notifications are enabled.",
    routes: [{ method: "GET", path: "/api/quota-resets" }],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit reset events as JSON." },
      { name: "--limit", value: "number", summary: "Limit returned events; defaults to 20, capped at 100." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["provider", "keychain"],
    summary: "Move a provider's API key into the OS keychain, restore it, or report where it lives.",
    routes: [
      { method: "GET", path: "/api/providers/keychain" },
      { method: "POST", path: "/api/providers/keychain" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the keychain status or result as JSON." }],
    mutates: true,
    json: "payload",
    details: [
      "`store` verifies every keychain write by read-back before config.json is rewritten with keychain: references; an unavailable keychain refuses with 503 and leaves the file untouched.",
      "Headless services usually have no unlocked keychain session; prefer ${ENV_VAR} references there.",
    ],
  },
  {
    command: ["account", "list"],
    summary: "Codex OAuth accounts with pool priority and pause state.",
    routes: [{ method: "GET", path: "/api/codex-auth/accounts" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the account list as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "STATUS names `paused` alongside `selected`: a paused-but-selected account still receives requests.",
      "`--quota` shows cached Codex windows (including 5h); `--refresh` bypasses the server TTL.",
    ],
  },
  {
    command: ["usage"],
    summary: "Token and estimated-cost report over a time range.",
    routes: [{ method: "GET", path: "/api/usage" }],
    flags: [
      { name: "--range", value: "string", summary: "today | 1d | 7d | 30d | all" },
      { name: "--since", value: "string", summary: "Inclusive start: epoch milliseconds or full ISO datetime with timezone; requires --until and overrides --range." },
      { name: "--until", value: "string", summary: "Inclusive end: epoch milliseconds or full ISO datetime with timezone; requires --since." },
      { name: "--provider", value: "string", summary: "Restrict to one provider." },
      { name: "--model", value: "string", summary: "Restrict to one model id." },
      { name: "--json", value: "boolean", summary: "Emit the usage report as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "Per-account totals are withheld under `--provider` or `--model`: account rows cannot be honestly re-partitioned by provider, so the report says so rather than printing an empty table.",
      "An `(ambiguous)` account row aggregates several accounts; do not read it as one identity.",
    ],
  },
  {
    command: ["account", "pause"],
    summary: "Stop routing new requests to one account in the Codex pool.",
    // One route, both directions: `resume` is the same PUT with `paused: false`.
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the pause result as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "Pausing also unbinds threads pinned to the account and selects a fallback if it was active -- side effects of the route, not of the word `pause`.",
      "The issue that requested this reported the route as POST; it is PUT.",
    ],
  },
  {
    command: ["account", "resume"],
    summary: "Return a paused account to the Codex pool.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the resume result as JSON." }],
    mutates: true,
    json: "envelope",
  },
  {
    command: ["account", "pause-exhausted"],
    summary: "Pause every Codex account whose quota is spent.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit paused ids and the checked/failed counts as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "The route refreshes quota per account and can partially fail; a non-zero failed count exits 1 and sets ok:false, because silence would read as `none were exhausted`.",
    ],
  },
  {
    command: ["account", "strategy"],
    summary: "Show or set how an account pool picks the next account.",
    // Both pools, because both have the setting. The Codex pool reads its applied values
    // from the active payload; the Anthropic pool has its own GET.
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/pool-strategy" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "A bare invocation reads and never writes.",
      "The APPLIED value is echoed, not the requested one, so a server-side normalization stays visible.",
      "Values are not re-validated in the CLI: the server owns the strategy names and the 1-100 sticky bound.",
      "`anthropic` owns the full pool contract. Other OAuth providers reach the same endpoint with a generic subset (enabled/strategy/autoSwitchThreshold) whose settings persist but do not yet steer selection; `sticky` and `quotaWindow` are refused for them.",
    ],
  },
  {
    command: ["account", "sticky"],
    summary: "Show or set how many consecutive requests stay on one account.",
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/pool-strategy" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: ["Only meaningful under the sticky-capable strategies; the pool strategy is the other half of this setting."],
  },
  {
    command: ["logs"],
    summary: "Recent request log rows, filterable by provider, model, conversation, and status.",
    routes: [{ method: "GET", path: "/api/logs" }],
    flags: [
      { name: "--provider", value: "string", summary: "Restrict to one provider, matching failover attempts too." },
      { name: "--model", value: "string", summary: "Restrict to one model id, matching failover attempts too." },
      { name: "--conversation", value: "string", summary: "Restrict to one conversation id (`--conversationId` is accepted too)." },
      { name: "--status", value: "string", summary: "An exact code (429) or a class (5xx)." },
      { name: "--limit", value: "number", summary: "Row cap; defaults to 200." },
      { name: "--follow", value: "boolean", summary: "Poll for new rows; add --jsonl to emit JSONL." },
      { name: "--json", value: "boolean", summary: "Emit the server payload as JSON." },
      { name: "--jsonl", value: "boolean", summary: "Emit one row per line." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "`--provider` and `--model` both match a failover attempt, so a request is findable by what actually served it, not only by what was asked for.",
      "Rows print `conv=<id>` when the entry carries one, so a conversation filter can be told apart from an empty result.",
      "`--follow` deduplicates by row id and cannot be combined with `--json`.",
    ],
  },
  {
    command: ["storage", "report"],
    summary: "Disk usage under CODEX_HOME, with the log-guard protection report.",
    routes: [{ method: "GET", path: "/api/storage" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the storage report as JSON." }],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx storage                 Storage report (default subcommand)"],
  },
  {
    command: ["storage", "cleanup"],
    summary: "Preview or delete the oldest archived sessions by percentage.",
    // Both routes, because the verb always previews: the mutating route requires the digest the
    // preview returns and rejects a stale one, so the two are one operation.
    routes: [
      { method: "POST", path: "/api/storage/cleanup/preview" },
      { method: "POST", path: "/api/storage/cleanup" },
    ],
    flags: [
      { name: "--percent", value: "number", summary: "Portion of the oldest archived sessions to target (0-100)." },
      { name: "--mode", value: "string", summary: "quarantine (recoverable from trash) or permanent." },
      { name: "--yes", value: "boolean", summary: "Required to actually delete; without it this is a preview." },
      { name: "--json", value: "boolean", summary: "Emit the preview or result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Without `--yes` it prints what WOULD be freed and exits 0 having changed nothing.",
      "There is no interactive confirmation: a prompt an agent can answer is not a safety boundary.",
      "`--mode quarantine` moves files to trash, so `storage trash restore` can undo it; `permanent` cannot be undone.",
    ],
  },
  {
    command: ["storage", "trash"],
    summary: "List quarantined cleanup batches, or restore one.",
    routes: [
      { method: "GET", path: "/api/storage/trash" },
      { method: "POST", path: "/api/storage/trash/restore" },
    ],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required for restore, which moves files and reconciles database rows." },
      { name: "--json", value: "boolean", summary: "Emit the trash list or restore result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Restore fails with a named 409 when the destination already exists, rather than overwriting it."],
  },
  {
    command: ["storage", "policy"],
    summary: "Show, change, or run the automatic archived-session cleanup policy.",
    routes: [
      { method: "GET", path: "/api/storage/cleanup-policy" },
      { method: "PUT", path: "/api/storage/cleanup-policy" },
      { method: "POST", path: "/api/storage/cleanup-policy/run" },
    ],
    flags: [
      { name: "--enabled", value: "string", summary: "true or false." },
      { name: "--percent", value: "number", summary: "Portion of oldest archived sessions each run targets." },
      { name: "--mode", value: "string", summary: "quarantine or permanent." },
      { name: "--schedule", value: "string", summary: "startup, daily, weekly, or manual." },
      { name: "--yes", value: "boolean", summary: "Required for `policy run`, which deletes immediately." },
      { name: "--json", value: "boolean", summary: "Emit the policy or run state as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "`policy set` never enables implicitly: omitting `--enabled` keeps the stored value.",
      "`policy run` forces a run regardless of schedule, so it needs `--yes`.",
    ],
  },
  {
    command: ["inspect", "config"],
    summary: "The effective merged configuration the proxy is running.",
    routes: [{ method: "GET", path: "/api/config" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the config as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "catalog"],
    summary: "The generated model catalog served to clients.",
    routes: [{ method: "GET", path: "/api/catalog" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the catalog as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "routing-analytics"],
    summary: "Aggregate routing outcomes per provider and model.",
    routes: [{ method: "GET", path: "/api/routing-analytics" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the analytics payload as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "pacing"],
    summary: "Request-pacing state for one provider or all of them.",
    routes: [{ method: "GET", path: "/api/provider-request-pacing" }],
    flags: [
      { name: "--name", value: "string", summary: "Restrict to one provider; omitted means every provider." },
      { name: "--json", value: "boolean", summary: "Emit the pacing state as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: ["An unknown provider name is a 404 rather than an empty result."],
  },
  {
    command: ["inspect", "key-providers"],
    summary: "Providers that authenticate with an API key rather than OAuth.",
    routes: [{ method: "GET", path: "/api/key-providers" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the provider list as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "codex-prompt"],
    summary: "The Codex system prompt state, or the prompt text itself.",
    routes: [
      { method: "GET", path: "/api/codex-prompt" },
      { method: "GET", path: "/api/codex-prompt/text" },
    ],
    flags: [
      { name: "--text", value: "boolean", summary: "Print the prompt body verbatim instead of its metadata." },
      { name: "--json", value: "boolean", summary: "Emit the prompt metadata as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: ["Read-only by design: the six mutating prompt routes require a dashboard session."],
  },
  {
    command: ["inspect", "client-config"],
    summary: "The generated configuration snippet for a supported client.",
    routes: [{ method: "GET", path: "/api/client-config" }],
    flags: [
      { name: "--client", value: "string", summary: "Required client id; the route names every accepted value on error." },
      { name: "--json", value: "boolean", summary: "Emit the snippet payload as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "star"],
    summary: "Whether this repository is starred by the signed-in GitHub account.",
    // GET only, permanently. The POST spends the operator identity and requires a dashboard
    // session precisely so an agent cannot answer that question for them.
    routes: [{ method: "GET", path: "/api/github/star" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the star status as JSON." }],
    mutates: false,
    json: "payload",
    details: ["Starring is never available from the CLI; the verb says so rather than offering a flag that cannot work."],
  },
  {
    command: ["inspect", "windows-tray"],
    summary: "Windows tray helper state.",
    routes: [{ method: "GET", path: "/api/windows-tray" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the tray state as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["system", "codex-app-server"],
    summary: "Codex app-server reachability and process state, as the dashboard sees it.",
    routes: [{ method: "GET", path: "/api/system/codex-app-server" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the app-server state as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "The GUI reads this state directly; without a verb an agent could not tell whether the Codex app-server was reachable at all.",
    ],
  },
  {
    command: ["system", "codex-cli-update", "check"],
    summary: "Inspect a configured Codex CLI candidate and its ownership provenance.",
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the redacted provenance report as JSON." }],
    mutates: false,
    json: "envelope",
    details: [
      "Proof-bound published-launcher context authenticates the configured candidate snapshot, not successful Codex execution; this check does not attest or admit a selected runtime.",
      "On Windows this first slice performs no candidate or configuration filesystem I/O: only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels; every other Windows candidate fails closed.",
      "Makes no package-registry request.",
      "Does not execute Codex or npm, install or repair software, control a process, or write configuration or cache state.",
    ],
  },
  {
    command: ["system", "codex-restart"],
    summary: "Restart the Codex app-server.",
    routes: [{ method: "POST", path: "/api/system/codex-restart" }],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required: restarts the operator's running Codex app-server." },
      { name: "--json", value: "boolean", summary: "Emit the restart result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "`sync --restart-codex` is not a substitute: it restarts only as a side effect after a catalog or cache write, so it cannot restart a healthy install on request.",
      "--yes is mandatory because this interrupts a running editor session, which must never happen because an agent guessed a subcommand.",
    ],
  },
  {
    command: ["claude", "desktop", "status"],
    summary: "Applied-vs-desired Claude Desktop state, including staleness, drift, and health.",
    routes: [{ method: "GET", path: "/api/claude-desktop/status" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the live status as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "Distinct from `claude desktop show`, which reports what this machine WOULD write; this reports what is actually in effect, which only the running proxy knows.",
    ],
  },
  {
    command: ["integration", "native"],
    summary: "Show or toggle the native Claude, Claude Desktop, Codex, and Grok integrations, and read the Cursor status (which builds are installed, gateway values, last request seen).",
    routes: [
      { method: "GET", path: "/api/native-integrations" },
      { method: "PUT", path: "/api/native-integrations/claude" },
      { method: "PUT", path: "/api/native-integrations/claude-desktop" },
      { method: "PUT", path: "/api/native-integrations/codex" },
      { method: "PUT", path: "/api/native-integrations/grok" },
      { method: "GET", path: "/api/native-integrations/cursor" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the client rows or toggle result as JSON." }],
    mutates: true,
    json: "payload",
    details: [
      "The list renders per-client state, installed, and desired columns; a blocked disable is named rather than left silent.",
      "Each client has its own route because a toggle rewrites that client's own config file.",
    ],
  },
  {
    command: ["integration", "client"],
    summary: "Inspect and toggle Aside profile catalogs, read their history, and restore a selected profile operation.",
    routes: [
      { method: "GET", path: "/api/client-integrations/aside/profiles" },
      { method: "PUT", path: "/api/client-integrations/aside/profiles" },
      { method: "GET", path: "/api/client-integrations/aside/profiles/{profileId}" },
      { method: "PUT", path: "/api/client-integrations/aside/profiles/{profileId}" },
      { method: "GET", path: "/api/client-integrations/aside/profiles/journal" },
      { method: "GET", path: "/api/client-integrations/aside/profiles/{profileId}/journal" },
      { method: "POST", path: "/api/client-integrations/aside/profiles/{profileId}/restore" },
    ],
    flags: [
      { name: "--client", value: "string", summary: "Select the file integration; use aside for profile controls." },
      { name: "--profile", value: "number", summary: "Select one registered Aside account; omitted toggles affect all profiles." },
      { name: "--op", value: "string", summary: "Operation ID for restore." },
      { name: "--confirm-drift", value: "boolean", summary: "Explicitly allow restore to replace subsequent edits." },
      { name: "--overwrite-conflict", value: "boolean", summary: "Explicitly allow enable to replace a conflicting provider block." },
      { name: "--json", value: "boolean", summary: "Emit the profile state, history, or mutation result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Use status/show/list, history/journal, enable/disable, or restore after integration client.",
      "These declarations cover the dedicated Aside profile paths; existing generic client routes retain their separate parity inventory.",
    ],
  },
  {
    command: ["sync"],
    summary: "Synchronize client catalogs, including Aside profiles through the running server's mutation owner.",
    routes: [{ method: "POST", path: "/api/client-integrations/aside/sync" }],
    flags: [
      { name: "--restart-codex", value: "boolean", summary: "Restart Codex app-servers after a catalog or cache write." },
      { name: "--restart-desktop-app", value: "boolean", summary: "Restart the Codex desktop app after a catalog or cache write." },
    ],
    mutates: true,
    json: "none",
    details: ["The Aside refresh uses the live server; other catalog synchronization also performs local work."],
  },
  {
    command: ["agent", "request-user-input"],
    summary: "Show or set whether default mode may ask the operator a question mid-task.",
    routes: [
      { method: "GET", path: "/api/codex-auth/features/default-mode-request-user-input" },
      { method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the feature state as JSON." }],
    mutates: true,
    json: "payload",
    details: ["A bare invocation reads and never writes."],
  },
  {
    command: ["skills", "list"],
    summary: "List all discovered skills across central store and agent symlinks.",
    routes: [{ method: "GET", path: "/api/skills" }],
    flags: [
      { name: "--status", value: "string", summary: "active | disabled | all" },
      { name: "--agent", value: "string", summary: "all | claude | codex | project" },
      { name: "--search", value: "string", summary: "Search query across name, description, and tags." },
      { name: "--tags", value: "string", summary: "Comma-separated tag filter." },
      { name: "--json", value: "boolean", summary: "Emit the skills catalog as JSON." },
    ],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx skills [list]           List skills across central store and agent symlinks"],
  },
  {
    command: ["skills", "view"],
    summary: "Inspect a skill's frontmatter metadata and markdown instructions.",
    routes: [{ method: "GET", path: "/api/skills/{name}" }],
    flags: [
      { name: "--raw", value: "boolean", summary: "Print verbatim SKILL.md markdown with YAML frontmatter." },
      { name: "--json", value: "boolean", summary: "Emit skill metadata and content as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["skills", "create"],
    summary: "Create a new skill package in the central store and link it to agents.",
    routes: [{ method: "POST", path: "/api/skills" }],
    flags: [
      { name: "--description", value: "string", summary: "Intent summary and trigger description." },
      { name: "--tags", value: "string", summary: "Comma-separated tags for search and categorization." },
      { name: "--content", value: "string", summary: "Markdown body for SKILL.md." },
      { name: "--link", value: "string", summary: "Comma-separated target agents (claude, codex, project)." },
      { name: "--json", value: "boolean", summary: "Emit created skill detail as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["skills", "edit"],
    summary: "Update an existing skill's frontmatter metadata or markdown content.",
    routes: [{ method: "PUT", path: "/api/skills/{name}" }],
    flags: [
      { name: "--description", value: "string", summary: "Updated description string." },
      { name: "--tags", value: "string", summary: "Updated comma-separated tags." },
      { name: "--content", value: "string", summary: "Updated markdown body." },
      { name: "--json", value: "boolean", summary: "Emit updated skill detail as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["skills", "toggle"],
    summary: "Enable or disable a skill globally or for a specific agent.",
    routes: [{ method: "POST", path: "/api/skills/{name}/toggle" }],
    flags: [
      { name: "--enable", value: "boolean", summary: "Enable the skill." },
      { name: "--disable", value: "boolean", summary: "Disable the skill." },
      { name: "--agent", value: "string", summary: "Optional agent target (claude | codex | all)." },
      { name: "--json", value: "boolean", summary: "Emit toggle status as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["skills", "delete"],
    summary: "Delete a skill safely (moves to trash store and cleans up symlinks).",
    routes: [{ method: "DELETE", path: "/api/skills/{name}" }],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required confirmation flag." },
      { name: "--permanent", value: "boolean", summary: "Permanently delete without moving to trash." },
      { name: "--json", value: "boolean", summary: "Emit deletion result as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["skills", "sync"],
    summary: "Synchronize, deduplicate, and establish symlinks across all coding agents.",
    routes: [{ method: "POST", path: "/api/skills/sync" }],
    flags: [
      { name: "--dry-run", value: "boolean", summary: "Simulate sync and deduplication without modifying disk." },
      { name: "--migrate", value: "boolean", summary: "Migrate unlinked client skills into central store." },
      { name: "--json", value: "boolean", summary: "Emit sync results and migration statistics as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["skills", "trash"],
    summary: "List all deleted skills recoverable from trash store.",
    routes: [{ method: "GET", path: "/api/skills/trash" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit trash records as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["skills", "restore"],
    summary: "Restore a deleted skill from trash and recreate client symlinks.",
    routes: [{ method: "POST", path: "/api/skills/trash/restore" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit restore outcome as JSON." }],
    mutates: true,
    json: "payload",
  },
  {
    command: ["mcp", "list"],
    summary: "List configured MCP servers across all supported clients.",
    routes: [
      { method: "GET", path: "/api/mcp" },
      { method: "GET", path: "/api/mcp/{client}" },
    ],
    flags: [
      { name: "--client", value: "string", summary: "Filter by client (all | claude-desktop | claude-code | codex | antigravity)." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--json", value: "boolean", summary: "Emit MCP server definitions as JSON." },
    ],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx mcp [list]              List configured MCP servers across all clients"],
  },
  {
    command: ["mcp", "get"],
    summary: "Inspect an MCP server configuration.",
    routes: [{ method: "GET", path: "/api/mcp/{client}" }],
    flags: [
      { name: "--client", value: "string", required: true, summary: "Target client identifier." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--json", value: "boolean", summary: "Emit server detail as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["mcp", "add"],
    summary: "Add a new MCP server definition to a client configuration.",
    routes: [{ method: "POST", path: "/api/mcp/{client}" }],
    flags: [
      { name: "--client", value: "string", required: true, summary: "Target client identifier." },
      { name: "--command", value: "string", summary: "Command/executable for stdio transport." },
      { name: "--args", value: "string", summary: "Comma-separated command line arguments." },
      { name: "--env", value: "string", summary: "Comma-separated KEY=VALUE pairs." },
      { name: "--cwd", value: "string", summary: "Working directory for execution." },
      { name: "--url", value: "string", summary: "Remote SSE/HTTP server URL." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--overwrite", value: "boolean", summary: "Overwrite existing definition if present." },
      { name: "--json", value: "boolean", summary: "Emit created server definition as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["mcp", "edit"],
    summary: "Update an existing MCP server configuration in place.",
    routes: [{ method: "PUT", path: "/api/mcp/{client}/{id}" }],
    flags: [
      { name: "--client", value: "string", required: true, summary: "Target client identifier." },
      { name: "--command", value: "string", summary: "Updated executable for stdio transport." },
      { name: "--args", value: "string", summary: "Updated comma-separated arguments." },
      { name: "--env", value: "string", summary: "Updated KEY=VALUE environment pairs." },
      { name: "--cwd", value: "string", summary: "Updated working directory." },
      { name: "--url", value: "string", summary: "Updated remote server URL." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--json", value: "boolean", summary: "Emit updated server definition as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["mcp", "toggle"],
    summary: "Enable or disable an MCP server in a client configuration.",
    routes: [{ method: "POST", path: "/api/mcp/{client}/{id}/toggle" }],
    flags: [
      { name: "--client", value: "string", required: true, summary: "Target client identifier." },
      { name: "--enable", value: "boolean", summary: "Enable the server." },
      { name: "--disable", value: "boolean", summary: "Disable the server." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--json", value: "boolean", summary: "Emit updated toggle state as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["mcp", "delete"],
    summary: "Remove an MCP server from a client configuration.",
    routes: [{ method: "DELETE", path: "/api/mcp/{client}/{id}" }],
    flags: [
      { name: "--client", value: "string", required: true, summary: "Target client identifier." },
      { name: "--yes", value: "boolean", summary: "Required confirmation flag." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--json", value: "boolean", summary: "Emit deletion message as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["mcp", "clone"],
    summary: "Clone / export an MCP server definition across different clients.",
    routes: [{ method: "POST", path: "/api/mcp/clone" }],
    flags: [
      { name: "--from", value: "string", required: true, summary: "Source client format." },
      { name: "--to", value: "string", required: true, summary: "Target client format." },
      { name: "--new-id", value: "string", summary: "Optional renamed server ID on target." },
      { name: "--overwrite", value: "boolean", summary: "Overwrite target if ID exists." },
      { name: "--scope", value: "string", summary: "global | project" },
      { name: "--json", value: "boolean", summary: "Emit cloned server definition as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["sessions", "list"],
    summary: "List all discovered sessions across agents (Codex, AGY, Claude Code, Grok).",
    routes: [{ method: "GET", path: "/api/sessions" }],
    flags: [
      { name: "--agent", value: "string", summary: "all | codex | agy | claude | grok" },
      { name: "--status", value: "string", summary: "all | active | archived" },
      { name: "--search", value: "string", summary: "Filter sessions by title, prompt or modified files." },
      { name: "--limit", value: "number", summary: "Maximum sessions to return (default 50)." },
      { name: "--json", value: "boolean", summary: "Emit sessions as JSON." },
    ],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx sessions [list]         List sessions across Codex, AGY, and Claude Code"],
  },
  {
    command: ["sessions", "view"],
    summary: "Inspect a session's turns, modified files, and token statistics.",
    routes: [{ method: "GET", path: "/api/sessions/{agent}/{id}" }],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit session details as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["sessions", "handoff"],
    summary: "Generate handoff context and dispatch execution to target agent.",
    routes: [
      { method: "POST", path: "/api/sessions/{agent}/{id}/handoff" },
      { method: "POST", path: "/api/sessions/{agent}/{id}/dispatch" },
    ],
    flags: [
      { name: "--to", value: "string", required: true, summary: "Target agent (codex | agy | claude)." },
      { name: "--execute", value: "boolean", summary: "Automatically launch target agent execution." },
      { name: "--strategy", value: "string", summary: "smart | full (default: smart)." },
      { name: "--instructions", value: "string", summary: "Custom user instructions to append." },
      { name: "--json", value: "boolean", summary: "Emit handoff / dispatch result as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["acp"],
    summary: "Run ocx as an ACP coding agent over stdio for ACP-compatible editors.",
    routes: [],
    flags: [{ name: "--model", value: "string", summary: "Pin the routed model ref for every session." }],
    mutates: false,
    json: "none",
    bannerLines: ["ocx acp [--model <ref>]     ACP agent endpoint for Zed/JetBrains/Neovim"],
  },
  {
    command: ["workflow", "go"],
    summary: "One-command start: classify the task, bind the default model, execute to the first gate.",
    routes: [{ method: "POST", path: "/api/workflows/go" }],
    flags: [
      { name: "--workflow", value: "string", summary: "Force a specific workflow definition." },
      { name: "--model", value: "string", summary: "Fallback for roles without a task override or definition default." },
      { name: "--set", value: "string", summary: "Pin a role to a model ref (repeatable, role=model-ref)." },
      { name: "--workspace", value: "string", summary: "Project directory (defaults to the CLI working directory)." },
      { name: "--base", value: "string", summary: "Git base revision for review (defaults to HEAD at run creation)." },
      { name: "--agent", value: "string", summary: "Worker CLI: codex, agy, grok, opencode, or claude." },
      { name: "--json", value: "boolean", summary: "Emit the started run as JSON." },
    ],
    mutates: true,
    json: "payload",
    bannerLines: ["ocx workflow go \"<description>\"  One-command workflow start (plans, then stops at a gate)"],
  },
  {
    command: ["workflow", "list"],
    summary: "List workflow definitions (built-ins plus user files).",
    routes: [{ method: "GET", path: "/api/workflows" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit definitions as JSON." }],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx workflow list           List phase-sequenced workflow definitions"],
  },
  {
    command: ["workflow", "delete"],
    summary: "Delete a user workflow definition (built-ins cannot be deleted).",
    routes: [{ method: "DELETE", path: "/api/workflows/{id}" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the result as JSON." }],
    mutates: true,
    json: "payload",
  },
  {
    command: ["workflow", "show"],
    summary: "Inspect a workflow definition's phases, roles, and gates.",
    routes: [{ method: "GET", path: "/api/workflows" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the definition as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["workflow", "run"],
    summary: "Start a run of a workflow definition.",
    routes: [{ method: "POST", path: "/api/workflows/runs" }],
    flags: [
      { name: "--title", value: "string", required: true, summary: "Human title for the run." },
      { name: "--set", value: "string", summary: "Pin a role to a model ref (repeatable, role=model-ref)." },
      { name: "--workspace", value: "string", summary: "Project directory (defaults to the CLI working directory)." },
      { name: "--base", value: "string", summary: "Git base revision for review (defaults to HEAD at run creation)." },
      { name: "--agent", value: "string", summary: "Worker CLI: codex, agy, grok, opencode, or claude." },
      { name: "--auto", value: "boolean", summary: "Execute phases automatically until the next gate or completion." },
      { name: "--json", value: "boolean", summary: "Emit the started run as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["workflow", "runs"],
    summary: "List workflow runs (newest first).",
    routes: [{ method: "GET", path: "/api/workflows/runs" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit runs as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["workflow", "status"],
    summary: "Inspect a run: phase timeline, current gate, journal tail.",
    routes: [{ method: "GET", path: "/api/workflows/runs/{id}" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit run details as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["workflow", "advance"],
    summary: "Complete the current phase and move to the next one.",
    routes: [{ method: "POST", path: "/api/workflows/runs/{id}/advance" }],
    flags: [
      { name: "--outputs", value: "string", summary: "Text output to record for the completed phase." },
      { name: "--json", value: "boolean", summary: "Emit the updated task as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["workflow", "execute"],
    summary: "Execute the current phase (chat via the proxy, agent via codex exec); --auto keeps going.",
    routes: [{ method: "POST", path: "/api/workflows/runs/{id}/execute" }],
    flags: [
      { name: "--auto", value: "boolean", summary: "Keep executing and advancing until the next gate, manual phase, or completion." },
      { name: "--json", value: "boolean", summary: "Emit the receipt as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["workflow", "gate"],
    summary: "Approve or reject the gate the run is waiting at.",
    routes: [{ method: "POST", path: "/api/workflows/runs/{id}/gate" }],
    flags: [
      { name: "--note", value: "string", summary: "Optional approval/rejection note." },
      { name: "--json", value: "boolean", summary: "Emit the updated task as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["workflow", "abort"],
    summary: "Abort a workflow run.",
    routes: [{ method: "POST", path: "/api/workflows/runs/{id}/abort" }],
    flags: [
      { name: "--reason", value: "string", summary: "Optional abort reason." },
      { name: "--json", value: "boolean", summary: "Emit the updated task as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
  {
    command: ["agy"],
    summary: "Launch Antigravity CLI (agy) with interactive account selection and proxy readiness.",
    routes: [
      { method: "GET", path: "/api/oauth/accounts" },
      { method: "PUT", path: "/api/oauth/accounts/active" },
    ],
    flags: [
      { name: "--account", value: "string", summary: "Account ID, email, or 1-based index to use for the session." },
      { name: "-a", value: "string", summary: "Alias of --account." },
      { name: "--no-select", value: "boolean", summary: "Skip interactive prompt and use the current active account." },
    ],
    mutates: true,
    json: "none",
  },
  {
    command: ["agy", "accounts"],
    summary: "List configured Google Antigravity accounts.",
    routes: [{ method: "GET", path: "/api/oauth/accounts" }],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit accounts as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["agy", "use"],
    summary: "Switch the active Google Antigravity account.",
    routes: [{ method: "PUT", path: "/api/oauth/accounts/active" }],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit receipt as JSON." },
    ],
    mutates: true,
    json: "payload",
  },
];

/** Capabilities that drive `route`, for `ocx capabilities --route`. */
export function capabilitiesForRoute(path: string): Capability[] {
  return CAPABILITIES.filter(cap => cap.routes.some(r => r.path === path));
}

/** Every `(method, path)` pair any capability drives. */
export function capabilityRouteKeys(): Set<string> {
  const keys = new Set<string>();
  for (const cap of CAPABILITIES) {
    for (const route of cap.routes) keys.add(`${route.method} ${route.path}`);
  }
  return keys;
}

/** Rendered command path, e.g. `ocx account pause`. */
export function capabilityInvocation(cap: Capability): string {
  return `ocx ${cap.command.join(" ")}`;
}
