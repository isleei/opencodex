/**
 * Top-of-Grok account + quota surface (Codex Auth–style).
 * xAI OAuth accounts and rate-limit bars live here so users need not dig into Providers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TFn } from "../i18n/shared";
import type { AccountQuota } from "../codex-quota-utils";
import { readJsonIfOk } from "../fetch-json";
import { displayAccountId } from "../lib/privacy";
import { LoginUrlBlock } from "./login-url-block";
import QuotaBars from "./QuotaBars";
import { Notice } from "../ui";
import {
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthBadgeClass,
  oauthHealthIsCooldown,
  oauthHealthShowsReauth,
  type OAuthHealthView,
} from "../oauth-health-display";

const PROVIDER = "xai";

interface GrokOAuthAccount {
  id: string;
  alias?: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
  plan?: string;
  quota?: AccountQuota | null;
  quotaUnavailable?: boolean;
  health?: OAuthHealthView;
}

interface LoginHint {
  url?: string;
  instructions?: string;
  deviceCode?: string;
}

function accountLabel(account: GrokOAuthAccount, t: TFn): string {
  return account.alias?.trim() || account.email?.trim() || displayAccountId(account.id) || t("grok.account.unnamed");
}

export default function GrokAccountQuota({ apiBase }: { apiBase: string }) {
  const t = useT();
  const aliveRef = useRef(true);
  const loginGenRef = useRef(0);
  const [accounts, setAccounts] = useState<GrokOAuthAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [loginHint, setLoginHint] = useState<LoginHint | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const loadAccounts = useCallback(async (opts?: { refresh?: boolean; soft?: boolean }) => {
    const refresh = opts?.refresh === true;
    if (!opts?.soft) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      // Cheap local list first so cards paint even when xAI billing is slow.
      const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${PROVIDER}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json() as { activeAccountId?: string | null; accounts?: GrokOAuthAccount[] };
      if (!aliveRef.current) return;
      setActiveAccountId(data.activeAccountId ?? null);
      setAccounts(data.accounts ?? []);
      setLoading(false);

      const quotaQs = refresh ? "&quota=1&refresh=1" : "&quota=1";
      const qRes = await fetch(`${apiBase}/api/oauth/accounts?provider=${PROVIDER}${quotaQs}`);
      if (!aliveRef.current) return;
      if (qRes.ok) {
        const qData = await qRes.json() as { activeAccountId?: string | null; accounts?: GrokOAuthAccount[] };
        setActiveAccountId(qData.activeAccountId ?? data.activeAccountId ?? null);
        setAccounts(qData.accounts ?? data.accounts ?? []);
      }
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : t("grok.account.loadFail"));
    } finally {
      if (aliveRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiBase, t]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const login = async (addAccount = false, accountId?: string) => {
    const gen = ++loginGenRef.current;
    setBusy(true);
    setFeedback(null);
    setLoginHint(null);
    try {
      const body: Record<string, unknown> = { provider: PROVIDER };
      if (addAccount || accountId) body.addAccount = true;
      if (accountId) {
        body.accountId = accountId;
        body.reauth = true;
      }
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (loginGenRef.current !== gen || !aliveRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setFeedback({ tone: "err", text: data.error || t("grok.account.loginFail") });
        return;
      }
      const data = await res.json() as LoginHint;
      if (data.url || data.instructions || data.deviceCode) setLoginHint(data);

      const baseline = accounts.length;
      for (let i = 0; i < 150 && aliveRef.current && loginGenRef.current === gen; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (loginGenRef.current !== gen || !aliveRef.current) return;
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${PROVIDER}`).catch(() => null);
        const s = sRes ? await readJsonIfOk<{
          loggedIn?: boolean;
          done?: boolean;
          error?: string;
          accounts?: GrokOAuthAccount[];
        }>(sRes) : null;
        if (!s) continue;
        if (s.error) {
          setFeedback({ tone: "err", text: s.error });
          setLoginHint(null);
          break;
        }
        const completed = addAccount || accountId
          ? ((s.accounts?.length ?? 0) > baseline || s.done === true)
          : (s.loggedIn === true || s.done === true);
        if (completed) {
          setFeedback({ tone: "ok", text: t("grok.account.loginOk") });
          setLoginHint(null);
          await loadAccounts({ refresh: true, soft: true });
          break;
        }
      }
    } catch (err) {
      if (aliveRef.current) {
        setFeedback({ tone: "err", text: err instanceof Error ? err.message : t("grok.account.loginFail") });
      }
    } finally {
      if (aliveRef.current && loginGenRef.current === gen) setBusy(false);
    }
  };

  const cancelLogin = async () => {
    loginGenRef.current += 1;
    setBusy(false);
    setLoginHint(null);
    try {
      await fetch(`${apiBase}/api/oauth/login/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: PROVIDER }),
      });
    } catch { /* ignore */ }
    setFeedback({ tone: "err", text: t("grok.account.loginCancelled") });
  };

  const switchAccount = async (accountId: string) => {
    setSwitchingId(accountId);
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: PROVIDER, accountId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || t("grok.account.switchFail"));
      }
      setFeedback({ tone: "ok", text: t("grok.account.switched") });
      await loadAccounts({ refresh: true, soft: true });
    } catch (err) {
      setFeedback({ tone: "err", text: err instanceof Error ? err.message : t("grok.account.switchFail") });
    } finally {
      if (aliveRef.current) setSwitchingId(null);
    }
  };

  const removeAccount = async (accountId: string) => {
    if (!window.confirm(t("grok.account.removeConfirm"))) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(PROVIDER)}&id=${encodeURIComponent(accountId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || t("grok.account.removeFail"));
      }
      setFeedback({ tone: "ok", text: t("grok.account.removed") });
      await loadAccounts({ soft: true });
    } catch (err) {
      setFeedback({ tone: "err", text: err instanceof Error ? err.message : t("grok.account.removeFail") });
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const loggedIn = accounts.length > 0;

  return (
    <section className="panel grok-account-panel" aria-label={t("grok.account.sectionAria")}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 className="panel-title" style={{ margin: 0 }}>{t("grok.account.title")}</h3>
          <p className="card-sub" style={{ margin: "6px 0 0" }}>{t("grok.account.subtitle")}</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={loading || refreshing || busy}
            onClick={() => void loadAccounts({ refresh: true, soft: true })}
          >
            {refreshing ? t("grok.account.refreshing") : t("grok.account.refreshQuota")}
          </button>
          {loggedIn ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || switchingId !== null}
              onClick={() => void login(true)}
            >
              {t("grok.account.addAccount")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void login(false)}
            >
              {busy ? t("grok.account.loggingIn") : t("grok.account.login")}
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div style={{ marginTop: 10 }}>
          <Notice tone={feedback.tone}>{feedback.text}</Notice>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 10 }}>
          <Notice tone="err">{error}</Notice>
        </div>
      )}

      {loginHint && (
        <div style={{ marginTop: 12 }}>
          {loginHint.url && <LoginUrlBlock url={loginHint.url} />}
          {loginHint.instructions && !loginHint.url && (
            <p className="muted small">{loginHint.instructions}</p>
          )}
          {loginHint.deviceCode && (
            <p className="muted small"><code>{loginHint.deviceCode}</code></p>
          )}
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => void cancelLogin()}>
            {t("grok.account.cancelLogin")}
          </button>
        </div>
      )}

      {loading && accounts.length === 0 ? (
        <p className="muted small" style={{ marginTop: 14 }}>{t("grok.account.loading")}</p>
      ) : !loggedIn ? (
        <p className="muted small" style={{ marginTop: 14 }}>{t("grok.account.empty")}</p>
      ) : (
        <ul className="pwi-auth-list" style={{ marginTop: 14 }}>
          {accounts.map(account => {
            const active = account.active || account.id === activeAccountId;
            const label = accountLabel(account, t);
            const showReauth = Boolean(account.needsReauth) || oauthHealthShowsReauth(account.health?.status);
            const inCooldown = oauthHealthIsCooldown(account.health?.status);
            const healthLabel = formatOAuthHealthLabel(t, account.health);
            const healthSummary = formatOAuthHealthSummary(t, PROVIDER, account.id, account.health);
            const switching = switchingId === account.id;
            return (
              <li key={account.id} className={`pwi-auth-acct${active ? " pwi-auth-acct--active" : ""}`}>
                <div className={`pwi-auth-row${active ? " pwi-auth-row--active" : ""}`}>
                  <button
                    type="button"
                    className="pwi-auth-row-main"
                    onClick={() => {
                      if (!active && !showReauth && !inCooldown && !switchingId) void switchAccount(account.id);
                    }}
                    aria-current={active ? "true" : undefined}
                    disabled={Boolean(showReauth || inCooldown || (switchingId && !switching) || busy)}
                  >
                    <span className={`pwi-auth-dot ${showReauth ? "pwi-auth-dot--warn" : active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                    <span className="pwi-auth-row-copy">
                      <span className="pwi-auth-row-label">{label}</span>
                      <span className="pwi-auth-row-secondary">
                        {[account.email, account.plan, `${t("prov.accountId")}: ${displayAccountId(account.id)}`].filter(Boolean).join(" · ")}
                      </span>
                      {healthSummary && <span className="pwi-auth-row-secondary faint">{healthSummary}</span>}
                      {inCooldown && <span className="pwi-auth-row-secondary faint">{t("pws.healthCooldownHint")}</span>}
                    </span>
                    {account.plan && <span className="badge badge-green">{account.plan}</span>}
                    {healthLabel && <span className={oauthHealthBadgeClass(account.health?.status)}>{healthLabel}</span>}
                    {showReauth && !healthLabel && <span className="badge badge-amber">{t("pws.reauth")}</span>}
                    {active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    {switching && <span className="badge badge-muted">{t("pws.accountSwitching")}</span>}
                  </button>
                  {showReauth && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || switchingId !== null}
                      onClick={() => void login(true, account.id)}
                    >
                      {t("pws.reauthenticate")}
                    </button>
                  )}
                  {!active && !showReauth && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || switchingId !== null}
                      onClick={() => void switchAccount(account.id)}
                    >
                      {t("grok.account.select")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy || switchingId !== null}
                    onClick={() => void removeAccount(account.id)}
                  >
                    {t("common.remove")}
                  </button>
                </div>
                <div className="pwi-auth-acct-quota">
                  {account.quotaUnavailable ? (
                    <p className="muted pwi-auth-acct-quota-stale">{t("pws.accountQuotaUnavailable")}</p>
                  ) : account.quota != null ? (
                    <QuotaBars
                      quota={account.quota}
                      plan={account.plan ?? null}
                      threshold={80}
                      t={t}
                      layout="stacked"
                    />
                  ) : account.plan ? (
                    <p className="muted pwi-auth-acct-quota-stale">
                      {t("pws.accountPlanOnly", { plan: account.plan })}
                    </p>
                  ) : (
                    <QuotaBars quota={null} plan={null} threshold={80} t={t} layout="stacked" pending />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
