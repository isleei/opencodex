import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  IconCreditCard,
  IconRefresh,
  IconCheck,
  IconAlert,
  IconTicket,
  IconServer,
} from "../icons";
import QuotaBars from "../components/QuotaBars";
import { formatProviderDisplayName, providerIconSrc } from "../provider-icons";
import { displayAccountId } from "../lib/privacy";
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
  health?: { status?: string; message?: string };
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
    weeklyPercent?: number;
    weeklyResetAt?: number;
    resetCredits?: number;
    plan?: string;
    customWindows?: any[];
  } | null;
  quotaUnavailable?: boolean;
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

  // Codex state
  const [codexMain, setCodexMain] = useState<CodexAccountSummary | null>(null);
  const [codexPool, setCodexPool] = useState<CodexAccountSummary[]>([]);

  // Grok state
  const [grokAccounts, setGrokAccounts] = useState<OAuthAccount[]>([]);
  const [grokActiveId, setGrokActiveId] = useState<string | null>(null);
  const [switchingGrokId, setSwitchingGrokId] = useState<string | null>(null);

  // Other connected OAuth providers with quotas
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

  const loadData = useCallback(async (opts?: { refresh?: boolean }) => {
    const isRefresh = opts?.refresh === true;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const qs = isRefresh ? "&quota=1&refresh=1" : "&quota=1";

    try {
      // 1. Fetch Google Antigravity (AGY) accounts & quotas
      const agyPromise = fetch(`${apiBase}/api/oauth/accounts?provider=google-antigravity${qs}`)
        .then(async r => (r.ok ? r.json() : null))
        .catch(() => null);

      // 2. Fetch Codex accounts & quotas
      const codexPromise = fetch(`${apiBase}/api/codex-auth/accounts${isRefresh ? "?refresh=1" : ""}`)
        .then(async r => (r.ok ? r.json() : null))
        .catch(() => null);

      // 3. Fetch xAI Grok accounts & quotas
      const grokPromise = fetch(`${apiBase}/api/oauth/accounts?provider=xai${qs}`)
        .then(async r => (r.ok ? r.json() : null))
        .catch(() => null);

      // 4. Fetch other supported OAuth providers (Anthropic, Kiro, Meta Muse)
      const others = ["anthropic", "kiro", "meta-muse"];
      const otherPromises = others.map(async name => {
        const data = await fetch(`${apiBase}/api/oauth/accounts?provider=${name}${qs}`)
          .then(async r => (r.ok ? r.json() : null))
          .catch(() => null);
        return { name, data };
      });

      const [agyRes, codexRes, grokRes, otherResults] = await Promise.all([
        agyPromise,
        codexPromise,
        grokPromise,
        Promise.all(otherPromises),
      ]);

      if (!aliveRef.current) return;

      // Handle AGY
      if (agyRes && Array.isArray(agyRes.accounts)) {
        setAgyActiveId(agyRes.activeAccountId ?? null);
        setAgyAccounts(agyRes.accounts);
      }

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

      // Handle Grok
      if (grokRes && Array.isArray(grokRes.accounts)) {
        setGrokActiveId(grokRes.activeAccountId ?? null);
        setGrokAccounts(grokRes.accounts);
      }

      // Handle Other Providers
      const populatedOthers = otherResults
        .filter(o => o.data && Array.isArray(o.data.accounts) && o.data.accounts.length > 0)
        .map(o => ({
          name: o.name,
          accounts: o.data.accounts,
          activeId: o.data.activeAccountId ?? null,
        }));
      setOtherProviders(populatedOthers);

      setLastUpdated(new Date());
    } catch (e) {
      if (aliveRef.current) {
        setFeedback({ tone: "err", text: String(e) });
      }
    } finally {
      if (aliveRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiBase]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Switch AGY active account
  const handleSwitchAgy = async (accountId: string) => {
    if (switchingAgyId || accountId === agyActiveId) return;
    setSwitchingAgyId(accountId);
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || "Failed to switch account");

      const target = agyAccounts.find(a => a.id === accountId);
      const name = target?.email || target?.label || displayAccountId(accountId);
      setAgyActiveId(accountId);
      setFeedback({
        tone: "ok",
        text: t("subscriptions.switchSuccess", { account: name }),
      });
      // Soft refresh
      void loadData({ refresh: false });
    } catch (err) {
      setFeedback({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSwitchingAgyId(null);
    }
  };

  // Switch Grok active account
  const handleSwitchGrok = async (accountId: string) => {
    if (switchingGrokId || accountId === grokActiveId) return;
    setSwitchingGrokId(accountId);
    setFeedback(null);
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
      setFeedback({
        tone: "ok",
        text: t("subscriptions.switchSuccess", { account: name }),
      });
      void loadData({ refresh: false });
    } catch (err) {
      setFeedback({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSwitchingGrokId(null);
    }
  };

  // Calculate totals
  const totalSubscriptions = (codexMain ? 1 : 0) + (grokAccounts.length > 0 ? 1 : 0) + (agyAccounts.length > 0 ? 1 : 0) + otherProviders.length;
  const totalAccounts = (codexMain ? 1 + codexPool.length : 0) + grokAccounts.length + agyAccounts.length + otherProviders.reduce((acc, p) => acc + p.accounts.length, 0);

  return (
    <div className="sub-shell">
      {/* Header */}
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

      {/* Feedback Toast / Notice */}
      {feedback && (
        <div
          role="status"
          style={{
            padding: "10px 16px",
            borderRadius: "var(--radius-md)",
            background: feedback.tone === "ok" ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
            color: feedback.tone === "ok" ? "#10b981" : "var(--red, #ef4444)",
            border: `1px solid ${feedback.tone === "ok" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {feedback.tone === "ok" ? <IconCheck width={15} height={15} /> : <IconAlert width={15} height={15} />}
          {feedback.text}
        </div>
      )}

      {/* Stats Summary Bar */}
      <div className="sub-stats-bar">
        <div className="sub-stat-card">
          <span className="sub-stat-label">{t("subscriptions.title")}</span>
          <span className="sub-stat-value">
            <IconCreditCard width={20} height={20} style={{ color: "var(--primary)" }} />
            {totalSubscriptions}
          </span>
        </div>
        <div className="sub-stat-card">
          <span className="sub-stat-label">{t("subscriptions.totalAccounts")}</span>
          <span className="sub-stat-value">
            <IconServer width={20} height={20} style={{ color: "var(--primary)" }} />
            {totalAccounts}
          </span>
        </div>
        <div className="sub-stat-card">
          <span className="sub-stat-label">{t("subscriptions.agyAccounts")}</span>
          <span className="sub-stat-value" style={{ color: agyAccounts.length >= 4 ? "var(--primary)" : undefined }}>
            {agyAccounts.length}
          </span>
        </div>
      </div>

      {/* SECTION 1: Google Antigravity (AGY) 4-Account Matrix */}
      <section className="sub-section">
        <div className="sub-section-header">
          <div className="sub-section-title-wrap">
            {providerIconSrc("google-antigravity") && (
              <img
                src={providerIconSrc("google-antigravity")}
                alt="Antigravity"
                style={{ width: 22, height: 22, borderRadius: 4 }}
              />
            )}
            <h3 className="sub-section-title">{t("subscriptions.agy.title")}</h3>
            <span className="badge badge-primary">{agyAccounts.length} Accounts</span>
          </div>
          <p className="sub-section-desc">
            {t("subscriptions.agy.desc", { count: String(agyAccounts.length) })}
          </p>
        </div>

        {loading && agyAccounts.length === 0 ? (
          <div className="pwi-auth-state" role="status">
            <span className="sub-spin" style={{ display: "inline-block", marginRight: 8 }}>⟳</span>
            {t("subscriptions.refreshing")}
          </div>
        ) : agyAccounts.length === 0 ? (
          <div className="sub-stat-card" style={{ textAlign: "center", padding: 24 }}>
            <p className="muted">{t("subscriptions.noAccounts")}</p>
          </div>
        ) : (
          <div className="sub-agy-grid">
            {agyAccounts.map((account, idx) => {
              const isActive = account.id === agyActiveId || account.active;
              const isSwitching = switchingAgyId === account.id;
              const label = account.alias?.trim() || account.email?.trim() || `Account ${idx + 1}`;
              const maskedId = displayAccountId(account.id);

              return (
                <div
                  key={account.id}
                  className={`sub-acct-card${isActive ? " sub-acct-card--active" : ""}`}
                >
                  <div className="sub-acct-head">
                    <div className="sub-acct-info">
                      <span className="sub-acct-name" title={account.email || account.id}>
                        {label}
                      </span>
                      <span className="sub-acct-id mono">{maskedId}</span>
                    </div>
                    {isActive ? (
                      <span className="sub-badge-active">
                        <IconCheck width={12} height={12} /> {t("subscriptions.agy.currentlyActive")}
                      </span>
                    ) : (
                      <span className="badge badge-muted">Standby #{idx + 1}</span>
                    )}
                  </div>

                  {/* Quota Bars Display */}
                  <div className="sub-acct-quota-box">
                    {account.quotaUnavailable ? (
                      <p className="muted text-caption" style={{ margin: 0, textAlign: "center" }}>
                        {t("pws.accountQuotaUnavailable")}
                      </p>
                    ) : account.quota != null ? (
                      <QuotaBars
                        quota={account.quota}
                        plan={account.plan ?? null}
                        threshold={80}
                        t={t}
                        layout="stacked"
                      />
                    ) : (
                      <QuotaBars
                        quota={null}
                        plan={null}
                        threshold={80}
                        t={t}
                        layout="stacked"
                        pending
                      />
                    )}
                  </div>

                  {/* Quick Action Button */}
                  <div className="sub-acct-actions">
                    {isActive ? (
                      <button
                        type="button"
                        className="btn btn-ghost sub-switch-btn"
                        disabled
                        style={{ background: "rgba(16, 185, 129, 0.08)", color: "#10b981", cursor: "default" }}
                      >
                        <IconCheck width={14} height={14} /> {t("subscriptions.agy.currentlyActive")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary sub-switch-btn"
                        disabled={Boolean(switchingAgyId)}
                        onClick={() => void handleSwitchAgy(account.id)}
                      >
                        {isSwitching ? (
                          <>
                            <span className="sub-spin" style={{ display: "inline-block" }}>⟳</span>
                            {t("subscriptions.agy.switching")}
                          </>
                        ) : (
                          t("subscriptions.agy.setActive")
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* SECTION 2 & 3: Codex & Grok Overview Grid */}
      <div className="sub-providers-grid">
        {/* OpenAI Codex Card */}
        <div className="sub-provider-card">
          <div className="sub-provider-head">
            <div className="sub-provider-brand">
              {providerIconSrc("openai") && (
                <img
                  src={providerIconSrc("openai")}
                  alt="OpenAI"
                  style={{ width: 22, height: 22, borderRadius: 4 }}
                />
              )}
              <h3 className="sub-provider-title">{t("subscriptions.codex.title")}</h3>
            </div>
            {codexMain?.plan && (
              <span className="badge badge-green" style={{ textTransform: "capitalize" }}>
                {codexMain.plan}
              </span>
            )}
          </div>

          <div className="sub-provider-body">
            {codexMain ? (
              <>
                <div className="sub-provider-plan-row">
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {codexMain.email || codexMain.label || t("codexAuth.mainAccount")}
                    </span>
                    <div className="mono text-caption muted">{displayAccountId(codexMain.id)}</div>
                  </div>
                  {(codexMain.quota?.resetCredits ?? 0) > 0 && (
                    <span
                      className="badge badge-amber"
                      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                      title={t("subscriptions.codex.tickets", { count: String(codexMain.quota?.resetCredits) })}
                    >
                      <IconTicket width={13} height={13} />
                      {t("subscriptions.codex.tickets", { count: String(codexMain.quota?.resetCredits) })}
                    </span>
                  )}
                </div>

                <div className="sub-acct-quota-box" style={{ background: "var(--surface)" }}>
                  {codexMain.quota ? (
                    <QuotaBars
                      quota={codexMain.quota as any}
                      plan={codexMain.plan ?? null}
                      threshold={80}
                      t={t}
                      layout="stacked"
                    />
                  ) : (
                    <QuotaBars
                      quota={null}
                      plan={null}
                      threshold={80}
                      t={t}
                      layout="stacked"
                      pending
                    />
                  )}
                </div>

                {/* Pool Accounts if any */}
                {codexPool.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="text-caption muted" style={{ marginBottom: 6, fontWeight: 600 }}>
                      {t("codexAuth.accountPool")} ({codexPool.length})
                    </div>
                    <div style={{ background: "var(--background)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)" }}>
                      {codexPool.map(acc => (
                        <div key={acc.id} className="sub-pool-account-row">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 12, fontWeight: 500 }}>
                              {acc.email || acc.label || displayAccountId(acc.id)}
                            </span>
                            {acc.plan && <span className="badge badge-muted text-caption">{acc.plan}</span>}
                          </div>
                          {acc.quota && (
                            <QuotaBars
                              quota={acc.quota as any}
                              plan={acc.plan}
                              threshold={80}
                              t={t}
                              layout="stacked"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="muted" style={{ textAlign: "center", margin: 20 }}>
                {t("subscriptions.noAccounts")}
              </p>
            )}
          </div>
        </div>

        {/* xAI Grok Card */}
        <div className="sub-provider-card">
          <div className="sub-provider-head">
            <div className="sub-provider-brand">
              {providerIconSrc("xai") && (
                <img
                  src={providerIconSrc("xai")}
                  alt="xAI Grok"
                  style={{ width: 22, height: 22, borderRadius: 4 }}
                />
              )}
              <h3 className="sub-provider-title">{t("subscriptions.grok.title")}</h3>
            </div>
            {grokAccounts.find(a => a.id === grokActiveId)?.plan && (
              <span className="badge badge-green" style={{ textTransform: "capitalize" }}>
                {grokAccounts.find(a => a.id === grokActiveId)?.plan}
              </span>
            )}
          </div>

          <div className="sub-provider-body">
            {grokAccounts.length > 0 ? (
              grokAccounts.map((account, idx) => {
                const isActive = account.id === grokActiveId || account.active;
                const isSwitching = switchingGrokId === account.id;
                const label = account.alias?.trim() || account.email?.trim() || `Grok #${idx + 1}`;

                return (
                  <div
                    key={account.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      padding: 12,
                      background: "var(--surface-soft, var(--background))",
                      borderRadius: "var(--radius-md)",
                      border: `1px solid ${isActive ? "var(--primary)" : "var(--border)"}`,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
                        <div className="mono text-caption muted">{displayAccountId(account.id)}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isActive ? (
                          <span className="sub-badge-active">
                            <IconCheck width={12} height={12} /> {t("subscriptions.agy.currentlyActive")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={Boolean(switchingGrokId)}
                            onClick={() => void handleSwitchGrok(account.id)}
                          >
                            {isSwitching ? "…" : t("subscriptions.agy.setActive")}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="sub-acct-quota-box" style={{ background: "var(--surface)" }}>
                      {account.quota ? (
                        <QuotaBars
                          quota={account.quota}
                          plan={account.plan ?? null}
                          threshold={80}
                          t={t}
                          layout="stacked"
                        />
                      ) : (
                        <QuotaBars
                          quota={null}
                          plan={null}
                          threshold={80}
                          t={t}
                          layout="stacked"
                          pending
                        />
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="muted" style={{ textAlign: "center", margin: 20 }}>
                {t("subscriptions.noAccounts")}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* SECTION 4: Other Connected OAuth Subscriptions (if any) */}
      {otherProviders.length > 0 && (
        <section className="sub-section">
          <div className="sub-section-header">
            <h3 className="sub-section-title">{t("subscriptions.other.title")}</h3>
          </div>
          <div className="sub-providers-grid">
            {otherProviders.map(p => (
              <div key={p.name} className="sub-provider-card">
                <div className="sub-provider-head">
                  <div className="sub-provider-brand">
                    {providerIconSrc(p.name) && (
                      <img
                        src={providerIconSrc(p.name)}
                        alt={p.name}
                        style={{ width: 22, height: 22, borderRadius: 4 }}
                      />
                    )}
                    <h4 className="sub-provider-title">{formatProviderDisplayName(p.name, t)}</h4>
                  </div>
                </div>
                <div className="sub-provider-body">
                  {p.accounts.map(acc => (
                    <div key={acc.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{acc.email || acc.label || acc.id}</span>
                        {acc.plan && <span className="badge badge-muted text-caption">{acc.plan}</span>}
                      </div>
                      {acc.quota && (
                        <QuotaBars
                          quota={acc.quota}
                          plan={acc.plan}
                          threshold={80}
                          t={t}
                          layout="stacked"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
