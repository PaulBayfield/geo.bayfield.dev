// The service's settings, live: access (API keys, limits, CORS), results, ranking, data. Admins change
// them; everyone else sees them. Each change is saved at once and applies to the next request.

import { useEffect, useState, type ReactNode } from "react";
import { ENDPOINTS, LAYERS, api, type ServiceSettings } from "../../lib/api";
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
          <Row label={t("dumpVersion")} hint={t("dumpVersionHint")}>
            <ListField value={[v.dumpVersion]} disabled={readOnly} onSave={(d) => d[0] && void save({ dumpVersion: d[0] })} />
          </Row>
        </section>
      )}
    </>
  );
}
