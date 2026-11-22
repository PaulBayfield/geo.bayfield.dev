// Regions: the map (installed in colour, click a country to pick it), the catalog of dumps grouped by
// continent, and the installed regions with their size, date and automatic updates.

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource } from "maplibre-gl";
import { api, type CatalogRegion, type Region, type ServiceSettings } from "../lib/api";
import { useApp } from "../lib/app";
import { countryShapes, regionCovers } from "../lib/countries";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, Spinner, useToast } from "./common";
import { MapCanvas, type MapInstance } from "./MapCanvas";
import { Download, RefreshCw, Search, Trash, X } from "./icons";
import { Switch } from "./settings/common";

type Status = "installed" | "busy" | "available";

export function RegionsPage() {
  const { t, f } = useSettings();
  const { admin, jobs, reloadJobs } = useApp();
  const toast = useToast();
  const regionsReq = useApi<Region[]>("/app/regions", true);
  const catalogReq = useApi<CatalogRegion[]>("/app/catalog");
  const serviceSettings = useApi<ServiceSettings>("/app/settings").data;
  const [selected, setSelected] = useState<CatalogRegion | null>(null);
  const [filter, setFilter] = useState("");
  const [removing, setRemoving] = useState<Region | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const map = useRef<MapInstance | null>(null);

  const installed = useMemo(() => new Map((regionsReq.data ?? []).map((r) => [r.id, r])), [regionsReq.data]);
  const busy = useMemo(() => new Set((jobs ?? []).filter((j) => j.status === "running" || j.status === "queued").map((j) => j.region)), [jobs]);
  const status = (id: string): Status => (busy.has(id) ? "busy" : installed.has(id) ? "installed" : "available");

  // When a job finishes, the installed list changes.
  const doneCount = (jobs ?? []).filter((j) => j.status === "done").length;
  useEffect(() => {
    invalidate("/app/regions");
    regionsReq.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount]);

  // Country → the catalog region covering it, and each country's status, for the map.
  const byCountry = useMemo(() => {
    const m = new Map<string, CatalogRegion>();
    for (const r of catalogReq.data ?? []) for (const name of regionCovers(r)) if (!m.has(name)) m.set(name, r);
    return m;
  }, [catalogReq.data]);

  const shapes = useMemo(() => {
    const fc = countryShapes();
    return {
      ...fc,
      features: fc.features.map((feat, i) => {
        const r = byCountry.get(feat.properties.name);
        return { ...feat, id: i, properties: { ...feat.properties, region: r?.id ?? "", status: r ? status(r.id) : "none", selected: !!r && r.id === selected?.id } };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byCountry, installed, busy, selected]);

  const drawLayers = (m: MapInstance, dark: boolean) => {
    if (m.getSource("countries")) return;
    m.addSource("countries", { type: "geojson", data: shapes });
    const available = dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)";
    m.addLayer({
      id: "countries-fill",
      type: "fill",
      source: "countries",
      paint: {
        "fill-color": ["match", ["get", "status"], "installed", "#2bb39a", "busy", "#e8a33d", "available", available, "rgba(0,0,0,0)"],
        "fill-opacity": ["case", ["get", "selected"], 0.75, ["match", ["get", "status"], "installed", 0.45, "busy", 0.5, 1]],
      },
    });
    m.addLayer({
      id: "countries-line",
      type: "line",
      source: "countries",
      paint: {
        "line-color": ["case", ["get", "selected"], "#2383e2", dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.15)"],
        "line-width": ["case", ["get", "selected"], 2, 0.5],
      },
    });
    m.on("mousemove", "countries-fill", (e) => {
      m.getCanvas().style.cursor = e.features?.[0]?.properties?.region ? "pointer" : "";
    });
    m.on("mouseleave", "countries-fill", () => (m.getCanvas().style.cursor = ""));
  };

  useEffect(() => {
    (map.current?.getSource("countries") as GeoJSONSource | undefined)?.setData(shapes);
  }, [shapes]);

  const install = async (r: CatalogRegion, options?: { languages: string[]; houseNumbers: boolean }) => {
    try {
      await api(`/app/regions/${encodeURIComponent(r.id)}/install`, { body: options ?? {} });
      toast(t("importQueued", { name: r.name }));
      reloadJobs();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const continents = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groups = new Map<string, CatalogRegion[]>();
    for (const r of catalogReq.data ?? []) {
      if (q && !r.name.toLowerCase().includes(q) && !r.path.includes(q)) continue;
      groups.set(r.continent, [...(groups.get(r.continent) ?? []), r]);
    }
    return [...groups];
  }, [catalogReq.data, filter]);

  return (
    <div className="regions-page">
      <div className="regions-map-wrap">
        <MapCanvas
          className="regions-map"
          center={[12, 47]}
          zoom={2.6}
          onReady={(m) => (map.current = m)}
          onStyle={drawLayers}
          onClick={(e, m) => {
            const hit = m.queryRenderedFeatures(e.point, { layers: ["countries-fill"] })[0];
            const id = hit?.properties?.region as string | undefined;
            setSelected(id ? (catalogReq.data?.find((r) => r.id === id) ?? null) : null);
          }}
        />
        <div className="map-legend">
          <span>
            <i className="swatch installed" />
            {t("installed")}
          </span>
          <span>
            <i className="swatch busy" />
            {t("importing")}
          </span>
          <span className="muted">{t("clickCountry")}</span>
        </div>
        {selected && (
          <RegionCard
            key={selected.id}
            region={selected}
            installed={installed.get(selected.id)}
            busy={busy.has(selected.id)}
            defaults={serviceSettings?.data}
            onInstall={(o) => void install(selected, o)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      <div className="page regions-lists">
        <section>
          <h2 className="section-title">{t("installedRegions")}</h2>
          {regionsReq.data?.length === 0 && <p className="muted">{t("noRegions")}</p>}
          <div className="table-wrap">
            {(regionsReq.data?.length ?? 0) > 0 && (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("region")}</th>
                    <th className="num">{t("features")}</th>
                    <th className="num">{t("addresses")}</th>
                    <th className="num">{t("size")}</th>
                    <th>{t("dataFrom")}</th>
                    <th>{t("autoUpdate")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {regionsReq.data!.map((r) => {
                    const entry = catalogReq.data?.find((c) => c.id === r.id);
                    return (
                      <tr key={r.id}>
                        <td>
                          <button className="link-button strong" onClick={() => entry && setSelected(entry)}>
                            {r.name}
                          </button>
                          <div className="small muted">
                            {r.languages.join(", ")}
                            {!r.houseNumbers && ` · ${t("noHouseNumbers")}`}
                          </div>
                        </td>
                        <td className="num tabular">{f.number(r.features)}</td>
                        <td className="num tabular">{f.number(r.addresses)}</td>
                        <td className="num tabular">{f.bytes(r.bytes)}</td>
                        <td className="small">
                          {r.dumpDate ? f.mediumDate(r.dumpDate) : "—"}
                          {entry?.updatedAt && r.importedAt && new Date(entry.updatedAt) > new Date(r.importedAt) && <span className="badge warn">{t("newerData")}</span>}
                        </td>
                        <td>
                          <Switch
                            checked={r.autoUpdate}
                            disabled={!admin}
                            label={t("autoUpdate")}
                            onChange={async (autoUpdate) => {
                              await api(`/app/regions/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { autoUpdate } });
                              invalidate("/app/regions");
                              regionsReq.reload();
                            }}
                          />
                        </td>
                        <td className="row-actions">
                          {admin && (
                            <>
                              <button className="icon-button small" title={t("updateNow")} disabled={busy.has(r.id) || !entry} onClick={() => entry && void install(entry)}>
                                <RefreshCw size={14} />
                              </button>
                              <button className="icon-button small danger" title={t("remove")} disabled={busy.has(r.id)} onClick={() => setRemoving(r)}>
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
            )}
          </div>
        </section>

        <section>
          <div className="section-head">
            <h2 className="section-title">{t("catalog")}</h2>
            <div className="search-field small">
              <Search size={14} />
              <input className="text-field" placeholder={t("filterRegions")} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button
              className="icon-button small"
              title={t("refreshCatalog")}
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await api("/app/catalog?refresh=1");
                  invalidate("/app/catalog");
                  catalogReq.reload();
                } catch (e) {
                  toast((e as Error).message, "error");
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <p className="small muted">{t("catalogHint")}</p>
          {catalogReq.loading && !catalogReq.data && (
            <p className="muted">
              <Spinner /> {t("loadingCatalog")}
            </p>
          )}
          {catalogReq.error && <p className="error-text">{catalogReq.error}</p>}
          <div className="catalog">
            {continents.map(([continent, regions]) => (
              <div key={continent} className="catalog-group">
                <h3>{regions.find((r) => r.isContinent)?.name ?? continent}</h3>
                <div className="catalog-items">
                  {regions.map((r) => {
                    const s = status(r.id);
                    return (
                      <button key={r.id} className={`catalog-item ${s}${selected?.id === r.id ? " active" : ""}`} onClick={() => setSelected(r)}>
                        <span className="catalog-name">
                          {r.isContinent ? t("wholeContinent") : r.name}
                        </span>
                        <span className="small muted tabular">{r.bytes ? f.bytes(r.bytes) : ""}</span>
                        {s !== "available" && <span className={`region-dot${s === "busy" ? " busy" : ""}`} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {removing && (
        <ConfirmDialog
          title={t("removeRegion")}
          text={t("removeRegionHint", { name: removing.name, size: f.bytes(removing.bytes) })}
          action={t("remove")}
          onConfirm={async () => {
            await api(`/app/regions/${encodeURIComponent(removing.id)}`, { method: "DELETE" });
            invalidate("/app/regions");
            regionsReq.reload();
            toast(t("regionRemoved"));
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** The picked region, over the map: what it holds and how to install it. */
function RegionCard({
  region,
  installed,
  busy,
  defaults,
  onInstall,
  onClose,
}: {
  region: CatalogRegion;
  installed?: Region;
  busy: boolean;
  defaults?: ServiceSettings["data"];
  onInstall: (o: { languages: string[]; houseNumbers: boolean }) => void;
  onClose: () => void;
}) {
  const { t, f } = useSettings();
  const { admin } = useApp();
  const [languages, setLanguages] = useState((installed?.languages ?? defaults?.languages ?? ["fr", "en"]).join(", "));
  const [houseNumbers, setHouseNumbers] = useState(installed?.houseNumbers ?? defaults?.houseNumbers ?? true);
  // Rough: the database ends up ~5.5× the compressed dump with house numbers (Belgium: 0.45 GB → 2.5 GB).
  const estimate = region.bytes ? region.bytes * (houseNumbers ? 5.5 : 2) : null;
  return (
    <div className="region-card">
      <div className="region-card-head">
        <div>
          <h3>{region.name}</h3>
          <span className="small muted">{region.path}</span>
        </div>
        <button className="icon-button small" aria-label={t("close")} onClick={onClose}>
          <X />
        </button>
      </div>
      <dl className="facts">
        <dt>{t("download")}</dt>
        <dd>{region.bytes ? f.bytes(region.bytes) : "—"}</dd>
        <dt>{t("dataFrom")}</dt>
        <dd>{region.updatedAt ? f.mediumDate(region.updatedAt) : "—"}</dd>
        {installed ? (
          <>
            <dt>{t("installed")}</dt>
            <dd>
              {f.bytes(installed.bytes)} · {installed.importedAt ? f.relative(installed.importedAt, t) : ""}
            </dd>
          </>
        ) : (
          estimate && (
            <>
              <dt>{t("estimatedSize")}</dt>
              <dd>≈ {f.bytes(estimate)}</dd>
            </>
          )
        )}
      </dl>
      {admin && (
        <>
          <label className="field">
            {t("keepLanguages")}
            <input className="text-field" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="fr, en, de, nl" />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={houseNumbers} onChange={(e) => setHouseNumbers(e.target.checked)} />
            {t("includeHouseNumbers")}
          </label>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => onInstall({ languages: languages.split(/[\s,]+/).filter((l) => /^[a-z]{2,3}$/.test(l)), houseNumbers })}
          >
            {installed ? <RefreshCw size={14} /> : <Download size={14} />}
            {busy ? t("importing") : installed ? t("updateNow") : t("install")}
          </button>
          {region.isContinent && <p className="small muted">{t("continentHint")}</p>}
        </>
      )}
    </div>
  );
}
