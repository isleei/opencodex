import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  IconRefresh,
  IconTicket,
  IconCopy,
  IconPlay,
  IconInfo,
  IconTag,
  IconX,
} from "../icons";
import { providerIconSrc } from "../provider-icons";
import { displayAccountId } from "../lib/privacy";
import QuotaBars from "../components/QuotaBars";
import { agyRemaining, formatAgyObservedAt, formatAgyResetAt, resolveAgyQuota } from "../lib/agy-quota";
import "../styles-subscriptions.css";

interface OAuthAccount {
  id: string;
  alias?: string;
  email?: string;
  label?: string;
  active?: boolean;
  needsReauth?: boolean;
  plan?: string;
  quota?: any;
  quotaUnavailable?: boolean;
  quotaStale?: boolean;
  quotaRefreshing?: boolean;
  expiresAt?: number;
  health?: { status?: string; message?: string };
}

type AgySyncStatusCode = "synced" | "pending_restart" | "failed" | "unsupported" | "not_installed" | "unknown";

interface AgyTargetState {
  target?: string;
  status: AgySyncStatusCode;
  code?: string;
  message?: string;
  retryable?: boolean;
}

interface AgySyncSnapshot {
  cli?: { filePresent?: boolean; matchesActive?: boolean | null; keyringPresent?: boolean; keyringMatchesActive?: boolean | null };
  ide?: { installed?: boolean; running?: boolean; credentialPresent?: boolean; credentialMatchesActive?: boolean | null };
  nativeKeyring?: string;
  unknown?: boolean;
}

interface CodexAccountSummary {
  id: string;
  email?: string;
  label?: string;
  plan?: string;
  needsReauth?: boolean;
  quota?: {
    fiveHourPercent?: number;
    fiveHourResetAt?: number;
    shortPercent?: number;
    shortResetAt?: number;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    monthlyPercent?: number;
    monthlyResetAt?: number;
    resetCredits?: number;
    plan?: string;
    customWindows?: any[];
    updatedAt?: number;
  } | null;
  quotaUnavailable?: boolean;
  quotaStale?: boolean;
  quotaRefreshing?: boolean;
}

function formatResetCountdown(resetAt?: number): string {
  if (!resetAt) return "已重置";
  const now = Date.now();
  const target = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const diffMs = target - now;
  if (diffMs <= 0) return "已重置";
  const totalMins = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const mins = totalMins % 60;
  const d = new Date(target);
  const dateStr = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days > 0) {
    return `${days}d ${hours}h ${mins}m (${dateStr})`;
  }
  return `${hours}h ${mins}m (${dateStr})`;
}

function formatCardDate(timestamp?: number): string {
  if (!timestamp) return new Date().toLocaleDateString();
  const d = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface AgyLastSwitch {
  accountId: string;
  ok: boolean;
  code?: string;
  message?: string;
  cli?: AgyTargetState;
  ide?: AgyTargetState;
  requestSeq: number;
}

/**
 * Fresh authoritative reads supersede the historical switch outcome when
 * they definitively disagree — same-account drift (native credentials moved
 * behind our back) or an external retry that healed a recorded failure.
 * Comparing only the account id would freeze a stale synced/failed badge.
 * `null` snapshot fields mean unknown and never contradict.
 */
function agySnapshotContradicts(lastSwitch: AgyLastSwitch, snapshot: AgySyncSnapshot): boolean {
  const snapCli = snapshot.cli;
  const mismatch = snapCli?.matchesActive === false || snapCli?.keyringMatchesActive === false;
  const match =
    snapCli?.matchesActive === true &&
    (snapCli?.keyringMatchesActive === true || snapshot.nativeKeyring === "unsupported");
  if (lastSwitch.cli) {
    if (lastSwitch.cli.status === "synced" && mismatch) return true;
    if (
      (lastSwitch.cli.status === "failed" ||
        lastSwitch.cli.status === "unknown" ||
        lastSwitch.cli.status === "unsupported") &&
      match
    ) {
      return true;
    }
  }
  const snapIde = snapshot.ide;
  if (lastSwitch.ide) {
    if (
      (lastSwitch.ide.status === "synced" || lastSwitch.ide.status === "pending_restart") &&
      snapIde?.credentialMatchesActive === false
    ) {
      return true;
    }
    if (
      (lastSwitch.ide.status === "failed" || lastSwitch.ide.status === "unknown") &&
      snapIde?.credentialMatchesActive === true &&
      snapIde?.installed !== false
    ) {
      return true;
    }
    if (lastSwitch.ide.status === "not_installed" && snapIde?.installed === true) return true;
  }
  return false;
}

export default function Subscriptions({ apiBase }: { apiBase: string }) {
  const t = useT();
  const aliveRef = useRef(true);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // AGY state
  const [agyAccounts, setAgyAccounts] = useState<OAuthAccount[]>([]);
  const [agyActiveId, setAgyActiveId] = useState<string | null>(null);
  const [switchingAgyId, setSwitchingAgyId] = useState<string | null>(null);
  const [, setAgySync] = useState<AgySyncSnapshot | null>(null);
  const [, setAgyLastSwitch] = useState<AgyLastSwitch | null>(null);
  const agyRequestSeq = useRef(0);
  const agyLoadSeq = useRef(0);
  // Ref mirror so loadData can reconcile the historical outcome against a
  // fresh snapshot synchronously (updaters must stay side-effect free).
  const agyLastSwitchRef = useRef<AgyLastSwitch | null>(null);
  const setAgyLastSwitchTracked = (value: AgyLastSwitch | null) => {
    agyLastSwitchRef.current = value;
    setAgyLastSwitch(value);
  };

  // Codex state
  const [codexMain, setCodexMain] = useState<CodexAccountSummary | null>(null);
  const [codexPool, setCodexPool] = useState<CodexAccountSummary[]>([]);

  // Grok state
  const [grokAccounts, setGrokAccounts] = useState<OAuthAccount[]>([]);
  const [grokActiveId, setGrokActiveId] = useState<string | null>(null);
  const [switchingGrokId, setSwitchingGrokId] = useState<string | null>(null);

  // Other connected OAuth providers
  const [otherProviders, setOtherProviders] = useState<{
    name: string;
    accounts: OAuthAccount[];
    activeId: string | null;
  }[]>([]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadData = useCallback(async (opts?: { refresh?: boolean; agyOnly?: boolean }) => {
    const isRefresh = opts?.refresh === true;
    const agyOnly = opts?.agyOnly === true;
    if (isRefresh) setRefreshing(true);
    else if (!agyOnly) setLoading(true);
    // Request ordering: an older response must never overwrite a newer one.
    const loadSeq = (agyLoadSeq.current += 1);

    const qs = isRefresh ? "&quota=1&refresh=1" : "&quota=1";

    try {
      // 1. Fetch Google Antigravity (AGY) accounts & quotas
      const agyPromise = fetch(`${apiBase}/api/oauth/accounts?provider=google-antigravity${qs}${isRefresh ? "" : "&cached=1"}`)
        .then(async r => (r.ok ? r.json() : null))
        .catch(() => null);

      // 2. Fetch Codex accounts & quotas
      const codexPromise = agyOnly ? Promise.resolve(null) : fetch(`${apiBase}/api/codex-auth/accounts${isRefresh ? "?refresh=1" : ""}`)
        .then(async r => (r.ok ? r.json() : null))
        .catch(() => null);

      // 3. Fetch xAI Grok accounts & quotas
      const grokPromise = agyOnly ? Promise.resolve(null) : fetch(`${apiBase}/api/oauth/accounts?provider=xai${qs}`)
        .then(async r => (r.ok ? r.json() : null))
        .catch(() => null);

      // 4. Fetch other supported OAuth providers (Anthropic, Kiro, Meta Muse)
      const others = agyOnly ? [] : ["anthropic", "kiro", "meta-muse"];
      const otherPromises = others.map(async name => {
        const data = await fetch(`${apiBase}/api/oauth/accounts?provider=${name}${qs}`)
          .then(async r => (r.ok ? r.json() : null))
          .catch(() => null);
        return { name, data };
      });

      // Publish each provider as soon as it resolves; a slow sibling must not
      // leave already-loaded accounts showing a count of zero.
      await Promise.all([
        agyPromise.then(agyRes => {
          if (!aliveRef.current || loadSeq !== agyLoadSeq.current) return;

          // Handle AGY
          if (agyRes && Array.isArray(agyRes.accounts)) {
            const freshActive = agyRes.activeAccountId ?? null;
            setAgyActiveId(freshActive);
            setAgyAccounts(agyRes.accounts);
            const freshSnapshot =
              agyRes.agySync && typeof agyRes.agySync === "object" ? (agyRes.agySync as AgySyncSnapshot) : null;
            if (freshSnapshot) {
              setAgySync(freshSnapshot);
            }
            // Reconcile the historical outcome against fresh authoritative reads:
            // drop results bound to another account AND same-account results the
            // snapshot definitively contradicts (drift or external healing). The
            // panel then derives from the snapshot; the banner keeps the history.
            const prev = agyLastSwitchRef.current;
            if (prev !== null && (prev.accountId !== freshActive || (freshSnapshot && agySnapshotContradicts(prev, freshSnapshot)))) {
              const sameAccount = prev.accountId === freshActive;
              setAgyLastSwitchTracked(null);
              if (sameAccount && loadSeq === agyLoadSeq.current) {
                setFeedback({
                  tone: "err",
                  text: t("subscriptions.agy.switchPartial", {
                    target: "CLI/IDE",
                    detail: "fresh proxy-host state disagrees with the last switch result — retry the switch if needed",
                  }),
                });
              }
            }
          }

        }),
        codexPromise.then(codexRes => {
          if (agyOnly) return;
          if (!aliveRef.current || loadSeq !== agyLoadSeq.current) return;

          // Handle Codex
          const codexAccounts = Array.isArray(codexRes)
            ? codexRes
            : (codexRes && Array.isArray(codexRes.accounts) ? codexRes.accounts : null);
          if (codexAccounts) {
            const main = codexAccounts.find((a: any) => a.id === "__main__" || a.id === "main" || a.isMain);
            const pool = codexAccounts.filter((a: any) => a !== main);
            setCodexMain(main ?? codexAccounts[0] ?? null);
            setCodexPool(pool);
          } else {
            setCodexMain(null);
            setCodexPool([]);
          }

        }),
        grokPromise.then(grokRes => {
          if (agyOnly) return;
          if (!aliveRef.current || loadSeq !== agyLoadSeq.current) return;

          // Handle Grok
          if (grokRes && Array.isArray(grokRes.accounts)) {
            setGrokActiveId(grokRes.activeAccountId ?? null);
            setGrokAccounts(grokRes.accounts);
          }

        }),
        Promise.all(otherPromises).then(otherResults => {
          if (agyOnly) return;
          if (!aliveRef.current || loadSeq !== agyLoadSeq.current) return;

          // Handle Other Providers
          const populatedOthers = otherResults
            .filter(o => o.data && Array.isArray(o.data.accounts) && o.data.accounts.length > 0)
            .map(o => ({
              name: o.name,
              accounts: o.data.accounts,
              activeId: o.data.activeAccountId ?? null,
            }));
          setOtherProviders(populatedOthers);

        }),
      ]);
      if (!aliveRef.current || loadSeq !== agyLoadSeq.current) return;

      setLastUpdated(new Date());
    } catch (e) {
      if (aliveRef.current && loadSeq === agyLoadSeq.current) {
        setFeedback({ tone: "err", text: String(e) });
      }
    } finally {
      if (aliveRef.current && loadSeq === agyLoadSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiBase, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (loading || refreshing) return;
    const pending = agyAccounts.some(account => account.quotaRefreshing);
    if (!pending && !agyAccounts.some(account => account.quotaUnavailable || account.quotaStale)) return;
    const timer = window.setTimeout(() => { void loadData({ agyOnly: true }); }, pending ? 2_000 : 30_000);
    return () => window.clearTimeout(timer);
  }, [agyAccounts, loading, refreshing, loadData]);


  // Switch AGY active account and sync to this proxy host's native CLI + IDE.
  // The response carries per-target sync states; HTTP 200 alone is NOT success.
  const handleSwitchAgy = async (accountId: string) => {
    if (switchingAgyId) return;
    setSwitchingAgyId(accountId);
    const seq = (agyRequestSeq.current += 1);
    const applyIfLatest = (fn: () => void) => {
      if (aliveRef.current && seq === agyRequestSeq.current) fn();
    };
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId }),
      });
      const body = (await res.json().catch(() => null)) as null | {
        ok?: boolean;
        activeAccountId?: string;
        code?: string;
        message?: string;
        cli?: AgyTargetState;
        ide?: AgyTargetState;
        error?: string;
      };
      if (!res.ok || !body) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const nextActive = body.activeAccountId ?? accountId;
      applyIfLatest(() => {
        setAgyActiveId(nextActive);
        setAgySync(prev => {
          if (!prev) return prev;
          // The authoritative snapshot arrives via loadData below; until
          // then, mark the CLI file state unknown rather than assuming it.
          if (!body.ok) return { ...prev, cli: { ...prev.cli, matchesActive: null } };
          return prev;
        });
        setAgyLastSwitchTracked({
          accountId: nextActive,
          ok: body.ok === true,
          code: body.code,
          message: body.message,
          ...(body.cli ? { cli: body.cli } : {}),
          ...(body.ide ? { ide: body.ide } : {}),
          requestSeq: seq,
        });
        if (body.ok === true) {
          const target = agyAccounts.find(a => a.id === nextActive);
          const name = target?.email || target?.alias || displayAccountId(nextActive);
          setFeedback({
            tone: "ok",
            text: body.code === "AGY_SWITCH_CLI_ONLY_NO_IDE"
              ? t("subscriptions.agy.cliOnlyNoIde", { account: name })
              : t("subscriptions.switchSuccess", { account: name }),
          });
        } else {
          const failedTarget = body.cli?.status !== "synced" && body.cli ? "CLI" : "IDE";
          setFeedback({
            tone: "err",
            text: t("subscriptions.agy.switchPartial", {
              target: failedTarget,
              detail: body.message || body.code || "",
            }),
          });
        }
      });
      void loadData({ refresh: false });
    } catch (err) {
      applyIfLatest(() => {
        setFeedback({
          tone: "err",
          text: t("subscriptions.agy.switchUnknown", { detail: err instanceof Error ? err.message : String(err) }),
        });
      });
      // Response不明: 刷新真实状态, 避免旧请求覆盖新状态.
      void loadData({ refresh: false });
    } finally {
      applyIfLatest(() => setSwitchingAgyId(null));
    }
  };

  // Switch Grok active account
  const handleSwitchGrok = async (accountId: string) => {
    if (switchingGrokId || accountId === grokActiveId) return;
    setSwitchingGrokId(accountId);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "xai", accountId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGrokActiveId(accountId);
      const target = grokAccounts.find(a => a.id === accountId);
      const name = target?.email || target?.alias || displayAccountId(accountId);
      setFeedback({ tone: "ok", text: `已切换至 ${name}` });
      void loadData({ refresh: false });
    } catch (err) {
      setFeedback({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSwitchingGrokId(null);
    }
  };

  // Copy helper
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    setFeedback({ tone: "ok", text: `已复制 ${label}` });
  };

  // Note dialog
  const promptNote = (_id: string, current?: string) => {
    const note = prompt("请输入账号备注：", current || "");
    if (note !== null) {
      setFeedback({ tone: "ok", text: `备注已更新` });
    }
  };

  const filteredAgy = agyAccounts;
  const filteredCodexMain = codexMain;
  const filteredCodexPool = codexPool;
  const filteredGrok = grokAccounts;

  // Counts
  const totalCodexCount = (codexMain ? 1 : 0) + codexPool.length;
  const totalOthersCount = otherProviders.reduce((acc, p) => acc + p.accounts.length, 0);

  return (
    <div className="sub-shell">
      {/* Page Header */}
      <div className="sub-header-row">
        <div className="sub-header-left">
          <div className="page-head" style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <h2>{t("subscriptions.title")}</h2>
          </div>
          <p className="page-sub" style={{ margin: "4px 0 0 0" }}>
            {t("subscriptions.subtitle")}
          </p>
        </div>

        <div className="sub-header-actions">
          {lastUpdated && (
            <span className="sub-last-updated mono">
              {t("subscriptions.lastUpdated", { time: lastUpdated.toLocaleTimeString() })}
            </span>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={refreshing || loading}
            onClick={() => void loadData({ refresh: true })}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <IconRefresh className={refreshing ? "sub-spin" : ""} style={{ width: 14, height: 14 }} aria-hidden="true" />
            {refreshing ? t("subscriptions.refreshing") : t("subscriptions.refreshAll")}
          </button>
        </div>
      </div>

      {/* Switch Alert Banner (Cockpit style) */}
      {feedback && (
        <div
          className="sub-alert-banner"
          style={{
            background: feedback.tone === "err" ? "rgba(239, 68, 68, 0.1)" : undefined,
            color: feedback.tone === "err" ? "#ef4444" : undefined,
            borderColor: feedback.tone === "err" ? "rgba(239, 68, 68, 0.3)" : undefined,
          }}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            className="sub-alert-close"
            onClick={() => setFeedback(null)}
            aria-label="Close"
          >
            <IconX style={{ width: 14, height: 14 }} />
          </button>
        </div>
      )}
      {/* SECTION 1: Google Antigravity (AGY) Dual-Column Matrix */}
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {providerIconSrc("google-antigravity") && (
                <img src={providerIconSrc("google-antigravity")} alt="AGY" style={{ width: 18, height: 18 }} />
              )}
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                {t("subscriptions.agy.title")}
              </h3>
              <span className="badge badge-muted text-caption">{agyAccounts.length} Accounts</span>
            </div>
          </div>

          <div className="cockpit-grid">
            {filteredAgy.map(account => {
              const isActive = account.id === agyActiveId;
              const isSwitching = switchingAgyId === account.id;
              const label = account.email || account.alias || displayAccountId(account.id);
              const agyQuota = resolveAgyQuota(account);
              const observedText = formatAgyObservedAt(
                (account.quota && typeof account.quota.updatedAt === "number" ? account.quota.updatedAt : undefined),
              );

              const renderQuotaModel = (model: (typeof agyQuota.buckets)[number]) => {
                const remaining = agyRemaining(model.percent);
                const resetText = formatAgyResetAt(model.resetAt);
                const tone = agyQuota.status === "stale" ? "stale" : remaining === null ? "green" : remaining > 70 ? "green" : remaining > 30 ? "amber" : "red";
                return (
                  <div key={model.bucketId} className="cockpit-quota-metric">
                    <div className="cockpit-metric-head">
                      <span className="cockpit-metric-label">
                        {t(model.group === "gemini" ? "subscriptions.agy.quota.gemini" : "subscriptions.agy.quota.claudeGpt")} · {t(model.window === "weekly" ? "subscriptions.agy.quota.weekly" : "subscriptions.agy.quota.fiveHour")}
                      </span>
                      <span className={`cockpit-metric-val ${tone}`}>
                        {remaining === null
                          ? t("subscriptions.agy.quota.unknown")
                          : t("subscriptions.agy.quota.remaining", { pct: String(Number(remaining.toFixed(2))) })}
                      </span>
                    </div>
                    <div className="cockpit-progress-bg">
                      <div
                        className={`cockpit-progress-fill ${tone}`}
                        style={{ width: `${remaining === null ? 0 : Math.round(remaining)}%` }}
                      />
                    </div>
                    <span className="cockpit-metric-time">
                      {resetText ?? t("subscriptions.agy.quota.resetUnknown")}
                    </span>

                  </div>
                );
              };
              return (
                <div key={account.id} className={`cockpit-card ${isActive ? "active" : ""}`}>
                  <div>
                    {/* Card Head */}
                    <div className="cockpit-card-head">
                      <div className="cockpit-card-identity">
                        <input type="checkbox" style={{ cursor: "pointer" }} />
                        <span className="cockpit-card-email" title={label}>
                          {label}
                        </span>
                        {isActive && <span className="cockpit-badge-active">当前</span>}
                        {typeof account.plan === "string" && account.plan.trim() && (
                          <span className="cockpit-badge-pro">{account.plan.trim()}</span>
                        )}
                      </div>
                    </div>

                    <div style={{ marginTop: 6, marginBottom: 10 }}>
                      <button
                        type="button"
                        className="cockpit-note-btn"
                        onClick={() => promptNote(account.id, account.alias)}
                      >
                        <IconTag style={{ width: 11, height: 11 }} /> 加备注
                      </button>
                    </div>

                    <div className="cockpit-dual-quota-box">
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        <span>{t("subscriptions.agy.quota.scopeNote")}</span>
                      </div>
                      {agyQuota.status === "stale" && <span className="agy-quota-stale-note">{t("subscriptions.agy.quota.stale")}</span>}
                      {account.quotaRefreshing && <span role="status">{t("subscriptions.agy.quota.updating")}</span>}
                      {agyQuota.status === "ok" || agyQuota.status === "stale" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {agyQuota.buckets.map(renderQuotaModel)}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>
                          <span>
                            {agyQuota.status === "unavailable"
                              ? t("subscriptions.agy.quota.unavailable")
                              : t("subscriptions.agy.quota.unknown")}
                          </span>
                        </div>
                      )}

                      <div className="cockpit-credits-row">
                        <span>{t("subscriptions.agy.quota.observedLabel")}:</span>
                        <span style={{ fontWeight: 600 }}>
                          {observedText
                            ? t("subscriptions.agy.quota.observedAt", { time: observedText })
                            : t("subscriptions.agy.quota.observedUnknown")}
                        </span>
                      </div>
                      {account.quotaUnavailable === true && (
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          <span>{t(agyQuota.status === "stale" ? "subscriptions.agy.quota.staleRetry" : "subscriptions.agy.quota.unavailableHint")}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Card Bottom Footer: quota observation time only. Credential
                    * expiry (expiresAt) is never shown here as a quota timestamp. */}
                  <div className="cockpit-card-footer">
                    <span>
                      {observedText
                        ? t("subscriptions.agy.quota.observedAt", { time: observedText })
                        : t("subscriptions.agy.quota.observedUnknown")}
                    </span>
                    <div className="cockpit-footer-actions">
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="查看信息"
                        onClick={() => alert(`账号ID: ${account.id}\n邮箱: ${account.email || "未提供"}`)}
                      >
                        <IconInfo style={{ width: 13, height: 13 }} />
                      </button>
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="复制 ID"
                        onClick={() => copyToClipboard(account.id, "账号 ID")}
                      >
                        <IconCopy style={{ width: 13, height: 13 }} />
                      </button>
                      {!isActive && (
                        <button
                          type="button"
                          className="cockpit-icon-btn primary"
                          title="设为当前活跃账号"
                          disabled={isSwitching || switchingAgyId !== null}
                          onClick={() => void handleSwitchAgy(account.id)}
                        >
                          <IconPlay style={{ width: 13, height: 13 }} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="刷新额度"
                        onClick={() => void loadData({ refresh: true })}
                      >
                        <IconRefresh style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

      {/* SECTION 2: OpenAI Codex Subscription */}
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {providerIconSrc("openai") && (
              <img src={providerIconSrc("openai")} alt="OpenAI" style={{ width: 18, height: 18 }} />
            )}
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              {t("subscriptions.codex.title")}
            </h3>
            <span className="badge badge-muted text-caption">{totalCodexCount} Accounts</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            {/* Main Codex Account Card */}
            {filteredCodexMain ? (
              <div className="cockpit-card active">
                <div>
                  <div className="cockpit-card-head">
                    <div className="cockpit-card-identity">
                      <input type="checkbox" defaultChecked style={{ cursor: "pointer" }} />
                      <span className="cockpit-card-email" title={filteredCodexMain.email}>
                        {filteredCodexMain.email || displayAccountId(filteredCodexMain.id)}
                      </span>
                      <span className="cockpit-badge-active">当前</span>
                      <span className="cockpit-badge-team">
                        {(filteredCodexMain.plan || "TEAM").toUpperCase()}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 10px 0", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="cockpit-note-btn"
                      onClick={() => promptNote(filteredCodexMain.id)}
                    >
                      <IconTag style={{ width: 11, height: 11 }} /> 加备注
                    </button>
                    {(filteredCodexMain.quota?.resetCredits ?? 0) > 0 && (
                      <span className="cockpit-badge-ticket" title="可用充能卡券">
                        <IconTicket style={{ width: 12, height: 12 }} />
                        重置 {filteredCodexMain.quota?.resetCredits}
                      </span>
                    )}
                  </div>

                  {/* Codex Quotas */}
                  <div className="cockpit-dual-quota-box">
                    <div className="cockpit-quota-metric">
                      <div className="cockpit-metric-head">
                        <span className="cockpit-metric-label">5h 滚动限额</span>
                        <span className="cockpit-metric-val green">
                          {100 - (filteredCodexMain.quota?.shortPercent ?? 0)}%
                        </span>
                      </div>
                      <div className="cockpit-progress-bg">
                        <div
                          className="cockpit-progress-fill green"
                          style={{ width: `${100 - (filteredCodexMain.quota?.shortPercent ?? 0)}%` }}
                        />
                      </div>
                      <span className="cockpit-metric-time">
                        {formatResetCountdown(filteredCodexMain.quota?.shortResetAt)}
                      </span>
                    </div>

                    <div className="cockpit-quota-metric" style={{ marginTop: 6 }}>
                      <div className="cockpit-metric-head">
                        <span className="cockpit-metric-label">Weekly 每周限额</span>
                        <span className="cockpit-metric-val green">
                          {100 - (filteredCodexMain.quota?.weeklyPercent ?? 0)}%
                        </span>
                      </div>
                      <div className="cockpit-progress-bg">
                        <div
                          className="cockpit-progress-fill green"
                          style={{ width: `${100 - (filteredCodexMain.quota?.weeklyPercent ?? 0)}%` }}
                        />
                      </div>
                      <span className="cockpit-metric-time">
                        {formatResetCountdown(filteredCodexMain.quota?.weeklyResetAt)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="cockpit-card-footer">
                  <span>{filteredCodexMain.quota?.updatedAt ? formatCardDate(filteredCodexMain.quota.updatedAt) : "Main Account"}</span>
                  <div className="cockpit-footer-actions">
                    <button
                      type="button"
                      className="cockpit-icon-btn"
                      title="复制账号"
                      onClick={() => copyToClipboard(filteredCodexMain.email || "", "Codex 账号")}
                    >
                      <IconCopy style={{ width: 13, height: 13 }} />
                    </button>
                    <button
                      type="button"
                      className="cockpit-icon-btn"
                      title="刷新额度"
                      onClick={() => void loadData({ refresh: true })}
                    >
                      <IconRefresh style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Additional Pool Accounts */}
            {filteredCodexPool.map(acc => {
              const shortRem = 100 - (acc.quota?.shortPercent ?? 0);
              const weekRem = 100 - (acc.quota?.weeklyPercent ?? 0);
              return (
                <div key={acc.id} className="cockpit-card">
                  <div>
                    <div className="cockpit-card-head">
                      <div className="cockpit-card-identity">
                        <input type="checkbox" style={{ cursor: "pointer" }} />
                        <span className="cockpit-card-email" title={acc.email}>
                          {acc.email || displayAccountId(acc.id)}
                        </span>
                        <span className="cockpit-badge-team">
                          {(acc.plan || "POOL").toUpperCase()}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 10px 0" }}>
                      <button
                        type="button"
                        className="cockpit-note-btn"
                        onClick={() => promptNote(acc.id)}
                      >
                        <IconTag style={{ width: 11, height: 11 }} /> 加备注
                      </button>
                      {(acc.quota?.resetCredits ?? 0) > 0 && (
                        <span className="cockpit-badge-ticket">
                          <IconTicket style={{ width: 12, height: 12 }} />
                          重置 {acc.quota?.resetCredits}
                        </span>
                      )}
                    </div>

                    <div className="cockpit-dual-quota-box">
                      <div className="cockpit-quota-metric">
                        <div className="cockpit-metric-head">
                          <span className="cockpit-metric-label">5h 限额</span>
                          <span className="cockpit-metric-val green">{shortRem}%</span>
                        </div>
                        <div className="cockpit-progress-bg">
                          <div className="cockpit-progress-fill green" style={{ width: `${shortRem}%` }} />
                        </div>
                        <span className="cockpit-metric-time">{formatResetCountdown(acc.quota?.shortResetAt)}</span>
                      </div>

                      <div className="cockpit-quota-metric" style={{ marginTop: 6 }}>
                        <div className="cockpit-metric-head">
                          <span className="cockpit-metric-label">Weekly 限额</span>
                          <span className="cockpit-metric-val green">{weekRem}%</span>
                        </div>
                        <div className="cockpit-progress-bg">
                          <div className="cockpit-progress-fill green" style={{ width: `${weekRem}%` }} />
                        </div>
                        <span className="cockpit-metric-time">{formatResetCountdown(acc.quota?.weeklyResetAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="cockpit-card-footer">
                    <span>{acc.quota?.updatedAt ? formatCardDate(acc.quota.updatedAt) : "Pool Account"}</span>
                    <div className="cockpit-footer-actions">
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="复制账号"
                        onClick={() => copyToClipboard(acc.email || acc.id, "Codex 账号")}
                      >
                        <IconCopy style={{ width: 13, height: 13 }} />
                      </button>
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="刷新额度"
                        onClick={() => void loadData({ refresh: true })}
                      >
                        <IconRefresh style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

      {/* SECTION 3: xAI Grok CLI Subscription */}
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {providerIconSrc("xai") && (
              <img src={providerIconSrc("xai")} alt="xAI" style={{ width: 18, height: 18 }} />
            )}
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              {t("subscriptions.grok.title")}
            </h3>
            <span className="badge badge-muted text-caption">{grokAccounts.length} Account</span>
          </div>

          <div className="cockpit-grid">
            {filteredGrok.map(account => {
              const isActive = account.id === grokActiveId || account.active;
              const label = account.email || account.alias || displayAccountId(account.id);
              return (
                <div key={account.id} className={`cockpit-card ${isActive ? "active" : ""}`}>
                  <div>
                    <div className="cockpit-card-head">
                      <div className="cockpit-card-identity">
                        <input type="checkbox" defaultChecked style={{ cursor: "pointer" }} />
                        <span className="cockpit-card-email" title={label}>
                          {label}
                        </span>
                        {isActive && <span className="cockpit-badge-active">当前</span>}
                        {typeof account.plan === "string" && account.plan.trim() && (
                          <span className="cockpit-badge-grok">
                            {account.plan.trim()}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ marginTop: 6, marginBottom: 10 }}>
                      <button
                        type="button"
                        className="cockpit-note-btn"
                        onClick={() => promptNote(account.id, account.alias)}
                      >
                        <IconTag style={{ width: 11, height: 11 }} /> 加备注
                      </button>
                    </div>

                    <div className="cockpit-dual-quota-box" style={{ gap: 10 }}>
                      {account.quotaUnavailable && account.quota == null ? (
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>
                          {t("pws.accountQuotaUnavailable")}
                        </span>
                      ) : account.quota != null ? (
                        <QuotaBars
                          quota={account.quota}
                          plan={account.plan ?? null}
                          threshold={80}
                          t={t}
                          layout="stacked"
                        />
                      ) : typeof account.plan === "string" && account.plan.trim() ? (
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>
                          {t("pws.accountPlanOnly", { plan: account.plan.trim() })}
                        </span>
                      ) : (
                        <QuotaBars quota={null} plan={null} threshold={80} t={t} layout="stacked" pending />
                      )}
                    </div>
                  </div>

                  <div className="cockpit-card-footer">
                    <span>{typeof account.quota?.updatedAt === "number" ? formatCardDate(account.quota.updatedAt) : formatCardDate(account.expiresAt)}</span>
                    <div className="cockpit-footer-actions">
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="复制 ID"
                        onClick={() => copyToClipboard(account.id, "Grok 账号")}
                      >
                        <IconCopy style={{ width: 13, height: 13 }} />
                      </button>
                      {!isActive && (
                        <button
                          type="button"
                          className="cockpit-icon-btn primary"
                          title="设为当前活跃账号"
                          disabled={switchingGrokId === account.id}
                          onClick={() => void handleSwitchGrok(account.id)}
                        >
                          <IconPlay style={{ width: 13, height: 13 }} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="刷新额度"
                        onClick={() => void loadData({ refresh: true })}
                      >
                        <IconRefresh style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

      {/* SECTION 4: Other Connected Providers */}
      {otherProviders.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              更多平台
            </h3>
            <span className="badge badge-muted text-caption">
              {totalOthersCount} Accounts
            </span>
          </div>

          <div className="cockpit-grid">
            {otherProviders.flatMap(p =>
              p.accounts.map(account => {
                const isActive = account.id === p.activeId || account.active;
                const label = account.email || account.alias || displayAccountId(account.id);
                return (
                  <div key={`${p.name}-${account.id}`} className={`cockpit-card ${isActive ? "active" : ""}`}>
                    <div>
                      <div className="cockpit-card-head">
                        <div className="cockpit-card-identity">
                          <input type="checkbox" defaultChecked style={{ cursor: "pointer" }} />
                          <span className="cockpit-card-email" title={label}>
                            {label}
                          </span>
                          {isActive && <span className="cockpit-badge-active">当前</span>}
                          <span className="cockpit-badge-pro">
                            {p.name.toUpperCase()}
                          </span>
                        </div>
                      </div>

                      <div style={{ marginTop: 6, marginBottom: 10 }}>
                        <button
                          type="button"
                          className="cockpit-note-btn"
                          onClick={() => promptNote(account.id, account.alias)}
                        >
                          <IconTag style={{ width: 11, height: 11 }} /> 加备注
                        </button>
                      </div>

                      <div className="cockpit-dual-quota-box" style={{ padding: "12px 14px" }}>
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>
                          已连接 {p.name} OAuth 账号
                        </span>
                      </div>
                    </div>

                    <div className="cockpit-card-footer">
                      <span>{formatCardDate(account.expiresAt)}</span>
                      <div className="cockpit-footer-actions">
                        <button
                          type="button"
                          className="cockpit-icon-btn"
                          title="复制 ID"
                          onClick={() => copyToClipboard(account.id, `${p.name} 账号`)}
                        >
                          <IconCopy style={{ width: 13, height: 13 }} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}
    </div>
  );
}
