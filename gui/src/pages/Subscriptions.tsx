import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  IconRefresh,
  IconTicket,
  IconGrid,
  IconList,
  IconSearch,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconPlay,
  IconInfo,
  IconTag,
  IconCalendar,
  IconTerminal,
  IconX,
} from "../icons";
import { providerIconSrc } from "../provider-icons";
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
  expiresAt?: number;
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
    shortPercent?: number;
    shortResetAt?: number;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    monthlyPercent?: number;
    monthlyResetAt?: number;
    resetCredits?: number;
    plan?: string;
    customWindows?: any[];
  } | null;
  quotaUnavailable?: boolean;
}

type TabType = "all" | "antigravity" | "codex" | "grok" | "others";

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

export default function Subscriptions({ apiBase }: { apiBase: string }) {
  const t = useT();
  const aliveRef = useRef(true);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Tabs & Filters
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSecretKey, setShowSecretKey] = useState(false);

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

  // Switch AGY active account and sync to native ~/.gemini/
  const handleSwitchAgy = async (accountId: string) => {
    if (switchingAgyId || accountId === agyActiveId) return;
    setSwitchingAgyId(accountId);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAgyActiveId(accountId);
      const target = agyAccounts.find(a => a.id === accountId);
      const name = target?.email || target?.alias || displayAccountId(accountId);
      setFeedback({ tone: "ok", text: `已切换至 ${name}` });
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

  // Filtering accounts by search term
  const filterMatch = (item: { email?: string; alias?: string; id?: string; label?: string }) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (
      (item.email && item.email.toLowerCase().includes(term)) ||
      (item.alias && item.alias.toLowerCase().includes(term)) ||
      (item.label && item.label.toLowerCase().includes(term)) ||
      (item.id && item.id.toLowerCase().includes(term))
    );
  };

  const filteredAgy = useMemo(() => agyAccounts.filter(filterMatch), [agyAccounts, searchTerm]);
  const filteredCodexMain = useMemo(() => (codexMain && filterMatch(codexMain) ? codexMain : null), [codexMain, searchTerm]);
  const filteredCodexPool = useMemo(() => codexPool.filter(filterMatch), [codexPool, searchTerm]);
  const filteredGrok = useMemo(() => grokAccounts.filter(filterMatch), [grokAccounts, searchTerm]);

  // Counts
  const totalCodexCount = (codexMain ? 1 : 0) + codexPool.length;
  const totalOthersCount = otherProviders.reduce((acc, p) => acc + p.accounts.length, 0);
  const totalAccountsCount = agyAccounts.length + totalCodexCount + grokAccounts.length + totalOthersCount;

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

      {/* Category Tabs (Cockpit category switcher) */}
      <div className="sub-tabs-strip">
        <button
          type="button"
          className={`sub-tab-item ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          全部平台
          <span className="sub-tab-badge">{totalAccountsCount}</span>
        </button>
        <button
          type="button"
          className={`sub-tab-item ${activeTab === "antigravity" ? "active" : ""}`}
          onClick={() => setActiveTab("antigravity")}
        >
          {providerIconSrc("google-antigravity") && (
            <img src={providerIconSrc("google-antigravity")} alt="AGY" style={{ width: 15, height: 15 }} />
          )}
          Antigravity
          <span className="sub-tab-badge">{agyAccounts.length}</span>
        </button>
        <button
          type="button"
          className={`sub-tab-item ${activeTab === "codex" ? "active" : ""}`}
          onClick={() => setActiveTab("codex")}
        >
          {providerIconSrc("openai") && (
            <img src={providerIconSrc("openai")} alt="Codex" style={{ width: 15, height: 15 }} />
          )}
          Codex
          <span className="sub-tab-badge">{totalCodexCount}</span>
        </button>
        <button
          type="button"
          className={`sub-tab-item ${activeTab === "grok" ? "active" : ""}`}
          onClick={() => setActiveTab("grok")}
        >
          {providerIconSrc("xai") && (
            <img src={providerIconSrc("xai")} alt="Grok" style={{ width: 15, height: 15 }} />
          )}
          Grok CLI
          <span className="sub-tab-badge">{grokAccounts.length}</span>
        </button>
        {otherProviders.length > 0 && (
          <button
            type="button"
            className={`sub-tab-item ${activeTab === "others" ? "active" : ""}`}
            onClick={() => setActiveTab("others")}
          >
            更多平台
            <span className="sub-tab-badge">{totalOthersCount}</span>
          </button>
        )}
      </div>

      {/* Cockpit Toolbar */}
      <div className="sub-toolbar">
        <div className="sub-toolbar-left">
          <div className="sub-search-wrap">
            <IconSearch className="sub-search-icon" />
            <input
              type="text"
              className="sub-search-input"
              placeholder="搜索账号..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>

          <div className="sub-view-toggle">
            <button
              type="button"
              className={`sub-view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title="网格视图"
            >
              <IconGrid style={{ width: 15, height: 15 }} />
            </button>
            <button
              type="button"
              className={`sub-view-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title="列表视图"
            >
              <IconList style={{ width: 15, height: 15 }} />
            </button>
          </div>

          <span className="sub-pill-badge">
            全部 ({activeTab === "antigravity" ? filteredAgy.length : activeTab === "codex" ? (filteredCodexMain ? 1 : 0) + filteredCodexPool.length : activeTab === "grok" ? filteredGrok.length : totalAccountsCount})
          </span>
        </div>
      </div>

      {/* SECTION 1: Google Antigravity (AGY) Dual-Column Matrix */}
      {(activeTab === "all" || activeTab === "antigravity") && (
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

          <div className={`cockpit-grid ${viewMode === "list" ? "cockpit-list" : ""}`}>
            {filteredAgy.map(account => {
              const isActive = account.id === agyActiveId;
              const isSwitching = switchingAgyId === account.id;
              const label = account.email || account.alias || displayAccountId(account.id);

              // Extract Claude and Gemini windows
              const customWindows = account.quota?.customWindows || [];
              const claWindow = customWindows.find((w: any) => w.label === "Cla");
              const gemWindow = customWindows.find((w: any) => w.label === "Gem");

              const claPercent = claWindow?.percent !== undefined ? Math.round(claWindow.percent) : 0;
              const claRemaining = 100 - claPercent;
              const gemPercent = gemWindow?.percent !== undefined ? Math.round(gemWindow.percent) : 0;
              const gemRemaining = 100 - gemPercent;

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
                        <span className="cockpit-badge-pro">PRO</span>
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

                    {/* Dual-Column Quota Box */}
                    <div className="cockpit-dual-quota-box">
                      <div className="cockpit-dual-columns">
                        {/* Column 1: Claude */}
                        <div className="cockpit-dual-col">
                          <div className="cockpit-col-title">
                            <span>Claude</span>
                          </div>

                          <div className="cockpit-quota-metric">
                            <div className="cockpit-metric-head">
                              <span className="cockpit-metric-label">5h</span>
                              <span className={`cockpit-metric-val ${claRemaining > 70 ? "green" : claRemaining > 30 ? "amber" : "red"}`}>
                                {claRemaining}%
                              </span>
                            </div>
                            <div className="cockpit-progress-bg">
                              <div
                                className={`cockpit-progress-fill ${claRemaining > 70 ? "green" : claRemaining > 30 ? "amber" : "red"}`}
                                style={{ width: `${claRemaining}%` }}
                              />
                            </div>
                            <span className="cockpit-metric-time">
                              {formatResetCountdown(claWindow?.resetAt)}
                            </span>
                          </div>

                          <div className="cockpit-quota-metric">
                            <div className="cockpit-metric-head">
                              <span className="cockpit-metric-label">Weekly</span>
                              <span className="cockpit-metric-val green">100%</span>
                            </div>
                            <div className="cockpit-progress-bg">
                              <div className="cockpit-progress-fill green" style={{ width: "100%" }} />
                            </div>
                            <span className="cockpit-metric-time">已重置</span>
                          </div>
                        </div>

                        {/* Column 2: Gemini */}
                        <div className="cockpit-dual-col">
                          <div className="cockpit-col-title">
                            <span>Gemini</span>
                          </div>

                          <div className="cockpit-quota-metric">
                            <div className="cockpit-metric-head">
                              <span className="cockpit-metric-label">5h</span>
                              <span className={`cockpit-metric-val ${gemRemaining > 70 ? "green" : gemRemaining > 30 ? "amber" : "red"}`}>
                                {gemRemaining}%
                              </span>
                            </div>
                            <div className="cockpit-progress-bg">
                              <div
                                className={`cockpit-progress-fill ${gemRemaining > 70 ? "green" : gemRemaining > 30 ? "amber" : "red"}`}
                                style={{ width: `${gemRemaining}%` }}
                              />
                            </div>
                            <span className="cockpit-metric-time">
                              {formatResetCountdown(gemWindow?.resetAt)}
                            </span>
                          </div>

                          <div className="cockpit-quota-metric">
                            <div className="cockpit-metric-head">
                              <span className="cockpit-metric-label">Weekly</span>
                              <span className="cockpit-metric-val green">100%</span>
                            </div>
                            <div className="cockpit-progress-bg">
                              <div className="cockpit-progress-fill green" style={{ width: "100%" }} />
                            </div>
                            <span className="cockpit-metric-time">已重置</span>
                          </div>
                        </div>
                      </div>

                      <div className="cockpit-credits-row">
                        <span>可用 AI 积分:</span>
                        <span style={{ fontWeight: 600 }}>—</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Bottom Footer */}
                  <div className="cockpit-card-footer">
                    <span>{formatCardDate(account.expiresAt)}</span>
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
                          disabled={isSwitching}
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
      )}

      {/* SECTION 2: OpenAI Codex Subscription & API Service */}
      {(activeTab === "all" || activeTab === "codex") && (
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
            {/* Left: API Service Card (Cockpit Style) */}
            <div className="cockpit-service-card">
              <div className="cockpit-service-head">
                <span className="cockpit-service-title">API 服务</span>
                <span className="cockpit-badge-active" style={{ background: "#10b981" }}>已启用</span>
              </div>

              <div className="cockpit-service-prop">
                <span style={{ color: "var(--muted)", fontWeight: 600 }}>服务端点</span>
                <div className="cockpit-service-val">
                  <span>http://127.0.0.1:10100/v1</span>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    onClick={() => copyToClipboard("http://127.0.0.1:10100/v1", "API 端点")}
                  >
                    <IconCopy style={{ width: 12, height: 12 }} />
                  </button>
                </div>
              </div>

              <div className="cockpit-service-prop">
                <span style={{ color: "var(--muted)", fontWeight: 600 }}>API 密钥</span>
                <div className="cockpit-service-val">
                  <span>{showSecretKey ? "agt_codex_7921bf38a209" : "agt_codex_••••••••••••"}</span>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    onClick={() => setShowSecretKey(!showSecretKey)}
                  >
                    {showSecretKey ? <IconEyeOff style={{ width: 12, height: 12 }} /> : <IconEye style={{ width: 12, height: 12 }} />}
                  </button>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    onClick={() => copyToClipboard("agt_codex_7921bf38a209", "API 密钥")}
                  >
                    <IconCopy style={{ width: 12, height: 12 }} />
                  </button>
                </div>
              </div>

              <div className="cockpit-service-prop">
                <span style={{ color: "var(--muted)", fontWeight: 600 }}>OAuth 绑定</span>
                <span className="badge badge-muted text-caption">已绑定 (Team)</span>
              </div>

              <div className="cockpit-service-prop">
                <span style={{ color: "var(--muted)", fontWeight: 600 }}>监听范围</span>
                <span style={{ fontWeight: 600 }}>仅本机</span>
              </div>

              <div className="cockpit-card-footer" style={{ marginTop: "auto" }}>
                <span>本地代理服务在线</span>
                <div className="cockpit-footer-actions">
                  <button type="button" className="cockpit-icon-btn" title="终端指令">
                    <IconTerminal style={{ width: 13, height: 13 }} />
                  </button>
                  <button
                    type="button"
                    className="cockpit-icon-btn"
                    title="刷新状态"
                    onClick={() => void loadData({ refresh: true })}
                  >
                    <IconRefresh style={{ width: 13, height: 13 }} />
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Main Codex Account Card */}
            {filteredCodexMain ? (
              <div className="cockpit-card active">
                <div>
                  <div className="cockpit-card-head">
                    <div className="cockpit-card-identity">
                      <input type="checkbox" defaultChecked style={{ cursor: "pointer" }} />
                      <span className="cockpit-card-email" title={filteredCodexMain.email}>
                        {filteredCodexMain.email || "ankh_lamp05@icloud.com"}
                      </span>
                      <span className="cockpit-badge-active">当前</span>
                      <span className="cockpit-badge-team">
                        {(filteredCodexMain.plan || "TEAM").toUpperCase()}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 10px 0", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Team Name: MyTeam</span>
                    <button
                      type="button"
                      className="cockpit-note-btn"
                      onClick={() => promptNote(filteredCodexMain.id)}
                    >
                      <IconTag style={{ width: 11, height: 11 }} /> 加备注
                    </button>
                    {(filteredCodexMain.quota?.resetCredits ?? 2) > 0 && (
                      <span className="cockpit-badge-ticket" title="可用充能卡券">
                        <IconTicket style={{ width: 12, height: 12 }} />
                        重置 {filteredCodexMain.quota?.resetCredits ?? 2}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
                    使用 passkey 登录 | 用户 ID: 102***88c
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

                  {/* Expiry Banner */}
                  <div style={{
                    marginTop: 10,
                    background: "rgba(245, 158, 11, 0.08)",
                    border: "1px solid rgba(245, 158, 11, 0.25)",
                    borderRadius: "var(--radius-md)",
                    padding: "8px 12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "#d97706",
                    fontWeight: 600,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <IconCalendar style={{ width: 13, height: 13 }} />
                      <span>订阅有效期 6天</span>
                    </div>
                    <span className="mono" style={{ fontSize: 11 }}>2026-09-10 15:17</span>
                  </div>
                </div>

                <div className="cockpit-card-footer">
                  <span>2026/09/04 17:36</span>
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
                    <span>Pool Account</span>
                    <div className="cockpit-footer-actions">
                      <button
                        type="button"
                        className="cockpit-icon-btn"
                        title="复制 ID"
                        onClick={() => copyToClipboard(acc.id, "账号 ID")}
                      >
                        <IconCopy style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* SECTION 3: xAI Grok CLI Subscription */}
      {(activeTab === "all" || activeTab === "grok") && (
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

          {/* Grok CLI Explanation Notice Banner (Screenshot 3) */}
          <div className="cockpit-grok-notice">
            <div className="cockpit-grok-notice-title">
              <IconInfo style={{ width: 15, height: 15 }} />
              <span>Grok CLI 账号管理说明</span>
            </div>
            <div>
              默认使用独立 GROK_HOME；开启“切号同步官方登录”后，默认实例切换 OAuth 账号会写入官方 ~/.grok/auth.json。
            </div>
            <ul>
              <li>本地范围：可读取默认 ~/.grok/auth.json 用于导入；仅在开关开启且默认实例切换 OAuth 账号时写入该文件。</li>
              <li>网络范围：OAuth 授权、凭据刷新及账号用量查询；不会上传凭据到云端服务。</li>
            </ul>
          </div>

          <div className={`cockpit-grid ${viewMode === "list" ? "cockpit-list" : ""}`}>
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
                        <span className="cockpit-badge-grok">
                          {account.plan || "Grok Pro"}
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

                    <div className="cockpit-dual-quota-box" style={{ gap: 10 }}>
                      <div className="cockpit-quota-metric">
                        <div className="cockpit-metric-head">
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <IconCalendar style={{ width: 12, height: 12, color: "var(--muted)" }} />
                            <span className="cockpit-metric-label">每周用量</span>
                          </div>
                          <span className="cockpit-metric-val green">剩余 89%</span>
                        </div>
                        <div className="cockpit-progress-bg">
                          <div className="cockpit-progress-fill green" style={{ width: "89%" }} />
                        </div>
                        <span className="cockpit-metric-time">2026/9/7 13:47:16</span>
                      </div>

                      <div className="cockpit-quota-metric">
                        <div className="cockpit-metric-head">
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <IconCalendar style={{ width: 12, height: 12, color: "var(--muted)" }} />
                            <span className="cockpit-metric-label">GrokBuild</span>
                          </div>
                          <span className="cockpit-metric-val green">剩余 90%</span>
                        </div>
                        <div className="cockpit-progress-bg">
                          <div className="cockpit-progress-fill green" style={{ width: "90%" }} />
                        </div>
                        <span className="cockpit-metric-time">2026/9/7 13:47:16</span>
                      </div>

                      <div className="cockpit-quota-metric">
                        <div className="cockpit-metric-head">
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <IconCalendar style={{ width: 12, height: 12, color: "var(--muted)" }} />
                            <span className="cockpit-metric-label">GrokChat</span>
                          </div>
                          <span className="cockpit-metric-val green">剩余 99%</span>
                        </div>
                        <div className="cockpit-progress-bg">
                          <div className="cockpit-progress-fill green" style={{ width: "99%" }} />
                        </div>
                        <span className="cockpit-metric-time">2026/9/7 13:47:16</span>
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", paddingTop: 4, borderTop: "1px dashed var(--border)" }}>
                        <span>高频任务</span>
                        <span style={{ fontWeight: 600, color: "#10b981" }}>0/10 · 剩余 100%</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)" }}>
                        <span>普通任务</span>
                        <span style={{ fontWeight: 600, color: "#10b981" }}>0/30 · 剩余 100%</span>
                      </div>
                    </div>
                  </div>

                  <div className="cockpit-card-footer">
                    <span>{formatCardDate(account.expiresAt)}</span>
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
      )}

      {/* SECTION 4: Other Connected Providers */}
      {(activeTab === "all" || activeTab === "others") && otherProviders.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              更多平台
            </h3>
            <span className="badge badge-muted text-caption">
              {totalOthersCount} Accounts
            </span>
          </div>

          <div className={`cockpit-grid ${viewMode === "list" ? "cockpit-list" : ""}`}>
            {otherProviders.flatMap(p =>
              p.accounts.filter(filterMatch).map(account => {
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
