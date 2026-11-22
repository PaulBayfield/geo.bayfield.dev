// API keys: who may call the API, with what limits. A new key is shown once; the server keeps its hash.

import { useState } from "react";
import { ENDPOINTS, api, type ApiKey, type Endpoint, type ServiceSettings } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, CopyButton, Dialog, useToast } from "./common";
import { Key, Pencil, Plus, Trash } from "./icons";
import { Switch } from "./settings/common";

export function KeysPage({ creating, setCreating }: { creating: boolean; setCreating: (v: boolean) => void }) {
  const { t, f } = useSettings();
  const { admin, openSettings } = useApp();
  const toast = useToast();
  const keys = useApi<ApiKey[]>("/app/keys", true);
  const access = useApi<ServiceSettings>("/app/settings").data?.access;
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [created, setCreated] = useState<ApiKey | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const reload = () => {
    invalidate("/app/keys");
    keys.reload();
  };

  const requirement = !access ? null : access.requireKey ? t("keysRequiredAll") : access.requireKeyFor.length ? t("keysRequiredSome", { list: access.requireKeyFor.join(", ") }) : t("keysOptional");

  return (
    <div className="page">
      <div className={`callout ${access?.requireKey || access?.requireKeyFor.length ? "good" : "info"}`}>
        <Key size={16} />
        <span>{requirement}</span>
        <button className="link-button" onClick={() => openSettings("access")}>
          {t("changeAccess")}
        </button>
      </div>

      {keys.data?.length === 0 && (
        <div className="empty-state">
          <Key size={28} />
          <h2>{t("noKeys")}</h2>
          <p className="muted">{t("noKeysHint")}</p>
          {admin && (
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Plus size={14} />
              {t("newKey")}
            </button>
          )}
        </div>
      )}

      {(keys.data?.length ?? 0) > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("key")}</th>
                <th>{t("scopes")}</th>
                <th>{t("limits")}</th>
                <th className="num">{t("today")}</th>
                <th className="num">{t("last30Days")}</th>
                <th>{t("lastUsed")}</th>
                <th>{t("enabled")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data!.map((k) => {
                const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
                return (
                  <tr key={k.id} className={k.disabled || expired ? "dimmed" : ""}>
                    <td>
                      <strong>{k.name}</strong>
                      {expired && <span className="badge warn">{t("expired")}</span>}
                      {k.expiresAt && !expired && <div className="small muted">{t("expiresOn", { when: f.mediumDate(k.expiresAt) })}</div>}
                    </td>
                    <td>
                      <code>{k.prefix}…</code>
                    </td>
                    <td className="small">{k.scopes.length ? k.scopes.join(", ") : t("allEndpoints")}</td>
                    <td className="small">
                      {[k.ratePerMinute ? t("perMinute", { n: f.number(k.ratePerMinute) }) : null, k.dailyQuota ? t("perDay", { n: f.number(k.dailyQuota) }) : null, k.origins.length ? t("nSites", { n: k.origins.length }) : null, k.ips.length ? t("nIps", { n: k.ips.length }) : null]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="num tabular">{f.number(k.requestsToday ?? 0)}</td>
                    <td className="num tabular">{f.number(k.requests30d ?? 0)}</td>
                    <td className="small">{k.lastUsedAt ? f.relative(k.lastUsedAt, t) : t("never")}</td>
                    <td>
                      <Switch
                        checked={!k.disabled}
                        disabled={!admin}
                        label={t("enabled")}
                        onChange={async (on) => {
                          try {
                            await api(`/app/keys/${k.id}`, { method: "PATCH", body: { disabled: !on } });
                            reload();
                          } catch (e) {
                            toast((e as Error).message, "error");
                          }
                        }}
                      />
                    </td>
                    <td className="row-actions">
                      {admin && (
                        <>
                          <button className="icon-button small" title={t("edit")} onClick={() => setEditing(k)}>
                            <Pencil size={14} />
                          </button>
                          <button className="icon-button small danger" title={t("delete")} onClick={() => setDeleting(k)}>
                            <Trash size={14} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <KeyDialog
          initial={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(k) => {
            reload();
            if (k.key) setCreated(k);
            else toast(t("saved"));
          }}
        />
      )}
      {created && (
        <Dialog title={t("keyCreated")} onClose={() => setCreated(null)}>
          <p className="dialog-text">{t("keyCreatedHint")}</p>
          <div className="link-row">
            <input className="text-field mono" readOnly value={created.key} onFocus={(e) => e.target.select()} autoFocus />
            <CopyButton text={created.key!} className="primary-button" label={t("copy")} />
          </div>
          <pre className="code-sample">{`curl -H "X-API-Key: ${created.key}" "${location.origin}/v1/autocomplete?q=paris"`}</pre>
          <div className="dialog-actions">
            <button className="primary-button" onClick={() => setCreated(null)}>
              {t("done")}
            </button>
          </div>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteKey")}
          text={t("deleteKeyHint", { name: deleting.name })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`/app/keys/${deleting.id}`, { method: "DELETE" });
            reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function KeyDialog({ initial, onClose, onSaved }: { initial: ApiKey | null; onClose: () => void; onSaved: (k: ApiKey) => void }) {
  const { t } = useSettings();
  const [name, setName] = useState(initial?.name ?? "");
  const [scopes, setScopes] = useState<Endpoint[]>(initial?.scopes ?? []);
  const [rate, setRate] = useState(initial?.ratePerMinute?.toString() ?? "");
  const [quota, setQuota] = useState(initial?.dailyQuota?.toString() ?? "");
  const [origins, setOrigins] = useState((initial?.origins ?? []).join("\n"));
  const [ips, setIps] = useState((initial?.ips ?? []).join("\n"));
  const [expires, setExpires] = useState(initial?.expiresAt?.slice(0, 10) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={initial ? t("editKey") : t("newKey")} onClose={onClose} wide>
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const body = {
            name,
            scopes,
            ratePerMinute: rate || null,
            dailyQuota: quota || null,
            origins: lines(origins),
            ips: lines(ips),
            expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
          };
          try {
            const k = initial ? await api<ApiKey>(`/app/keys/${initial.id}`, { method: "PATCH", body }) : await api<ApiKey>("/app/keys", { body });
            onSaved(k);
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="field">
          {t("name")}
          <input className="text-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("keyNamePlaceholder")} autoFocus required maxLength={80} />
        </label>
        <div className="field">
          {t("scopes")}
          <div className="check-grid">
            {ENDPOINTS.map((ep) => (
              <label key={ep} className="checkbox">
                <input type="checkbox" checked={scopes.includes(ep)} onChange={(e) => setScopes((s) => (e.target.checked ? [...s, ep] : s.filter((x) => x !== ep)))} />
                {t(`endpoint_${ep}`)}
              </label>
            ))}
          </div>
          <span className="small muted">{t("scopesHint")}</span>
        </div>
        <div className="field-row">
          <label className="field">
            {t("ratePerMinute")}
            <input className="text-field" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} placeholder={t("defaultValue")} />
          </label>
          <label className="field">
            {t("dailyQuota")}
            <input className="text-field" type="number" min={1} value={quota} onChange={(e) => setQuota(e.target.value)} placeholder={t("unlimited")} />
          </label>
          <label className="field">
            {t("expires")}
            <input className="text-field" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            {t("allowedSites")}
            <textarea className="text-field area" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://maps.bayfield.dev" />
            <span className="small muted">{t("allowedSitesHint")}</span>
          </label>
          <label className="field">
            {t("allowedIps")}
            <textarea className="text-field area" rows={3} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.7" />
            <span className="small muted">{t("allowedIpsHint")}</span>
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !name.trim()}>
            {initial ? t("save") : t("createKey")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
