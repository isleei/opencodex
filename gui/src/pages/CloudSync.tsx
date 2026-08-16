/**
 * OneDrive cloud backup/restore for ~/.opencodex.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconAlert, IconCheck, IconExternal, IconLock, IconRefresh } from "../icons";

interface CloudStatus {
  clientId: string | null;
  hasClientSecret?: boolean;
  loggedIn: boolean;
  account: string | null;
  deviceId: string;
  deviceName: string;
  lastSyncAt: string | null;
  lastSyncDirection: "push" | "pull" | null;
  remoteRoot: string;
  includeUsage: boolean;
  includeVault: boolean;
  loopbackPort?: number;
  azureRedirectUri?: string;
  remoteManifest: {
    updatedAt?: string;
    deviceName?: string;
    files?: string[];
    hasVault?: boolean;
  } | null;
  remoteError: string | null;
}

interface LoginStart {
  mode?: "browser" | "device";
  userCode?: string;
  authUrl?: string;
  redirectUri?: string;
  verificationUri?: string;
  verificationUriComplete?: string | null;
  message?: string;
  interval?: number;
}

export default function CloudSync({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [includeUsage, setIncludeUsage] = useState(false);
  const [includeVault, setIncludeVault] = useState(true);

  const [login, setLogin] = useState<LoginStart | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/cloud-sync/status`);
      const data = await res.json() as CloudStatus & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data);
      if (data.clientId && !clientIdInput) setClientIdInput(data.clientId);
      setIncludeUsage(data.includeUsage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, clientIdInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/cloud-sync/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CloudStatus;
        if (cancelled) return;
        setStatus(data);
        if (data.clientId && !clientIdInput) setClientIdInput(data.clientId);
        setIncludeUsage(data.includeUsage);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, clientIdInput]);

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
  }, []);

  const saveClientId = async () => {
    const id = clientIdInput.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: { clientId: string; clientSecret?: string } = { clientId: id };
      // Only update secret when the user typed a new value (omit key = keep existing).
      if (clientSecretInput.trim().length > 0) {
        payload.clientSecret = clientSecretInput.trim();
      }
      const res = await fetch(`${apiBase}/api/cloud-sync/client-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { error?: string; hasClientSecret?: boolean };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setClientSecretInput("");
      setNotice(
        data.hasClientSecret ? t("cloud.clientIdSecretSaved") : t("cloud.clientIdSaved"),
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stopPoll = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startLogin = async (mode: "browser" | "device" = "browser") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    stopPoll();
    try {
      const res = await fetch(`${apiBase}/api/cloud-sync/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientIdInput.trim() || undefined, mode }),
      });
      const data = await res.json() as LoginStart & { error?: string; interval?: number };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setLogin({ ...data, mode: data.mode || mode });
      const url = data.authUrl || data.verificationUriComplete || data.verificationUri;
      if (url) window.open(url, "_blank", "noopener,noreferrer");

      const intervalMs = Math.max(2, data.interval ?? 2) * 1000;
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const poll = await fetch(`${apiBase}/api/cloud-sync/login/poll`, { method: "POST" });
            const body = await poll.json() as { ok?: boolean; pending?: boolean; account?: string; error?: string };
            if (body.pending) return;
            stopPoll();
            if (body.ok) {
              setLogin(null);
              setNotice(t("cloud.loginOk", { account: body.account || "—" }));
              await refresh();
            } else {
              setError(body.error || t("cloud.loginFailed"));
              setLogin(null);
            }
          } catch (e) {
            stopPoll();
            setError(e instanceof Error ? e.message : String(e));
            setLogin(null);
          }
        })();
      }, intervalMs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`${apiBase}/api/cloud-sync/logout`, { method: "POST" });
      setNotice(t("cloud.logoutOk"));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const push = async () => {
    if (includeVault && passphrase.trim().length < 8) {
      setError(t("cloud.passphraseShort"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/cloud-sync/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passphrase: includeVault ? passphrase : undefined,
          includeUsage,
          noVault: !includeVault,
        }),
      });
      const data = await res.json() as { error?: string; files?: string[]; hasVault?: boolean };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNotice(t("cloud.pushOk", { files: (data.files ?? []).join(", ") }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pull = async () => {
    if (!window.confirm(t("cloud.pullConfirm"))) return;
    if (status?.remoteManifest?.hasVault && passphrase.trim().length < 8) {
      setError(t("cloud.passphraseShort"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/cloud-sync/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yes: true,
          passphrase: passphrase.trim() || undefined,
          includeUsage,
        }),
      });
      const data = await res.json() as { error?: string; files?: string[] };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNotice(t("cloud.pullOk", { files: (data.files ?? []).join(", ") }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return <div className="page-head"><p className="muted">{t("common.loading")}</p></div>;
  }

  return (
    <div className="cloud-sync-page">
      <div className="page-head">
        <h2>{t("nav.cloud")}</h2>
      </div>
      <p className="page-sub">{t("cloud.subtitle")}</p>

      {error && (
        <div className="notice notice-err" role="alert" style={{ marginBottom: 16 }}>
          <IconAlert /><span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="notice notice-ok" role="status" style={{ marginBottom: 16 }}>
          <IconCheck /><span>{notice}</span>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="spread">
          <div>
            <div className="font-semibold">{t("cloud.statusTitle")}</div>
            <div className="muted text-control" style={{ marginTop: 4 }}>{t("cloud.statusHint")}</div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={busy}>
            <IconRefresh /> {t("common.retry")}
          </button>
        </div>
        <dl className="kv-list" style={{ marginTop: 14 }}>
          <div><dt>{t("cloud.loggedIn")}</dt><dd>{status?.loggedIn ? t("common.ok") : t("cloud.notLoggedIn")}</dd></div>
          {status?.account && <div><dt>{t("cloud.account")}</dt><dd className="mono">{status.account}</dd></div>}
          <div><dt>{t("cloud.device")}</dt><dd className="mono">{status?.deviceName} ({status?.deviceId})</dd></div>
          <div><dt>{t("cloud.remote")}</dt><dd className="mono">{status?.remoteRoot}</dd></div>
          <div><dt>{t("cloud.lastSync")}</dt><dd>{status?.lastSyncAt ? `${status.lastSyncAt} (${status.lastSyncDirection ?? "—"})` : t("cloud.never")}</dd></div>
          {status?.remoteManifest && (
            <div>
              <dt>{t("cloud.remoteManifest")}</dt>
              <dd className="mono">
                {status.remoteManifest.updatedAt ?? "—"} · {status.remoteManifest.deviceName ?? "—"}
                {status.remoteManifest.hasVault ? ` · ${t("cloud.hasVault")}` : ""}
              </dd>
            </div>
          )}
          {status?.remoteError && (
            <div><dt>{t("cloud.remoteError")}</dt><dd className="muted">{status.remoteError}</dd></div>
          )}
        </dl>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="font-semibold">{t("cloud.clientIdTitle")}</div>
        <p className="muted text-control" style={{ marginTop: 6 }}>{t("cloud.clientIdHint")}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 280px", minWidth: 200 }}
            value={clientIdInput}
            onChange={e => setClientIdInput(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            autoComplete="off"
            disabled={busy}
          />
          <button type="button" className="btn btn-primary" onClick={() => void saveClientId()} disabled={busy || !clientIdInput.trim()}>
            {t("common.save")}
          </button>
        </div>
        <label className="field" style={{ display: "block", marginTop: 12 }}>
          <span className="muted text-label">{t("cloud.clientSecret")}</span>
          <input
            className="input"
            type="password"
            style={{ marginTop: 6, width: "100%", maxWidth: 420 }}
            value={clientSecretInput}
            onChange={e => setClientSecretInput(e.target.value)}
            placeholder={status?.hasClientSecret ? t("cloud.clientSecretSet") : t("cloud.clientSecretPlaceholder")}
            autoComplete="new-password"
            disabled={busy}
          />
          <span className="muted text-label" style={{ display: "block", marginTop: 6 }}>{t("cloud.clientSecretHint")}</span>
        </label>
        <div className="notice notice-ok" style={{ marginTop: 14 }} role="note">
          <div>
            <div className="font-semibold">{t("cloud.redirectUriTitle")}</div>
            <p className="muted text-control" style={{ margin: "6px 0 8px" }}>{t("cloud.redirectUriHint")}</p>
            <code className="mono" style={{ fontSize: "1rem", userSelect: "all" }}>
              {status?.azureRedirectUri || "http://localhost:18765"}
            </code>
            <p className="muted text-label" style={{ marginTop: 8 }}>{t("cloud.redirectUriWhere")}</p>
          </div>
        </div>
        <p className="muted text-label" style={{ marginTop: 10 }}>
          <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">
            {t("cloud.azurePortal")} <IconExternal style={{ width: 12, height: 12, verticalAlign: "middle" }} />
          </a>
          {" · "}
          {t("cloud.azureSteps")}
        </p>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="font-semibold">{t("cloud.loginTitle")}</div>
        <p className="muted text-control" style={{ marginTop: 6 }}>{t("cloud.loginHint")}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {!status?.loggedIn ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void startLogin("browser")} disabled={busy}>
                <IconLock style={{ width: 14, height: 14 }} /> {t("cloud.login")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void startLogin("device")} disabled={busy}>
                {t("cloud.loginDevice")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => void logout()} disabled={busy}>
              {t("cloud.logout")}
            </button>
          )}
        </div>
        {login && (
          <div className="notice notice-ok" style={{ marginTop: 14 }} role="status">
            <div>
              {login.mode === "device" && login.userCode ? (
                <>
                  <div className="font-semibold">{t("cloud.deviceCodeTitle")}</div>
                  <p style={{ margin: "8px 0 0" }}>
                    {t("cloud.deviceCodeHint")}{" "}
                    <a href={login.verificationUriComplete || login.verificationUri} target="_blank" rel="noreferrer">
                      {login.verificationUri}
                    </a>
                  </p>
                  <p className="mono" style={{ fontSize: "1.4rem", letterSpacing: "0.12em", margin: "10px 0 0" }}>
                    {login.userCode}
                  </p>
                </>
              ) : (
                <>
                  <div className="font-semibold">{t("cloud.browserLoginTitle")}</div>
                  <p style={{ margin: "8px 0 0" }}>
                    {t("cloud.browserLoginHint")}{" "}
                    <a href={login.authUrl || login.verificationUriComplete || login.verificationUri} target="_blank" rel="noreferrer">
                      {t("cloud.openAuthPage")}
                    </a>
                  </p>
                  {login.redirectUri && (
                    <p className="muted text-label mono" style={{ marginTop: 8 }}>
                      {t("cloud.redirectUri")}: {login.redirectUri}
                    </p>
                  )}
                </>
              )}
              <p className="muted text-label" style={{ marginTop: 8 }}>{t("cloud.waitingAuth")}</p>
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="font-semibold">{t("cloud.transferTitle")}</div>
        <p className="muted text-control" style={{ marginTop: 6 }}>{t("cloud.transferHint")}</p>

        <label className="field" style={{ display: "block", marginTop: 14 }}>
          <span className="muted text-label">{t("cloud.passphrase")}</span>
          <input
            className="input"
            type="password"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            placeholder={t("cloud.passphrasePlaceholder")}
            autoComplete="new-password"
            disabled={busy}
            style={{ marginTop: 6, width: "100%", maxWidth: 420 }}
          />
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={includeVault} onChange={e => setIncludeVault(e.target.checked)} disabled={busy} />
            <span>{t("cloud.includeVault")}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={includeUsage} onChange={e => setIncludeUsage(e.target.checked)} disabled={busy} />
            <span>{t("cloud.includeUsage")}</span>
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary" onClick={() => void push()} disabled={busy || !status?.loggedIn}>
            {t("cloud.push")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void pull()} disabled={busy || !status?.loggedIn}>
            {t("cloud.pull")}
          </button>
        </div>
        <p className="muted text-label" style={{ marginTop: 12 }}>{t("cloud.securityNote")}</p>
      </div>
    </div>
  );
}
