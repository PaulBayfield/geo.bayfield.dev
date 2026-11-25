// The service's settings, live: access (API keys, limits, CORS), results, ranking, data. Admins change
// them; everyone else sees them. Each change is saved at once and applies to the next request.

import { useEffect, useState, type ReactNode } from "react";
import { ENDPOINTS, FORMATS, LAYERS, api, type CacheStats, type Format, type ServiceSettings } from "../../lib/api";
import { useApp } from "../../lib/app";
import { invalidate, useApi } from "../../lib/hooks";
import { useSettings } from "../../lib/settings";
import { useToast } from "../common";
import { PageHeader, Row, Switch } from "./common";

type Section = keyof ServiceSettings;

/** Loads the settings and saves one section's changes. */
function useService<S extends Section>(section: S) {
  const { admin } = useApp();
  const { t } = useSettings();
  const toast = useToast();
  const req = useApi<ServiceSettings>("/app/settings");
  const save = async (patch: Partial<ServiceSettings[S]>) => {
    try {
      await api(`/app/settings/${section}`, { method: "PATCH", body: patch });
      invalidate("/app/settings");
      req.reload();
      toast(t("saved"));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return { value: req.data?.[section], save, readOnly: !admin };
}

/** A number field that saves when it loses focus (or on Enter). */
function NumberField({ value, onSave, min, max, step = 1, suffix, disabled }: { value: number; onSave: (n: number) => void; min: number; max: number; step?: number; suffix?: string; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <span className="number-field">
      <input
        className="text-field"
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      />
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  );
}

/** A list (comma or line separated) saved on blur. */
function ListField({ value, onSave, placeholder, disabled }: { value: string[]; onSave: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value.join(",")]);
  return (
    <input
      className="text-field wide"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.split(/[\s,]+/).filter(Boolean);
        if (next.join(",") !== value.join(",")) onSave(next);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

const Loading = ({ children }: { children: ReactNode }) => <>{children}</>;

export function AccessPage() {
  const { t } = useSettings();
  const { value: v, save, readOnly } = useService("access");
  return (
    <>
      <PageHeader title={t("access")} hint={t("accessHint")} />
      {v && (
        <Loading>
          <section className="settings-rows">
            <Row label={t("requireKey")} hint={t("requireKeyHint")}>
              <Switch checked={v.requireKey} disabled={readOnly} onChange={(requireKey) => void save({ requireKey })} label={t("requireKey")} />
            </Row>
            <Row label={t("requireKeyFor")} hint={t("requireKeyForHint")} disabled={v.requireKey} stack>
              <div className="check-grid">
                {ENDPOINTS.map((ep) => (
                  <label key={ep} className="checkbox">
                    <input
                      type="checkbox"
                      disabled={readOnly || v.requireKey}
                      checked={v.requireKey || v.requireKeyFor.includes(ep)}
                      onChange={(e) => void save({ requireKeyFor: e.target.checked ? [...v.requireKeyFor, ep] : v.requireKeyFor.filter((x) => x !== ep) })}
                    />
                    {t(`endpoint_${ep}`)}
                  </label>
                ))}
              </div>
            </Row>
          </section>
          <section className="settings-rows">
            <h3>{t("rateLimits")}</h3>
            <Row label={t("ipPerMinute")} hint={t("ipPerMinuteHint")}>
              <NumberField value={v.ipPerMinute} min={0} max={100000} disabled={readOnly} suffix={t("perMinuteShort")} onSave={(ipPerMinute) => void save({ ipPerMinute })} />
            </Row>
            <Row label={t("keyPerMinute")} hint={t("keyPerMinuteHint")}>
              <NumberField value={v.keyPerMinute} min={0} max={1000000} disabled={readOnly} suffix={t("perMinuteShort")} onSave={(keyPerMinute) => void save({ keyPerMinute })} />
            </Row>
          </section>
          <section className="settings-rows">
            <Row label={t("corsOrigins")} hint={t("corsOriginsHint")} stack>
              <ListField value={v.corsOrigins} disabled={readOnly} placeholder="* or https://example.com" onSave={(corsOrigins) => void save({ corsOrigins })} />
            </Row>
          </section>
        </Loading>
      )}
    </>
  );
}

export function ResultsPage() {
  const { t } = useSettings();
  const { value: v, save, readOnly } = useService("results");
  return (
    <>
      <PageHeader title={t("results")} hint={t("resultsHint")} />
      {v && (
        <>
          <section className="settings-rows">
            <Row label={t("defaultLimit")}>
              <NumberField value={v.defaultLimit} min={1} max={v.maxLimit} disabled={readOnly} onSave={(defaultLimit) => void save({ defaultLimit })} />
            </Row>
            <Row label={t("maxLimit")} hint={t("maxLimitHint")}>
              <NumberField value={v.maxLimit} min={1} max={200} disabled={readOnly} onSave={(maxLimit) => void save({ maxLimit })} />
            </Row>
            <Row label={t("defaultLanguage")} hint={t("defaultLanguageHint")}>
              <ListField value={[v.defaultLanguage]} disabled={readOnly} onSave={(l) => l[0] && void save({ defaultLanguage: l[0] })} />
            </Row>
            <Row label={t("reverseRadius")} hint={t("reverseRadiusHint")}>
              <NumberField value={v.reverseRadius} min={10} max={100000} disabled={readOnly} suffix="m" onSave={(reverseRadius) => void save({ reverseRadius })} />
            </Row>
            <Row label={t("defaultFormat")} hint={t("defaultFormatHint")}>
              <select className="text-field" value={v.format} disabled={readOnly} onChange={(e) => void save({ format: e.target.value as Format })}>
                {FORMATS.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {t(`format_${fmt}`)}
                  </option>
                ))}
              </select>
            </Row>
          </section>
          <section className="settings-rows">
            <Row label={t("enabledLayers")} hint={t("enabledLayersHint")} stack>
              <div className="check-grid">
                {LAYERS.map((l) => (
                  <label key={l} className="checkbox">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={v.layers.includes(l)}
                      onChange={(e) => void save({ layers: e.target.checked ? [...v.layers, l] : v.layers.filter((x) => x !== l) })}
                    />
                    {t(`layer_${l}`)}
                  </label>
                ))}
              </div>
            </Row>
          </section>
        </>
      )}
    </>
  );
}

export function RankingPage() {
  const { t } = useSettings();
  const { value: v, save, readOnly } = useService("ranking");
  const slider = (key: "importance" | "prefix" | "nameMatch" | "near", label: string, hint: string) =>
    v && (
      <Row label={label} hint={hint}>
        <span className="slider-field">
          <input type="range" min={0} max={2} step={0.05} defaultValue={v[key]} disabled={readOnly} onPointerUp={(e) => void save({ [key]: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => void save({ [key]: Number((e.target as HTMLInputElement).value) })} />
          <span className="tabular small">{v[key].toFixed(2)}</span>
        </span>
      </Row>
    );
  return (
    <>
      <PageHeader title={t("ranking")} hint={t("rankingHint")} />
      {v && (
        <section className="settings-rows" key={JSON.stringify(v)}>
          {slider("importance", t("wImportance"), t("wImportanceHint"))}
          {slider("prefix", t("wPrefix"), t("wPrefixHint"))}
          {slider("nameMatch", t("wNameMatch"), t("wNameMatchHint"))}
          {slider("near", t("wNear"), t("wNearHint"))}
          <Row label={t("nearKm")} hint={t("nearKmHint")}>
            <NumberField value={v.nearKm} min={1} max={5000} disabled={readOnly} suffix="km" onSave={(nearKm) => void save({ nearKm })} />
          </Row>
        </section>
      )}
    </>
  );
}

export function DataPage() {
  const { t } = useSettings();
  const { value: v, save, readOnly } = useService("data");
  return (
    <>
      <PageHeader title={t("data")} hint={t("dataHint")} />
      {v && (
        <section className="settings-rows">
          <Row label={t("keepLanguages")} hint={t("keepLanguagesHint")} stack>
            <ListField value={v.languages} disabled={readOnly} placeholder="fr, en, de, nl" onSave={(languages) => void save({ languages })} />
          </Row>
          <Row label={t("includeHouseNumbers")} hint={t("houseNumbersHint")}>
            <Switch checked={v.houseNumbers} disabled={readOnly} onChange={(houseNumbers) => void save({ houseNumbers })} label={t("includeHouseNumbers")} />
          </Row>
          <Row label={t("updateEvery")} hint={t("updateEveryHint")}>
            <NumberField value={v.updateEveryDays} min={0} max={365} disabled={readOnly} suffix={t("days")} onSave={(updateEveryDays) => void save({ updateEveryDays })} />
          </Row>
          <Row label={t("dumpServer")} hint={t("dumpServerHint")} stack>
            <ListField value={[v.dumpBaseUrl]} disabled={readOnly} placeholder="https://download1.graphhopper.com/public" onSave={(d) => d[0] && void save({ dumpBaseUrl: d[0] })} />
          </Row>
          <Row label={t("dumpVersion")} hint={t("dumpVersionHint")}>
            <ListField value={[v.dumpVersion]} disabled={readOnly} onSave={(d) => d[0] && void save({ dumpVersion: d[0] })} />
          </Row>
        </section>
      )}
    </>
  );
}

/** Several lines of text, saved when it loses focus. */
function LinesField({ value, onSave, placeholder, disabled, rows = 6 }: { value: string; onSave: (v: string) => void; placeholder?: string; disabled?: boolean; rows?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <textarea
      className="text-field area wide mono"
      rows={rows}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
    />
  );
}

const nonEmptyLines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function SynonymsPage() {
  const { t } = useSettings();
  const { value: v, save, readOnly } = useService("text");
  return (
    <>
      <PageHeader title={t("synonyms")} hint={t("synonymsHint")} />
      {v && (
        <section className="settings-rows">
          <Row label={t("synonymGroups")} hint={t("synonymGroupsHint")} stack>
            <LinesField
              value={v.synonyms.map((g) => g.join(", ")).join("\n")}
              disabled={readOnly}
              rows={10}
              placeholder={"st, saint, sankt\nav, avenue\nbd, boulevard\nmt, mont, mount"}
              onSave={(text) => void save({ synonyms: nonEmptyLines(text).map((l) => l.split(/[,\s]+/).filter(Boolean)) })}
            />
          </Row>
        </section>
      )}
    </>
  );
}

export function BlocklistPage() {
  const { t } = useSettings();
  const { value: v, save, readOnly } = useService("blocklist");
  return (
    <>
      <PageHeader title={t("blocklist")} hint={t("blocklistHint")} />
      {v && (
        <section className="settings-rows">
          <Row label={t("blockedIds")} hint={t("blockedIdsHint")} stack>
            <LinesField value={v.ids.join("\n")} disabled={readOnly} rows={6} placeholder={"N240109189\nW4536714\nX12"} onSave={(text) => void save({ ids: nonEmptyLines(text).flatMap((l) => l.split(/[,\s]+/)).filter(Boolean) })} />
          </Row>
          <Row label={t("blockedNames")} hint={t("blockedNamesHint")} stack>
            <LinesField value={v.names.join("\n")} disabled={readOnly} rows={6} placeholder={"*test*\nparking"} onSave={(text) => void save({ names: nonEmptyLines(text) })} />
          </Row>
        </section>
      )}
    </>
  );
}

export function CachePage() {
  const { t, f } = useSettings();
  const toast = useToast();
  const { admin } = useApp();
  const { value: v, save, readOnly } = useService("cache");
  const stats = useApi<CacheStats>("/app/cache");
  // Live numbers while the page is open.
  useEffect(() => {
    const timer = window.setInterval(() => stats.reload(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const s = stats.data;
  return (
    <>
      <PageHeader title={t("cache")} hint={t("cacheHint")} />
      {v && (
        <section className="settings-rows">
          <Row label={t("cacheEnabled")} hint={t("cacheEnabledHint")}>
            <Switch checked={v.enabled} disabled={readOnly} onChange={(enabled) => void save({ enabled })} label={t("cacheEnabled")} />
          </Row>
          <Row label={t("cacheTtl")} hint={t("cacheTtlHint")} disabled={!v.enabled}>
            <NumberField value={v.ttlSeconds} min={1} max={86400} disabled={readOnly || !v.enabled} suffix="s" onSave={(ttlSeconds) => void save({ ttlSeconds })} />
          </Row>
          <Row label={t("cacheMax")} hint={t("cacheMaxHint")} disabled={!v.enabled}>
            <NumberField value={v.maxEntries} min={100} max={1000000} disabled={readOnly || !v.enabled} onSave={(maxEntries) => void save({ maxEntries })} />
          </Row>
        </section>
      )}
      {s && (
        <section className="settings-rows">
          <h3>{t("cacheStats")}</h3>
          <div className="cache-stats">
            <div>
              <span className="cache-stat-value tabular">{f.number(s.entries)}</span>
              <span className="small muted">{t("cacheEntries")}</span>
            </div>
            <div>
              <span className="cache-stat-value tabular">{s.hitRate === null ? "—" : `${Math.round(s.hitRate * 100)} %`}</span>
              <span className="small muted">{t("cacheHitRate")}</span>
            </div>
            <div>
              <span className="cache-stat-value tabular">{f.number(s.hits)}</span>
              <span className="small muted">{t("cacheHits")}</span>
            </div>
            <div>
              <span className="cache-stat-value tabular">{f.number(s.misses)}</span>
              <span className="small muted">{t("cacheMisses")}</span>
            </div>
          </div>
          <Row label={t("cacheSince", { when: f.relative(s.since, t) })} hint={t("cacheClearHint")}>
            <button
              className="text-button"
              disabled={!admin}
              onClick={async () => {
                try {
                  await api("/app/cache/clear", { method: "POST" });
                  invalidate("/app/cache");
                  stats.reload();
                  toast(t("cacheCleared"));
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }}
            >
              {t("cacheClear")}
            </button>
          </Row>
        </section>
      )}
    </>
  );
}
