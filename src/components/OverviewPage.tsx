// Overview: what's served (regions, places, disk), how much it's used (daily, weekly, monthly), who
// uses it, and how fast it answers.

import { useState } from "react";
import type { Endpoint, Overview, Region, UsageGrain, UsageRow } from "../lib/api";
import { ENDPOINTS } from "../lib/api";
import { useApp } from "../lib/app";
import { useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { JobRow } from "./ActivityPanel";
import { CopyButton } from "./common";
import { Globe } from "./icons";

const COLORS: Record<Endpoint, string> = { autocomplete: "#2bb39a", search: "#2383e2", reverse: "#9b6dd6", photon: "#e8a33d" };
/** Bottom to top. Ordered so neighbouring segments stay distinct with colour-blindness (blue and violet apart). */
const STACK: Endpoint[] = ["search", "photon", "reverse", "autocomplete"];

/** How many periods each chart shows; the server sends twice as many, for the previous period. */
const WINDOW: Record<UsageGrain, number> = { daily: 30, weekly: 26, monthly: 12 };
const GRAINS: UsageGrain[] = ["daily", "weekly", "monthly"];
const GRAIN_KEY = "geopol.usageGrain";
const DAY = 86_400_000;

interface Bucket {
  period: string;
  by: Record<Endpoint, number>;
  total: number;
  errors: number;
}

/** The last `count` periods (UTC, as the server counts them), oldest first, every one present. */
function periods(grain: UsageGrain, count: number): string[] {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i;
    if (grain === "daily") return iso(today - back * DAY);
    if (grain === "weekly") return iso(today - ((now.getUTCDay() + 6) % 7) * DAY - back * 7 * DAY);
    return iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  });
}

function buckets(rows: UsageRow[] | undefined, grain: UsageGrain, count: number): Bucket[] {
  const byPeriod = new Map<string, UsageRow[]>();
  for (const r of rows ?? []) byPeriod.set(r.period, [...(byPeriod.get(r.period) ?? []), r]);
  return periods(grain, count).map((period) => {
    const list = byPeriod.get(period) ?? [];
    const by = Object.fromEntries(ENDPOINTS.map((e) => [e, list.filter((r) => r.endpoint === e).reduce((n, r) => n + r.requests, 0)])) as Record<Endpoint, number>;
    return { period, by, total: list.reduce((n, r) => n + r.requests, 0), errors: list.reduce((n, r) => n + r.errors, 0) };
  });
}

const sum = (list: Bucket[], pick: (b: Bucket) => number = (b) => b.total) => list.reduce((n, b) => n + pick(b), 0);
/** Change from `before` to `now`, or null when there's nothing to compare with. */
const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);

/** A round axis maximum: 1, 2, 2.5, 5 × 10ⁿ. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

function storedGrain(): UsageGrain {
  try {
    const v = localStorage.getItem(GRAIN_KEY);
    return GRAINS.includes(v as UsageGrain) ? (v as UsageGrain) : "daily";
  } catch {
    return "daily";
  }
}

export function OverviewPage() {
  const { t, f } = useSettings();
  const { navigate, jobs, server } = useApp();
  const data = useApi<Overview>("/app/overview", true).data;
  const regions = useApi<Region[]>("/app/regions", true).data;
  const running = (jobs ?? []).filter((j) => j.status === "running" || j.status === "queued");

  // The headline numbers, from the last 60 days.
  const days = buckets(data?.usage.daily, "daily", 60);
  const today = days[59];
  const yesterday = days[58];
  const last7 = days.slice(-7);
  const last30 = days.slice(-30);
  const total7 = sum(last7);
  const total30 = sum(last30);
  const errors30 = sum(last30, (b) => b.errors);
  const delta7 = change(total7, sum(days.slice(-14, -7)));
  const delta30 = change(total30, sum(days.slice(0, 30)));
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

  const v = (s: string) => (data ? s : "…");
  return (
    <div className="page">
      <div className="stat-grid">
        <Stat label={t("requestsToday")} value={v(f.number(today.total))} hint={data ? t("yesterdayN", { n: f.number(yesterday.total) }) : undefined} />
        <Stat label={t("requestsLast7Days")} value={v(f.number(total7))} delta={delta7} hint={t("vsPrevious7")} />
        <Stat label={t("requestsLast30Days")} value={v(f.number(total30))} delta={delta30} hint={t("vsPrevious30")} spark={data ? last30 : undefined} />
        <Stat
          label={t("errorRate")}
          value={v(total30 ? f.percent(errors30 / total30) : "—")}
          hint={data ? t("errorRateHint", { n: f.number(errors30) }) : undefined}
        />
        <Stat label={t("regions")} value={v(f.number(data?.totals.regions ?? 0))} onClick={() => navigate({ name: "regions" })} />
        <Stat
          label={t("places")}
          value={v(f.compact((data?.totals.features ?? 0) + (data?.totals.addresses ?? 0)))}
          hint={data ? t("placesHint", { features: f.compact(data.totals.features), addresses: f.compact(data.totals.addresses) }) : undefined}
        />
        <Stat label={t("database")} value={v(f.bytes(data?.totals.databaseBytes ?? 0))} />
        <Stat
          label={t("apiKeys")}
          value={v(f.number(data?.keys.active ?? 0))}
          hint={data && data.keys.total !== data.keys.active ? t("ofTotal", { n: data.keys.total }) : undefined}
          onClick={() => navigate({ name: "keys" })}
        />
      </div>

      {running.length > 0 && (
        <section className="card">
          <h2 className="section-title">{t("importing")}</h2>
          {running.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </section>
      )}

      <UsageCard data={data} />

      <div className="two-cols">
        <TopKeys data={data} total30={total30} />
        <section className="card">
          <h2 className="section-title">{t("responseTimes")}</h2>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>{t("endpoint")}</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">{t("slowest")}</th>
                <th className="num">{t("samples")}</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => {
                const l = data?.latency[e];
                return (
                  <tr key={e}>
                    <td>
                      <span className="endpoint-name">
                        <i className="swatch" style={{ background: COLORS[e] }} />
                        {t(`endpoint_${e}`)}
                      </span>
                    </td>
                    <td className="num tabular">{l?.p50 != null ? f.ms(l.p50) : "—"}</td>
                    <td className="num tabular">{l?.p95 != null ? f.ms(l.p95) : "—"}</td>
                    <td className="num tabular muted">{l?.max != null ? f.ms(l.max) : "—"}</td>
                    <td className="num tabular muted">{l ? f.number(l.samples) : 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted">{t("responseTimesHint")}</p>
        </section>
      </div>

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
  );
}

// ---------- Usage: stacked bars per endpoint, by day, week or month ----------

function UsageCard({ data }: { data: Overview | undefined }) {
  const { t, f } = useSettings();
  const [grain, setGrainState] = useState<UsageGrain>(storedGrain);
  const [hover, setHover] = useState<number | null>(null);
  const [focusEndpoint, setFocusEndpoint] = useState<Endpoint | null>(null);
  const setGrain = (g: UsageGrain) => {
    setGrainState(g);
    setHover(null);
    try {
      localStorage.setItem(GRAIN_KEY, g);
    } catch {
      // Not remembered: fine.
    }
  };

  const n = WINDOW[grain];
  const all = buckets(data?.usage[grain], grain, n * 2);
  const shown = all.slice(n);
  const total = sum(shown);
  const errors = sum(shown, (b) => b.errors);
  const delta = change(total, sum(all.slice(0, n)));
  const peak = shown.reduce((best, b) => (b.total > best.total ? b : best), shown[0]);
  const max = niceMax(Math.max(...shown.map((b) => b.total)));
  const byEndpoint = Object.fromEntries(ENDPOINTS.map((e) => [e, sum(shown, (b) => b.by[e])])) as Record<Endpoint, number>;

  const label = (period: string) =>
    grain === "daily" ? f.weekday(period) : grain === "weekly" ? t("weekOf", { date: f.dayMonth(period) }) : f.monthYear(period);
  const tick = (period: string) => (grain === "monthly" ? f.shortMonth(period) : f.dayMonth(period));
  // Every 7th day / 4th week back from the latest, every month.
  const every = grain === "daily" ? 7 : grain === "weekly" ? 4 : 1;
  const average = { daily: "averagePerDay", weekly: "averagePerWeek", monthly: "averagePerMonth" } as const;
  const hint = { daily: "usageDailyHint", weekly: "usageWeeklyHint", monthly: "usageMonthlyHint" } as const;
  const hovered = hover != null ? shown[hover] : null;

  return (
    <section className="card">
      <div className="section-head">
        <h2 className="section-title">
          {t("usage")} <span className="small muted">{t(hint[grain])}</span>
        </h2>
        <div className="segmented" role="tablist" aria-label={t("usage")}>
          {GRAINS.map((g) => (
            <button key={g} role="tab" aria-selected={g === grain} className={g === grain ? "active" : ""} onClick={() => setGrain(g)}>
              {t(g)}
            </button>
          ))}
        </div>
      </div>

      <div className="usage-summary">
        <Figure label={t("total")} value={data ? f.number(total) : "…"} delta={delta} deltaHint={t("vsPrevious")} />
        <Figure label={t(average[grain])} value={data ? f.number(Math.round(total / n)) : "…"} />
        <Figure label={t("peak")} value={data && peak.total ? f.number(peak.total) : "—"} sub={data && peak.total ? label(peak.period) : undefined} />
        <Figure
          label={t("errors")}
          value={data ? f.number(errors) : "…"}
          sub={total ? f.percent(errors / total) : undefined}
        />
      </div>

      <div className="usage-chart" onPointerLeave={() => setHover(null)}>
        <div className="usage-y" aria-hidden>
          {[max, max / 2, 0].map((y) => (
            <span key={y}>{f.compact(y)}</span>
          ))}
        </div>
        <div className="usage-plot">
          <div className="usage-grid" aria-hidden>
            <i />
            <i />
            <i />
          </div>
          <div className={`usage-bars${focusEndpoint ? " focused" : ""}`} role="list" aria-label={`${t("usage")}, ${t(hint[grain])}`}>
            {shown.map((b, i) => (
              <div
                key={b.period}
                role="listitem"
                tabIndex={0}
                className={`usage-bar${hover === i ? " hover" : ""}${i === shown.length - 1 ? " current" : ""}`}
                aria-label={`${label(b.period)}: ${f.number(b.total)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {b.total > 0 && (
                  <div className="usage-stack" style={{ height: `${(100 * b.total) / max}%` }}>
                    {STACK.map((e) =>
                      b.by[e] ? (
                        <span
                          key={e}
                          className={focusEndpoint && focusEndpoint !== e ? "dim" : ""}
                          style={{ height: `${(100 * b.by[e]) / b.total}%`, background: COLORS[e] }}
                        />
                      ) : null,
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {hovered && hover != null && (
            <div
              className={`chart-tooltip${hover < n / 4 ? " start" : hover >= (n * 3) / 4 ? " end" : ""}`}
              style={{ left: `${(100 * (hover + 0.5)) / n}%` }}
              role="status"
            >
              <div className="chart-tooltip-title">
                {label(hovered.period)}
                {hover === shown.length - 1 && ` · ${t("soFar")}`}
              </div>
              <div className="chart-tooltip-total tabular">{f.number(hovered.total)}</div>
              {[...STACK].reverse().map((e) => (
                <div key={e} className="chart-tooltip-row">
                  <i style={{ background: COLORS[e] }} />
                  <span className="muted">{t(`endpoint_${e}`)}</span>
                  <b className="tabular">{f.number(hovered.by[e])}</b>
                </div>
              ))}
              {hovered.errors > 0 && (
                <div className="chart-tooltip-row errors">
                  <i />
                  <span className="muted">{t("errors")}</span>
                  <b className="tabular">
                    {f.number(hovered.errors)} · {f.percent(hovered.errors / hovered.total)}
                  </b>
                </div>
              )}
            </div>
          )}
          {data && total === 0 && <div className="usage-empty muted small">{t("noRequestsYet")}</div>}
        </div>
        <div className="usage-x" aria-hidden>
          {shown.map((b, i) => (
            <span key={b.period}>{(shown.length - 1 - i) % every === 0 ? tick(b.period) : ""}</span>
          ))}
        </div>
      </div>

      <div className="usage-legend">
        {STACK.map((e) => (
          <button
            key={e}
            className={focusEndpoint === e ? "active" : ""}
            onPointerEnter={() => setFocusEndpoint(e)}
            onPointerLeave={() => setFocusEndpoint(null)}
            onFocus={() => setFocusEndpoint(e)}
            onBlur={() => setFocusEndpoint(null)}
          >
            <i className="swatch" style={{ background: COLORS[e] }} />
            <span>{t(`endpoint_${e}`)}</span>
            <b className="tabular">{f.number(byEndpoint[e])}</b>
            <span className="muted tabular">{total ? f.percent(byEndpoint[e] / total) : "—"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------- Who calls: the keys used most ----------

function TopKeys({ data, total30 }: { data: Overview | undefined; total30: number }) {
  const { t, f } = useSettings();
  const { navigate } = useApp();
  const rows = data?.topKeys ?? [];
  return (
    <section className="card">
      <h2 className="section-title">
        {t("topKeys")} <span className="small muted">{t("topKeysHint")}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="small muted">{data ? t("noRequestsYet") : "…"}</p>
      ) : (
        <table className="data-table compact">
          <thead>
            <tr>
              <th>{t("name")}</th>
              <th className="num">{t("samples")}</th>
              <th>{t("share")}</th>
              <th className="num">{t("errors")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => {
              const share = total30 ? k.requests / total30 : 0;
              return (
                <tr key={k.id || "-"} className={k.id && k.name ? "clickable" : ""} onClick={k.id && k.name ? () => navigate({ name: "keys" }) : undefined}>
                  <td>
                    {k.id === "" ? <span className="muted">{t("withoutKey")}</span> : k.name ?? <span className="muted">{t("deletedKey")}</span>}
                    {k.prefix && <span className="key-prefix muted">{k.prefix}…</span>}
                  </td>
                  <td className="num tabular">{f.number(k.requests)}</td>
                  <td>
                    <span className="key-share" title={f.percent(share)}>
                      <i style={{ width: `${Math.max(2, 100 * share)}%` }} />
                    </span>
                  </td>
                  <td className="num tabular muted">{k.errors ? f.number(k.errors) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------- Pieces ----------

function Delta({ value, hint }: { value: number | null; hint?: string }) {
  const { f } = useSettings();
  if (value == null) return null;
  const dir = value > 0.005 ? "up" : value < -0.005 ? "down" : "flat";
  return (
    <span className={`delta ${dir}`} title={hint}>
      {dir === "up" ? "▲" : dir === "down" ? "▼" : "•"} {f.signedPercent(value)}
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  delta,
  spark,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
  spark?: Bucket[];
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  // A "vs previous" hint only makes sense next to a change.
  const showHint = !!hint && delta !== null;
  return (
    <Tag className={`stat${onClick ? " clickable" : ""}`} onClick={onClick}>
      <span className="stat-label">{label}</span>
      <span className="stat-value tabular">{value}</span>
      {(delta != null || showHint) && (
        <span className="stat-foot small muted">
          {delta != null && <Delta value={delta} />}
          {showHint && hint}
        </span>
      )}
      {spark && <Sparkline buckets={spark} />}
    </Tag>
  );
}

/** A tiny bar per day, no axes: the shape of the month, with the day and count on hover. */
function Sparkline({ buckets }: { buckets: Bucket[] }) {
  const { f } = useSettings();
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <span className="sparkline" aria-hidden>
      {buckets.map((b) => (
        <i key={b.period} title={`${f.dayMonth(b.period)}: ${f.number(b.total)}`}>
          <span style={{ height: `${b.total ? Math.max(8, (100 * b.total) / max) : 0}%` }} />
        </i>
      ))}
    </span>
  );
}

function Figure({ label, value, sub, delta, deltaHint }: { label: string; value: string; sub?: string; delta?: number | null; deltaHint?: string }) {
  return (
    <div className="figure">
      <span className="stat-label">{label}</span>
      <span className="figure-value tabular">{value}</span>
      <span className="small muted figure-sub">
        {delta !== undefined && <Delta value={delta ?? null} hint={deltaHint} />}
        {sub}
        {delta != null && deltaHint && <span className="figure-delta-hint"> {deltaHint}</span>}
      </span>
    </div>
  );
}
