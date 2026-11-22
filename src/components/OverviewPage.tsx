// Overview: what's served (regions, places, disk), how much it's used (30 days), how fast it answers.

import type { Endpoint, Overview, Region } from "../lib/api";
import { ENDPOINTS } from "../lib/api";
import { useApp } from "../lib/app";
import { useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { JobRow } from "./ActivityPanel";
import { CopyButton } from "./common";
import { Globe } from "./icons";

const COLORS: Record<Endpoint, string> = { autocomplete: "#2bb39a", search: "#2383e2", reverse: "#9b6dd6", photon: "#e8a33d" };

export function OverviewPage() {
  const { t, f } = useSettings();
  const { navigate, jobs, server } = useApp();
  const data = useApi<Overview>("/app/overview", true).data;
  const regions = useApi<Region[]>("/app/regions", true).data;
  const running = (jobs ?? []).filter((j) => j.status === "running" || j.status === "queued");

  // The last 30 days, every day present (zero when quiet).
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 29 + i);
    return d.toISOString().slice(0, 10);
  });
  const perDay = days.map((day) => {
    const rows = (data?.usage ?? []).filter((u) => u.day === day);
    return { day, byEndpoint: Object.fromEntries(ENDPOINTS.map((e) => [e, rows.find((r) => r.endpoint === e)?.requests ?? 0])) as Record<Endpoint, number> };
  });
  const max = Math.max(1, ...perDay.map((d) => Object.values(d.byEndpoint).reduce((a, b) => a + b, 0)));
  const today = perDay.at(-1)!;
  const todayTotal = Object.values(today.byEndpoint).reduce((a, b) => a + b, 0);
  const monthTotal = perDay.reduce((n, d) => n + Object.values(d.byEndpoint).reduce((a, b) => a + b, 0), 0);
  const example = `curl "${server?.publicUrl ?? location.origin}/v1/autocomplete?q=paris&limit=5"`;

  if (regions && regions.length === 0 && !running.length) {
    return (
      <div className="page">
        <div className="empty-state">
          <Globe size={32} />
          <h2>{t("welcome")}</h2>
          <p className="muted">{t("welcomeHint")}</p>
          <button className="primary-button" onClick={() => navigate({ name: "regions" })}>
            {t("chooseRegions")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="stat-grid">
        <Stat label={t("regions")} value={data ? f.number(data.totals.regions) : "…"} onClick={() => navigate({ name: "regions" })} />
        <Stat label={t("places")} value={data ? f.compact(data.totals.features + data.totals.addresses) : "…"} hint={data ? t("placesHint", { features: f.compact(data.totals.features), addresses: f.compact(data.totals.addresses) }) : undefined} />
        <Stat label={t("database")} value={data ? f.bytes(data.totals.databaseBytes) : "…"} />
        <Stat label={t("requestsToday")} value={f.number(todayTotal)} hint={t("last30DaysN", { n: f.compact(monthTotal) })} />
        <Stat label={t("apiKeys")} value={data ? f.number(data.keys.active) : "…"} hint={data && data.keys.total !== data.keys.active ? t("ofTotal", { n: data.keys.total }) : undefined} onClick={() => navigate({ name: "keys" })} />
      </div>

      {running.length > 0 && (
        <section className="card">
          <h2 className="section-title">{t("importing")}</h2>
          {running.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h2 className="section-title">{t("requests30Days")}</h2>
          <div className="legend">
            {ENDPOINTS.map((e) => (
              <span key={e}>
                <i className="swatch" style={{ background: COLORS[e] }} />
                {t(`endpoint_${e}`)}
              </span>
            ))}
          </div>
        </div>
        <div className="bars" role="img" aria-label={t("requests30Days")}>
          {perDay.map((d) => {
            const total = Object.values(d.byEndpoint).reduce((a, b) => a + b, 0);
            return (
              <div key={d.day} className="bar" title={`${f.mediumDate(d.day)}: ${f.number(total)}`}>
                {ENDPOINTS.map((e) => (d.byEndpoint[e] ? <span key={e} style={{ height: `${(100 * d.byEndpoint[e]) / max}%`, background: COLORS[e] }} /> : null))}
              </div>
            );
          })}
        </div>
      </section>

      <div className="two-cols">
        <section className="card">
          <h2 className="section-title">{t("responseTimes")}</h2>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>{t("endpoint")}</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">{t("samples")}</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => {
                const l = data?.latency[e];
                return (
                  <tr key={e}>
                    <td>{t(`endpoint_${e}`)}</td>
                    <td className="num tabular">{l?.p50 != null ? `${f.ms(l.p50)}` : "—"}</td>
                    <td className="num tabular">{l?.p95 != null ? `${f.ms(l.p95)}` : "—"}</td>
                    <td className="num tabular muted">{l ? f.number(l.samples) : 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted">{t("responseTimesHint")}</p>
        </section>
        <section className="card">
          <h2 className="section-title">{t("tryIt")}</h2>
          <div className="code-sample with-copy">
            <code>{example}</code>
            <CopyButton text={example} />
          </div>
          <p className="small muted">{t("tryItHint")}</p>
          <div className="button-row">
            <button className="text-button" onClick={() => navigate({ name: "playground" })}>
              {t("openPlayground")}
            </button>
            <button className="text-button" onClick={() => navigate({ name: "docs" })}>
              {t("readDocs")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, onClick }: { label: string; value: string; hint?: string; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`stat${onClick ? " clickable" : ""}`} onClick={onClick}>
      <span className="stat-label">{label}</span>
      <span className="stat-value tabular">{value}</span>
      {hint && <span className="small muted">{hint}</span>}
    </Tag>
  );
}
