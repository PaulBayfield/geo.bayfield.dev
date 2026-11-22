// The test console: type to autocomplete or search, click the map to reverse geocode. Results show on
// the map with their time and raw JSON. Goes through /api/app/try, so it works whatever the API's
// key settings are.

import { useEffect, useRef, useState } from "react";
import { api, query, type GeoResult } from "../lib/api";
import { useSettings } from "../lib/settings";
import { MapCanvas, maplibregl, type MapInstance } from "./MapCanvas";
import { CopyButton } from "./common";
import { Code, Crosshair, MapPin, Search } from "./icons";

type Mode = "autocomplete" | "search" | "reverse";

export function PlaygroundPage() {
  const { t, f, settings, update } = useSettings();
  const mode = settings.playgroundMode;
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [raw, setRaw] = useState(false);
  const [useBias, setUseBias] = useState(true);
  const [clicked, setClicked] = useState<{ lat: number; lon: number } | null>(null);
  const map = useRef<MapInstance | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const lang = settings.playgroundLang;

  const run = async (path: string) => {
    try {
      const r = await api<{ results: GeoResult[]; ms: number }>(path);
      setResults(r.results);
      setMs(r.ms);
      setError(null);
      setSelected(0);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Typing: autocomplete on every keystroke (debounced a little), search on Enter.
  useEffect(() => {
    if (mode !== "autocomplete") return;
    if (!q.trim()) return setResults([]);
    const c = map.current?.getCenter();
    const timer = window.setTimeout(() => void run(`/app/try/autocomplete${query({ q, lang, lat: useBias ? c?.lat.toFixed(4) : undefined, lon: useBias ? c?.lng.toFixed(4) : undefined })}`), 120);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode, lang, useBias]);

  const search = () => {
    const c = map.current?.getCenter();
    void run(`/app/try/search${query({ q, lang, lat: useBias ? c?.lat.toFixed(4) : undefined, lon: useBias ? c?.lng.toFixed(4) : undefined })}`);
  };

  // Results on the map.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const mk of markers.current) mk.remove();
    markers.current = results.map((r, i) => {
      const el = document.createElement("div");
      el.className = `result-marker${i === selected ? " active" : ""}`;
      el.textContent = String(i + 1);
      el.onclick = (e) => {
        e.stopPropagation();
        setSelected(i);
      };
      return new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(m);
    });
    if (clicked && mode === "reverse") {
      const el = document.createElement("div");
      el.className = "click-marker";
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([clicked.lon, clicked.lat]).addTo(m));
    }
  }, [results, selected, clicked, mode]);

  // The selected result: fly there.
  useEffect(() => {
    const r = results[selected];
    const m = map.current;
    if (!r || !m || mode === "reverse") return;
    if (r.extent && r.extent[0] !== r.extent[2]) m.fitBounds([[r.extent[0], r.extent[3]], [r.extent[2], r.extent[1]]], { padding: 60, maxZoom: 17, duration: 600 });
    else m.flyTo({ center: [r.lon, r.lat], zoom: Math.max(m.getZoom(), 15), duration: 600 });
  }, [selected, results, mode]);

  const setMode = (m: Mode) => {
    update({ playgroundMode: m });
    setResults([]);
    setMs(null);
    setError(null);
  };

  const current = results[selected];

  return (
    <div className="playground">
      <MapCanvas
        className="playground-map"
        onReady={(m) => (map.current = m)}
        onClick={(e) => {
          if (mode !== "reverse") return;
          const p = { lat: +e.lngLat.lat.toFixed(6), lon: +e.lngLat.lng.toFixed(6) };
          setClicked(p);
          void run(`/app/try/reverse${query({ ...p, lang })}`);
        }}
      />
      <div className="playground-card">
        <div className="segmented full" role="radiogroup">
          {(["autocomplete", "search", "reverse"] as Mode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {t(`mode_${m}`)}
            </button>
          ))}
        </div>
        {mode === "reverse" ? (
          <p className="playground-hint">
            <Crosshair size={14} />
            {t("reverseHint")}
          </p>
        ) : (
          <form
            className="playground-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (mode === "search") search();
            }}
          >
            <Search size={16} />
            <input autoFocus value={q} placeholder={t("playgroundPlaceholder")} onChange={(e) => setQ(e.target.value)} />
          </form>
        )}
        <div className="playground-options">
          <label className="checkbox">
            <input type="checkbox" checked={useBias} disabled={mode === "reverse"} onChange={(e) => setUseBias(e.target.checked)} />
            {t("biasToMap")}
          </label>
          <select value={lang} onChange={(e) => update({ playgroundLang: e.target.value })} aria-label={t("language")}>
            <option value="">{t("defaultLanguage")}</option>
            {["fr", "en", "de", "nl", "es", "it"].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          {ms !== null && <span className="badge good tabular">{t("tookMs", { ms: f.number(ms) })}</span>}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="playground-results">
          {results.length === 0 && ms !== null && <p className="muted small">{t("noResults")}</p>}
          {results.map((r, i) => (
            <button key={`${r.id}-${i}`} className={`result-row${i === selected ? " active" : ""}`} onClick={() => setSelected(i)}>
              <span className="result-index">{i + 1}</span>
              <span className="result-main">
                <span className="result-label">{r.label}</span>
                <span className="small muted">
                  {t(`layer_${r.layer}` as never) || r.layer} · {r.osm.key}={r.osm.value}
                  {r.distance !== undefined && ` · ${f.number(r.distance)} m`}
                </span>
              </span>
            </button>
          ))}
        </div>
        {current && (
          <div className="playground-raw">
            <button className="text-button small" onClick={() => setRaw((v) => !v)}>
              <Code size={13} />
              {raw ? t("hideJson") : t("showJson")}
            </button>
            <a className="text-button small" href={`https://www.openstreetmap.org/${{ N: "node", W: "way", R: "relation" }[current.osm.type] ?? "node"}/${current.osm.id}`} target="_blank" rel="noreferrer">
              <MapPin size={13} />
              OSM
            </a>
            {raw && (
              <div className="json-box">
                <CopyButton text={JSON.stringify(current, null, 2)} />
                <pre>{JSON.stringify(current, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
