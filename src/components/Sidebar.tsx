import { useRef, type CSSProperties, type ReactNode } from "react";
import type { Region } from "../lib/api";
import { useApp } from "../lib/app";
import { useApi } from "../lib/hooks";
import type { Page } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { StringKey } from "../lib/i18n";
import { Flags } from "./common";
import { BookOpen, Crosshair, Gauge, Globe, Key, MapPin, PanelLeft, Search } from "./icons";

const MIN_W = 200;
const MAX_W = 480;
const DEFAULT_W = 248;

export const NAV: { page: Page; label: StringKey; icon: ReactNode; key: string }[] = [
  { page: "overview", label: "overview", icon: <Gauge />, key: "1" },
  { page: "regions", label: "regions", icon: <Globe />, key: "2" },
  { page: "playground", label: "playground", icon: <Crosshair />, key: "3" },
  { page: "places", label: "customPlaces", icon: <MapPin />, key: "4" },
  { page: "keys", label: "apiKeys", icon: <Key />, key: "5" },
  { page: "docs", label: "docs", icon: <BookOpen />, key: "6" },
];

/** Same layout as Calendar's and Notes' sidebars: toggle and search on top, then the pages and the regions. */
export function Sidebar() {
  const { t, f, settings } = useSettings();
  const { route, navigate, toggleSidebar, openSearch, jobs } = useApp();
  const regions = useApi<Region[]>("/app/regions", true).data;
  const busy = new Set((jobs ?? []).filter((j) => j.status === "running" || j.status === "queued").map((j) => j.region));

  return (
    <aside className="sidebar" style={{ "--sidebar-w": `${settings.sidebarWidth}px` } as CSSProperties}>
      <ResizeHandle />
      <div className="sidebar-top">
        <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} aria-label={t("toggleSidebar")} onClick={toggleSidebar}>
          <PanelLeft />
        </button>
        <div className="toolbar-spacer" />
        <button className="icon-button" title={`${t("search")} (Ctrl+K)`} aria-label={t("search")} onClick={openSearch}>
          <Search />
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((n) => (
          <button key={n.page} className={`sidebar-row${route.name === n.page ? " active" : ""}`} onClick={() => navigate({ name: n.page })}>
            {n.icon}
            <span className="row-label">{t(n.label)}</span>
            <span className="row-meta">{n.key}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-scroll">
        <div className="sidebar-group">
          <div className="sidebar-group-title">{t("installedRegions")}</div>
          {regions?.length === 0 && (
            <button className="sidebar-row empty" onClick={() => navigate({ name: "regions" })}>
              <span className="row-label">{t("noRegionsShort")}</span>
            </button>
          )}
          {(regions ?? []).map((r) => (
            <button key={r.id} className="sidebar-row" title={r.path} onClick={() => navigate({ name: "regions" })}>
              <span className={`region-dot${busy.has(r.id) ? " busy" : ""}`} />
              <Flags codes={r.countries} max={2} size={12} />
              <span className="row-label">{r.name}</span>
              <span className="row-meta">{f.bytes(r.bytes)}</span>
            </button>
          ))}
          {[...busy]
            .filter((id) => !regions?.some((r) => r.id === id))
            .map((id) => (
              <button key={id} className="sidebar-row empty" onClick={() => navigate({ name: "regions" })}>
                <span className="region-dot busy" />
                <span className="row-label">{jobs?.find((j) => j.region === id)?.name ?? id}</span>
                <span className="row-meta">{t("installing")}</span>
              </button>
            ))}
        </div>
      </div>
    </aside>
  );
}

/** Drag the right edge to resize; double-click to reset. */
export function ResizeHandle() {
  const { update } = useSettings();
  const drag = useRef<{ x: number; w: number; aside: HTMLElement } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const aside = e.currentTarget.parentElement!;
        drag.current = { x: e.clientX, w: aside.getBoundingClientRect().width, aside };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.documentElement.classList.add("resizing-sidebar");
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) d.aside.style.setProperty("--sidebar-w", `${clamp(d.w + e.clientX - d.x)}px`);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        document.documentElement.classList.remove("resizing-sidebar");
        update({ sidebarWidth: clamp(d.w + e.clientX - d.x) });
      }}
      onDoubleClick={() => update({ sidebarWidth: DEFAULT_W })}
    />
  );
}
