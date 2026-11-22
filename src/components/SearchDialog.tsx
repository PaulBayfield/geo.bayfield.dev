// Ctrl+K / "/": the same command palette as Calendar's and Notes'. Jumps to a page, a region, a
// settings page, or geocodes what's typed (the first results, in the playground).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, query, type GeoResult, type Region } from "../lib/api";
import { useApp, type SettingsPage } from "../lib/app";
import { useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import type { StringKey } from "../lib/i18n";
import { NAV } from "./Sidebar";
import { Flags } from "./common";
import { Gear, Globe, MapPin, Search } from "./icons";

interface Result {
  key: string;
  section: StringKey;
  title: string;
  extra?: string;
  icon: ReactNode;
  run: () => void;
}

const SETTINGS: { id: SettingsPage; label: StringKey }[] = [
  { id: "profile", label: "profile" },
  { id: "preferences", label: "preferences" },
  { id: "security", label: "security" },
  { id: "access", label: "access" },
  { id: "results", label: "results" },
  { id: "ranking", label: "ranking" },
  { id: "data", label: "data" },
  { id: "shortcuts", label: "shortcuts" },
  { id: "about", label: "about" },
];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { t, f } = useSettings();
  const { navigate, openSettings } = useApp();
  const regions = useApi<Region[]>("/app/regions").data;
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [places, setPlaces] = useState<GeoResult[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const q = norm(text.trim());

  // What's typed, geocoded (after a short pause).
  useEffect(() => {
    if (text.trim().length < 3) return setPlaces([]);
    let live = true;
    const timer = window.setTimeout(() => {
      api<{ results: GeoResult[] }>(`/app/try/autocomplete${query({ q: text, limit: 4 })}`).then(
        (r) => live && setPlaces(r.results),
        () => live && setPlaces([]),
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text]);

  const results = useMemo(() => {
    const keep = (title: string) => !q || norm(title).includes(q);
    const done = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const out: Result[] = [];
    for (const n of NAV) if (keep(t(n.label))) out.push({ key: `page:${n.page}`, section: "pages", title: t(n.label), icon: n.icon, run: done(() => navigate({ name: n.page })) });
    for (const r of regions ?? []) if (q && keep(r.name)) out.push({ key: `region:${r.id}`, section: "regions", title: r.name, extra: f.bytes(r.bytes), icon: r.countries.length ? <Flags codes={r.countries} max={1} size={12} /> : <Globe size={16} />, run: done(() => navigate({ name: "regions" })) });
    for (const p of places) out.push({ key: `place:${p.id}`, section: "places", title: p.label, extra: t(`layer_${p.layer}` as StringKey), icon: p.address.countryCode ? <Flags codes={[p.address.countryCode]} size={12} /> : <MapPin size={16} />, run: done(() => navigate({ name: "playground" })) });
    if (q) for (const s of SETTINGS.filter((s) => keep(t(s.label)))) out.push({ key: `settings:${s.id}`, section: "settings", title: t(s.label), icon: <Gear size={16} />, run: done(() => openSettings(s.id)) });
    return out;
  }, [q, regions, places, t, f, navigate, openSettings, onClose]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".search-result.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastSection: StringKey | null = null;
  return (
    <div className="dialog-backdrop search-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-label={t("search")}>
        <div className="search-input-row">
          <Search size={18} />
          <input
            autoFocus
            value={text}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") setActive((i) => Math.min(results.length - 1, i + 1));
              else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
              else if (e.key === "Enter" && results[active]) results[active].run();
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
        <div className="search-results" ref={listRef}>
          {results.length === 0 && <p className="search-empty">{t("noResults")}</p>}
          {results.map((r, i) => {
            const header = r.section !== lastSection ? <div className="search-section">{t(r.section)}</div> : null;
            lastSection = r.section;
            return (
              <div key={r.key}>
                {header}
                <button className={`search-result${i === active ? " active" : ""}`} onMouseEnter={() => setActive(i)} onClick={r.run}>
                  <span className="search-result-icon">{r.icon}</span>
                  <span className="search-result-text">
                    <span className="search-result-title">{r.title}</span>
                  </span>
                  {r.extra && <span className="search-result-when">{r.extra}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
